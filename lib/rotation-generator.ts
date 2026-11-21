/**
 * AI-assisted rotation generation orchestrator for fallo.
 *
 * Responsibilities:
 * 1. Classify field into agricultural group.
 * 2. Filter crop catalog by group + region.
 * 3. Build a structured prompt for an AI provider.
 * 4. Parse and validate AI response with Zod.
 * 5. Score accepted proposals using the deterministic engine.
 *
 * This module does NOT contain runtime AI provider credentials.
 * The actual network call to an LLM lives in the API route, which checks
 * process.env for provider configuration.
 */

import { z } from "zod";
import { ThinkingLevel, type GoogleGenAIOptions } from "@google/genai";
import { getVercelOidcToken } from "@vercel/oidc";
import {
  ExternalAccountClient,
  type BaseExternalAccountClient,
} from "google-auth-library";
import { normalizeLongitude } from "@/lib/coordinates";
import {
  GLOBAL_REGION_TAGS,
  resolveGeographicContext,
  type GeographicContext,
} from "@/lib/region";
import {
  type ClimateData,
  type SoilData,
  type FarmerPriorities,
  type RotationStrategy,
  type StrategyResult,
  type AIUsageMetadata,
  type CropEvidenceLevel,
  DEFAULT_AI_TIMEOUT_MS,
  cropLibrary,
  scoreStrategy,
  rankStrategyResults,
  getAvailableCropsForContext,
  evaluateFieldCropEvidenceLevel,
  buildFieldSpecificObjectives,
} from "@/lib/rotation-scoring";
import {
  classifyAgGroup,
  isGroupSupported,
  type AgGroup,
  type ClassificationResult,
} from "@/lib/agro-classifier";
import {
  validateProposal,
  formatCompatibilityRulesForPrompt,
  type ValidationContext,
} from "@/lib/rotation-validator";

// ─── Request validation schemas (shared with API route) ───────────────

const NullableFiniteNumberSchema = z.number().finite().nullable();
const MonthlyArraySchema = z.array(NullableFiniteNumberSchema).length(12);

const NormalizedLongitudeSchema = z
  .number()
  .finite()
  .transform((val) => normalizeLongitude(val) ?? val);

export const ClimateDataSchema = z.object({
  location: z.object({
    lat: z.number().finite().min(-90).max(90),
    lon: NormalizedLongitudeSchema,
    elevation: NullableFiniteNumberSchema,
  }),
  fullRecord: z.object({
    avgAnnualTemp: NullableFiniteNumberSchema,
    avgAnnualPrecip: NullableFiniteNumberSchema,
    avgDailySolar: NullableFiniteNumberSchema,
    monthlyTemp: MonthlyArraySchema,
    monthlyPrecip: MonthlyArraySchema,
    monthlySolar: MonthlyArraySchema,
  }),
  stressMetrics: z.object({
    summerDrySpells: z.object({
      avgMaxConsecutiveDryDays: NullableFiniteNumberSchema,
      thresholdMm: z.number().finite(),
      monthsDesc: z.string().min(1),
    }),
    summerHeatDays: z.object({
      avgDaysAboveThreshold: NullableFiniteNumberSchema,
      thresholdC: z.number().finite(),
      monthsDesc: z.string().min(1),
    }),
    springPrecip: z.object({
      avgTotalMm: NullableFiniteNumberSchema,
      monthsDesc: z.string().min(1),
    }),
    growingSeasonPrecip: z.object({
      avgTotalMm: NullableFiniteNumberSchema,
      monthsDesc: z.string().min(1),
    }),
  }),
  source: z.string().min(1),
  spatialResolution: z.string().min(1),
  limitations: z.array(z.string()),
});

const DepthPropertiesSchema = z.object({
  sand: NullableFiniteNumberSchema,
  silt: NullableFiniteNumberSchema,
  clay: NullableFiniteNumberSchema,
  om: NullableFiniteNumberSchema,
  ph: NullableFiniteNumberSchema,
  awc: NullableFiniteNumberSchema,
});

export const SoilDataSchema = z
  .object({
    aggregated: z.object({
      depth0_30cm: DepthPropertiesSchema,
      drainage: z.string().nullable(),
      slope: NullableFiniteNumberSchema,
    }),
    dataCoverage: z.object({
      depth0_30cm: DepthPropertiesSchema,
      drainage: NullableFiniteNumberSchema,
      slope: NullableFiniteNumberSchema,
    }),
    totalComponentPercent: z.number().finite().min(0).max(200),
    source: z.string().min(1),
    limitations: z.array(z.string()),
  })
  .nullable();

const PrioritySliderValueSchema = z.number().finite().min(0).max(100);

export const FarmerPrioritiesSchema = z.object({
  waterSuitability: PrioritySliderValueSchema,
  nitrogenContribution: PrioritySliderValueSchema,
  soilCoverage: PrioritySliderValueSchema,
  diversityPestBreak: PrioritySliderValueSchema,
  climateRiskResilience: PrioritySliderValueSchema,
});

export const RegionTagSchema = z.enum(GLOBAL_REGION_TAGS).nullable();

export const GenerationRequestSchema = z.object({
  fieldId: z.string().trim().min(1),
  fieldName: z.string().trim().min(1),
  lat: z.number().finite().min(-90).max(90),
  lon: NormalizedLongitudeSchema,
  climate: ClimateDataSchema,
  soil: SoilDataSchema,
  priorities: FarmerPrioritiesSchema,
  regionTag: RegionTagSchema,
});

// ─── Zod schemas for structured AI output ─────────────────────────────

const RotationSeasonSchema = z.object({
  season: z.string().min(1),
  crop: z.string().min(1),
  activity: z.string().min(1),
  months: z.array(z.number().int().min(1).max(12)).min(1),
});

const RotationYearSchema = z.object({
  year: z.number().int().min(1).max(3),
  seasons: z.array(RotationSeasonSchema).min(1).max(4),
});

const TradeoffsSchema = z.object({
  advantages: z.array(z.string()),
  disadvantages: z.array(z.string()),
  operational: z.array(z.string()),
  warnings: z.array(
    z.union([z.string(), z.object({ severity: z.enum(["high", "moderate"]), text: z.string() })])
  ),
});

const AIFallbackStrategySchema = z.object({
  id: z.string().regex(/^[a-z_]+$/),
  name: z.string().min(3).max(80),
  archetype: z.string().min(3).max(40),
  description: z.string().min(20).max(500),
  regionExample: z.string().optional(),
  years: z.array(RotationYearSchema).length(3),
  tradeoffs: TradeoffsSchema,
});

export const AIProposalSchema = z.object({
  strategies: z.array(AIFallbackStrategySchema).min(1).max(3),
  rationale: z.string().min(1).max(800),
});

export type AIProposal = z.infer<typeof AIProposalSchema>;

// ─── Types ────────────────────────────────────────────────────────────

export interface GenerationContext {
  fieldId: string;
  fieldName: string;
  lat: number;
  lon: number;
  climate: ClimateData;
  soil: SoilData | null;
  priorities: FarmerPriorities;
  regionTag: string | null;
}

export interface RejectedProposalInfo {
  id: string;
  name: string;
  errors: string[];
  warnings: string[];
}

export interface GenerationResult {
  classification: {
    group: AgGroup;
    confidence: string;
    reasons: string[];
    inputsUsed: string[];
    limitations: string[];
    evidenceLevel?: CropEvidenceLevel;
    waterRegime?: string;
    dominantSeasonality?: string;
    gaezThermalZone?: string;
    gaezMoistureZone?: string;
    estimatedLgpDays?: number | null;
  };
  geography?: GeographicContext;
  evidenceLevel?: CropEvidenceLevel;
  evidenceSummary?: string;
  availableCrops: string[];
  proposals: StrategyResult[];
  rejectedProposals?: RejectedProposalInfo[];
  rationale?: string;
  supportStatus: "supported" | "limited-evidence" | "unavailable";
  aiUnavailableReason?: string;
  aiProvider?: string;
  aiModel?: string;
  generatedAt?: string;
  usageMetadata?: AIUsageMetadata;
  retryCount?: number;
  remainingGenerations?: number;
}

export interface AIProviderClient {
  generate(props: {
    prompt: string;
    maxTokens?: number;
    signal?: AbortSignal;
    timeoutMs?: number;
    requestId?: string;
  }): Promise<string>;
  providerName: string;
  modelName?: string;
  lastUsageMetadata?: AIUsageMetadata;
}

export { DEFAULT_AI_TIMEOUT_MS };
export const DEFAULT_GEMINI_MAX_OUTPUT_TOKENS = 3500;
export const DEFAULT_GEMINI_MODEL = "gemini-3.8-flash";
export const DEFAULT_GEMINI_ENTERPRISE_MODEL = "gemini-4-argon";
export const DEFAULT_GOOGLE_CLOUD_LOCATION = "global";

export const GCP_STS_TOKEN_URL = "https://sts.googleapis.com/v1/token";
export const GCP_SUBJECT_TOKEN_TYPE_JWT = "urn:ietf:params:oauth:token-type:jwt";

export const REQUIRED_VERCEL_WIF_ENV_VARS = [
  "GCP_PROJECT_NUMBER",
  "GCP_SERVICE_ACCOUNT_EMAIL",
  "GCP_WORKLOAD_IDENTITY_POOL_ID",
  "GCP_WORKLOAD_IDENTITY_POOL_PROVIDER_ID",
] as const;

export interface VercelWifConfig {
  projectNumber: string;
  serviceAccountEmail: string;
  workloadIdentityPoolId: string;
  workloadIdentityPoolProviderId: string;
}

export type OidcTokenSupplier = () => Promise<string>;
export type GeminiAuthMode = "adc" | "vercel-oidc-wif";

/**
 * Build the Google Cloud Workload Identity Federation provider audience string:
 * `//iam.googleapis.com/projects/PROJECT_NUMBER/locations/global/workloadIdentityPools/POOL_ID/providers/PROVIDER_ID`
 */
export function buildVercelWifAudience(
  config: Pick<
    VercelWifConfig,
    "projectNumber" | "workloadIdentityPoolId" | "workloadIdentityPoolProviderId"
  >
): string {
  return `//iam.googleapis.com/projects/${config.projectNumber.trim()}/locations/global/workloadIdentityPools/${config.workloadIdentityPoolId.trim()}/providers/${config.workloadIdentityPoolProviderId.trim()}`;
}

