import { NextRequest, NextResponse } from "next/server";
import {
  generateRotations,
  GenerationRequestSchema,
  resolveRuntimeAIProvider,
  isVercelDeploymentEnvironment,
  getMissingVercelWifEnvVars,
  type GenerationContext,
} from "@/lib/rotation-generator";

/**
 * Node.js runtime is required so `@google/genai`, `@vercel/oidc`, and `google-auth-library`
 * can resolve Vercel OIDC Workload Identity Federation credentials or local ADC on the server.
 */
export const runtime = "nodejs";
export const maxDuration = 120;

/**
 * Secure server-side route for AI-assisted rotation generation.
 *
 * - NEVER exposes AI credentials, OIDC tokens, or ADC tokens to the client.
 * - Uses Google Cloud's Gemini Enterprise Agent Platform (`@google/genai` with
 *   `enterprise: true`, `GOOGLE_CLOUD_PROJECT`, `GOOGLE_CLOUD_LOCATION`) authenticated via:
 *   - Vercel OIDC + Google Cloud Workload Identity Federation (`ExternalAccountClient.fromJSON`)
 *     on deployed Vercel environments (`GCP_PROJECT_NUMBER`, `GCP_SERVICE_ACCOUNT_EMAIL`,
 *     `GCP_WORKLOAD_IDENTITY_POOL_ID`, `GCP_WORKLOAD_IDENTITY_POOL_PROVIDER_ID`).
 *   - Application Default Credentials (ADC) in local development.
 * - Validates input strictly with GenerationRequestSchema (Zod).
 * - Always runs deterministic classification and available-crop filtering,
 *   even when no runtime AI provider is configured (returning 503 with classification).
 * - Calls the LLM with a timeout and AbortSignal when configured, validates output,
 *   rejects agronomically invalid proposals, and scores accepted proposals.
 */

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

  const provider = resolveRuntimeAIProvider(process.env);

  try {
    const result = await generateRotations(context, provider, {
      signal: req.signal,
    });

    if (!provider) {
      const onVercel = isVercelDeploymentEnvironment(process.env);
      const missingWifVars = onVercel ? getMissingVercelWifEnvVars(process.env) : [];
      const vercelWifHint =
        onVercel && missingWifVars.length > 0
          ? ` Missing Vercel OIDC Workload Identity Federation environment variables: ${missingWifVars.join(", ")}.`
          : "";
      const unavailableMessage =
        (result.aiUnavailableReason ??
          "No runtime AI provider is configured for this deployment. " +
            "Set GOOGLE_GENAI_USE_ENTERPRISE=true, GOOGLE_CLOUD_PROJECT, and GOOGLE_CLOUD_LOCATION (with Vercel OIDC Workload Identity Federation on Vercel or Application Default Credentials locally) to enable Gemini Enterprise rotation generation.") +
        vercelWifHint;

      return NextResponse.json(
        {
          ...result,
          aiUnavailableReason: unavailableMessage,
          error: "AI generation unavailable",
          message: unavailableMessage,
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
