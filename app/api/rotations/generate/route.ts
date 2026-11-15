import { NextRequest, NextResponse } from "next/server";
import {
  generateRotations,
  GenerationRequestSchema,
  OpenAICompatibleProvider,
  DEFAULT_AI_TIMEOUT_MS,
  type GenerationContext,
  type AIProviderClient,
} from "@/lib/rotation-generator";

/**
 * Secure server-side route for AI-assisted rotation generation.
 *
 * - NEVER exposes AI credentials to the client.
 * - Validates input strictly with GenerationRequestSchema (Zod).
 * - Always runs deterministic classification and available-crop filtering,
 *   even when no runtime AI provider is configured (returning 503 with classification).
 * - Calls the LLM with a timeout and AbortSignal when configured, validates output,
 *   rejects agronomically invalid proposals, and scores accepted proposals.
 */

function getProvider(): AIProviderClient | null {
  const providerName = process.env.FALLO_AI_PROVIDER?.trim();
  const apiKey = process.env.FALLO_AI_API_KEY?.trim();
  if (!providerName || !apiKey) return null;

  const baseUrl = process.env.FALLO_AI_BASE_URL?.trim() || undefined;
  const model = process.env.FALLO_AI_MODEL?.trim() || "gpt-4o-mini";
  const parsedTimeout = Number(process.env.FALLO_AI_TIMEOUT_MS);
  const timeoutMs =
    Number.isFinite(parsedTimeout) && parsedTimeout >= 1000
      ? parsedTimeout
      : DEFAULT_AI_TIMEOUT_MS;

  return new OpenAICompatibleProvider({
    providerName,
    apiKey,
    baseUrl,
    model,
    timeoutMs,
  });
}

export async function POST(req: NextRequest) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const parseResult = GenerationRequestSchema.safeParse(body);
  if (!parseResult.success) {
    return NextResponse.json(
      { error: "Validation failed", details: parseResult.error.flatten() },
      { status: 400 }
    );
  }

  const data = parseResult.data;

  const context: GenerationContext = {
    fieldId: data.fieldId,
    fieldName: data.fieldName,
    lat: data.lat,
    lon: data.lon,
    climate: data.climate,
    soil: data.soil,
    priorities: data.priorities,
    regionTag: data.regionTag,
  };

  const provider = getProvider();

  try {
    const result = await generateRotations(context, provider);

    if (!provider) {
      return NextResponse.json(
        {
          ...result,
          error: "AI generation unavailable",
          message:
            result.aiUnavailableReason ??
            "No runtime AI provider is configured for this deployment. " +
              "To enable AI-assisted rotation generation, set FALLO_AI_PROVIDER and FALLO_AI_API_KEY environment variables. " +
              "The deterministic classifier, validator, and crop catalog are fully functional without AI.",
          aiStatus: "unavailable",
        },
        { status: 503 }
      );
    }

    return NextResponse.json(result, { status: 200 });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json(
      {
        error: "Generation failed",
        message,
        classification: null,
        availableCrops: [],
        proposals: [],
        supportStatus: "unavailable",
      },
      { status: 500 }
    );
  }
}