/**
 * Build the standard Google Cloud IAM Credentials service-account impersonation URL.
 */
export function buildServiceAccountImpersonationUrl(serviceAccountEmail: string): string {
  return `https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/${serviceAccountEmail.trim()}:generateAccessToken`;
}

/**
 * Detect whether the application is running in a deployed Vercel environment
 * (production or preview). Returns `false` in local development (including when
 * `VERCEL_ENV="development"` from `vercel env pull` or `vercel dev`), preserving
 * local Google Cloud Application Default Credentials (ADC).
 */
export function isVercelDeploymentEnvironment(
  env: Record<string, string | undefined> = process.env
): boolean {
  const vercelEnv = env.VERCEL_ENV?.trim().toLowerCase();
  if (vercelEnv === "development") {
    return false;
  }
  if (vercelEnv === "production" || vercelEnv === "preview") {
    return true;
  }
  const vercelFlag = env.VERCEL?.trim().toLowerCase();
  return vercelFlag === "1" || vercelFlag === "true";
}

/**
 * Return any missing Workload Identity Federation environment variable names.
 */
export function getMissingVercelWifEnvVars(
  env: Record<string, string | undefined> = process.env
): string[] {
  return REQUIRED_VERCEL_WIF_ENV_VARS.filter((key) => !env[key]?.trim());
}

/**
 * Redact any accidental OAuth2 access tokens, OIDC JWTs, or Bearer tokens from error strings.
 */
export function sanitizeGenerationErrorMessage(
  rawMessage: string | null | undefined,
  fallback = "We couldn't finish generating your plans. Please try again later."
): string {
  const trimmed = (rawMessage ?? "").trim();
  if (!trimmed) return fallback;
  return trimmed
    .replace(/AIza[0-9A-Za-z-_]{35}/g, "[REDACTED_API_KEY]")
    .replace(/ya29\.[A-Za-z0-9._-]+/g, "[REDACTED_TOKEN]")
    .replace(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, "[REDACTED_OIDC_TOKEN]")
    .replace(/Bearer\s+[A-Za-z0-9._-]+/gi, "Bearer [REDACTED]");
}

/**
 * Build a clear, environment-aware explanation when `resolveRuntimeAIProvider(env)` returns `null`.
 * Distinguishes:
 * 1. Explicit `FALLO_AI_ENABLED=false`
 * 2. Vercel Preview deployments (`VERCEL_ENV="preview"`), where Production Google Cloud WIF
 *    credentials are intentionally not exposed
 * 3. Vercel Production deployments (`VERCEL_ENV="production"` or `VERCEL="1"`), listing any
 *    missing Production WIF or project variables
 * 4. Local development (`localhost`), explaining `.env.local` and Google Cloud ADC setup
 */
export function describeMissingAIProviderReason(
  env: Record<string, string | undefined> = process.env
): string {
  const aiEnabledRaw = env.FALLO_AI_ENABLED?.trim().toLowerCase();
  if (aiEnabledRaw === "false" || aiEnabledRaw === "0") {
    return "SI rotation generation is disabled because FALLO_AI_ENABLED is set to false. Set FALLO_AI_ENABLED=true and configure GEMINI_API_KEY / FALLO_AI_PROVIDER / GOOGLE_CLOUD_PROJECT to enable AI-assisted rotation generation.";
  }

  const vercelEnv = env.VERCEL_ENV?.trim().toLowerCase();
  if (vercelEnv === "preview") {
    const missingWif = getMissingVercelWifEnvVars(env);
    const missingNote =
      missingWif.length > 0
        ? ` (missing in Preview: ${missingWif.join(", ")})`
        : "";
    return `SI rotation generation is not enabled on Vercel Preview deployments because Google Cloud Workload Identity Federation and Gemini Enterprise credentials (FALLO_AI_PROVIDER, GOOGLE_CLOUD_PROJECT, GCP_*) are scoped to the Production environment${missingNote} and local development (via Google Cloud ADC). To run on Preview deployments, configure GEMINI_API_KEY, or use Preview deployments to verify UI, Climate, Soil, What-If Simulator, Field Calendar, and Climate Analogues, and run live SI rotation generation on localhost or Vercel Production.`;
  }

  if (isVercelDeploymentEnvironment(env)) {
    const missingVars: string[] = [];
    if (!env.GOOGLE_CLOUD_PROJECT?.trim()) {
      missingVars.push("GOOGLE_CLOUD_PROJECT");
    }
    for (const wifKey of getMissingVercelWifEnvVars(env)) {
      missingVars.push(wifKey);
    }
    const missingSuffix =
      missingVars.length > 0
        ? ` Missing Vercel OIDC Workload Identity Federation environment variables: ${missingVars.join(", ")}.`
        : "";
    return `No runtime AI provider is configured for this Vercel deployment. Set GEMINI_API_KEY in your Vercel Project Environment Variables, or set GOOGLE_GENAI_USE_ENTERPRISE=true, GOOGLE_CLOUD_PROJECT, GOOGLE_CLOUD_LOCATION, and FALLO_AI_PROVIDER=gemini-enterprise along with Vercel OIDC Workload Identity Federation variables.${missingSuffix}`;
  }

  return "No runtime AI provider is configured. Set GEMINI_API_KEY in your .env.local file, or configure GOOGLE_GENAI_USE_ENTERPRISE=true, GOOGLE_CLOUD_PROJECT, and GOOGLE_CLOUD_LOCATION (with Application Default Credentials via `gcloud auth application-default login`), or set FALLO_AI_PROVIDER, to enable AI-assisted rotation generation.";
}

/**
 * Resolve Google Cloud Workload Identity Federation configuration from environment variables.
 * Returns `null` if any required variable is missing.
 */
export function resolveVercelWifConfig(
  env: Record<string, string | undefined> = process.env
): VercelWifConfig | null {
  const projectNumber = env.GCP_PROJECT_NUMBER?.trim();
  const serviceAccountEmail = env.GCP_SERVICE_ACCOUNT_EMAIL?.trim();
  const workloadIdentityPoolId = env.GCP_WORKLOAD_IDENTITY_POOL_ID?.trim();
  const workloadIdentityPoolProviderId =
    env.GCP_WORKLOAD_IDENTITY_POOL_PROVIDER_ID?.trim();

  if (
    !projectNumber ||
    !serviceAccountEmail ||
    !workloadIdentityPoolId ||
    !workloadIdentityPoolProviderId
  ) {
    return null;
  }

  return {
    projectNumber,
    serviceAccountEmail,
    workloadIdentityPoolId,
    workloadIdentityPoolProviderId,
  };
}

/**
 * Create a Google Cloud `ExternalAccountClient` via `ExternalAccountClient.fromJSON`
 * configured for Vercel OIDC + Workload Identity Federation and service-account impersonation.
 *
 * Uses `subject_token_supplier` with `getSubjectToken` calling `getVercelOidcToken()`
 * lazily when the client exchanges tokens at runtime.
 */
export function createVercelWifExternalAccountClient(
  config: VercelWifConfig,
  oidcTokenSupplier: OidcTokenSupplier = getVercelOidcToken
): BaseExternalAccountClient {
  const projectNumber = config.projectNumber?.trim();
  const serviceAccountEmail = config.serviceAccountEmail?.trim();
  const workloadIdentityPoolId = config.workloadIdentityPoolId?.trim();
  const workloadIdentityPoolProviderId = config.workloadIdentityPoolProviderId?.trim();

  if (
    !projectNumber ||
    !serviceAccountEmail ||
    !workloadIdentityPoolId ||
    !workloadIdentityPoolProviderId
  ) {
    throw new Error(
      "Incomplete Google Cloud Workload Identity Federation configuration. Required: GCP_PROJECT_NUMBER, GCP_SERVICE_ACCOUNT_EMAIL, GCP_WORKLOAD_IDENTITY_POOL_ID, and GCP_WORKLOAD_IDENTITY_POOL_PROVIDER_ID."
    );
  }

  const audience = buildVercelWifAudience({
    projectNumber,
    workloadIdentityPoolId,
    workloadIdentityPoolProviderId,
  });
  const serviceAccountImpersonationUrl =
    buildServiceAccountImpersonationUrl(serviceAccountEmail);

  const authClient = ExternalAccountClient.fromJSON({
    type: "external_account",
    audience,
    subject_token_type: GCP_SUBJECT_TOKEN_TYPE_JWT,
    token_url: GCP_STS_TOKEN_URL,
    service_account_impersonation_url: serviceAccountImpersonationUrl,
    subject_token_supplier: {
      getSubjectToken: () => oidcTokenSupplier(),
    },
  });

  if (!authClient) {
    throw new Error(
      "Failed to initialize Google Cloud ExternalAccountClient from Workload Identity Federation configuration."
    );
  }

  return authClient;
}

export type GeminiThinkingLevel = "LOW" | "MEDIUM" | "HIGH";
export const DEFAULT_GEMINI_THINKING_LEVEL: GeminiThinkingLevel = "LOW";

export function parseGeminiThinkingLevel(raw?: string): GeminiThinkingLevel {
  if (!raw || !raw.trim()) return DEFAULT_GEMINI_THINKING_LEVEL;
  const upper = raw.trim().toUpperCase();
  if (upper === "LOW" || upper === "MEDIUM" || upper === "HIGH") {
    return upper;
  }
  throw new Error(
    `Unsupported Gemini 4 Argon thinkingLevel "${raw}". Allowed values are LOW, MEDIUM, or HIGH (MINIMAL and thinkingBudget are not supported).`
  );
}

export interface GeminiUsageMetadata {
  promptTokenCount?: number;
  candidatesTokenCount?: number;
  thoughtsTokenCount?: number;
  totalTokenCount?: number;
}

export interface GeminiGenerateContentRequest {
  model: string;
  contents: string;
  config?: {
    systemInstruction?: string;
    thinkingConfig?: {
      thinkingLevel?: ThinkingLevel;
    };
    maxOutputTokens?: number;
    responseMimeType?: string;
    abortSignal?: AbortSignal;
    httpOptions?: {
      timeout?: number;
      retryOptions?: {
        attempts?: number;
      };
    };
  };
}

export interface GeminiGenerateContentResponse {
  text?: string;
  usageMetadata?: GeminiUsageMetadata;
}

