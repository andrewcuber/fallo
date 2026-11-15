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
} from "@/lib/rotation-scoring";
import { classifyAgGroup, type AgGroup } from "@/lib/agro-classifier";
import { validateProposal, type ValidationContext } from "@/lib/rotation-validator";

// ─── Zod schemas for structured AI output ─────────────────────────────

const RotationSeasonSchema = z.object({
  season: z.string(),
  crop: z.string(),
  activity: z.string(),
  months: z.array(z.number().min(1).max(12)),
});

const RotationYearSchema = z.object({
  year: z.number().min(1).max(5),
  seasons: z.array(RotationSeasonSchema),
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
  rationale: z.string().max(800),
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
  supportStatus: "supported" | "limited-evidence" | "unavailable";
  aiUnavailableReason?: string;
}

export interface AIProviderClient {
  generate(props: { prompt: string; maxTokens?: number }): Promise<string>;
  providerName: string;
}

// ─── Prompt builder ───────────────────────────────────────────────────

function buildSystemPrompt(context: GenerationContext, availableCrops: string[]): string {
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

  return `You are an agricultural planning assistant for the fallo app.
Your role is to suggest 1–3 crop rotation strategies (each exactly 3 years) for a specific field.

## CRITICAL RULES
- You may ONLY use crops from the verified catalog listed below. Do not invent crops, varieties, planting windows, or agronomic traits.
- Each strategy must have exactly 3 years. Each year can have 1–4 seasons.
- Every year must contain at least one cash crop.
- Do not repeat the same botanical family in more than 2 years across the 3-year rotation.
- Do not place Sclerotinia-susceptible crops (sunflower, soybean) in multiple years unless separated by a strong break crop.
- Avoid wheat immediately following corn or sorghum due to Fusarium head blight risk.
- Consider the farmer's priorities when choosing crop emphasis.
- Return ONLY valid JSON matching the requested schema.

## FIELD CONTEXT
Location: ${context.lat.toFixed(4)}, ${context.lon.toFixed(4)}
Detected agricultural group: ${context.climate.fullRecord.avgAnnualTemp != null ? "temperate_humid or semi_arid_temperate" : "unknown"}

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

## AVAILABLE CROPS (verified catalog)
${cropSummaries}

## OUTPUT SCHEMA
Return a JSON object with:
- strategies: array of 1–3 strategy objects, each with id, name, archetype, description, regionExample, years (length 3), tradeoffs
- rationale: a short paragraph explaining how the priorities and climate/soil shaped the recommendation

Strategy object shape:
{
  "id": "snake_case_id",
  "name": "Human-readable name",
  "archetype": "machine_tag",
  "description": "1–2 sentence summary",
  "regionExample": "Optional region example",
  "years": [
    { "year": 1, "seasons": [
      { "season": "Fall", "crop": "crop_id", "activity": "Plant cover crop", "months": [9,10,11] }
    ]}
  ],
  "tradeoffs": {
    "advantages": ["..."],
    "disadvantages": ["..."],
    "operational": ["..."],
    "warnings": ["..."] // or objects with severity and text
  }
}
`;
}

// ─── Public API ───────────────────────────────────────────────────────

/**
 * Generate rotation proposals for a field.
 *
 * If `aiProvider` is provided and env vars are set, this will call the LLM.
 * If `aiProvider` is null (no runtime provider configured), the function returns
 * an honest result explaining that AI generation is unavailable, while still
 * providing the classification and available-crop list.
 */
export async function generateRotations(
  context: GenerationContext,
  aiProvider: AIProviderClient | null
): Promise<GenerationResult> {
  // 1. Classify
  const classification = classifyAgGroup(context.climate, context.soil);

  // 2. Filter crops
  const availableCrops = Object.values(cropLibrary)
    .filter((c) => {
      if (classification.group === "unknown") return true; // don't block when unknown
      if (!c.applicableGroups || c.applicableGroups.length === 0) return false;
      return c.applicableGroups.includes(classification.group);
    })
    .map((c) => c.id);

  const supportStatus: GenerationResult["supportStatus"] =
    classification.group === "unknown"
      ? "unavailable"
      : classification.confidence === "high" && availableCrops.length >= 5
      ? "supported"
      : "limited-evidence";

  // If no AI provider, return classification + empty proposals + honest message
  if (!aiProvider) {
    return {
      classification: {
        group: classification.group,
        confidence: classification.confidence,
        reasons: classification.reasons,
        inputsUsed: classification.inputsUsed,
        limitations: classification.limitations,
      },
      availableCrops,
      proposals: [],
      supportStatus,
      aiUnavailableReason:
        "No runtime AI provider is configured. To enable AI-assisted rotation generation, set the FALLO_AI_PROVIDER and FALLO_AI_API_KEY environment variables.",
    };
  }

  // 3. Build prompt and call AI
  const prompt = buildSystemPrompt(context, availableCrops);
  let rawAiText: string;
  try {
    rawAiText = await aiProvider.generate({ prompt, maxTokens: 4000 });
  } catch (err) {
    return {
      classification: {
        group: classification.group,
        confidence: classification.confidence,
        reasons: classification.reasons,
        inputsUsed: classification.inputsUsed,
        limitations: classification.limitations,
      },
      availableCrops,
      proposals: [],
      supportStatus,
      aiUnavailableReason: `AI provider (${aiProvider.providerName}) call failed: ${
        err instanceof Error ? err.message : String(err)
      }`,
    };
  }

  // 4. Parse with Zod
  let parsed: AIProposal;
  try {
    const cleaned = rawAiText.replace(/```json\s*/i, "").replace(/```\s*$/i, "").trim();
    const json = JSON.parse(cleaned);
    parsed = AIProposalSchema.parse(json);
  } catch (err) {
    return {
      classification: {
        group: classification.group,
        confidence: classification.confidence,
        reasons: classification.reasons,
        inputsUsed: classification.inputsUsed,
        limitations: classification.limitations,
      },
      availableCrops,
      proposals: [],
      supportStatus,
      aiUnavailableReason: `AI response could not be parsed or validated: ${
        err instanceof Error ? err.message : String(err)
      }`,
    };
  }

  // 5. Validate each proposal and score accepted ones
  const validationCtx: ValidationContext = {
    agGroup: classification.group,
    regionTag: context.regionTag,
    availableCropIds: availableCrops,
  };

  const proposals: StrategyResult[] = [];
  for (const strat of parsed.strategies) {
    const validation = validateProposal(strat, validationCtx);

    const strategyWithMeta: RotationStrategy = {
      ...strat,
      generationInfo: {
        source: "ai-assisted",
        generatedAt: new Date().toISOString(),
        agGroup: classification.group,
        supportStatus: validation.valid ? supportStatus : "unavailable",
        validationErrors: validation.errors,
        aiProvider: aiProvider.providerName,
      },
    };

    // Even invalid proposals get scored so the UI can show the diagnostic
    const result = scoreStrategy(strategyWithMeta, context.climate, context.soil, context.priorities, context.regionTag);
    proposals.push(result);
  }

  return {
    classification: {
      group: classification.group,
      confidence: classification.confidence,
      reasons: classification.reasons,
      inputsUsed: classification.inputsUsed,
      limitations: classification.limitations,
    },
    availableCrops,
    proposals,
    supportStatus,
  };
}
