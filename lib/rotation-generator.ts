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
import {
  type ClimateData,
  type SoilData,
  type FarmerPriorities,
  type RotationStrategy,
  type StrategyResult,
  type AIUsageMetadata,
  cropLibrary,
  scoreStrategy,
  rankStrategyResults,
  getAvailableCropsForContext,
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

export const ClimateDataSchema = z.object({
  location: z.object({
    lat: z.number().finite().min(-90).max(90),
    lon: z.number().finite().min(-180).max(180),
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

export const RegionTagSchema = z
  .enum(["us_southeast", "us_midwest", "us_northeast", "us_great_plains", "us_southwest"])
  .nullable();

export const GenerationRequestSchema = z.object({
  fieldId: z.string().trim().min(1),
  fieldName: z.string().trim().min(1),
  lat: z.number().finite().min(-90).max(90),
  lon: z.number().finite().min(-180).max(180),
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
  };
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
}

export interface AIProviderClient {
  generate(props: {
    prompt: string;
    maxTokens?: number;
    signal?: AbortSignal;
    timeoutMs?: number;
  }): Promise<string>;
  providerName: string;
  modelName?: string;
  lastUsageMetadata?: AIUsageMetadata;
}

export const DEFAULT_AI_TIMEOUT_MS = 120_000;
export const DEFAULT_GEMINI_MAX_OUTPUT_TOKENS = 3500;
export const DEFAULT_GEMINI_ENTERPRISE_MODEL = "gemini-4-argon";
export const DEFAULT_GOOGLE_CLOUD_LOCATION = "global";

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
    generateContent(params: GeminiGenerateContentRequest): Promise<GeminiGenerateContentResponse>;
  };
}

export type GeminiClientFactory = (
  options: GoogleGenAIOptions
) => GeminiClientLike | Promise<GeminiClientLike>;

/**
 * Official `@google/genai` provider for Google Cloud's Gemini Enterprise Agent Platform
 * using Application Default Credentials (ADC).
 *
 * Initializes `new GoogleGenAI({ enterprise: true, project, location, httpOptions })`
 * and does NOT require an API key (`FALLO_AI_API_KEY`).
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
  private defaultTimeoutMs: number;
  private clientFactory: GeminiClientFactory;

  constructor(opts: {
    providerName?: string;
    project: string;
    location?: string;
    model?: string;
    enterprise?: boolean;
    thinkingLevel?: GeminiThinkingLevel | string;
    timeoutMs?: number;
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
    this.clientFactory =
      opts.clientFactory ??
      (async (sdkOptions: GoogleGenAIOptions) => {
        const { GoogleGenAI } = await import("@google/genai");
        return new GoogleGenAI(sdkOptions);
      });
  }

  private sanitizeErrorMessage(raw: string): string {
    // Redact any accidental OAuth2 access tokens or bearer tokens
    return raw
      .replace(/ya29\.[A-Za-z0-9._-]+/g, "[REDACTED_TOKEN]")
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
      lower.includes("reauth") ||
      lower.includes("status: 401") ||
      lower.includes("status: 403") ||
      lower.includes("code: 401") ||
      lower.includes("code: 403")
    );
  }

  private extractUsageMetadata(raw?: GeminiUsageMetadata): AIUsageMetadata | undefined {
    if (!raw) return undefined;
    const hasAnyCount =
      typeof raw.promptTokenCount === "number" ||
      typeof raw.candidatesTokenCount === "number" ||
      typeof raw.thoughtsTokenCount === "number" ||
      typeof raw.totalTokenCount === "number";
    if (!hasAnyCount) return undefined;
    return {
      promptTokenCount: raw.promptTokenCount,
      candidatesTokenCount: raw.candidatesTokenCount,
      thoughtsTokenCount: raw.thoughtsTokenCount,
      totalTokenCount: raw.totalTokenCount,
      estimatedCostUsd: null,
    };
  }

  async generate({
    prompt,
    maxTokens = DEFAULT_GEMINI_MAX_OUTPUT_TOKENS,
    signal,
    timeoutMs = this.defaultTimeoutMs,
  }: {
    prompt: string;
    maxTokens?: number;
    signal?: AbortSignal;
    timeoutMs?: number;
  }): Promise<string> {
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
      const sdkOptions: GoogleGenAIOptions = {
        enterprise: this.enterprise,
        project: this.project,
        location: this.location,
        httpOptions,
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

/**
 * Resolve the configured runtime AI provider from environment variables.
 *
 * Primary provider: Google Cloud Gemini Enterprise Agent Platform (`@google/genai`)
 * authenticated via Application Default Credentials (ADC). Does NOT require `FALLO_AI_API_KEY`.
 *
 * Activated when:
 * - `FALLO_AI_ENABLED` is not `"false"`
 * - `GOOGLE_GENAI_USE_ENTERPRISE=true` (or `FALLO_AI_PROVIDER` is `"gemini-enterprise"` / `"google-genai"` / `"vertex"` / unset)
 * - AND `GOOGLE_CLOUD_PROJECT` is set.
 *
 * Optional fallback: `OpenAICompatibleProvider` when `FALLO_AI_PROVIDER` is set to
 * an OpenAI-compatible provider name and `FALLO_AI_API_KEY` is provided.
 */
export function resolveRuntimeAIProvider(
  env: Record<string, string | undefined> = process.env,
  geminiClientFactory?: GeminiClientFactory
): AIProviderClient | null {
  const aiEnabledRaw = env.FALLO_AI_ENABLED?.trim().toLowerCase();
  if (aiEnabledRaw === "false" || aiEnabledRaw === "0") {
    return null;
  }

  const providerPref = env.FALLO_AI_PROVIDER?.trim().toLowerCase();
  const useEnterpriseRaw = env.GOOGLE_GENAI_USE_ENTERPRISE?.trim().toLowerCase();
  const gcpProject = env.GOOGLE_CLOUD_PROJECT?.trim();
  const gcpLocation = env.GOOGLE_CLOUD_LOCATION?.trim() || DEFAULT_GOOGLE_CLOUD_LOCATION;
  const configuredModel = env.FALLO_AI_MODEL?.trim() || env.GOOGLE_GENAI_MODEL?.trim();
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
    providerPref === "gemini";

  // 1. Explicit OpenAI-compatible provider when requested and API key is present
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

  // 2. Google Cloud Gemini Enterprise Agent Platform via ADC (no API key required)
  const enterpriseEnabled = useEnterpriseRaw !== "false";
  if (isGeminiProviderPref && enterpriseEnabled && gcpProject) {
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
  }: {
    prompt: string;
    maxTokens?: number;
    signal?: AbortSignal;
    timeoutMs?: number;
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
  const cropSummaries = availableCrops
    .map((id) => {
      const c = cropLibrary[id];
      if (!c) return null;
      const nCredit = c.nitrogenBehavior.residualNcredit?.value ?? "none";
      const nDemand = c.nitrogenBehavior.demand ?? "unknown";
      const windowStr = [
        c.growingWindow.planting ? `plant:${c.growingWindow.planting}` : null,
        c.growingWindow.harvest ? `harvest:${c.growingWindow.harvest}` : null,
        c.growingWindow.termination ? `terminate:${c.growingWindow.termination}` : null,
      ]
        .filter(Boolean)
        .join(", ");
      return `  - ${id} (${c.commonName}, ${c.family}, ${c.type}): water=${c.waterDemand}, drought=${c.droughtTolerance}, N-demand=${nDemand}, N-credit=${nCredit}, window=[${windowStr}]`;
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
    `Growing-season precip (May–Aug): ${context.climate.stressMetrics.growingSeasonPrecip.avgTotalMm?.toFixed(0) ?? "unknown"} mm | Spring precip (Mar–May): ${context.climate.stressMetrics.springPrecip.avgTotalMm?.toFixed(0) ?? "unknown"} mm`,
    `Summer dry spells (Jun–Aug): ${context.climate.stressMetrics.summerDrySpells.avgMaxConsecutiveDryDays?.toFixed(1) ?? "unknown"} days | Heat-stress days (Jul–Aug, >35 °C): ${context.climate.stressMetrics.summerHeatDays.avgDaysAboveThreshold?.toFixed(1) ?? "unknown"} days`,
    `Monthly seasonality (Temp/Precip): ${monthlySeasonality}`,
  ].join("\n");

  const d0 = context.soil?.aggregated.depth0_30cm;
  const soilSummary = context.soil
    ? [
        `AWC (0–30 cm): ${d0?.awc !== null && d0?.awc !== undefined ? `${d0.awc.toFixed(3)} cm/cm` : "null"} | OM: ${d0?.om !== null && d0?.om !== undefined ? `${d0.om.toFixed(1)}%` : "null"} | pH: ${d0?.ph !== null && d0?.ph !== undefined ? d0.ph.toFixed(1) : "null"}`,
        `Texture (sand/silt/clay): ${d0?.sand !== null && d0?.sand !== undefined ? `${d0.sand.toFixed(0)}%` : "null"} / ${d0?.silt !== null && d0?.silt !== undefined ? `${d0.silt.toFixed(0)}%` : "null"} / ${d0?.clay !== null && d0?.clay !== undefined ? `${d0.clay.toFixed(0)}%` : "null"}`,
        `Drainage: ${context.soil.aggregated.drainage ?? "null"} | Slope: ${context.soil.aggregated.slope !== null && context.soil.aggregated.slope !== undefined ? `${context.soil.aggregated.slope.toFixed(1)}%` : "null"}`,
      ].join("\n")
    : "No soil data available (soil = null).";

  const classificationSummary = [
    `Classified agricultural group: ${classification.group}`,
    `Classification confidence: ${classification.confidence}`,
    `Geographic region tag: ${context.regionTag ?? "outside documented US bounding boxes"}`,
    `Classification rationale: ${classification.reasons.join(" ") || "N/A"}`,
    `Classification limitations: ${classification.limitations.join(" ") || "None"}`,
  ].join("\n");

  return `You are an agricultural planning assistant for the fallo app.
Generate 3 distinct, field-specific 3-year crop rotation strategies in a single JSON response:
1. "soil_health" (Soil Health Building)
2. "water_resilience" (Water Resilience)
3. "crop_diversity" (Crop Diversity & Pest Break)

## COMPATIBILITY RULES (AUTHORITATIVE)
${formatCompatibilityRulesForPrompt()}

- Keep each strategy's "description" to 1 concise sentence stating its objective for this field.
- Include 2–3 short "advantages", 1–2 "disadvantages", and 1–2 "operational" bullets grounded in the field's actual climate/soil metrics and verified crop traits.
- Do not assume or mention a default state/region (such as North Carolina) unless the field's coordinates and region tag place it there.
- Return ONLY valid JSON matching the schema below.

## FIELD CONTEXT
Field: ${context.fieldName} (${context.lat.toFixed(4)}, ${context.lon.toFixed(4)})
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

const inFlightFieldGenerations = new Set<string>();

export function isFieldGenerationInFlight(fieldId: string): boolean {
  return inFlightFieldGenerations.has(fieldId);
}

export function tryAcquireFieldGenerationLock(fieldId: string): boolean {
  if (!fieldId) return false;
  if (inFlightFieldGenerations.has(fieldId)) {
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
  options?: { signal?: AbortSignal; timeoutMs?: number }
): Promise<GenerationResult> {
  if (!tryAcquireFieldGenerationLock(context.fieldId)) {
    const classification = classifyAgGroup(context.climate, context.soil);
    return {
      classification: {
        group: classification.group,
        confidence: classification.confidence,
        reasons: classification.reasons,
        inputsUsed: classification.inputsUsed,
        limitations: classification.limitations,
      },
      availableCrops: getAvailableCropsForContext(classification.group, context.regionTag),
      proposals: [],
      supportStatus: "unavailable",
      aiUnavailableReason: `A rotation generation request is already in progress for field "${context.fieldName}" (${context.fieldId}). Please wait for the active request to complete.`,
    };
  }

  try {
    // 1. Classify deterministically
  const classification = classifyAgGroup(context.climate, context.soil);
  const classificationSummary = {
    group: classification.group,
    confidence: classification.confidence,
    reasons: classification.reasons,
    inputsUsed: classification.inputsUsed,
    limitations: classification.limitations,
  };

  // 2. Filter crops strictly by supported agricultural group and geographic region (when known)
  const groupSupported = isGroupSupported(classification.group);
  const availableCrops = getAvailableCropsForContext(classification.group, context.regionTag);

  if (!groupSupported || availableCrops.length === 0) {
    const reason =
      classification.group === "unknown"
        ? "Cannot generate AI-assisted rotations: field agricultural group is unknown due to insufficient or unclassified climate data."
        : !groupSupported
        ? `Cannot generate AI-assisted rotations: agricultural group "${classification.group}" does not yet have a verified crop catalog.`
        : `Cannot generate AI-assisted rotations: no verified crops match group "${classification.group}"${
            context.regionTag ? ` and region "${context.regionTag}"` : ""
          }.`;

    return {
      classification: classificationSummary,
      availableCrops: [],
      proposals: [],
      supportStatus: "unavailable",
      aiUnavailableReason: reason,
    };
  }

  const supportStatus: GenerationResult["supportStatus"] =
    classification.confidence === "high" && availableCrops.length >= 5
      ? "supported"
      : "limited-evidence";

  // If no AI provider, return classification + available crops + honest message
  if (!aiProvider) {
    return {
      classification: classificationSummary,
      availableCrops,
      proposals: [],
      supportStatus,
      aiUnavailableReason:
        "No runtime AI provider is configured. Set GOOGLE_GENAI_USE_ENTERPRISE=true, GOOGLE_CLOUD_PROJECT, and GOOGLE_CLOUD_LOCATION (with Application Default Credentials via `gcloud auth application-default login`), or set FALLO_AI_PROVIDER, to enable AI-assisted rotation generation.",
    };
  }

  // 3. Build prompt with real classification and call AI
  const prompt = buildSystemPrompt(context, classification, availableCrops);
  let rawAiText: string;
  try {
    rawAiText = await aiProvider.generate({
      prompt,
      maxTokens: DEFAULT_GEMINI_MAX_OUTPUT_TOKENS,
      signal: options?.signal,
      timeoutMs: options?.timeoutMs,
    });
  } catch (err) {
    return {
      classification: classificationSummary,
      availableCrops,
      proposals: [],
      supportStatus: "unavailable",
      aiUnavailableReason: `AI provider (${aiProvider.providerName}) call failed: ${
        err instanceof Error ? err.message : String(err)
      }`,
      aiProvider: aiProvider.providerName,
      aiModel: aiProvider.modelName,
    };
  }

  // 4. Parse with Zod
  let parsed: AIProposal;
  try {
    const cleaned = extractJsonString(rawAiText);
    const json = JSON.parse(cleaned);
    parsed = AIProposalSchema.parse(json);
  } catch (err) {
    return {
      classification: classificationSummary,
      availableCrops,
      proposals: [],
      supportStatus: "unavailable",
      aiUnavailableReason: `AI response could not be parsed or validated: ${
        err instanceof Error ? err.message : String(err)
      }`,
      aiProvider: aiProvider.providerName,
      aiModel: aiProvider.modelName,
      usageMetadata: aiProvider.lastUsageMetadata,
    };
  }

  // 5. Validate each proposal deterministically; reject invalid proposals and preserve soft warnings
  const validationCtx: ValidationContext = {
    agGroup: classification.group,
    regionTag: context.regionTag,
    availableCropIds: availableCrops,
  };

  const acceptedResults: StrategyResult[] = [];
  const rejectedProposals: RejectedProposalInfo[] = [];
  const generatedAt = new Date().toISOString();

  for (const strat of parsed.strategies) {
    const validation = validateProposal(strat, validationCtx);

    if (!validation.valid) {
      rejectedProposals.push({
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
        fieldId: context.fieldId,
        usageMetadata: aiProvider.lastUsageMetadata,
      },
    };

    const result = scoreStrategy(
      strategyWithMeta,
      context.climate,
      context.soil,
      context.priorities,
      context.regionTag
    );
    acceptedResults.push(result);
  }

  if (acceptedResults.length === 0) {
    const rejectionSummary = rejectedProposals
      .map((r) => `"${r.name}" (${r.id}): ${r.errors.join("; ")}`)
      .join(" | ");
    return {
      classification: classificationSummary,
      availableCrops,
      proposals: [],
      rejectedProposals,
      supportStatus: "unavailable",
      aiUnavailableReason: `All AI-generated proposals were rejected by deterministic agronomic validation: ${rejectionSummary}`,
      aiProvider: aiProvider.providerName,
      aiModel: aiProvider.modelName,
      usageMetadata: aiProvider.lastUsageMetadata,
    };
  }

  const rankedProposals = rankStrategyResults(acceptedResults);

  return {
    classification: classificationSummary,
    availableCrops,
    proposals: rankedProposals,
    rejectedProposals: rejectedProposals.length > 0 ? rejectedProposals : undefined,
    rationale: parsed.rationale,
    supportStatus,
    aiProvider: aiProvider.providerName,
    aiModel: aiProvider.modelName,
    generatedAt,
    usageMetadata: aiProvider.lastUsageMetadata,
  };
  } finally {
    releaseFieldGenerationLock(context.fieldId);
  }
}