export interface GeminiClientLike {
  models: {
    generateContent: (params: any) => Promise<any>;
  };
  interactions?: {
    create: (params: any, options?: any) => Promise<any>;
  };
}

export type GeminiClientFactory = (
  options: GoogleGenAIOptions
) => GeminiClientLike | Promise<GeminiClientLike>;

/**
 * Official `@google/genai` provider for Google's Gemini Developer API.
 *
 * Authenticates directly with the Gemini Developer API via `process.env.GEMINI_API_KEY`.
 * - No Google Cloud project, IAM, Workload Identity Federation, or billing account required.
 * - Free-tier friendly with standard Gemini Developer API limits.
 * - Configurable model via `GEMINI_MODEL` (defaults to "gemini-2.5-flash").
 * - Surfaces clear quota-exceeded (429 / RESOURCE_EXHAUSTED) and authentication errors.
 * - Redacts Google API keys (`AIza...`) and OAuth tokens from all error messages.
 * - Disables SDK automatic retries (`retryOptions: { attempts: 1 }`) to maintain responsive timeouts.
 * - Propagates `AbortSignal` and timeout (default 120,000 ms) to the underlying request.
 */
export class GeminiDeveloperProvider implements AIProviderClient {
  providerName: string;
  modelName: string;
  lastUsageMetadata?: AIUsageMetadata;
  readonly apiKey: string;
  readonly model: string;
  private defaultTimeoutMs: number;
  private clientFactory: GeminiClientFactory;

  constructor(opts: {
    providerName?: string;
    apiKey: string;
    model?: string;
    timeoutMs?: number;
    clientFactory?: GeminiClientFactory;
  }) {
    const trimmedApiKey = opts.apiKey?.trim();
    if (!trimmedApiKey) {
      throw new Error(
        "GeminiDeveloperProvider requires a non-empty Gemini API key (GEMINI_API_KEY)."
      );
    }
    this.providerName = opts.providerName ?? "gemini";
    this.apiKey = trimmedApiKey;
    this.model = opts.model?.trim() || DEFAULT_GEMINI_MODEL;
    this.modelName = this.model;
    this.defaultTimeoutMs = opts.timeoutMs ?? DEFAULT_AI_TIMEOUT_MS;
    this.clientFactory =
      opts.clientFactory ??
      (async (sdkOptions: GoogleGenAIOptions) => {
        const { GoogleGenAI } = await import("@google/genai");
        return new GoogleGenAI(sdkOptions);
      });
  }

  private sanitizeErrorMessage(raw: string): string {
    return raw
      .replace(/AIza[0-9A-Za-z-_]{35}/g, "[REDACTED_API_KEY]")
      .replace(/ya29\.[A-Za-z0-9._-]+/g, "[REDACTED_TOKEN]")
      .replace(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, "[REDACTED_OIDC_TOKEN]")
      .replace(/Bearer\s+[A-Za-z0-9._-]+/gi, "Bearer [REDACTED]");
  }

  private isQuotaOrRateLimitError(msg: string): boolean {
    const lower = msg.toLowerCase();
    return (
      lower.includes("429") ||
      lower.includes("resource_exhausted") ||
      lower.includes("quota exceeded") ||
      lower.includes("rate limit") ||
      lower.includes("too many requests") ||
      lower.includes("queries per minute") ||
      lower.includes("tokens per minute") ||
      lower.includes("exceeded your current quota")
    );
  }

  private isAuthError(msg: string): boolean {
    const lower = msg.toLowerCase();
    return (
      lower.includes("api_key_invalid") ||
      lower.includes("api key not valid") ||
      lower.includes("invalid api key") ||
      lower.includes("unauthenticated") ||
      lower.includes("permission_denied") ||
      lower.includes("status: 401") ||
      lower.includes("code: 401") ||
      lower.includes("status: 403") ||
      lower.includes("code: 403")
    );
  }

  private extractUsageMetadata(raw?: GeminiUsageMetadata | any): AIUsageMetadata | undefined {
    if (!raw) return undefined;

    const promptCount = raw.promptTokenCount ?? raw.total_input_tokens;
    const candidatesCount = raw.candidatesTokenCount ?? raw.total_output_tokens;
    const totalCount = raw.totalTokenCount ?? raw.total_tokens;
    const thoughtsCount = raw.thoughtsTokenCount ?? raw.total_thought_tokens;

    const hasAnyCount =
      typeof promptCount === "number" ||
      typeof candidatesCount === "number" ||
      typeof thoughtsCount === "number" ||
      typeof totalCount === "number";

    if (!hasAnyCount) return undefined;
    return {
      promptTokenCount: promptCount,
      candidatesTokenCount: candidatesCount,
      thoughtsTokenCount: thoughtsCount,
      totalTokenCount: totalCount,
      estimatedCostUsd: null,
    };
  }

  async generate({
    prompt,
    maxTokens = DEFAULT_GEMINI_MAX_OUTPUT_TOKENS,
    signal,
    timeoutMs = this.defaultTimeoutMs,
    requestId,
  }: {
    prompt: string;
    maxTokens?: number;
    signal?: AbortSignal;
    timeoutMs?: number;
    requestId?: string;
  }): Promise<string> {
    const reqIdStr = requestId ? ` [Req: ${requestId}]` : "";
    this.lastUsageMetadata = undefined;
    const controller = new AbortController();
    let timedOut = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const timeoutPromise = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        timedOut = true;
        controller.abort();
        const err = new Error("Timeout");
        err.name = "TimeoutError";
        reject(err);
      }, timeoutMs);
    });

    const onExternalAbort = () => {
      controller.abort();
    };

    if (signal) {
      if (signal.aborted) {
        if (timer) clearTimeout(timer);
        throw new Error(`AI provider (${this.providerName}) request was aborted.`);
      }
      signal.addEventListener("abort", onExternalAbort, { once: true });
    }

    const httpOptions = {
      timeout: timeoutMs,
      retryOptions: {
        attempts: 1, // Let our custom loop handle retries
      },
    };

    try {
      const sdkOptions: GoogleGenAIOptions = {
        apiKey: this.apiKey,
        // Explicitly disable Vertex AI flags so the SDK routes to generativelanguage.googleapis.com
        // even when GOOGLE_GENAI_USE_ENTERPRISE=true or GOOGLE_GENAI_USE_VERTEXAI=true is present
        // in the environment (e.g. from a legacy .env.local or ADC configuration).
        enterprise: false,
        vertexai: false,
        httpOptions,
      };
      const client = await this.clientFactory(sdkOptions);

      let response: any;
      let lastErr: unknown;
      let baseDelayMs = 1000;
      const maxAttempts = 4;

      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        if (signal?.aborted) {
          throw new Error(`AI provider (${this.providerName}) request was aborted.`);
        }
        const attemptStart = Date.now();
        console.log(`[Rotations API]${reqIdStr} Gemini request attempt ${attempt}/${maxAttempts} started`);
        
        try {
          response = (await Promise.race([
            client.interactions!.create(
              {
                model: this.model,
                input:
                  "Generate 3 field-specific 3-year crop rotation strategies (soil_health, water_resilience, crop_diversity) as JSON matching the required schema.",
                system_instruction: prompt,
                response_format: {
                  type: "object",
                  properties: {
                    strategies: {
                      type: "array",
                      items: {
                        type: "object",
                        properties: {
                          id: { type: "string" },
                          name: { type: "string" },
                          archetype: { type: "string" },
                          description: { type: "string" },
                          regionExample: { type: "string" },
                          years: {
                            type: "array",
                            items: {
                              type: "object",
                              properties: {
                                year: { type: "integer" },
                                seasons: {
                                  type: "array",
                                  items: {
                                    type: "object",
                                    properties: {
                                      season: { type: "string" },
                                      crop: { type: "string" },
                                      activity: { type: "string" },
                                      months: { type: "array", items: { type: "integer" } }
                                    },
                                    required: ["season", "crop", "activity", "months"]
                                  }
                                }
                              },
                              required: ["year", "seasons"]
                            }
                          },
                          tradeoffs: {
                            type: "object",
                            properties: {
                              advantages: { type: "array", items: { type: "string" } },
                              disadvantages: { type: "array", items: { type: "string" } },
                              operational: { type: "array", items: { type: "string" } },
                              warnings: { type: "array", items: { type: "string" } }
                            },
                            required: ["advantages", "disadvantages", "operational", "warnings"]
                          }
                        },
                        required: ["id", "name", "archetype", "description", "years", "tradeoffs"]
                      }
                    },
                    rationale: { type: "string" }
                  },
                  required: ["strategies", "rationale"]
                },
                generation_config: {
                  max_output_tokens: maxTokens,
                },
              },
              {
                signal: controller.signal,
                httpOptions,
              }
            ),
            timeoutPromise,
          ])) as any;
          
          console.log(`[Rotations API]${reqIdStr} Gemini request attempt ${attempt} succeeded in ${Date.now() - attemptStart}ms`);
          lastErr = null;
          break; // Success
        } catch (err) {
          lastErr = err;
          const msg = err instanceof Error ? err.message : String(err);
          const statusMatch = msg.match(/(?:status|code):?\s*(\d+)/i) || msg.match(/HTTP\s*(\d+)/i) || err instanceof Error && (err as any).status;
          const status = statusMatch && typeof statusMatch !== 'number' ? parseInt(statusMatch[1] as string, 10) : typeof statusMatch === 'number' ? statusMatch : undefined;
          
          console.log(`[Rotations API]${reqIdStr} Gemini request attempt ${attempt} failed in ${Date.now() - attemptStart}ms. Status: ${status ?? 'unknown'}. Error: ${this.sanitizeErrorMessage(msg)}`);
          // Retry ONLY on transient errors: 503 (Service Unavailable / Overloaded), 500 (Internal), 502, 504, or generic transient network fails
          const isTransient5xx = status && status >= 500 && status <= 599;
          const isFetchFailed = msg.includes("fetch failed") || msg.includes("ECONNRESET") || msg.includes("ETIMEDOUT");
          
          if ((isTransient5xx || isFetchFailed) && attempt < maxAttempts && !timedOut && !signal?.aborted) {
            // Extract Retry-After if present
            let retryAfterS = 0;
            if (err instanceof Error && 'headers' in err) {
              const headers = (err as any).headers;
              if (headers && typeof headers.get === 'function') {
                const ra = headers.get("retry-after");
                if (ra) retryAfterS = parseInt(ra, 10);
              }
            }
            
            const delayMs = retryAfterS > 0 ? retryAfterS * 1000 : baseDelayMs + Math.random() * 500;
            console.log(`[Rotations API]${reqIdStr} Retrying Gemini request in ${delayMs.toFixed(0)}ms...`);
            const sleepPromise = new Promise<void>((res) => {
              const sleepTimer = setTimeout(res, delayMs);
              const onAbort = () => { clearTimeout(sleepTimer); res(); };
              signal?.addEventListener("abort", onAbort, { once: true });
              controller.signal.addEventListener("abort", onAbort, { once: true });
            });
            await Promise.race([sleepPromise, timeoutPromise]);
            baseDelayMs *= 2;
            continue;
          }
          break; // Don't retry auth, 429 quota, or unhandled errors
        }
      }

      if (lastErr) {
        throw lastErr;
      }

      this.lastUsageMetadata = this.extractUsageMetadata(response?.usage);

      const content = response?.output_text?.trim();
      if (!content) {
        throw new Error("Empty response from Gemini Developer API provider.");
      }
      return content;
    } catch (err) {
      if (timedOut || (err instanceof Error && err.name === "TimeoutError")) {
        throw new Error(
          `AI provider (${this.providerName}) request timed out after ${timeoutMs}ms.`
        );
      }
      if (signal?.aborted || (err instanceof Error && err.name === "AbortError")) {
        throw new Error(`AI provider (${this.providerName}) request was aborted.`);
      }
      const rawMessage = err instanceof Error ? err.message : String(err);
      const safeMessage = this.sanitizeErrorMessage(rawMessage);

      if (this.isQuotaOrRateLimitError(safeMessage)) {
        throw new Error(
          `Gemini API quota or rate limit exceeded for model "${this.model}". If you are on the free tier, please wait a minute before generating again, or check your quota in Google AI Studio.`
        );
      }

      if (this.isAuthError(safeMessage)) {
        throw new Error(
          `Gemini API authentication failed for model "${this.model}": ${safeMessage}. Please check that GEMINI_API_KEY is valid in your environment variables (.env.local or Vercel).`
        );
      }

      throw new Error(safeMessage);
    } finally {
      if (timer) clearTimeout(timer);
      if (signal) {
        signal.removeEventListener("abort", onExternalAbort);
      }
    }
  }
}

