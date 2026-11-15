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
import {
  type ClimateData,
  type SoilData,
  type FarmerPriorities,
  type RotationStrategy,
  type StrategyResult,
  cropLibrary,
  scoreStrategy,
  rankStrategyResults,
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
}

export interface AIProviderClient {
  generate(props: {
    prompt: string;
    maxTokens?: number;
    signal?: AbortSignal;
    timeoutMs?: number;
  }): Promise<string>;
  providerName: string;
}

export const DEFAULT_AI_TIMEOUT_MS = 30_000;

/**
 * Minimal OpenAI-compatible provider client with timeout, AbortSignal forwarding,
 * and credential-safe error handling.
 */
export class OpenAICompatibleProvider implements AIProviderClient {
  providerName: string;
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
      const nCredit = c.nitrogenBehavior.residualNcredit?.value ?? "N/A";
      const nDemand = c.nitrogenBehavior.demand ?? "N/A";
      return `  - ${id} (${c.commonName}, ${c.family}, ${c.type}): water=${c.waterDemand}, drought=${c.droughtTolerance}, N=${nDemand}, N-credit=${nCredit}`;
    })
    .filter(Boolean)
    .join("\n");

  const climateSummary = [
    `Average annual temperature: ${context.climate.fullRecord.avgAnnualTemp?.toFixed(1) ?? "unknown"} °C`,
    `Average annual precipitation: ${context.climate.fullRecord.avgAnnualPrecip?.toFixed(0) ?? "unknown"} mm`,
    `Growing-season precip (May–Aug): ${context.climate.stressMetrics.growingSeasonPrecip.avgTotalMm?.toFixed(0) ?? "unknown"} mm`,
    `Summer dry spells (Jun–Aug): ${context.climate.stressMetrics.summerDrySpells.avgMaxConsecutiveDryDays?.toFixed(1) ?? "unknown"} days`,
    `Heat-stress days (Jul–Aug, >35 °C): ${context.climate.stressMetrics.summerHeatDays.avgDaysAboveThreshold?.toFixed(1) ?? "unknown"} days`,
  ].join("\n");

  const soilSummary = context.soil
    ? [
        `AWC (0–30 cm): ${context.soil.aggregated.depth0_30cm.awc?.toFixed(3) ?? "unknown"} cm/cm`,
        `Drainage: ${context.soil.aggregated.drainage ?? "unknown"}`,
        `Slope: ${context.soil.aggregated.slope?.toFixed(1) ?? "unknown"}%`,
      ].join("\n")
    : "No soil data available.";

  const classificationSummary = [
    `Classified agricultural group: ${classification.group}`,
    `Classification confidence: ${classification.confidence}`,
    `Geographic region tag: ${context.regionTag ?? "outside documented US bounding boxes"}`,
    `Classification rationale: ${classification.reasons.join(" ") || "N/A"}`,
    `Classification limitations: ${classification.limitations.join(" ") || "None"}`,
  ].join("\n");

  return `You are an agricultural planning assistant for the fallo app.
Your role is to suggest 3 field-specific crop rotation strategies (each covering 3 years: Soil Health, Water Resilience, and Crop Diversity) tailored to this field.

## COMPATIBILITY RULES (AUTHORITATIVE)
${formatCompatibilityRulesForPrompt()}

- Propose up to 3 distinct strategy archetypes: "soil_health", "water_resilience", and "crop_diversity".
- Keep each strategy's "description" to a single concise sentence stating its objective for this field.
- Include 2–3 short, scannable "advantages" bullets grounded in the field's actual climate and soil metrics and the verified crop traits.
- Do not assume or mention a default region (such as North Carolina) unless the field's actual coordinates and region tag place it there.
- Consider the farmer's priorities when choosing crop emphasis.
- Return ONLY valid JSON matching the requested schema.

## FIELD CONTEXT
Field Name: ${context.fieldName}
Location: ${context.lat.toFixed(4)}, ${context.lon.toFixed(4)}
${classificationSummary}

### Climate
${climateSummary}

### Soil
${soilSummary}

### Farmer priorities (weights)
- Water Suitability: ${context.priorities.waterSuitability}%
- Nitrogen Contribution: ${context.priorities.nitrogenContribution}%
- Soil Coverage: ${context.priorities.soilCoverage}%
- Diversity / Pest Break: ${context.priorities.diversityPestBreak}%
- Climate Risk Resilience: ${context.priorities.climateRiskResilience}%

## AVAILABLE CROPS (verified catalog for group "${classification.group}")
${cropSummaries}

## OUTPUT SCHEMA
Return a JSON object with:
- strategies: array of 1–3 strategy objects, each with id, name, archetype ("soil_health" | "water_resilience" | "crop_diversity"), description (one concise sentence), years (length 3), tradeoffs
- rationale: a short paragraph explaining how the priorities and climate/soil shaped the recommendation

Strategy object shape:
{
  "id": "snake_case_id",
  "name": "Human-readable name",
  "archetype": "soil_health",
  "description": "One concise sentence describing the objective for this field.",
  "years": [
    { "year": 1, "seasons": [
      { "season": "Fall", "crop": "crop_id", "activity": "Plant cover crop", "months": [9,10,11] }
    ]}
  ],
  "tradeoffs": {
    "advantages": ["Short field-specific advantage 1", "Short advantage 2"],
    "disadvantages": ["..."],
    "operational": ["..."],
    "warnings": ["..."]
  }
}
`;
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

/**
 * Deterministically filter the verified crop catalog for a classified
 * agroecological group and geographic region tag.
 */
export function getAvailableCropsForContext(
  agGroup: AgGroup,
  regionTag: string | null
): string[] {
  if (!isGroupSupported(agGroup)) return [];
  return Object.values(cropLibrary)
    .filter((c) => {
      if (!c.applicableGroups || !c.applicableGroups.includes(agGroup)) {
        return false;
      }
      if (regionTag && !c.supportedRegions.includes(regionTag)) {
        return false;
      }
      return true;
    })
    .map((c) => c.id);
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
  aiProvider: AIProviderClient | null
): Promise<GenerationResult> {
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
        "No runtime AI provider is configured. To enable AI-assisted rotation generation, set the FALLO_AI_PROVIDER and FALLO_AI_API_KEY environment variables.",
    };
  }

  // 3. Build prompt with real classification and call AI
  const prompt = buildSystemPrompt(context, classification, availableCrops);
  let rawAiText: string;
  try {
    rawAiText = await aiProvider.generate({ prompt, maxTokens: 4000 });
  } catch (err) {
    return {
      classification: classificationSummary,
      availableCrops,
      proposals: [],
      supportStatus: "unavailable",
      aiUnavailableReason: `AI provider (${aiProvider.providerName}) call failed: ${
        err instanceof Error ? err.message : String(err)
      }`,
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
        generatedAt: new Date().toISOString(),
        agGroup: classification.group,
        supportStatus,
        validationErrors: [],
        validationWarnings: validation.warnings,
        rationale: parsed.rationale,
        aiProvider: aiProvider.providerName,
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
  };
}
