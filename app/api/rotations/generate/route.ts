import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import {
  generateRotations,
  type GenerationContext,
  type AIProviderClient,
} from "@/lib/rotation-generator";
import { type ClimateData, type SoilData, type FarmerPriorities } from "@/lib/rotation-scoring";

/**
 * Secure server-side route for AI-assisted rotation generation.
 *
 * - NEVER exposes AI credentials to the client.
 * - Returns 503 if no runtime AI provider is configured.
 * - Accepts climate + soil + priorities from the client (already fetched).
 * - Validates input with Zod.
 * - Calls the LLM, validates output, scores proposals, returns structured result.
 */

// ─── Env var checks ───────────────────────────────────────────────────

const AI_PROVIDER = process.env.FALLO_AI_PROVIDER; // e.g. "openai"
const AI_API_KEY = process.env.FALLO_AI_API_KEY;
const AI_BASE_URL = process.env.FALLO_AI_BASE_URL; // optional, for custom endpoints
const AI_MODEL = process.env.FALLO_AI_MODEL ?? "gpt-4o-mini";

function isProviderConfigured(): boolean {
  return !!AI_PROVIDER && !!AI_API_KEY;
}

// ─── Minimal OpenAI-compatible provider client ────────────────────────

class OpenAICompatibleProvider implements AIProviderClient {
  providerName = AI_PROVIDER ?? "unknown";
  private apiKey: string;
  private baseUrl: string;
  private model: string;

  constructor(opts: { apiKey: string; baseUrl?: string; model: string }) {
    this.apiKey = opts.apiKey;
    this.baseUrl = opts.baseUrl ?? "https://api.openai.com/v1";
    this.model = opts.model;
  }

  async generate({ prompt, maxTokens = 4000 }: { prompt: string; maxTokens?: number }): Promise<string> {
    const res = await fetch(`${this.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        model: this.model,
        messages: [
          { role: "system", content: prompt },
          { role: "user", content: "Generate rotation strategies for this field." },
        ],
        temperature: 0.3,
        max_tokens: maxTokens,
      }),
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Provider returned ${res.status}: ${text}`);
    }

    const data = (await res.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
      error?: { message?: string };
    };

    const content = data.choices?.[0]?.message?.content;
    if (!content) {
      throw new Error("Empty response from provider");
    }
    return content;
  }
}

function getProvider(): AIProviderClient | null {
  if (!isProviderConfigured()) return null;
  // We only support OpenAI-compatible providers for now
  return new OpenAICompatibleProvider({
    apiKey: AI_API_KEY!,
    baseUrl: AI_BASE_URL,
    model: AI_MODEL,
  });
}

// ─── Request validation ───────────────────────────────────────────────

const RequestSchema = z.object({
  fieldId: z.string().min(1),
  fieldName: z.string().min(1),
  lat: z.number().min(-90).max(90),
  lon: z.number().min(-180).max(180),
  climate: z.custom<ClimateData>(() => true),
  soil: z.custom<SoilData | null>(() => true),
  priorities: z.custom<FarmerPriorities>(() => true),
  regionTag: z.string().nullable(),
});

export async function POST(req: NextRequest) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const parseResult = RequestSchema.safeParse(body);
  if (!parseResult.success) {
    return NextResponse.json(
      { error: "Validation failed", details: parseResult.error.flatten() },
      { status: 400 }
    );
  }

  const data = parseResult.data;

  const provider = getProvider();
  if (!provider) {
    return NextResponse.json(
      {
        error: "AI generation unavailable",
        message:
          "No runtime AI provider is configured for this deployment. " +
          "To enable AI-assisted rotation generation, set FALLO_AI_PROVIDER and FALLO_AI_API_KEY environment variables. " +
          "The deterministic classifier, validator, and crop catalog are fully functional without AI.",
        classification: null,
        proposals: [],
        supportStatus: "unavailable",
      },
      { status: 503 }
    );
  }

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

  try {
    const result = await generateRotations(context, provider);
    return NextResponse.json(result, { status: 200 });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json(
      {
        error: "Generation failed",
        message,
        classification: null,
        proposals: [],
        supportStatus: "unavailable",
      },
      { status: 500 }
    );
  }
}