/**
 * Official `@google/genai` provider for Google Cloud's Gemini Enterprise Agent Platform.
 *
 * Supports two server-side authentication modes (resolved lazily at runtime):
 * 1. Local development (`authMode: "adc"`): Uses Application Default Credentials (ADC)
 *    via `new GoogleGenAI({ enterprise: true, project, location, httpOptions })`.
 * 2. Deployed Vercel environment (`authMode: "vercel-oidc-wif"`): Uses Vercel OIDC
 *    (`getVercelOidcToken`) and Google Cloud Workload Identity Federation
 *    (`ExternalAccountClient.fromJSON`) passed via `googleAuthOptions: { authClient, projectId }`.
 *
 * Configured specifically for `gemini-4-argon`:
 * - Uses `thinkingConfig: { thinkingLevel: "LOW" }` by default for responsive structured output.
 * - Omits unsupported/ignored sampling parameters (`temperature`, `topP`, `topK`, `thinkingBudget`).
 * - Disables SDK automatic retries (`retryOptions: { attempts: 1 }`) to prevent duplicate billing.
 * - Propagates `AbortSignal` and `httpOptions.timeout` (default 120,000 ms) to the underlying request.
 */
export class GeminiEnterpriseProvider implements AIProviderClient {
  providerName: string;
  modelName: string;
  lastUsageMetadata?: AIUsageMetadata;
  readonly project: string;
  readonly location: string;
  readonly model: string;
  readonly enterprise: boolean;
  readonly thinkingLevel: GeminiThinkingLevel;
  readonly authMode: GeminiAuthMode;
  readonly wifConfig?: VercelWifConfig;
  private defaultTimeoutMs: number;
  private clientFactory: GeminiClientFactory;
  private oidcTokenSupplier: OidcTokenSupplier;

  constructor(opts: {
    providerName?: string;
    project: string;
    location?: string;
    model?: string;
    enterprise?: boolean;
    thinkingLevel?: GeminiThinkingLevel | string;
    timeoutMs?: number;
    wifConfig?: VercelWifConfig;
    oidcTokenSupplier?: OidcTokenSupplier;
    clientFactory?: GeminiClientFactory;
  }) {
    const trimmedProject = opts.project?.trim();
    if (!trimmedProject) {
      throw new Error(
        "GeminiEnterpriseProvider requires a non-empty Google Cloud project ID (GOOGLE_CLOUD_PROJECT)."
      );
    }
    this.providerName = opts.providerName ?? "gemini-enterprise";
    this.project = trimmedProject;
    this.location = opts.location?.trim() || DEFAULT_GOOGLE_CLOUD_LOCATION;
    this.model = opts.model?.trim() || DEFAULT_GEMINI_ENTERPRISE_MODEL;
    this.modelName = this.model;
    this.enterprise = opts.enterprise ?? true;
    this.thinkingLevel = parseGeminiThinkingLevel(opts.thinkingLevel);
    this.defaultTimeoutMs = opts.timeoutMs ?? DEFAULT_AI_TIMEOUT_MS;
    if (opts.wifConfig) {
      const projectNumber = opts.wifConfig.projectNumber?.trim();
      const serviceAccountEmail = opts.wifConfig.serviceAccountEmail?.trim();
      const workloadIdentityPoolId = opts.wifConfig.workloadIdentityPoolId?.trim();
      const workloadIdentityPoolProviderId =
        opts.wifConfig.workloadIdentityPoolProviderId?.trim();
      if (
        !projectNumber ||
        !serviceAccountEmail ||
        !workloadIdentityPoolId ||
        !workloadIdentityPoolProviderId
      ) {
        throw new Error(
          "GeminiEnterpriseProvider wifConfig requires non-empty projectNumber, serviceAccountEmail, workloadIdentityPoolId, and workloadIdentityPoolProviderId."
        );
      }
      this.authMode = "vercel-oidc-wif";
      this.wifConfig = {
        projectNumber,
        serviceAccountEmail,
        workloadIdentityPoolId,
        workloadIdentityPoolProviderId,
      };
    } else {
      this.authMode = "adc";
      this.wifConfig = undefined;
    }
    this.oidcTokenSupplier = opts.oidcTokenSupplier ?? getVercelOidcToken;
    this.clientFactory =
      opts.clientFactory ??
      (async (sdkOptions: GoogleGenAIOptions) => {
        const { GoogleGenAI } = await import("@google/genai");
        return new GoogleGenAI(sdkOptions);
      });
  }

  private sanitizeErrorMessage(raw: string): string {
    // Redact any accidental OAuth2 access tokens, OIDC JWTs, or bearer tokens
    return raw
      .replace(/ya29\.[A-Za-z0-9._-]+/g, "[REDACTED_TOKEN]")
      .replace(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, "[REDACTED_OIDC_TOKEN]")
      .replace(/Bearer\s+[A-Za-z0-9._-]+/gi, "Bearer [REDACTED]");
  }

  private isAuthError(msg: string): boolean {
    const lower = msg.toLowerCase();
    return (
      lower.includes("could not load the default credentials") ||
      lower.includes("application default credentials") ||
      lower.includes("unauthenticated") ||
      lower.includes("permission_denied") ||
      lower.includes("permission denied") ||
      lower.includes("invalid_grant") ||
      lower.includes("invalid_target") ||
      lower.includes("invalid_client") ||
      lower.includes("unauthorized_client") ||
      lower.includes("subject token") ||
      lower.includes("vercel oidc") ||
      lower.includes("sts.googleapis.com") ||
      lower.includes("iamcredentials.googleapis.com") ||
      lower.includes("workloadidentitypools") ||
      lower.includes("reauth") ||
      lower.includes("status: 401") ||
      lower.includes("status: 403") ||
      lower.includes("code: 401") ||
      lower.includes("code: 403")
    );
  }

  private extractUsageMetadata(raw?: GeminiUsageMetadata | any): AIUsageMetadata | undefined {
    if (!raw) return undefined;

    const promptCount = raw.promptTokenCount ?? raw.total_input_tokens;
    const candidatesCount = raw.candidatesTokenCount ?? raw.total_output_tokens;
    const totalCount = raw.totalTokenCount ?? raw.total_tokens;
    const thoughtsCount = raw.thoughtsTokenCount ?? raw.total_thought_tokens;

    const hasAnyCount =
      typeof promptCount === "number" ||
      typeof candidatesCount === "number" ||
      typeof thoughtsCount === "number" ||
      typeof totalCount === "number";

    if (!hasAnyCount) return undefined;
    return {
      promptTokenCount: promptCount,
      candidatesTokenCount: candidatesCount,
      thoughtsTokenCount: thoughtsCount,
      totalTokenCount: totalCount,
      estimatedCostUsd: null,
    };
  }

