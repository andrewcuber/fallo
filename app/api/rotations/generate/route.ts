import { NextRequest, NextResponse } from "next/server";
import {
  generateRotations,
  GenerationRequestSchema,
  resolveRuntimeAIProvider,
  describeMissingAIProviderReason,
  sanitizeGenerationErrorMessage,
  MAX_GENERATION_REQUEST_BYTES,
  type GenerationContext,
} from "@/lib/rotation-generator";
import { reserveUsage, reconcileUsage } from "@/lib/redis-usage";
import crypto from "crypto";

export const runtime = "nodejs";
export const maxDuration = 120;

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

  // 1. Resolve Anonymous Visitor ID
  let visitorId = req.cookies.get("fallo_visitor_id")?.value;
  let newCookieStr: string | null = null;
  if (!visitorId) {
    visitorId = crypto.randomUUID();
    // In Edge/Node, setting cookies on NextRequest/NextResponse directly varies by pattern. 
    // We will set-cookie on the NextResponse.
    newCookieStr = `fallo_visitor_id=${visitorId}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=31536000`;
  }

  const usageLimitsEnabled = process.env.FALLO_AI_USAGE_LIMITS_ENABLED === "true";

  // 2. Atomically Reserve Usage in Redis (if enabled)
  const expectedModel = process.env.GEMINI_MODEL || "gemini-3.8-flash";

  let reservation: any = {
    allowed: true,
    reason: undefined,
    remainingGenerations: null,
    reservationId: undefined,
    retryAfterSeconds: 0
  };

  if (usageLimitsEnabled) {
    reservation = await reserveUsage(visitorId, clientIp, expectedModel);
  }

  if (!reservation.allowed) {
    const res = NextResponse.json(
      {
        error: "Rate limit exceeded",
        message: reservation.reason === "ip_limit" ? `Too many attempts from this IP. Please wait.` 
                 : reservation.reason === "visitor_generations" ? `You have exhausted your daily allowance of generations.`
                 : reservation.reason === "visitor_concurrent" ? `Please wait for your previous generation to complete.`
                 : reservation.reason?.startsWith("global") ? `The website's global AI budget has been reached for today. Please try again tomorrow.`
                 : `Too many rotation generation requests. Please try again later.`,
        aiStatus: "limit_exhausted",
        limitReason: reservation.reason,
        aiUnavailableReason: reservation.reason === "visitor_generations" ? `You have exhausted your daily allowance of generations.` : `Too many rotation generation requests. Please try again later.`
      },
      {
        status: 429,
        headers: reservation.retryAfterSeconds ? { "Retry-After": String(reservation.retryAfterSeconds) } : {},
      }
    );
    if (newCookieStr) res.headers.set("Set-Cookie", newCookieStr);
    return res;
  }

  let body: unknown;
  try {
    const rawBody = await req.text();
    if (rawBody.length > MAX_GENERATION_REQUEST_BYTES) {
      // Reconcile failed usage
      if (reservation.reservationId) {
        await reconcileUsage(visitorId, reservation.reservationId, 0, 0, expectedModel, false);
      }
      const res = NextResponse.json(
        { error: "Payload too large", message: "Request payload exceeds 256 KB limit." },
        { status: 413 }
      );
      if (newCookieStr) res.headers.set("Set-Cookie", newCookieStr);
      return res;
    }
    body = JSON.parse(rawBody);
  } catch {
    if (reservation.reservationId) {
      await reconcileUsage(visitorId, reservation.reservationId, 0, 0, expectedModel, false);
    }
    const res = NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
    if (newCookieStr) res.headers.set("Set-Cookie", newCookieStr);
    return res;
  }

  const parseResult = GenerationRequestSchema.safeParse(body);
  if (!parseResult.success) {
    if (reservation.reservationId) {
      await reconcileUsage(visitorId, reservation.reservationId, 0, 0, expectedModel, false);
    }
    const res = NextResponse.json(
      { error: "Validation failed", details: parseResult.error.flatten() },
      { status: 400 }
    );
    if (newCookieStr) res.headers.set("Set-Cookie", newCookieStr);
    return res;
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
  const actualModel = provider?.modelName || expectedModel;

  try {
    const result = await generateRotations(context, provider, {
      signal: req.signal,
    });

    // Extract actual usage metadata to reconcile
    const usage = result.usageMetadata;
    const inputTokens = usage?.promptTokenCount || 0;
    const outputTokens = (usage?.candidatesTokenCount || 0) + (usage?.thoughtsTokenCount || 0);

    // If no provider or no proposals, we consider it a failure (0 tokens) or just whatever tokens were consumed.
    // If it generated empty proposals but used tokens, we still charge them for the tokens.
    const success = Array.isArray(result.proposals) && result.proposals.length > 0;
    
    if (reservation.reservationId) {
      await reconcileUsage(visitorId, reservation.reservationId, inputTokens, outputTokens, actualModel, success);
    }

    if (!provider) {
      const unavailableMessage = sanitizeGenerationErrorMessage(
        result.aiUnavailableReason || describeMissingAIProviderReason(process.env)
      );

      const res = NextResponse.json(
        {
          ...result,
          aiUnavailableReason: unavailableMessage,
          error: "AI generation unavailable",
          message: unavailableMessage,
          aiStatus: "unavailable",
          remainingGenerations: reservation.remainingGenerations,
        },
        { status: 503 }
      );
      if (newCookieStr) res.headers.set("Set-Cookie", newCookieStr);
      return res;
    }

    if (!success) {
      const failureMessage = sanitizeGenerationErrorMessage(
        result.aiUnavailableReason,
        "SI rotation generation could not complete. Please verify your provider configuration and try again."
      );
      const res = NextResponse.json(
        {
          ...result,
          aiUnavailableReason: failureMessage,
          message: failureMessage,
          remainingGenerations: reservation.remainingGenerations,
        },
        { status: 200 }
      );
      if (newCookieStr) res.headers.set("Set-Cookie", newCookieStr);
      return res;
    }

    const res = NextResponse.json({
       ...result,
       remainingGenerations: reservation.remainingGenerations,
    }, { status: 200 });
    if (newCookieStr) res.headers.set("Set-Cookie", newCookieStr);
    return res;
  } catch (err) {
    if (reservation.reservationId) {
      await reconcileUsage(visitorId, reservation.reservationId, 0, 0, actualModel, false);
    }
    const message = sanitizeGenerationErrorMessage(
      err instanceof Error ? err.message : String(err)
    );
    const res = NextResponse.json(
      {
        error: "Generation failed",
        message,
        classification: null,
        availableCrops: [],
        proposals: [],
        supportStatus: "unavailable",
        remainingGenerations: reservation.remainingGenerations,
      },
      { status: 500 }
    );
    if (newCookieStr) res.headers.set("Set-Cookie", newCookieStr);
    return res;
  }
}