import { NextRequest, NextResponse } from "next/server";
import {
  generateRotations,
  GenerationRequestSchema,
  resolveRuntimeAIProvider,
  describeMissingAIProviderReason,
  sanitizeGenerationErrorMessage,
  checkGenerationRateLimit,
  getInFlightGenerationCount,
  MAX_CONCURRENT_GENERATIONS,
  MAX_GENERATION_REQUEST_BYTES,
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
  const contentLengthHeader = req.headers.get("content-length");
  if (contentLengthHeader) {
    const byteLength = Number(contentLengthHeader);
    if (Number.isFinite(byteLength) && byteLength > MAX_GENERATION_REQUEST_BYTES) {
      return NextResponse.json(
        { error: "Payload too large", message: "Request payload exceeds 256 KB limit." },
        { status: 413 }
      );
    }
  }

  const forwardedFor = req.headers.get("x-forwarded-for");
  const clientIp =
    forwardedFor?.split(",")[0]?.trim() ||
    req.headers.get("x-real-ip")?.trim() ||
    "local-client";

  // Best-effort per-instance rate limit and concurrency protection.
  // Note: In serverless deployments, in-memory Maps/Sets are scoped to each warm
  // function instance rather than globally shared across all instances.
  const rateStatus = checkGenerationRateLimit(clientIp);
  if (!rateStatus.allowed) {
    return NextResponse.json(
      {
        error: "Rate limit exceeded",
        message: `Too many rotation generation requests. Please wait ${rateStatus.retryAfterSeconds} seconds before generating again.`,
      },
      {
        status: 429,
        headers: {
          "Retry-After": String(rateStatus.retryAfterSeconds),
        },
      }
    );
  }

  if (getInFlightGenerationCount() >= MAX_CONCURRENT_GENERATIONS) {
    return NextResponse.json(
      {
        error: "Server busy",
        message:
          "Maximum concurrent SI generation requests are currently in progress. Please wait a moment and try again.",
      },
      { status: 429 }
    );
  }

  let body: unknown;
  try {
    const rawBody = await req.text();
    if (rawBody.length > MAX_GENERATION_REQUEST_BYTES) {
      return NextResponse.json(
        { error: "Payload too large", message: "Request payload exceeds 256 KB limit." },
        { status: 413 }
      );
    }
    body = JSON.parse(rawBody);
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
      const unavailableMessage = sanitizeGenerationErrorMessage(
        result.aiUnavailableReason || describeMissingAIProviderReason(process.env)
      );

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

    if (!Array.isArray(result.proposals) || result.proposals.length === 0) {
      const failureMessage = sanitizeGenerationErrorMessage(
        result.aiUnavailableReason,
        "SI rotation generation could not complete. Please verify your provider configuration and try again."
      );
      return NextResponse.json(
        {
          ...result,
          aiUnavailableReason: failureMessage,
          message: failureMessage,
        },
        { status: 200 }
      );
    }

    return NextResponse.json(result, { status: 200 });
  } catch (err) {
    const message = sanitizeGenerationErrorMessage(
      err instanceof Error ? err.message : String(err)
    );
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