  async generate({
    prompt,
    maxTokens = DEFAULT_GEMINI_MAX_OUTPUT_TOKENS,
    signal,
    timeoutMs = this.defaultTimeoutMs,
    requestId,
  }: {
    prompt: string;
    maxTokens?: number;
    signal?: AbortSignal;
    timeoutMs?: number;
    requestId?: string;
  }): Promise<string> {
    const reqIdStr = requestId ? ` [Req: ${requestId}]` : "";
    this.lastUsageMetadata = undefined;
    const controller = new AbortController();
    let timedOut = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const timeoutPromise = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        timedOut = true;
        controller.abort();
        const err = new Error("Timeout");
        err.name = "TimeoutError";
        reject(err);
      }, timeoutMs);
    });

    const onExternalAbort = () => {
      controller.abort();
    };

    if (signal) {
      if (signal.aborted) {
        if (timer) clearTimeout(timer);
        throw new Error(`AI provider (${this.providerName}) request was aborted.`);
      }
      signal.addEventListener("abort", onExternalAbort, { once: true });
    }

    const httpOptions = {
      timeout: timeoutMs,
      retryOptions: {
        attempts: 1,
      },
    };

    try {
      // Lazily instantiate ExternalAccountClient at runtime when in Vercel OIDC WIF mode
      const authClient =
        this.authMode === "vercel-oidc-wif" && this.wifConfig
          ? createVercelWifExternalAccountClient(this.wifConfig, this.oidcTokenSupplier)
          : undefined;

      const sdkOptions: GoogleGenAIOptions = {
        enterprise: this.enterprise,
        project: this.project,
        location: this.location,
        httpOptions,
        ...(authClient
          ? {
              googleAuthOptions: {
                authClient,
                projectId: this.project,
              },
            }
          : {}),
      };
      const client = await this.clientFactory(sdkOptions);

      const sdkLevel: ThinkingLevel =
        this.thinkingLevel === "HIGH"
          ? ThinkingLevel.HIGH
          : this.thinkingLevel === "MEDIUM"
            ? ThinkingLevel.MEDIUM
            : ThinkingLevel.LOW;

      const response = await Promise.race([
        client.models.generateContent({
          model: this.model,
          contents:
            "Generate 3 field-specific 3-year crop rotation strategies (soil_health, water_resilience, crop_diversity) as JSON matching the required schema.",
          config: {
            systemInstruction: prompt,
            thinkingConfig: {
              thinkingLevel: sdkLevel,
            },
            maxOutputTokens: maxTokens,
            responseMimeType: "application/json",
            abortSignal: controller.signal,
            httpOptions,
          },
        }),
        timeoutPromise,
      ]);

      this.lastUsageMetadata = this.extractUsageMetadata(response?.usageMetadata);

      const content = response?.text?.trim();
      if (!content) {
        throw new Error("Empty response from Gemini Enterprise provider.");
      }
      return content;
    } catch (err) {
      if (timedOut || (err instanceof Error && err.name === "TimeoutError")) {
        throw new Error(
          `AI provider (${this.providerName}) request timed out after ${timeoutMs}ms.`
        );
      }
      if (signal?.aborted || (err instanceof Error && err.name === "AbortError")) {
        throw new Error(`AI provider (${this.providerName}) request was aborted.`);
      }
      const rawMessage = err instanceof Error ? err.message : String(err);
      const safeMessage = this.sanitizeErrorMessage(rawMessage);
      if (this.isAuthError(safeMessage)) {
        if (this.authMode === "vercel-oidc-wif") {
          throw new Error(
            `Google Cloud Workload Identity Federation (Vercel OIDC) authentication failed for project "${this.project}" (${this.location}, model "${this.model}"): ${safeMessage}. Verify Vercel OIDC token issuance and GCP_PROJECT_NUMBER, GCP_SERVICE_ACCOUNT_EMAIL, GCP_WORKLOAD_IDENTITY_POOL_ID, and GCP_WORKLOAD_IDENTITY_POOL_PROVIDER_ID.`
          );
        }
        throw new Error(
          `Google Cloud ADC authentication failed for project "${this.project}" (${this.location}, model "${this.model}"): ${safeMessage}. Verify Application Default Credentials with "gcloud auth application-default login".`
        );
      }
      throw new Error(safeMessage);
    } finally {
      if (timer) clearTimeout(timer);
      if (signal) {
        signal.removeEventListener("abort", onExternalAbort);
      }
    }
  }
}

export interface ResolveRuntimeAIProviderOptions {
  geminiClientFactory?: GeminiClientFactory;
  oidcTokenSupplier?: OidcTokenSupplier;
}

/**
 * Resolve the configured runtime AI provider from environment variables.
 *
 * Primary provider: Google Gemini Developer API (`@google/genai`)
 * - Reads API key exclusively from `process.env.GEMINI_API_KEY` on the server.
 * - Configurable model via `process.env.GEMINI_MODEL` (defaults to "gemini-2.5-flash").
 * - Does not require Google Cloud project IDs, IAM roles, or Workload Identity Federation.
 *
 * Legacy fallback: Google Cloud Gemini Enterprise Agent Platform (`@google/genai`)
 * - In local development: Authenticated via Application Default Credentials (ADC).
 * - In deployed Vercel environments: Authenticated via Vercel OIDC + WIF.
 *
 * Optional fallback: `OpenAICompatibleProvider` when `FALLO_AI_PROVIDER` is set to
 * an OpenAI-compatible provider name and `FALLO_AI_API_KEY` is provided.
 */
export function resolveRuntimeAIProvider(
  env: Record<string, string | undefined> = process.env,
  geminiClientFactoryOrOptions?: GeminiClientFactory | ResolveRuntimeAIProviderOptions
): AIProviderClient | null {
  const aiEnabledRaw = env.FALLO_AI_ENABLED?.trim().toLowerCase();
  if (aiEnabledRaw === "false" || aiEnabledRaw === "0") {
    return null;
  }

  const geminiClientFactory =
    typeof geminiClientFactoryOrOptions === "function"
      ? geminiClientFactoryOrOptions
      : geminiClientFactoryOrOptions?.geminiClientFactory;
  const oidcTokenSupplier =
    typeof geminiClientFactoryOrOptions === "object" && geminiClientFactoryOrOptions !== null
      ? geminiClientFactoryOrOptions.oidcTokenSupplier
      : undefined;

  const geminiApiKey = env.GEMINI_API_KEY?.trim();
  const providerPref = env.FALLO_AI_PROVIDER?.trim().toLowerCase();
  const useEnterpriseRaw = env.GOOGLE_GENAI_USE_ENTERPRISE?.trim().toLowerCase();
  const gcpProject = env.GOOGLE_CLOUD_PROJECT?.trim();
  const gcpLocation = env.GOOGLE_CLOUD_LOCATION?.trim() || DEFAULT_GOOGLE_CLOUD_LOCATION;
  const configuredModel =
    env.GEMINI_MODEL?.trim() || env.FALLO_AI_MODEL?.trim() || env.GOOGLE_GENAI_MODEL?.trim();
  const apiKey = env.FALLO_AI_API_KEY?.trim();

  const parsedTimeout = Number(env.FALLO_AI_TIMEOUT_MS);
  const timeoutMs =
    Number.isFinite(parsedTimeout) && parsedTimeout >= 1000
      ? parsedTimeout
      : DEFAULT_AI_TIMEOUT_MS;

  const isGeminiProviderPref =
    !providerPref ||
    providerPref === "gemini-enterprise" ||
    providerPref === "google-genai" ||
    providerPref === "vertex" ||
    providerPref === "gemini" ||
    providerPref === "gemini-developer";

  // 1. Primary: Google Gemini Developer API via @google/genai and GEMINI_API_KEY
  if (geminiApiKey) {
    return new GeminiDeveloperProvider({
      providerName: "gemini",
      apiKey: geminiApiKey,
      model: configuredModel || DEFAULT_GEMINI_MODEL,
      timeoutMs,
      clientFactory: geminiClientFactory,
    });
  }

  // 2. Explicit OpenAI-compatible provider when requested and API key is present
  if (providerPref && !isGeminiProviderPref) {
    if (!apiKey) return null;
    return new OpenAICompatibleProvider({
      providerName: providerPref,
      apiKey,
      baseUrl: env.FALLO_AI_BASE_URL?.trim() || undefined,
      model: configuredModel || "gpt-4o-mini",
      timeoutMs,
    });
  }

  // 3. Fallback: Google Cloud Gemini Enterprise Agent Platform via ADC (local) or Vercel OIDC WIF (deployed Vercel)
  const enterpriseEnabled = useEnterpriseRaw !== "false";
  if (isGeminiProviderPref && enterpriseEnabled && gcpProject) {
    const onVercelDeployment = isVercelDeploymentEnvironment(env);
    let wifConfig: VercelWifConfig | undefined;

    if (onVercelDeployment) {
      const resolvedWif = resolveVercelWifConfig(env);
      if (!resolvedWif) {
        // Do not enable production SI generation on Vercel until WIF authentication is configured
        return null;
      }
      wifConfig = resolvedWif;
    }

    const rawLevel = env.FALLO_AI_THINKING_LEVEL?.trim();
    let thinkingLevel: GeminiThinkingLevel = DEFAULT_GEMINI_THINKING_LEVEL;
    if (rawLevel) {
      try {
        thinkingLevel = parseGeminiThinkingLevel(rawLevel);
      } catch {
        thinkingLevel = DEFAULT_GEMINI_THINKING_LEVEL;
      }
    }
    return new GeminiEnterpriseProvider({
      providerName: "gemini-enterprise",
      project: gcpProject,
      location: gcpLocation,
      model: configuredModel || DEFAULT_GEMINI_ENTERPRISE_MODEL,
      enterprise: true,
      thinkingLevel,
      timeoutMs,
      wifConfig,
      oidcTokenSupplier,
      clientFactory: geminiClientFactory,
    });
  }

  return null;
}

/**
 * Minimal OpenAI-compatible provider client with timeout, AbortSignal forwarding,
 * and credential-safe error handling.
 */
export class OpenAICompatibleProvider implements AIProviderClient {
  providerName: string;
  modelName: string;
  private apiKey: string;
  private baseUrl: string;
  private model: string;
  private defaultTimeoutMs: number;
  private fetchImpl: typeof fetch;

  constructor(opts: {
    providerName?: string;
    apiKey: string;
    baseUrl?: string;
    model?: string;
    timeoutMs?: number;
    fetchImpl?: typeof fetch;
  }) {
    this.providerName = opts.providerName ?? "openai-compatible";
    this.apiKey = opts.apiKey;
    this.baseUrl = (opts.baseUrl ?? "https://api.openai.com/v1").replace(/\/+$/, "");
    this.model = opts.model ?? "gpt-4o-mini";
    this.modelName = this.model;
    this.defaultTimeoutMs = opts.timeoutMs ?? DEFAULT_AI_TIMEOUT_MS;
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  private redactSecrets(text: string): string {
    if (!this.apiKey) return text;
    return text.split(this.apiKey).join("[REDACTED]");
  }

  async generate({
    prompt,
    maxTokens = 4000,
    signal,
    timeoutMs = this.defaultTimeoutMs,
    requestId,
  }: {
    prompt: string;
    maxTokens?: number;
    signal?: AbortSignal;
    timeoutMs?: number;
    requestId?: string;
  }): Promise<string> {
    const controller = new AbortController();
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);

    const onExternalAbort = () => {
      controller.abort();
    };

    if (signal) {
      if (signal.aborted) {
        clearTimeout(timer);
        throw new Error(`AI provider (${this.providerName}) request was aborted.`);
      }
      signal.addEventListener("abort", onExternalAbort, { once: true });
    }

    try {
      const res = await this.fetchImpl(`${this.baseUrl}/chat/completions`, {
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
        signal: controller.signal,
      });

      if (!res.ok) {
        const text = await res.text().catch(() => "Unable to read error response");
        const safeSnippet = this.redactSecrets(text).slice(0, 200);
        throw new Error(`Provider returned HTTP ${res.status}: ${safeSnippet}`);
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
    } catch (err) {
      if (timedOut) {
        throw new Error(
          `AI provider (${this.providerName}) request timed out after ${timeoutMs}ms.`
        );
      }
      if (signal?.aborted || (err instanceof Error && err.name === "AbortError")) {
        throw new Error(`AI provider (${this.providerName}) request was aborted.`);
      }
      const rawMessage = err instanceof Error ? err.message : String(err);
      throw new Error(this.redactSecrets(rawMessage));
    } finally {
      clearTimeout(timer);
      if (signal) {
        signal.removeEventListener("abort", onExternalAbort);
      }
    }
  }
}

// ─── Prompt builder ───────────────────────────────────────────────────

export function buildSystemPrompt(
  context: GenerationContext,
  classification: ClassificationResult,
  availableCrops: string[]
): string {
  const normLon = normalizeLongitude(context.lon) ?? context.lon;
  const geo = resolveGeographicContext(context.lat, normLon);
  const effectiveRegionTag = context.regionTag ?? geo.regionTag;

  const cropSummaries = availableCrops
    .map((id) => {
      const c = cropLibrary[id];
      if (!c) return null;
      const nCredit = c.nitrogenBehavior.residualNcredit?.value ?? "none";
      const nDemand = c.nitrogenBehavior.demand ?? "unknown";
      const waterRegime = c.irrigationRegime ?? "irrigated_or_rainfed";
      const windowStr = [
        c.growingWindow.planting ? `plant:${c.growingWindow.planting}` : null,
        c.growingWindow.harvest ? `harvest:${c.growingWindow.harvest}` : null,
        c.growingWindow.termination ? `terminate:${c.growingWindow.termination}` : null,
      ]
        .filter(Boolean)
        .join(", ");
      return `  - ${id} (${c.commonName}, ${c.family}, ${c.type}): water=${c.waterDemand}, drought=${c.droughtTolerance}, regime=${waterRegime}, N-demand=${nDemand}, N-credit=${nCredit}, window=[${windowStr}]`;
    })
    .filter(Boolean)
    .join("\n");

  const monthNames = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const monthlySeasonality = monthNames
    .map((m, idx) => {
      const t = context.climate.fullRecord.monthlyTemp[idx];
      const p = context.climate.fullRecord.monthlyPrecip[idx];
      return `${m}:${t !== null && t !== undefined ? `${t.toFixed(0)}°C` : "?"}/${p !== null && p !== undefined ? `${p.toFixed(0)}mm` : "?"}`;
    })
    .join(" ");

  const climateSummary = [
    `Annual avg temp: ${context.climate.fullRecord.avgAnnualTemp?.toFixed(1) ?? "unknown"} °C | Annual precip: ${context.climate.fullRecord.avgAnnualPrecip?.toFixed(0) ?? "unknown"} mm`,
    `GAEZ v5 thermal/moisture zone: ${classification.gaezThermalZone ?? "N/A"} / ${classification.gaezMoistureZone ?? "N/A"} (est. LGP: ${classification.estimatedLgpDays ?? "unknown"} days)`,
    `Dominant seasonality: ${classification.dominantSeasonality ?? "unknown"} | Water regime: ${classification.waterRegime ?? geo.defaultWaterRegime}`,
    `Growing-season precip (May–Aug): ${context.climate.stressMetrics.growingSeasonPrecip.avgTotalMm?.toFixed(0) ?? "unknown"} mm | Spring precip (Mar–May): ${context.climate.stressMetrics.springPrecip.avgTotalMm?.toFixed(0) ?? "unknown"} mm`,
    `Summer dry spells (Jun–Aug): ${context.climate.stressMetrics.summerDrySpells.avgMaxConsecutiveDryDays?.toFixed(1) ?? "unknown"} days | Heat-stress days (Jul–Aug, >35 °C): ${context.climate.stressMetrics.summerHeatDays.avgDaysAboveThreshold?.toFixed(1) ?? "unknown"} days`,
    `Monthly seasonality (Temp/Precip): ${monthlySeasonality}`,
  ].join("\n");

  const d0 = context.soil?.aggregated.depth0_30cm;
  const soilSummary = context.soil
    ? [
        `Source: ${context.soil.source}`,
        `AWC (0–30 cm): ${d0?.awc !== null && d0?.awc !== undefined ? `${d0.awc.toFixed(3)} cm/cm` : "null"} | OM: ${d0?.om !== null && d0?.om !== undefined ? `${d0.om.toFixed(1)}%` : "null"} | pH: ${d0?.ph !== null && d0?.ph !== undefined ? d0.ph.toFixed(1) : "null"}`,
        `Texture (sand/silt/clay): ${d0?.sand !== null && d0?.sand !== undefined ? `${d0.sand.toFixed(0)}%` : "null"} / ${d0?.silt !== null && d0?.silt !== undefined ? `${d0.silt.toFixed(0)}%` : "null"} / ${d0?.clay !== null && d0?.clay !== undefined ? `${d0.clay.toFixed(0)}%` : "null"}`,
        `Drainage: ${context.soil.aggregated.drainage ?? "null"} | Slope: ${context.soil.aggregated.slope !== null && context.soil.aggregated.slope !== undefined ? `${context.soil.aggregated.slope.toFixed(1)}%` : "null"}`,
      ].join("\n")
    : "No soil data available (soil = null).";

  const classificationSummary = [
    `Country & Administrative Region: ${geo.countryName} (${geo.countryCodeIso3}) — ${geo.admin1Name}`,
    `Classified agricultural group: ${classification.group}`,
    `Classification confidence: ${classification.confidence}`,
    `Geographic region tag: ${effectiveRegionTag ?? "outside documented regional boxes"}`,
    `Classification rationale: ${classification.reasons.join(" ") || "N/A"}`,
    `Classification limitations: ${classification.limitations.join(" ") || "None"}`,
  ].join("\n");

  const fieldObjectives = buildFieldSpecificObjectives({
    climate: context.climate,
    soil: context.soil,
    priorities: context.priorities,
    availableCropIds: availableCrops,
  });

  const objectivesSummary = fieldObjectives
    .map(
      (obj, idx) =>
        `${idx + 1}. "${obj.archetype}" (${obj.name} — ${obj.emphasisTag}): ${obj.objective}${
          obj.recommendedCropIds.length > 0
            ? ` Candidate crops: ${obj.recommendedCropIds.join(", ")}.`
            : ""
        }`
    )
    .join("\n");

  return `You are an agricultural planning assistant for the fallo app.
Generate 3 distinct, field-specific 3-year crop rotation strategies in a single JSON response tailored to this field's planning objectives:
${objectivesSummary}

## COMPATIBILITY RULES (AUTHORITATIVE)
${formatCompatibilityRulesForPrompt()}

- Keep each strategy's "description" to 1 concise sentence stating its objective for this field.
- Include 2–3 short "advantages", 1–2 "disadvantages", and 1–2 "operational" bullets grounded in the field's actual climate/soil metrics, water regime (${classification.waterRegime ?? geo.defaultWaterRegime}), and verified crop traits.
- Align seasonal planting/harvest months with the field's hemisphere (${geo.hemisphere}) and dominant seasonality (${classification.dominantSeasonality ?? "local calendar"}).
- Diversify crop combinations across the 3 strategies so they do not all repeat the exact same high-risk crop pairs; never place primary Sclerotinia oilseed hosts (sunflower, winter_canola, spring_canola) in more than 1 year or fill all 3 years with Sclerotinia-susceptible crops.
- Do not assume or mention a default US state/region (such as North Carolina) unless the field's coordinates and region tag place it there.
- Return ONLY valid JSON matching the schema below.

## FIELD CONTEXT
Field: ${context.fieldName} (${context.lat.toFixed(4)}, ${normLon.toFixed(4)})
${classificationSummary}

### Climate
${climateSummary}

### Soil
${soilSummary}

### Farmer priority weights
Water Suitability: ${context.priorities.waterSuitability}% | Nitrogen Contribution: ${context.priorities.nitrogenContribution}% | Soil Coverage: ${context.priorities.soilCoverage}% | Diversity / Pest Break: ${context.priorities.diversityPestBreak}% | Climate Risk Resilience: ${context.priorities.climateRiskResilience}%

## AVAILABLE CROPS (verified catalog for group "${classification.group}")
${cropSummaries}

## OUTPUT SCHEMA
Return a single JSON object:
{
  "strategies": [
    {
      "id": "soil_health_plan",
      "name": "Soil Health Building Plan",
      "archetype": "soil_health",
      "description": "One concise sentence describing the objective for this field.",
      "years": [
        { "year": 1, "seasons": [{ "season": "Fall–Winter", "crop": "crop_id", "activity": "Brief activity", "months": [10,11,12,1,2,3] }] },
        { "year": 2, "seasons": [...] },
        { "year": 3, "seasons": [...] }
      ],
      "tradeoffs": {
        "advantages": ["Short field-specific advantage 1", "Short advantage 2"],
        "disadvantages": ["Short disadvantage"],
        "operational": ["Short operational note"],
        "warnings": []
      }
    }
  ],
  "rationale": "1–2 concise sentences explaining how the field's climate, soil, and priorities shaped these 3 plans."
}`;
}

function extractJsonString(rawText: string): string {
  const trimmed = rawText.trim();
  const fenceMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  if (fenceMatch && fenceMatch[1]) {
    return fenceMatch[1].trim();
  }
  return trimmed;
}

function mergeValidationWarnings(
  existingWarnings: RotationStrategy["tradeoffs"]["warnings"],
  validationWarnings: string[]
): RotationStrategy["tradeoffs"]["warnings"] {
  const merged = [...existingWarnings];
  const existingTexts = new Set(
    existingWarnings.map((w) => (typeof w === "string" ? w.toLowerCase() : w.text.toLowerCase()))
  );
  for (const w of validationWarnings) {
    if (!existingTexts.has(w.toLowerCase())) {
      existingTexts.add(w.toLowerCase());
      merged.push({ severity: "moderate", text: w });
    }
  }
  return merged;
}

// ─── Public API ───────────────────────────────────────────────────────

export { getAvailableCropsForContext };

export const MAX_CONCURRENT_GENERATIONS = 5;
export const GENERATION_RATE_LIMIT_WINDOW_MS = 10 * 60 * 1000; // 10 minutes
export const GENERATION_RATE_LIMIT_MAX_REQUESTS = 8; // max 8 requests per IP per 10-minute window
export const MAX_GENERATION_REQUEST_BYTES = 256 * 1024; // 256 KB max payload
export const MAX_VALIDATION_RETRY_ATTEMPTS = 1; // At most 1 corrective retry when all proposals fail validation

export interface AggregatedRejectionAnalysis {
  uniqueErrors: string[];
  sharedRejectionReasons: string[];
  requiresCropDiversification: boolean;
  perStrategySummaries: string[];
}

function classifyErrorCategory(errorText: string): string {
  const lower = errorText.toLowerCase();
  if (lower.includes("sclerotinia")) return "Sclerotinia host stacking";
  if (lower.includes("botanical family sequence constraint")) return "Botanical family repetition";
  if (lower.includes("overlapping activity months")) return "Same-year cash-crop window overlap";
  if (lower.includes("no cash crop")) return "Missing cash crop in one or more years";
  if (lower.includes("not in the verified catalog")) return "Unverified crop ID";
  if (lower.includes("not documented for agricultural group")) return "Unsupported agricultural group crop";
  if (lower.includes("not documented for region")) return "Unsupported regional crop";
  return errorText;
}

/**
 * Aggregate deterministic validation errors across rejected proposals and detect
 * when multiple strategies failed for the same agronomic constraint.
 */
export function aggregateRejectionReasons(
  rejectedProposals: RejectedProposalInfo[]
): AggregatedRejectionAnalysis {
  const uniqueErrorsSet = new Set<string>();
  const categoryStrategyCounts = new Map<string, number>();
  const exactErrorStrategyCounts = new Map<string, number>();
  const perStrategySummaries: string[] = [];

  for (const rejected of rejectedProposals) {
    perStrategySummaries.push(`"${rejected.name}" (${rejected.id}): ${rejected.errors.join("; ")}`);
    const seenCategoriesForStrategy = new Set<string>();
    const seenExactForStrategy = new Set<string>();

    for (const err of rejected.errors) {
      uniqueErrorsSet.add(err);
      const cat = classifyErrorCategory(err);
      seenCategoriesForStrategy.add(cat);
      seenExactForStrategy.add(err);
    }

    for (const cat of seenCategoriesForStrategy) {
      categoryStrategyCounts.set(cat, (categoryStrategyCounts.get(cat) ?? 0) + 1);
    }
    for (const exact of seenExactForStrategy) {
      exactErrorStrategyCounts.set(exact, (exactErrorStrategyCounts.get(exact) ?? 0) + 1);
    }
  }

  const sharedRejectionReasons: string[] = [];
  for (const [cat, count] of categoryStrategyCounts.entries()) {
    if (count >= 2 || (rejectedProposals.length === 1 && count === 1)) {
      sharedRejectionReasons.push(cat);
    }
  }

  const requiresCropDiversification =
    rejectedProposals.length >= 2 &&
    Array.from(categoryStrategyCounts.values()).some((count) => count >= 2);

  return {
    uniqueErrors: Array.from(uniqueErrorsSet),
    sharedRejectionReasons,
    requiresCropDiversification,
    perStrategySummaries,
  };
}

/**
 * Build a corrective retry prompt that feeds exact deterministic rejection reasons
 * back to the AI provider and instructs it to diversify crop combinations.
 */
export function buildRetrySystemPrompt(
  basePrompt: string,
  rejectedProposals: RejectedProposalInfo[],
  availableCrops: string[]
): string {
  const analysis = aggregateRejectionReasons(rejectedProposals);
  const perPlanLines = analysis.perStrategySummaries.map((s) => `  - ${s}`).join("\n");
  const uniqueConstraintLines = analysis.uniqueErrors.map((e) => `  - ${e}`).join("\n");

  const diversificationDirective = analysis.requiresCropDiversification
    ? `\n- CRITICAL CROP DIVERSIFICATION REQUIREMENT: Multiple proposals in your previous response failed for the same reason (${analysis.sharedRejectionReasons.join(", ")}) because they repeated the same incompatible crop combinations. You MUST diversify crop selections across the 3 strategies using different non-conflicting cash and cover crops from the AVAILABLE CROPS list (${availableCrops.join(", ")}).`
    : `\n- Replace the offending crops in the rejected strategies using non-conflicting alternatives from the AVAILABLE CROPS list (${availableCrops.join(", ")}).`;

  return `${basePrompt}

## CORRECTIVE RETRY CONSTRAINTS (PREVIOUS ATTEMPT REJECTED BY DETERMINISTIC VALIDATOR)
Your previous response was rejected by deterministic agronomic validation:
${perPlanLines}

Specific validation errors that MUST be resolved in this retry:
${uniqueConstraintLines}
${diversificationDirective}
- Ensure every regenerated strategy strictly passes all Hard Agronomic Constraints while returning valid JSON matching the OUTPUT SCHEMA.`;
}

function mergeUsageMetadata(
  first?: AIUsageMetadata,
  second?: AIUsageMetadata
): AIUsageMetadata | undefined {
  if (!first && !second) return undefined;
  if (!first) return second;
  if (!second) return first;
  return {
    promptTokenCount: (first.promptTokenCount ?? 0) + (second.promptTokenCount ?? 0),
    candidatesTokenCount: (first.candidatesTokenCount ?? 0) + (second.candidatesTokenCount ?? 0),
    thoughtsTokenCount:
      first.thoughtsTokenCount !== undefined || second.thoughtsTokenCount !== undefined
        ? (first.thoughtsTokenCount ?? 0) + (second.thoughtsTokenCount ?? 0)
        : undefined,
    totalTokenCount: (first.totalTokenCount ?? 0) + (second.totalTokenCount ?? 0),
    estimatedCostUsd:
      typeof first.estimatedCostUsd === "number" && typeof second.estimatedCostUsd === "number"
        ? first.estimatedCostUsd + second.estimatedCostUsd
        : first.estimatedCostUsd ?? second.estimatedCostUsd ?? null,
  };
}

/**
 * NOTE ON SERVERLESS SCOPE:
 * `inFlightFieldGenerations` and `clientRateWindowMap` are stored in process memory.
 * On serverless platforms (such as Vercel Functions), these structures provide
 * best-effort per-instance burst and concurrency protection within a warm Node.js
 * instance, plus single-process protection in local development. They are NOT
 * globally shared across multiple concurrent serverless instances; global distributed
 * rate limiting across all instances requires an external state store (e.g. Redis/KV)
 * or edge WAF rate-limiting rules.
 */
const inFlightFieldGenerations = new Set<string>();
const clientRateWindowMap = new Map<string, number[]>();

export function isFieldGenerationInFlight(fieldId: string): boolean {
  return inFlightFieldGenerations.has(fieldId);
}

export function getInFlightGenerationCount(): number {
  return inFlightFieldGenerations.size;
}

export function resetGenerationRateLimiterForTests(): void {
  clientRateWindowMap.clear();
}

export function tryAcquireFieldGenerationLock(fieldId: string): boolean {
  if (!fieldId) return false;
  if (inFlightFieldGenerations.has(fieldId)) {
    return false;
  }
  if (inFlightFieldGenerations.size >= MAX_CONCURRENT_GENERATIONS) {
    return false;
  }
  inFlightFieldGenerations.add(fieldId);
  return true;
}

export function releaseFieldGenerationLock(fieldId: string): void {
  inFlightFieldGenerations.delete(fieldId);
}

/**
 * Generate rotation proposals for a field.
 *
 * 1. Runs deterministic agricultural group classification.
 * 2. Filters verified crops for the actual classified group and geographic region.
 * 3. Refuses generation if the group is unknown/unsupported or has no verified crops.
 * 4. If `aiProvider` is null, returns classification + available crops + honest unavailable reason.
 * 5. Calls AI provider, parses output with Zod, and validates each proposal deterministically.
 * 6. Rejects any proposal that fails deterministic validation, preserving validation errors.
 * 7. Attaches soft validation warnings to accepted proposals and scores them.
 */
export async function generateRotations(
  context: GenerationContext,
  aiProvider: AIProviderClient | null,
  options?: { signal?: AbortSignal; timeoutDeadlineMs?: number; requestId?: string }
): Promise<GenerationResult> {
  const overallStart = Date.now();
  const reqIdStr = options?.requestId ? ` [Req: ${options.requestId}]` : "";
  const timeoutDeadlineMs = options?.timeoutDeadlineMs;
  const overallTimeoutMs = timeoutDeadlineMs ? timeoutDeadlineMs - overallStart : 115000;
  const normLon = normalizeLongitude(context.lon) ?? context.lon;
  const geo = resolveGeographicContext(context.lat, normLon);
  const effectiveRegionTag = context.regionTag ?? geo.regionTag;
  const normalizedContext: GenerationContext = {
    ...context,
    lon: normLon,
    regionTag: effectiveRegionTag,
  };

  if (!tryAcquireFieldGenerationLock(normalizedContext.fieldId)) {
    const classification = classifyAgGroup(normalizedContext.climate, normalizedContext.soil);
    const availableCrops = getAvailableCropsForContext(classification.group, effectiveRegionTag);
    const evidence = evaluateFieldCropEvidenceLevel({
      agGroup: classification.group,
      regionTag: effectiveRegionTag,
      availableCropIds: availableCrops,
      soil: normalizedContext.soil,
    });
    return {
      classification: {
        group: classification.group,
        confidence: classification.confidence,
        reasons: classification.reasons,
        inputsUsed: classification.inputsUsed,
        limitations: classification.limitations,
        evidenceLevel: evidence.level,
        waterRegime: classification.waterRegime,
        dominantSeasonality: classification.dominantSeasonality,
        gaezThermalZone: classification.gaezThermalZone,
        gaezMoistureZone: classification.gaezMoistureZone,
        estimatedLgpDays: classification.estimatedLgpDays,
      },
      geography: geo,
      evidenceLevel: evidence.level,
      evidenceSummary: evidence.summary,
      availableCrops,
      proposals: [],
      supportStatus: "unavailable",
      aiUnavailableReason: `A rotation generation request is already in progress for field "${normalizedContext.fieldName}" (${normalizedContext.fieldId}). Please wait for the active request to complete.`,
    };
  }

  try {
    // 1. Classify deterministically
    const classification = classifyAgGroup(normalizedContext.climate, normalizedContext.soil);

    // 2. Filter crops strictly by supported agricultural group and geographic region (when known)
    const groupSupported = isGroupSupported(classification.group);
    const availableCrops = getAvailableCropsForContext(classification.group, effectiveRegionTag);
    const evidence = evaluateFieldCropEvidenceLevel({
      agGroup: classification.group,
      regionTag: effectiveRegionTag,
      availableCropIds: availableCrops,
      soil: normalizedContext.soil,
    });

    const classificationSummary = {
      group: classification.group,
      confidence: classification.confidence,
      reasons: classification.reasons,
      inputsUsed: classification.inputsUsed,
      limitations: classification.limitations,
      evidenceLevel: evidence.level,
      waterRegime: classification.waterRegime,
      dominantSeasonality: classification.dominantSeasonality,
      gaezThermalZone: classification.gaezThermalZone,
      gaezMoistureZone: classification.gaezMoistureZone,
      estimatedLgpDays: classification.estimatedLgpDays,
    };

    if (!groupSupported || availableCrops.length === 0 || evidence.level === "level_3_insufficient") {
      const reason =
        classification.group === "unknown"
          ? "Cannot generate AI-assisted rotations: field agricultural group is unknown due to insufficient or unclassified climate data."
          : !groupSupported
          ? `Cannot generate AI-assisted rotations: agricultural group "${classification.group}" does not yet have a verified crop catalog.`
          : `Cannot generate AI-assisted rotations: insufficient verified crop coverage (${availableCrops.length} crops) for group "${classification.group}"${
              effectiveRegionTag ? ` and region "${effectiveRegionTag}"` : ""
            }.`;

      return {
        classification: classificationSummary,
        geography: geo,
        evidenceLevel: "level_3_insufficient",
        evidenceSummary: evidence.summary,
        availableCrops: [],
        proposals: [],
        supportStatus: "unavailable",
        aiUnavailableReason: reason,
      };
    }

    const supportStatus: GenerationResult["supportStatus"] =
      evidence.level === "level_1_strong_local" && classification.confidence === "high"
        ? "supported"
        : classification.confidence === "high" && availableCrops.length >= 5
        ? "supported"
        : "limited-evidence";

    // If no AI provider, return classification + available crops + honest message
    if (!aiProvider) {
      return {
        classification: classificationSummary,
        geography: geo,
        evidenceLevel: evidence.level,
        evidenceSummary: evidence.summary,
        availableCrops,
        proposals: [],
        supportStatus,
        aiUnavailableReason: describeMissingAIProviderReason(process.env),
      };
    }

    // 3. Build prompt with real classification and call AI (with bounded validation retry)
    console.log(`[Rotations API]${reqIdStr} Prep time (classification/filtering): ${Date.now() - overallStart}ms`);
    const basePrompt = buildSystemPrompt(normalizedContext, classification, availableCrops);
    const validationCtx: ValidationContext = {
      agGroup: classification.group,
      regionTag: effectiveRegionTag,
      availableCropIds: availableCrops,
      climate: normalizedContext.climate,
      hemisphere: geo.hemisphere === "equatorial" ? "tropical" : geo.hemisphere,
    };

    let currentPrompt = basePrompt;
    let acceptedResults: StrategyResult[] = [];
    let rejectedProposals: RejectedProposalInfo[] = [];
    let latestRationale: string | undefined;
    let accumulatedUsage: AIUsageMetadata | undefined;
    let retryCount = 0;
    const generatedAt = new Date().toISOString();

    for (let attempt = 0; attempt <= MAX_VALIDATION_RETRY_ATTEMPTS; attempt++) {
      if (attempt > 0) {
        retryCount = attempt;
        currentPrompt = buildRetrySystemPrompt(basePrompt, rejectedProposals, availableCrops);
      }

      const remainingTimeout = timeoutDeadlineMs ? timeoutDeadlineMs - Date.now() : overallTimeoutMs - (Date.now() - overallStart);
      if (remainingTimeout <= 0) {
        console.log(`[Rotations API]${reqIdStr} Overall timeout (${overallTimeoutMs}ms) reached before validation attempt ${attempt}. Returning unavailable.`);
        return {
          classification: classificationSummary,
          geography: geo,
          evidenceLevel: evidence.level,
          evidenceSummary: evidence.summary,
          availableCrops,
          proposals: [],
          supportStatus: "unavailable",
          aiUnavailableReason: `Rotation generation timed out globally after ${overallTimeoutMs}ms limit.`,
          aiProvider: aiProvider.providerName,
          aiModel: aiProvider.modelName,
          retryCount,
        };
      }

      let rawAiText: string;
      try {
        const geminiWaitStart = Date.now();
        rawAiText = await aiProvider.generate({
          prompt: currentPrompt,
          maxTokens: DEFAULT_GEMINI_MAX_OUTPUT_TOKENS,
          signal: options?.signal,
          timeoutMs: remainingTimeout,
          requestId: options?.requestId,
        });
        console.log(`[Rotations API]${reqIdStr} Validation attempt ${attempt}, Gemini wait time: ${Date.now() - geminiWaitStart}ms`);
        accumulatedUsage = mergeUsageMetadata(accumulatedUsage, aiProvider.lastUsageMetadata);
      } catch (err) {
        if (attempt > 0 && rejectedProposals.length > 0) {
          // If the retry attempt itself fails at the network/provider level, preserve the
          // deterministic rejection diagnostics from the initial attempt.
          break;
        }
        const safeErr = sanitizeGenerationErrorMessage(
          err instanceof Error ? err.message : String(err)
        );
        return {
          classification: classificationSummary,
          geography: geo,
          evidenceLevel: evidence.level,
          evidenceSummary: evidence.summary,
          availableCrops,
          proposals: [],
          supportStatus: "unavailable",
          aiUnavailableReason: `AI provider (${aiProvider.providerName}) call failed: ${safeErr}`,
          aiProvider: aiProvider.providerName,
          aiModel: aiProvider.modelName,
          retryCount,
        };
      }

      // 4. Parse with Zod
      let parsed: AIProposal;
      try {
        const parsingStart = Date.now();
        const cleaned = extractJsonString(rawAiText);
        const json = JSON.parse(cleaned);
        parsed = AIProposalSchema.parse(json);
        console.log(`[Rotations API]${reqIdStr} Validation attempt ${attempt}, Parsing time: ${Date.now() - parsingStart}ms`);
      } catch (err) {
        if (attempt > 0 && rejectedProposals.length > 0) {
          break;
        }
        return {
          classification: classificationSummary,
          geography: geo,
          evidenceLevel: evidence.level,
          evidenceSummary: evidence.summary,
          availableCrops,
          proposals: [],
          supportStatus: "unavailable",
          aiUnavailableReason: `AI response could not be parsed or validated: ${
            err instanceof Error ? err.message : String(err)
          }`,
          aiProvider: aiProvider.providerName,
          aiModel: aiProvider.modelName,
          usageMetadata: accumulatedUsage,
          retryCount,
        };
      }

      // 5. Validate each proposal deterministically; reject invalid proposals and preserve soft warnings
      const attemptAccepted: StrategyResult[] = [];
      const attemptRejected: RejectedProposalInfo[] = [];
      latestRationale = parsed.rationale;

      for (const strat of parsed.strategies) {
        const validation = validateProposal(strat, validationCtx);

        if (!validation.valid) {
          attemptRejected.push({
            id: strat.id,
            name: strat.name,
            errors: validation.errors,
            warnings: validation.warnings,
          });
          continue;
        }

        const mergedWarnings = mergeValidationWarnings(strat.tradeoffs.warnings, validation.warnings);

        const strategyWithMeta: RotationStrategy = {
          ...strat,
          tradeoffs: {
            ...strat.tradeoffs,
            warnings: mergedWarnings,
          },
          generationInfo: {
            source: "ai-assisted",
            generatedAt,
            agGroup: classification.group,
            supportStatus,
            validationStatus: "passed",
            validationErrors: [],
            validationWarnings: validation.warnings,
            rationale: parsed.rationale,
            aiProvider: aiProvider.providerName,
            aiModel: aiProvider.modelName,
            fieldId: normalizedContext.fieldId,
            usageMetadata: accumulatedUsage,
          },
        };

        const result = scoreStrategy(
          strategyWithMeta,
          normalizedContext.climate,
          normalizedContext.soil,
          normalizedContext.priorities,
          effectiveRegionTag
        );
        attemptAccepted.push(result);
      }

      acceptedResults = attemptAccepted;
      rejectedProposals = attemptRejected;

      // Stop if at least one proposal passed deterministic validation, or if signal was aborted
      if (acceptedResults.length > 0 || rejectedProposals.length === 0 || options?.signal?.aborted) {
        break;
      }
    }

    if (acceptedResults.length === 0) {
      const rejectionSummary = rejectedProposals
        .map((r) => `"${r.name}" (${r.id}): ${r.errors.join("; ")}`)
        .join(" | ");
      return {
        classification: classificationSummary,
        geography: geo,
        evidenceLevel: evidence.level,
        evidenceSummary: evidence.summary,
        availableCrops,
        proposals: [],
        rejectedProposals,
        supportStatus: "unavailable",
        aiUnavailableReason: `All AI-generated proposals were rejected by deterministic agronomic validation: ${rejectionSummary}`,
        aiProvider: aiProvider.providerName,
        aiModel: aiProvider.modelName,
        usageMetadata: accumulatedUsage,
        retryCount,
      };
    }

    const rankedProposals = rankStrategyResults(acceptedResults);

    return {
      classification: classificationSummary,
      geography: geo,
      evidenceLevel: evidence.level,
      evidenceSummary: evidence.summary,
      availableCrops,
      proposals: rankedProposals,
      rejectedProposals: rejectedProposals.length > 0 ? rejectedProposals : undefined,
      rationale: latestRationale,
      supportStatus,
      aiProvider: aiProvider.providerName,
      aiModel: aiProvider.modelName,
      generatedAt,
      usageMetadata: accumulatedUsage,
      retryCount,
    };
  } finally {
    releaseFieldGenerationLock(normalizedContext.fieldId);
  }
}
