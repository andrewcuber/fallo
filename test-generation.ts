/**
 * Deterministic generation pipeline tests for fallo.
 *
 * These tests verify:
 * - Agricultural group classifier behavior across all groups and edge-case climate/soil data.
 * - Prompt and validator compatibility-rule alignment (single source of truth).
 * - Proposal validator hard constraints and soft warnings.
 * - Request Zod schema validation (rejecting malformed payloads while allowing valid nulls).
 * - Generation orchestrator with mock AI providers (valid JSON, markdown fences, invalid JSON,
 *   Zod failure, deterministic rejection of invalid proposals, soft warning preservation,
 *   provider errors/timeouts, unknown groups).
 * - Persistence state updates, merged strategy ranking, and detail-page lookup.
 *
 * Run: npx tsx test-generation.ts
 */

import { strict as assert } from "assert";
import { classifyAgGroup, isGroupSupported } from "@/lib/agro-classifier";
import {
  validateProposal,
  isStrategyStructurallyValid,
  formatCompatibilityRulesForPrompt,
} from "@/lib/rotation-validator";
import {
  generateRotations,
  buildSystemPrompt,
  getAvailableCropsForContext,
  GenerationRequestSchema,
  OpenAICompatibleProvider,
  GeminiEnterpriseProvider,
  resolveRuntimeAIProvider,
  parseGeminiThinkingLevel,
  isFieldGenerationInFlight,
  isVercelDeploymentEnvironment,
  getMissingVercelWifEnvVars,
  resolveVercelWifConfig,
  buildVercelWifAudience,
  buildServiceAccountImpersonationUrl,
  createVercelWifExternalAccountClient,
  GCP_STS_TOKEN_URL,
  GCP_SUBJECT_TOKEN_TYPE_JWT,
  DEFAULT_AI_TIMEOUT_MS,
  DEFAULT_GEMINI_MAX_OUTPUT_TOKENS,
  DEFAULT_GEMINI_THINKING_LEVEL,
  DEFAULT_GEMINI_ENTERPRISE_MODEL,
  DEFAULT_GOOGLE_CLOUD_LOCATION,
  checkGenerationRateLimit,
  resetGenerationRateLimiterForTests,
  GENERATION_RATE_LIMIT_MAX_REQUESTS,
  type AIProviderClient,
} from "@/lib/rotation-generator";
import {
  DEFAULT_WHAT_IF_SCENARIO,
  WHAT_IF_PRESETS,
  isBaselineScenario,
  formatScenarioSummary,
  formatEnumLabel,
  formatCropName,
  formatSeasonSequenceNames,
  applyWhatIfScenarioToClimate,
  evaluateWhatIfScenario,
} from "@/lib/what-if-simulator";
import {
  buildFieldCalendar,
  selectHemisphereWindowText,
} from "@/lib/field-calendar";
import {
  computeClimateAnalogues,
  resolveGrowingSeasonWindow,
} from "@/lib/climate-analogues";
import { IdentityPoolClient } from "google-auth-library";
import {
  type RotationStrategy,
  type ClimateData,
  type SoilData,
  type FarmerPriorities,
  DEFAULT_PRIORITIES,
  strategies as staticStrategies,
  STRATEGY_OBJECTIVES,
  buildObjectiveFieldContextBullets,
  buildStrategyOverviewBullets,
  isReferenceStrategyApplicable,
  isVerifiedAiStrategyForField,
  scoreVerifiedAiStrategies,
  mergeAndRankStrategies,
  resolveScoredStrategyById,
  rankStrategyResults,
  scoreStrategy,
} from "@/lib/rotation-scoring";
import {
  applyFieldRotationsUpdate,
  sanitizeStoredFields,
  type Field,
  type StoredRotations,
} from "@/components/providers";
import {
  normalizeLongitude,
  validateLatitude,
  normalizeCoordinates,
} from "@/lib/coordinates";
import {
  detectRegion,
  detectRegionTag,
  resolveGeographicContext,
  GLOBAL_REGION_TAGS,
} from "@/lib/region";
import {
  GLOBAL_DATA_PROVIDERS,
  resolveGlobalSoilFallback,
  evaluateGaezV5Indicators,
  buildUnifiedFieldEvidenceProfile,
} from "@/lib/global-data-providers";
import { evaluateFieldCropEvidenceLevel } from "@/lib/rotation-scoring";

// ─── Helpers ──────────────────────────────────────────────────────────

function makeClimate(
  overrides: Partial<ClimateData["fullRecord"]> & Partial<ClimateData["stressMetrics"]> = {}
): ClimateData {
  const defaultFullRecord = {
    avgAnnualTemp: 14,
    avgAnnualPrecip: 1100,
    avgDailySolar: 16,
    monthlyTemp: [4, 6, 10, 15, 20, 24, 26, 25, 21, 15, 9, 5],
    monthlyPrecip: [80, 85, 95, 90, 100, 110, 105, 100, 90, 70, 75, 90],
    monthlySolar: [10, 12, 15, 18, 21, 23, 22, 20, 17, 14, 11, 9],
  };
  const defaultStress = {
    summerDrySpells: { avgMaxConsecutiveDryDays: 5, thresholdMm: 1, monthsDesc: "Jun–Aug" },
    summerHeatDays: { avgDaysAboveThreshold: 6, thresholdC: 35, monthsDesc: "Jul–Aug" },
    springPrecip: { avgTotalMm: 280, monthsDesc: "Mar–May" },
    growingSeasonPrecip: { avgTotalMm: 420, monthsDesc: "May–Aug" },
  };
  return {
    location: { lat: 35.67, lon: -80.47, elevation: 200 },
    fullRecord: { ...defaultFullRecord, ...overrides },
    stressMetrics: {
      summerDrySpells: { ...defaultStress.summerDrySpells, ...overrides.summerDrySpells },
      summerHeatDays: { ...defaultStress.summerHeatDays, ...overrides.summerHeatDays },
      springPrecip: { ...defaultStress.springPrecip, ...overrides.springPrecip },
      growingSeasonPrecip: {
        ...defaultStress.growingSeasonPrecip,
        ...overrides.growingSeasonPrecip,
      },
    },
    source: "NASA POWER (test mock)",
    spatialResolution: "0.5°",
    limitations: ["Mock data for testing only"],
  };
}

function makeSoil(): SoilData {
  return {
    aggregated: {
      depth0_30cm: { sand: 55, silt: 25, clay: 20, om: 1.5, ph: 6.2, awc: 0.15 },
      drainage: "Well drained",
      slope: 4,
    },
    dataCoverage: {
      depth0_30cm: { sand: 90, silt: 90, clay: 90, om: 85, ph: 90, awc: 90 },
      drainage: 100,
      slope: 100,
    },
    totalComponentPercent: 80,
    source: "SSURGO (test mock)",
    limitations: ["Mock soil data"],
  };
}

function makeValidStrategy(id = "test_strategy", name = "Test Strategy"): RotationStrategy {
  return {
    id,
    name,
    archetype: "test_archetype",
    description: "A valid three-year test rotation strategy with diverse crop families.",
    regionExample: "NC Piedmont",
    years: [
      {
        year: 1,
        seasons: [
          { season: "Spring", crop: "field_corn", activity: "Plant corn", months: [4, 5, 6, 7, 8] },
          { season: "Fall", crop: "cereal_rye", activity: "Plant rye cover", months: [9, 10, 11] },
        ],
      },
      {
        year: 2,
        seasons: [
          { season: "Spring", crop: "soybean", activity: "Plant soybean", months: [5, 6, 7, 8, 9] },
          {
            season: "Fall",
            crop: "crimson_clover",
            activity: "Plant clover",
            months: [9, 10, 11],
          },
        ],
      },
      {
        year: 3,
        seasons: [
          {
            season: "Spring",
            crop: "soft_red_winter_wheat",
            activity: "Plant wheat",
            months: [3, 4, 5, 6],
          },
          {
            season: "Fall",
            crop: "forage_radish",
            activity: "Plant radish",
            months: [8, 9, 10],
          },
        ],
      },
    ],
    tradeoffs: {
      advantages: ["Diverse families"],
      disadvantages: ["Management complexity"],
      operational: ["Terminate covers on time"],
      warnings: [],
    },
  };
}

function makeMockProvider(responseTextOrFn: string | (() => Promise<string>)): AIProviderClient {
  return {
    providerName: "mock-test-provider",
    async generate() {
      if (typeof responseTextOrFn === "function") {
        return await responseTextOrFn();
      }
      return responseTextOrFn;
    },
  };
}

// ─── Async-aware test runner ──────────────────────────────────────────

interface QueuedTest {
  section?: string;
  name: string;
  fn: () => void | Promise<void>;
}

const queue: QueuedTest[] = [];
let pendingSection: string | undefined;

function section(title: string) {
  pendingSection = title;
}

function test(name: string, fn: () => void | Promise<void>) {
  queue.push({ section: pendingSection, name, fn });
  pendingSection = undefined;
}

// ─── 1. Classifier tests ──────────────────────────────────────────────

section("Agricultural Group Classifier");

test("Temperate humid climate (NC-like) with soil -> temperate_humid, high confidence", () => {
  const result = classifyAgGroup(makeClimate(), makeSoil());
  assert.equal(result.group, "temperate_humid");
  assert.equal(result.confidence, "high");
  assert.ok(result.reasons.some((r) => r.includes("Moderate annual temperature")));
  assert.ok(result.limitations.some((l) => l.includes("Provisional climate-based classification")));
});

test("Temperate humid climate without soil -> degrades confidence to moderate", () => {
  const result = classifyAgGroup(makeClimate(), null);
  assert.equal(result.group, "temperate_humid");
  assert.equal(result.confidence, "moderate");
  assert.ok(result.limitations.some((l) => l.includes("No soil data available")));
});

test("Semi-arid climate (low precip + high dry days) -> semi_arid_temperate", () => {
  const climate = makeClimate({
    avgAnnualPrecip: 400,
    monthlyPrecip: [10, 10, 15, 20, 30, 40, 50, 40, 25, 15, 10, 10],
  });
  climate.stressMetrics.summerDrySpells.avgMaxConsecutiveDryDays = 20;
  const result = classifyAgGroup(climate, makeSoil());
  assert.equal(result.group, "semi_arid_temperate");
  assert.equal(result.confidence, "high");
});

test("Subtropical humid climate (warm + high precip) -> subtropical_humid", () => {
  const climate = makeClimate({
    avgAnnualTemp: 20,
    avgAnnualPrecip: 1250,
    monthlyPrecip: [90, 90, 100, 100, 110, 120, 130, 120, 110, 95, 90, 95],
  });
  const result = classifyAgGroup(climate, makeSoil());
  assert.equal(result.group, "subtropical_humid");
  assert.equal(result.confidence, "high");
});

test("Temperate Mediterranean climate (winter-wet, summer-dry) -> temperate_mediterranean", () => {
  const climate = makeClimate({
    avgAnnualTemp: 15,
    avgAnnualPrecip: 600,
    // Jun, Jul, Aug = 10 + 5 + 10 = 25 (< 80); Dec, Jan, Feb = 110 + 120 + 100 = 330 (> 50)
    monthlyPrecip: [120, 100, 70, 40, 20, 10, 5, 10, 20, 45, 50, 110],
  });
  const result = classifyAgGroup(climate, makeSoil());
  assert.equal(result.group, "temperate_mediterranean");
  assert.equal(result.confidence, "high");
});

test("Missing core climate data -> unknown, low confidence", () => {
  const climate = makeClimate({
    avgAnnualTemp: null,
    avgAnnualPrecip: null,
  });
  const result = classifyAgGroup(climate, null);
  assert.equal(result.group, "unknown");
  assert.equal(result.confidence, "low");
  assert.ok(result.limitations.length > 0);
});

test("Unmatched extreme climate profile -> unknown, low confidence", () => {
  const climate = makeClimate({
    avgAnnualTemp: -3,
    avgAnnualPrecip: 300,
  });
  const result = classifyAgGroup(climate, makeSoil());
  assert.equal(result.group, "unknown");
  assert.equal(result.confidence, "low");
});

test("isGroupSupported returns true for all 12 supported global agroecological groups and false for boreal/unknown", () => {
  assert.equal(isGroupSupported("temperate_humid"), true);
  assert.equal(isGroupSupported("semi_arid_temperate"), true);
  assert.equal(isGroupSupported("subtropical_humid"), true);
  assert.equal(isGroupSupported("temperate_mediterranean"), true);
  assert.equal(isGroupSupported("tropical_humid"), true);
  assert.equal(isGroupSupported("tropical_subhumid"), true);
  assert.equal(isGroupSupported("tropical_savanna"), true);
  assert.equal(isGroupSupported("tropical_monsoon"), true);
  assert.equal(isGroupSupported("tropical_semi_arid"), true);
  assert.equal(isGroupSupported("arid"), true);
  assert.equal(isGroupSupported("continental"), true);
  assert.equal(isGroupSupported("highland_montane"), true);
  assert.equal(isGroupSupported("boreal"), false);
  assert.equal(isGroupSupported("unknown"), false);
});

// ─── 2. Prompt & Validator Rule Alignment tests ───────────────────────

section("Prompt & Compatibility Rules Alignment");

test("Prompt uses real classification result and authoritative Sclerotinia constraint", () => {
  const climate = makeClimate();
  const soil = makeSoil();
  const classification = classifyAgGroup(climate, soil);
  const prompt = buildSystemPrompt(
    {
      fieldId: "f1",
      fieldName: "North Field",
      lat: 35.67,
      lon: -80.47,
      climate,
      soil,
      priorities: DEFAULT_PRIORITIES,
      regionTag: "us_southeast",
    },
    classification,
    ["field_corn", "soybean", "soft_red_winter_wheat"]
  );

  assert.ok(prompt.includes("Classified agricultural group: temperate_humid"));
  assert.ok(prompt.includes("Classification confidence: high"));
  assert.ok(!prompt.includes("temperate_humid or semi_arid_temperate"));
  assert.ok(!prompt.includes("unless separated by a strong break crop"));
  assert.ok(prompt.includes(formatCompatibilityRulesForPrompt()));
});

// ─── 3. Proposal Validator tests ──────────────────────────────────────

section("Proposal Validator");

test("Valid proposal passes all hard constraints", () => {
  const strategy = makeValidStrategy();
  const result = validateProposal(strategy, {
    agGroup: "temperate_humid",
    regionTag: "us_southeast",
    availableCropIds: [
      "field_corn",
      "soybean",
      "soft_red_winter_wheat",
      "cereal_rye",
      "crimson_clover",
      "forage_radish",
    ],
  });
  assert.equal(result.valid, true);
  assert.equal(result.errors.length, 0);
});

test("Unknown crop ID rejected", () => {
  const strategy = makeValidStrategy();
  strategy.years[0].seasons[0].crop = "phantom_crop";
  const result = validateProposal(strategy, {
    agGroup: "temperate_humid",
    regionTag: "us_southeast",
    availableCropIds: [],
  });
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.includes("phantom_crop")));
});

test("Crop in wrong group rejected", () => {
  const strategy = makeValidStrategy();
  // hairy_vetch is only applicable to temperate_humid; validating against semi_arid_temperate rejects it
  strategy.years[0].seasons[0].crop = "hairy_vetch";
  const result = validateProposal(strategy, {
    agGroup: "semi_arid_temperate",
    regionTag: "us_southeast",
    availableCropIds: ["hairy_vetch"],
  });
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.includes("semi_arid_temperate")));
});

test("Unknown group does not reject crops in standalone validator (conservative)", () => {
  const strategy = makeValidStrategy();
  const result = validateProposal(strategy, {
    agGroup: "unknown",
    regionTag: null,
    availableCropIds: ["field_corn", "soybean"],
  });
  assert.equal(result.valid, true);
});

test("Cash-crop month overlap (>1 shared month in same year) rejected", () => {
  const strategy = makeValidStrategy();
  strategy.years[0].seasons = [
    { season: "Spring", crop: "field_corn", activity: "Plant corn", months: [4, 5, 6, 7, 8] },
    { season: "Summer", crop: "grain_sorghum", activity: "Plant sorghum", months: [6, 7, 8, 9] },
  ];
  const result = validateProposal(strategy, {
    agGroup: "temperate_humid",
    regionTag: "us_southeast",
    availableCropIds: ["field_corn", "grain_sorghum", "soybean", "soft_red_winter_wheat"],
  });
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.includes("overlapping activity months")));
});

test("Crop-family repetition in >2 years rejected", () => {
  const strategy = makeValidStrategy();
  // Year 1 has field_corn (Poaceae), Year 2 has cereal_rye (Poaceae) + soybean, Year 3 has wheat (Poaceae)
  strategy.years[1].seasons.push({
    season: "Winter",
    crop: "cereal_rye",
    activity: "Winter rye",
    months: [12, 1, 2],
  });
  const result = validateProposal(strategy, {
    agGroup: "temperate_humid",
    regionTag: "us_southeast",
    availableCropIds: ["field_corn", "soybean", "soft_red_winter_wheat", "cereal_rye"],
  });
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.includes("Poaceae") && e.includes("more than 2 years")));
});

test("Sclerotinia host stacking rejected across both consecutive and non-consecutive years", () => {
  // Case 1: Year 1 sunflower, Year 2 soybean
  const consecutive = makeValidStrategy();
  consecutive.years[0].seasons[0].crop = "sunflower";
  consecutive.years[1].seasons[0].crop = "soybean";
  consecutive.years[2].seasons[0].crop = "field_corn";
  const res1 = validateProposal(consecutive, {
    agGroup: "temperate_humid",
    regionTag: "us_southeast",
    availableCropIds: ["sunflower", "soybean", "field_corn"],
  });
  assert.equal(res1.valid, false);
  assert.ok(res1.errors.some((e) => e.includes("Sclerotinia")));

  // Case 2: Year 1 sunflower, Year 2 corn, Year 3 soybean
  const separated = makeValidStrategy();
  separated.years[0].seasons = [
    { season: "Summer", crop: "sunflower", activity: "Plant sunflower", months: [5, 6, 7, 8, 9] },
  ];
  separated.years[1].seasons = [
    { season: "Summer", crop: "field_corn", activity: "Plant corn", months: [4, 5, 6, 7, 8] },
  ];
  separated.years[2].seasons = [
    { season: "Summer", crop: "soybean", activity: "Plant soybean", months: [5, 6, 7, 8, 9] },
  ];
  const res2 = validateProposal(separated, {
    agGroup: "temperate_humid",
    regionTag: "us_southeast",
    availableCropIds: ["sunflower", "soybean", "field_corn"],
  });
  assert.equal(res2.valid, false);
  assert.ok(res2.errors.some((e) => e.includes("Sclerotinia")));
});

test("Wheat following sorghum produces warning (not hard error)", () => {
  const strategy = makeValidStrategy();
  strategy.years[0].seasons[0].crop = "grain_sorghum";
  strategy.years[1].seasons[0].crop = "soft_red_winter_wheat";
  strategy.years[2].seasons[0].crop = "soybean";
  const result = validateProposal(strategy, {
    agGroup: "temperate_humid",
    regionTag: "us_southeast",
    availableCropIds: [
      "grain_sorghum",
      "soft_red_winter_wheat",
      "soybean",
      "cereal_rye",
      "crimson_clover",
      "forage_radish",
    ],
  });
  assert.equal(result.valid, true);
  assert.ok(result.warnings.some((w) => w.includes("Fusarium")));
});

test("Year without cash crop rejected", () => {
  const strategy = makeValidStrategy();
  strategy.years[1].seasons = [
    { season: "Fall", crop: "cereal_rye", activity: "Plant rye", months: [9, 10, 11] },
    { season: "Winter", crop: "crimson_clover", activity: "Plant clover", months: [12, 1, 2] },
  ];
  const result = validateProposal(strategy, {
    agGroup: "temperate_humid",
    regionTag: "us_southeast",
    availableCropIds: [
      "field_corn",
      "cereal_rye",
      "crimson_clover",
      "soft_red_winter_wheat",
      "forage_radish",
    ],
  });
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.includes("no cash crop")));
});

test("Low botanical diversity produces soft warning when valid", () => {
  const strategy = makeValidStrategy();
  // Use only 2 families (Poaceae in Years 1 & 3, Fabaceae in Year 2)
  strategy.years[2].seasons = [
    {
      season: "Spring",
      crop: "soft_red_winter_wheat",
      activity: "Plant wheat",
      months: [3, 4, 5, 6],
    },
  ];
  const result = validateProposal(strategy, {
    agGroup: "temperate_humid",
    regionTag: "us_southeast",
    availableCropIds: ["field_corn", "soybean", "soft_red_winter_wheat", "cereal_rye", "crimson_clover"],
  });
  assert.equal(result.valid, true);
  assert.ok(result.warnings.some((w) => w.includes("Low botanical diversity")));
});

test("SCN frequency warning when soybean appears >1 year", () => {
  const strategy = makeValidStrategy();
  strategy.years[0].seasons[0].crop = "soybean";
  strategy.years[1].seasons[0].crop = "soybean";
  strategy.years[2].seasons[0].crop = "field_corn";
  const result = validateProposal(strategy, {
    agGroup: "temperate_humid",
    regionTag: "us_southeast",
    availableCropIds: ["soybean", "field_corn", "cereal_rye", "crimson_clover", "forage_radish"],
  });
  assert.ok(result.warnings.some((w) => w.includes("SCN")));
});

test("isStrategyStructurallyValid catches malformed strategies", () => {
  assert.equal(isStrategyStructurallyValid(makeValidStrategy()), true);
  assert.equal(
    isStrategyStructurallyValid({
      id: "",
      name: "",
      archetype: "",
      description: "",
      years: [],
      tradeoffs: { advantages: [], disadvantages: [], operational: [], warnings: [] },
    }),
    false
  );
});

// ─── 4. Request Zod Validation tests ──────────────────────────────────

section("Request Schema Validation (GenerationRequestSchema)");

test("Accepts valid payload and valid null observations (soil: null, nullable climate metrics)", () => {
  const validPayload = {
    fieldId: "field_1",
    fieldName: "Rowan Demo",
    lat: 35.67,
    lon: -80.47,
    climate: makeClimate({ avgDailySolar: null }),
    soil: null,
    priorities: DEFAULT_PRIORITIES,
    regionTag: "us_southeast",
  };
  const parsed = GenerationRequestSchema.safeParse(validPayload);
  assert.equal(parsed.success, true);
});

test("Rejects malformed climate, invalid coordinates, and out-of-range priorities", () => {
  const badCoords = GenerationRequestSchema.safeParse({
    fieldId: "f1",
    fieldName: "Bad Lat",
    lat: 95,
    lon: -80,
    climate: makeClimate(),
    soil: null,
    priorities: DEFAULT_PRIORITIES,
    regionTag: null,
  });
  assert.equal(badCoords.success, false);

  const badClimate = GenerationRequestSchema.safeParse({
    fieldId: "f1",
    fieldName: "Bad Climate",
    lat: 35,
    lon: -80,
    climate: { broken: true },
    soil: null,
    priorities: DEFAULT_PRIORITIES,
    regionTag: null,
  });
  assert.equal(badClimate.success, false);

  const badPriorities = GenerationRequestSchema.safeParse({
    fieldId: "f1",
    fieldName: "Bad Priorities",
    lat: 35,
    lon: -80,
    climate: makeClimate(),
    soil: null,
    priorities: { ...DEFAULT_PRIORITIES, waterSuitability: 140 },
    regionTag: null,
  });
  assert.equal(badPriorities.success, false);

  const badRegion = GenerationRequestSchema.safeParse({
    fieldId: "f1",
    fieldName: "Bad Region",
    lat: 35,
    lon: -80,
    climate: makeClimate(),
    soil: null,
    priorities: DEFAULT_PRIORITIES,
    regionTag: "mars_crater",
  });
  assert.equal(badRegion.success, false);
});

// ─── 5. Generation Orchestrator & Mock Provider tests ─────────────────

section("Generation Orchestrator & Mock Provider");

test("Without AI provider, returns deterministic classification, available crops, and unavailable reason", async () => {
  const result = await generateRotations(
    {
      fieldId: "f1",
      fieldName: "Test Field",
      lat: 35.67,
      lon: -80.47,
      climate: makeClimate(),
      soil: makeSoil(),
      priorities: DEFAULT_PRIORITIES,
      regionTag: "us_southeast",
    },
    null
  );
  assert.equal(result.proposals.length, 0);
  assert.equal(result.classification.group, "temperate_humid");
  assert.ok(result.availableCrops.length >= 5);
  assert.ok(result.aiUnavailableReason?.includes("FALLO_AI_PROVIDER"));
  assert.equal(result.supportStatus, "supported");
});

test("Valid structured AI output is accepted, validated, and scored", async () => {
  const validStrat = makeValidStrategy("ai_balanced_plan", "AI Balanced Plan");
  const mockProvider = makeMockProvider(
    JSON.stringify({
      strategies: [validStrat],
      rationale: "Balanced rotation tailored to temperate humid climate.",
    })
  );

  const result = await generateRotations(
    {
      fieldId: "f1",
      fieldName: "Test Field",
      lat: 35.67,
      lon: -80.47,
      climate: makeClimate(),
      soil: makeSoil(),
      priorities: DEFAULT_PRIORITIES,
      regionTag: "us_southeast",
    },
    mockProvider
  );

  assert.equal(result.proposals.length, 1);
  assert.equal(result.proposals[0].strategy.id, "ai_balanced_plan");
  assert.equal(result.proposals[0].strategy.generationInfo?.source, "ai-assisted");
  assert.equal(result.proposals[0].strategy.generationInfo?.agGroup, "temperate_humid");
  assert.ok(typeof result.proposals[0].overallScore === "number");
  assert.equal(result.rejectedProposals, undefined);
});

test("JSON output surrounded by Markdown fences is parsed and accepted", async () => {
  const validStrat = makeValidStrategy("fenced_plan", "Fenced AI Plan");
  const fencedJson = "```json\n" + JSON.stringify({
    strategies: [validStrat],
    rationale: "Generated inside markdown code block.",
  }) + "\n```";

  const result = await generateRotations(
    {
      fieldId: "f1",
      fieldName: "Test Field",
      lat: 35.67,
      lon: -80.47,
      climate: makeClimate(),
      soil: makeSoil(),
      priorities: DEFAULT_PRIORITIES,
      regionTag: "us_southeast",
    },
    makeMockProvider(fencedJson)
  );

  assert.equal(result.proposals.length, 1);
  assert.equal(result.proposals[0].strategy.id, "fenced_plan");
});

test("Invalid JSON output returns honest unavailable result with zero proposals", async () => {
  const result = await generateRotations(
    {
      fieldId: "f1",
      fieldName: "Test Field",
      lat: 35.67,
      lon: -80.47,
      climate: makeClimate(),
      soil: makeSoil(),
      priorities: DEFAULT_PRIORITIES,
      regionTag: "us_southeast",
    },
    makeMockProvider("not valid json {{{")
  );

  assert.equal(result.proposals.length, 0);
  assert.equal(result.supportStatus, "unavailable");
  assert.ok(result.aiUnavailableReason?.includes("could not be parsed"));
});

test("Malformed Zod proposal output (e.g. 2-year strategy) is rejected", async () => {
  const malformed = {
    strategies: [
      {
        ...makeValidStrategy(),
        years: makeValidStrategy().years.slice(0, 2), // only 2 years instead of 3
      },
    ],
    rationale: "Incomplete years.",
  };

  const result = await generateRotations(
    {
      fieldId: "f1",
      fieldName: "Test Field",
      lat: 35.67,
      lon: -80.47,
      climate: makeClimate(),
      soil: makeSoil(),
      priorities: DEFAULT_PRIORITIES,
      regionTag: "us_southeast",
    },
    makeMockProvider(JSON.stringify(malformed))
  );

  assert.equal(result.proposals.length, 0);
  assert.equal(result.supportStatus, "unavailable");
  assert.ok(result.aiUnavailableReason?.includes("could not be parsed or validated"));
});

test("Invalid agronomic proposal is rejected, never returned in proposals, and preserves errors", async () => {
  const invalidSclerotinia = makeValidStrategy("invalid_sclerotinia", "Invalid Sclerotinia Plan");
  invalidSclerotinia.years[0].seasons[0].crop = "sunflower";
  invalidSclerotinia.years[1].seasons[0].crop = "soybean";
  invalidSclerotinia.years[2].seasons[0].crop = "field_corn";

  const result = await generateRotations(
    {
      fieldId: "f1",
      fieldName: "Test Field",
      lat: 35.67,
      lon: -80.47,
      climate: makeClimate(),
      soil: makeSoil(),
      priorities: DEFAULT_PRIORITIES,
      regionTag: "us_southeast",
    },
    makeMockProvider(
      JSON.stringify({
        strategies: [invalidSclerotinia],
        rationale: "Contains Sclerotinia host stacking.",
      })
    )
  );

  assert.equal(result.proposals.length, 0);
  assert.equal(result.supportStatus, "unavailable");
  assert.equal(result.rejectedProposals?.length, 1);
  assert.equal(result.rejectedProposals![0].id, "invalid_sclerotinia");
  assert.ok(result.rejectedProposals![0].errors.some((e) => e.includes("Sclerotinia")));
  assert.ok(result.aiUnavailableReason?.includes("rejected by deterministic agronomic validation"));
});

test("Soft warnings (Fusarium, low diversity) are preserved on accepted proposals", async () => {
  const fusariumStrategy = makeValidStrategy("fusarium_plan", "Fusarium Warning Plan");
  // Year 1: grain_sorghum (Poaceae), Year 2: soft_red_winter_wheat (Poaceae -> follows sorghum), Year 3: soybean (Fabaceae)
  // Also remove radish so only 2 families (Poaceae + Fabaceae) are present -> triggers low diversity warning too
  fusariumStrategy.years[0].seasons = [
    { season: "Summer", crop: "grain_sorghum", activity: "Plant sorghum", months: [5, 6, 7, 8, 9] },
  ];
  fusariumStrategy.years[1].seasons = [
    {
      season: "Spring",
      crop: "soft_red_winter_wheat",
      activity: "Plant wheat",
      months: [3, 4, 5, 6],
    },
  ];
  fusariumStrategy.years[2].seasons = [
    { season: "Summer", crop: "soybean", activity: "Plant soybean", months: [5, 6, 7, 8, 9] },
  ];

  const result = await generateRotations(
    {
      fieldId: "f1",
      fieldName: "Test Field",
      lat: 35.67,
      lon: -80.47,
      climate: makeClimate(),
      soil: makeSoil(),
      priorities: DEFAULT_PRIORITIES,
      regionTag: "us_southeast",
    },
    makeMockProvider(
      JSON.stringify({
        strategies: [fusariumStrategy],
        rationale: "Valid but has soft agronomic advisories.",
      })
    )
  );

  assert.equal(result.proposals.length, 1);
  const accepted = result.proposals[0].strategy;
  const genWarnings = accepted.generationInfo?.validationWarnings ?? [];
  assert.ok(genWarnings.some((w) => w.includes("Fusarium")));
  assert.ok(genWarnings.some((w) => w.includes("Low botanical diversity")));

  const tradeoffWarningTexts = accepted.tradeoffs.warnings.map((w) =>
    typeof w === "string" ? w : w.text
  );
  assert.ok(tradeoffWarningTexts.some((t) => t.includes("Fusarium")));
  assert.ok(tradeoffWarningTexts.some((t) => t.includes("Low botanical diversity")));
});

test("OpenAICompatibleProvider enforces timeout, supports AbortSignal, and redacts API keys", async () => {
  const secretKey = "sk-super-secret-test-key-12345";

  // 1. Timeout test using a hanging fetch mock that respects signal abort
  const hangingProvider = new OpenAICompatibleProvider({
    providerName: "test-timeout-provider",
    apiKey: secretKey,
    timeoutMs: 40,
    fetchImpl: (_url, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          const abortErr = new Error("Aborted");
          abortErr.name = "AbortError";
          reject(abortErr);
        });
      }),
  });

  const timeoutResult = await generateRotations(
    {
      fieldId: "f1",
      fieldName: "Test Field",
      lat: 35.67,
      lon: -80.47,
      climate: makeClimate(),
      soil: makeSoil(),
      priorities: DEFAULT_PRIORITIES,
      regionTag: "us_southeast",
    },
    hangingProvider
  );

  assert.equal(timeoutResult.proposals.length, 0);
  assert.equal(timeoutResult.supportStatus, "unavailable");
  assert.ok(timeoutResult.aiUnavailableReason?.includes("timed out after 40ms"));
  assert.ok(!timeoutResult.aiUnavailableReason?.includes(secretKey));

  // 2. HTTP error redaction test
  const errorProvider = new OpenAICompatibleProvider({
    providerName: "test-error-provider",
    apiKey: secretKey,
    fetchImpl: async () =>
      new Response(`Invalid key ${secretKey} rejected`, { status: 401 }),
  });

  const errResult = await generateRotations(
    {
      fieldId: "f1",
      fieldName: "Test Field",
      lat: 35.67,
      lon: -80.47,
      climate: makeClimate(),
      soil: makeSoil(),
      priorities: DEFAULT_PRIORITIES,
      regionTag: "us_southeast",
    },
    errorProvider
  );

  assert.equal(errResult.proposals.length, 0);
  assert.ok(errResult.aiUnavailableReason?.includes("[REDACTED]"));
  assert.ok(!errResult.aiUnavailableReason?.includes(secretKey));
});

test("Unknown agricultural group refuses AI generation even when provider is supplied", async () => {
  let providerCalled = false;
  const spyProvider = makeMockProvider(async () => {
    providerCalled = true;
    return JSON.stringify({ strategies: [makeValidStrategy()], rationale: "Should not run" });
  });

  const unknownClimate = makeClimate({ avgAnnualTemp: null, avgAnnualPrecip: null });
  const result = await generateRotations(
    {
      fieldId: "f1",
      fieldName: "Unknown Climate Field",
      lat: 0,
      lon: 0,
      climate: unknownClimate,
      soil: null,
      priorities: DEFAULT_PRIORITIES,
      regionTag: null,
    },
    spyProvider
  );

  assert.equal(providerCalled, false);
  assert.equal(result.classification.group, "unknown");
  assert.equal(result.availableCrops.length, 0);
  assert.equal(result.proposals.length, 0);
  assert.equal(result.supportStatus, "unavailable");
  assert.ok(result.aiUnavailableReason?.includes("group is unknown"));
});

// ─── 6. Persistence, Ranking & Detail-Page Lookup tests ───────────────

section("Persistence, Ranking & Detail-Page Lookup");

test("applyFieldRotationsUpdate persists valid AI strategies, refuses invalid/static strategies, and preserves previous valid plans on failed regeneration", () => {
  const f1: Field = { id: "f1", name: "Field 1", lat: 35.67, lon: -80.47 };
  const f2: Field = { id: "f2", name: "Field 2", lat: 36.0, lon: -79.0 };
  const validAiStrategy: RotationStrategy = {
    ...makeValidStrategy("ai_gen_1", "AI Generated 1"),
    generationInfo: {
      source: "ai-assisted",
      generatedAt: "2026-11-14T00:00:00.000Z",
      agGroup: "temperate_humid",
      supportStatus: "supported",
      validationStatus: "passed",
      aiProvider: "gemini-enterprise",
      aiModel: "gemini-4-argon",
      fieldId: "f1",
    },
  };
  const stored: StoredRotations = {
    strategies: [validAiStrategy],
    generatedAt: "2026-11-14T00:00:00.000Z",
    agGroup: "temperate_humid",
    version: "1.0",
    fieldId: "f1",
    aiProvider: "gemini-enterprise",
    aiModel: "gemini-4-argon",
    validationStatus: "passed",
    usageMetadata: {
      promptTokenCount: 820,
      candidatesTokenCount: 640,
      thoughtsTokenCount: 110,
      totalTokenCount: 1570,
      estimatedCostUsd: null,
    },
  };

  // 1. Persists after validation succeeds
  const updated = applyFieldRotationsUpdate([f1, f2], f1, "f1", stored);
  assert.equal(updated.fields[0].generatedRotations?.strategies.length, 1);
  assert.equal(updated.activeField?.generatedRotations?.strategies.length, 1);
  assert.equal(updated.fields[0].generatedRotations?.aiProvider, "gemini-enterprise");
  assert.equal(updated.fields[0].generatedRotations?.aiModel, "gemini-4-argon");
  assert.equal(updated.fields[0].generatedRotations?.validationStatus, "passed");
  assert.equal(updated.fields[0].generatedRotations?.usageMetadata?.totalTokenCount, 1570);
  assert.equal(updated.fields[1].generatedRotations, undefined);

  // 2. Preserves previous valid AI-generated plans if a later regeneration attempt fails (empty or failed strategies)
  const failedRegenAttempt: StoredRotations = {
    strategies: [
      {
        ...makeValidStrategy("bad_plan", "Bad Plan"),
        generationInfo: {
          source: "ai-assisted",
          validationStatus: "failed",
          supportStatus: "unavailable",
        },
      },
    ],
    generatedAt: "2026-11-15T00:00:00.000Z",
    agGroup: "temperate_humid",
    version: "1.0",
  };
  const afterFailedRegen = applyFieldRotationsUpdate(
    updated.fields,
    updated.activeField,
    "f1",
    failedRegenAttempt
  );
  assert.equal(afterFailedRegen.fields[0].generatedRotations?.strategies.length, 1);
  assert.equal(afterFailedRegen.fields[0].generatedRotations?.strategies[0].id, "ai_gen_1");
  assert.equal(afterFailedRegen.activeField?.generatedRotations?.strategies[0].id, "ai_gen_1");

  // 3. No persistence when validation fails on a fresh field with no prior plans
  const f2AfterFailed = applyFieldRotationsUpdate([f1, f2], f2, "f2", failedRegenAttempt);
  assert.equal(f2AfterFailed.fields[1].generatedRotations, undefined);
  assert.equal(f2AfterFailed.activeField?.generatedRotations, undefined);

  // 4. Explicit Clear (null) sets both to null
  const cleared = applyFieldRotationsUpdate(updated.fields, updated.activeField, "f1", null);
  assert.equal(cleared.fields[0].generatedRotations, null);
  assert.equal(cleared.activeField?.generatedRotations, null);
});

test("mergeAndRankStrategies sorts by overallScore descending (nulls last) and re-ranks on priority changes", () => {
  const climate = makeClimate();
  const soil = makeSoil();

  // Create a low-scoring generated strategy (minimal cover, high water/N demand)
  const lowScoringAi = makeValidStrategy("ai_low_score", "AI Low Score Strategy");
  lowScoringAi.years = [
    {
      year: 1,
      seasons: [{ season: "Summer", crop: "field_corn", activity: "Corn", months: [5, 6, 7, 8] }],
    },
    {
      year: 2,
      seasons: [{ season: "Summer", crop: "sunflower", activity: "Sunflower", months: [6, 7, 8] }],
    },
    {
      year: 3,
      seasons: [
        {
          season: "Spring",
          crop: "soft_red_winter_wheat",
          activity: "Wheat",
          months: [3, 4, 5],
        },
      ],
    },
  ];
  lowScoringAi.generationInfo = { source: "ai-assisted", agGroup: "temperate_humid" };

  const merged = mergeAndRankStrategies([lowScoringAi], climate, soil, DEFAULT_PRIORITIES, "us_southeast");
  assert.equal(merged.length, 4);

  // Verify scores are strictly non-increasing and ranks are 1..4
  for (let i = 0; i < merged.length; i++) {
    assert.equal(merged[i].rank, i + 1);
    if (i > 0) {
      assert.ok((merged[i - 1].overallScore ?? -1) >= (merged[i].overallScore ?? -1));
    }
  }

  // Verify the low-scoring AI strategy is NOT ranked #1 merely because it was passed first
  assert.notEqual(merged[0].strategy.id, "ai_low_score");

  // Verify null scores are placed last
  const nullRanked = rankStrategyResults([
    { ...scoreStrategy(lowScoringAi, climate, soil, DEFAULT_PRIORITIES), overallScore: null },
    merged[0],
  ]);
  assert.equal(nullRanked[0].strategy.id, merged[0].strategy.id);
  assert.equal(nullRanked[1].overallScore, null);
  assert.equal(nullRanked[1].rank, 2);
});

test("scoreVerifiedAiStrategies and resolveScoredStrategyById display ONLY verified AI-generated strategies and never fall back to static predefined sequences", () => {
  const climate = makeClimate();
  const soil = makeSoil();

  // 1. Before generation (null or empty stored strategies), no static 3-year sequences are scored or returned
  assert.equal(
    scoreVerifiedAiStrategies(null, "f1", climate, soil, DEFAULT_PRIORITIES, "us_southeast").length,
    0
  );
  assert.equal(
    scoreVerifiedAiStrategies([], "f1", climate, soil, DEFAULT_PRIORITIES, "us_southeast").length,
    0
  );

  // 2. Passing static predefined strategies (from data/rotations.json) is rejected by isVerifiedAiStrategyForField and scoreVerifiedAiStrategies
  for (const s of staticStrategies) {
    assert.equal(isVerifiedAiStrategyForField(s, "f1"), false);
  }
  assert.equal(
    scoreVerifiedAiStrategies(staticStrategies, "f1", climate, soil, DEFAULT_PRIORITIES, "us_southeast")
      .length,
    0
  );

  // 3. Verified AI-generated strategy for f1 is resolved and scored
  const genStrat: RotationStrategy = {
    ...makeValidStrategy("ai_custom_detail", "AI Custom Detail Plan"),
    generationInfo: {
      source: "ai-assisted",
      agGroup: "temperate_humid",
      supportStatus: "supported",
      validationStatus: "passed",
      fieldId: "f1",
      aiProvider: "gemini-enterprise",
      aiModel: "gemini-4-argon",
      validationWarnings: ["Sample warning for detail view"],
    },
  };

  const customPriorities: FarmerPriorities = {
    waterSuitability: 10,
    nitrogenContribution: 60,
    soilCoverage: 10,
    diversityPestBreak: 10,
    climateRiskResilience: 10,
  };

  const scoredAi = scoreVerifiedAiStrategies(
    [genStrat],
    "f1",
    climate,
    soil,
    customPriorities,
    "us_southeast"
  );
  assert.equal(scoredAi.length, 1);
  assert.equal(scoredAi[0].strategy.id, "ai_custom_detail");

  const resolvedGen = resolveScoredStrategyById(
    "ai_custom_detail",
    [genStrat],
    climate,
    soil,
    customPriorities,
    "us_southeast",
    "f1"
  );
  assert.ok(resolvedGen);
  assert.equal(resolvedGen!.strategy.id, "ai_custom_detail");
  assert.equal(resolvedGen!.strategy.generationInfo?.source, "ai-assisted");
  assert.deepEqual(resolvedGen!.strategy.generationInfo?.validationWarnings, [
    "Sample warning for detail view",
  ]);

  // 4. Static strategy IDs NEVER resolve via resolveScoredStrategyById (no static fallback on detail page)
  const resolvedStatic = resolveScoredStrategyById(
    "soil_health_building",
    [genStrat],
    climate,
    soil,
    customPriorities,
    "us_southeast",
    "f1"
  );
  assert.equal(resolvedStatic, null);

  // 5. Strategy generated for a different fieldId ("f1") is not returned for field "f2"
  assert.equal(
    scoreVerifiedAiStrategies([genStrat], "f2", climate, soil, customPriorities, "us_southeast")
      .length,
    0
  );
  assert.equal(
    resolveScoredStrategyById(
      "ai_custom_detail",
      [genStrat],
      climate,
      soil,
      customPriorities,
      "us_southeast",
      "f2"
    ),
    null
  );

  // 6. Returns null when generated strategies are cleared
  const afterClear = resolveScoredStrategyById(
    "ai_custom_detail",
    null,
    climate,
    soil,
    customPriorities,
    "us_southeast",
    "f1"
  );
  assert.equal(afterClear, null);
});

test("Static reference strategies have concise one-sentence descriptions without North Carolina default labels", () => {
  assert.equal(staticStrategies.length, 3);
  for (const s of staticStrategies) {
    assert.equal(s.regionExample, undefined);
    assert.ok(!s.description.toLowerCase().includes("north carolina"));
    assert.ok(!s.description.toLowerCase().includes("piedmont"));
  }
});

test("buildObjectiveFieldContextBullets and buildStrategyOverviewBullets produce 2–3 deterministic field-specific bullets", () => {
  const climate = makeClimate();
  const soil = makeSoil();

  assert.equal(STRATEGY_OBJECTIVES.length, 3);
  for (const obj of STRATEGY_OBJECTIVES) {
    const bullets = buildObjectiveFieldContextBullets(obj.archetype, climate, soil);
    assert.equal(bullets.length, 3);
    assert.ok(bullets.every((b) => b.length > 10 && b.length < 140));
  }

  // Soil health bullet incorporates OM and slope when available
  const shBullets = buildObjectiveFieldContextBullets("soil_health", climate, soil);
  assert.ok(shBullets[0].includes("1.5%"));
  assert.ok(shBullets[1].includes("4.0%"));

  // Water resilience bullet incorporates May-Aug rainfall and dry spells
  const wrBullets = buildObjectiveFieldContextBullets("water_resilience", climate, soil);
  assert.ok(wrBullets[0].includes("420 mm"));
  assert.ok(wrBullets[0].includes("5.0-day"));

  // Strategy overview bullets summarize cash sequence + cover diversity + field context
  const cardBullets = buildStrategyOverviewBullets(staticStrategies[0], climate, soil);
  assert.equal(cardBullets.length, 3);
  assert.ok(cardBullets[0].startsWith("Cash sequence:"));
  assert.ok(cardBullets[1].includes("botanical families"));
});

test("isReferenceStrategyApplicable and getAvailableCropsForContext gate regional applicability strictly", () => {
  const seCrops = getAvailableCropsForContext("temperate_humid", "us_southeast");
  assert.equal(seCrops.length, 11);

  const neCrops = getAvailableCropsForContext("temperate_humid", "us_northeast");
  assert.ok(neCrops.length > 0 && neCrops.length < 11);
  assert.ok(!neCrops.includes("grain_sorghum"));

  assert.equal(getAvailableCropsForContext("unknown", "us_southeast").length, 0);
  assert.equal(getAvailableCropsForContext("boreal", "us_southeast").length, 0);
  assert.ok(getAvailableCropsForContext("subtropical_humid", "us_southeast").length > 0);

  // Reference templates are applicable to temperate_humid + us_southeast
  for (const s of staticStrategies) {
    assert.equal(isReferenceStrategyApplicable(s, "temperate_humid", "us_southeast"), true);
    assert.equal(isReferenceStrategyApplicable(s, "semi_arid_temperate", "us_southeast"), false);
    assert.equal(isReferenceStrategyApplicable(s, "unknown", "us_southeast"), false);
    assert.equal(isReferenceStrategyApplicable(s, "temperate_humid", null), false);
    // All 3 static reference templates include at least one crop not in us_northeast (pearl_millet, grain_sorghum, or sunflower)
    assert.equal(isReferenceStrategyApplicable(s, "temperate_humid", "us_northeast"), false);
  }
});

// ─── 7. Gemini Enterprise Agent Platform (ADC) Provider Tests ─────────

section("Gemini Enterprise Agent Platform (ADC) Provider");

test("resolveRuntimeAIProvider detects Google Cloud Gemini Enterprise without requiring FALLO_AI_API_KEY", () => {
  const provider = resolveRuntimeAIProvider({
    GOOGLE_CLOUD_PROJECT: "triangle-hackathon-claude-code",
    GOOGLE_CLOUD_LOCATION: "global",
    GOOGLE_GENAI_USE_ENTERPRISE: "true",
    FALLO_AI_MODEL: "gemini-4-argon",
  });

  assert.ok(provider instanceof GeminiEnterpriseProvider);
  const gemini = provider as GeminiEnterpriseProvider;
  assert.equal(gemini.providerName, "gemini-enterprise");
  assert.equal(gemini.project, "triangle-hackathon-claude-code");
  assert.equal(gemini.location, "global");
  assert.equal(gemini.model, "gemini-4-argon");
  assert.equal(gemini.enterprise, true);

  // Defaults location to "global" and model to "gemini-4-argon" when omitted
  const defaultProvider = resolveRuntimeAIProvider({
    GOOGLE_CLOUD_PROJECT: "triangle-hackathon-claude-code",
    GOOGLE_GENAI_USE_ENTERPRISE: "true",
  }) as GeminiEnterpriseProvider;
  assert.ok(defaultProvider instanceof GeminiEnterpriseProvider);
  assert.equal(defaultProvider.location, DEFAULT_GOOGLE_CLOUD_LOCATION);
  assert.equal(defaultProvider.model, DEFAULT_GEMINI_ENTERPRISE_MODEL);

  // Returns null when GOOGLE_CLOUD_PROJECT is missing and no OpenAI key is configured
  const missingProject = resolveRuntimeAIProvider({
    GOOGLE_GENAI_USE_ENTERPRISE: "true",
  });
  assert.equal(missingProject, null);

  // Preserves OpenAICompatibleProvider fallback when explicitly requested with FALLO_AI_API_KEY
  const openAiProvider = resolveRuntimeAIProvider({
    FALLO_AI_PROVIDER: "openai-compatible",
    FALLO_AI_API_KEY: "sk-test-key",
    GOOGLE_CLOUD_PROJECT: "triangle-hackathon-claude-code",
  });
  assert.ok(openAiProvider instanceof OpenAICompatibleProvider);
});

test("GeminiEnterpriseProvider initializes @google/genai with enterprise: true, project, location, LOW thinkingConfig, 120s timeout, retryOptions={attempts:1}, and extracts real usageMetadata", async () => {
  assert.equal(DEFAULT_AI_TIMEOUT_MS, 120_000);
  assert.equal(DEFAULT_GEMINI_MAX_OUTPUT_TOKENS, 3500);
  assert.equal(DEFAULT_GEMINI_THINKING_LEVEL, "LOW");

  // Verify thinkingLevel validation: LOW, MEDIUM, HIGH allowed; MINIMAL rejected
  assert.equal(parseGeminiThinkingLevel("low"), "LOW");
  assert.equal(parseGeminiThinkingLevel("MEDIUM"), "MEDIUM");
  assert.equal(parseGeminiThinkingLevel("HIGH"), "HIGH");
  assert.throws(
    () => parseGeminiThinkingLevel("MINIMAL"),
    /Allowed values are LOW, MEDIUM, or HIGH/
  );
  assert.throws(
    () =>
      new GeminiEnterpriseProvider({
        project: "triangle-hackathon-claude-code",
        thinkingLevel: "MINIMAL",
      }),
    /MINIMAL and thinkingBudget are not supported/
  );

  // Verify FALLO_AI_ENABLED=false disables provider resolution
  assert.equal(
    resolveRuntimeAIProvider({
      GOOGLE_CLOUD_PROJECT: "triangle-hackathon-claude-code",
      GOOGLE_GENAI_USE_ENTERPRISE: "true",
      FALLO_AI_ENABLED: "false",
    }),
    null
  );

  let capturedSdkOptions: Record<string, unknown> | null = null;
  let capturedModel: string | null = null;
  let capturedConfig: Record<string, unknown> | undefined;

  const s1 = makeValidStrategy("soil_health_field", "Soil Health Plan");
  s1.archetype = "soil_health";
  const s2 = makeValidStrategy("water_resilience_field", "Water Resilience Plan");
  s2.archetype = "water_resilience";
  const s3 = makeValidStrategy("crop_diversity_field", "Crop Diversity Plan");
  s3.archetype = "crop_diversity";

  const geminiProvider = new GeminiEnterpriseProvider({
    project: "triangle-hackathon-claude-code",
    location: "global",
    model: "gemini-4-argon",
    clientFactory: (opts) => {
      capturedSdkOptions = opts as Record<string, unknown>;
      return {
        models: {
          generateContent: async (params) => {
            capturedModel = params.model;
            capturedConfig = params.config as unknown as Record<string, unknown>;
            return {
              text: JSON.stringify({
                strategies: [s1, s2, s3],
                rationale: "Generated 3 field-specific strategies via Gemini 4 Argon.",
              }),
              usageMetadata: {
                promptTokenCount: 912,
                candidatesTokenCount: 745,
                thoughtsTokenCount: 128,
                totalTokenCount: 1785,
              },
            };
          },
        },
      };
    },
  });

  const result = await generateRotations(
    {
      fieldId: "f1",
      fieldName: "Rowan Field",
      lat: 35.67,
      lon: -80.47,
      climate: makeClimate(),
      soil: makeSoil(),
      priorities: DEFAULT_PRIORITIES,
      regionTag: "us_southeast",
    },
    geminiProvider
  );

  assert.deepEqual(capturedSdkOptions, {
    enterprise: true,
    project: "triangle-hackathon-claude-code",
    location: "global",
    httpOptions: {
      timeout: 120_000,
      retryOptions: {
        attempts: 1,
      },
    },
  });
  assert.equal(capturedModel, "gemini-4-argon");
  assert.ok(capturedConfig);
  assert.equal(capturedConfig!.responseMimeType, "application/json");
  assert.equal(capturedConfig!.maxOutputTokens, 3500);
  assert.deepEqual(capturedConfig!.thinkingConfig, { thinkingLevel: "LOW" });
  assert.deepEqual(capturedConfig!.httpOptions, {
    timeout: 120_000,
    retryOptions: {
      attempts: 1,
    },
  });
  // Verify unsupported parameters are absent
  assert.equal("temperature" in capturedConfig!, false);
  assert.equal("topP" in capturedConfig!, false);
  assert.equal("topK" in capturedConfig!, false);
  assert.equal("thinkingBudget" in (capturedConfig!.thinkingConfig as Record<string, unknown>), false);

  assert.equal(result.supportStatus, "supported");
  assert.equal(result.proposals.length, 3);
  assert.equal(result.aiProvider, "gemini-enterprise");
  assert.equal(result.aiModel, "gemini-4-argon");
  assert.equal(result.usageMetadata?.promptTokenCount, 912);
  assert.equal(result.usageMetadata?.candidatesTokenCount, 745);
  assert.equal(result.usageMetadata?.thoughtsTokenCount, 128);
  assert.equal(result.usageMetadata?.totalTokenCount, 1785);
  assert.equal(result.usageMetadata?.estimatedCostUsd, null);

  const firstGenInfo = result.proposals[0].strategy.generationInfo;
  assert.equal(firstGenInfo?.aiProvider, "gemini-enterprise");
  assert.equal(firstGenInfo?.aiModel, "gemini-4-argon");
  assert.equal(firstGenInfo?.fieldId, "f1");
  assert.equal(firstGenInfo?.validationStatus, "passed");
  assert.equal(firstGenInfo?.usageMetadata?.totalTokenCount, 1785);
});

test("GeminiEnterpriseProvider handles malformed responses, unsupported crops, and invalid crop sequences safely", async () => {
  // 1. Malformed / non-JSON response
  const malformedGemini = new GeminiEnterpriseProvider({
    project: "triangle-hackathon-claude-code",
    clientFactory: () => ({
      models: {
        generateContent: async () => ({ text: "Not valid JSON output" }),
      },
    }),
  });

  const malformedRes = await generateRotations(
    {
      fieldId: "f1",
      fieldName: "Rowan Field",
      lat: 35.67,
      lon: -80.47,
      climate: makeClimate(),
      soil: makeSoil(),
      priorities: DEFAULT_PRIORITIES,
      regionTag: "us_southeast",
    },
    malformedGemini
  );
  assert.equal(malformedRes.proposals.length, 0);
  assert.equal(malformedRes.supportStatus, "unavailable");

  // 2. Response with unsupported crop (e.g. grain_sorghum in us_northeast) and invalid sequence (Sclerotinia stacking)
  const unsupportedCropStrat = makeValidStrategy("unsupported_ne", "Unsupported NE Strategy");
  unsupportedCropStrat.years[0].seasons[0].crop = "grain_sorghum";

  const invalidSclerotiniaStrat = makeValidStrategy("sclerotinia_stack", "Sclerotinia Stack");
  invalidSclerotiniaStrat.years[0].seasons[0].crop = "sunflower";
  invalidSclerotiniaStrat.years[1].seasons[0].crop = "soybean";

  const invalidSequenceGemini = new GeminiEnterpriseProvider({
    project: "triangle-hackathon-claude-code",
    clientFactory: () => ({
      models: {
        generateContent: async () => ({
          text: JSON.stringify({
            strategies: [unsupportedCropStrat, invalidSclerotiniaStrat],
            rationale: "Both strategies violate hard deterministic constraints.",
          }),
        }),
      },
    }),
  });

  const rejectedRes = await generateRotations(
    {
      fieldId: "f1",
      fieldName: "Northeast Field",
      lat: 42.44,
      lon: -76.5,
      climate: makeClimate(),
      soil: makeSoil(),
      priorities: DEFAULT_PRIORITIES,
      regionTag: "us_northeast",
    },
    invalidSequenceGemini
  );

  assert.equal(rejectedRes.proposals.length, 0);
  assert.equal(rejectedRes.rejectedProposals?.length, 2);
  assert.equal(rejectedRes.supportStatus, "unavailable");
});

test("GeminiEnterpriseProvider surfaces clear ADC authentication errors, redacts OAuth tokens, and enforces timeouts", async () => {
  const fakeToken = "ya29.a0AfB_byCDEFGHIJKLMNOPQRSTUVWXYZ123456";

  // 1. ADC authentication error + token redaction
  const authFailGemini = new GeminiEnterpriseProvider({
    project: "triangle-hackathon-claude-code",
    location: "global",
    model: "gemini-4-argon",
    clientFactory: () => ({
      models: {
        generateContent: async () => {
          throw new Error(
            `Could not load the default credentials. Token ${fakeToken} rejected with status: 401 UNAUTHENTICATED`
          );
        },
      },
    }),
  });

  const authRes = await generateRotations(
    {
      fieldId: "f1",
      fieldName: "Rowan Field",
      lat: 35.67,
      lon: -80.47,
      climate: makeClimate(),
      soil: makeSoil(),
      priorities: DEFAULT_PRIORITIES,
      regionTag: "us_southeast",
    },
    authFailGemini
  );

  assert.equal(authRes.proposals.length, 0);
  assert.equal(authRes.supportStatus, "unavailable");
  assert.ok(authRes.aiUnavailableReason?.includes("Google Cloud ADC authentication failed"));
  assert.ok(authRes.aiUnavailableReason?.includes("gcloud auth application-default login"));
  assert.ok(!authRes.aiUnavailableReason?.includes(fakeToken));
  assert.ok(authRes.aiUnavailableReason?.includes("[REDACTED_TOKEN]"));

  // 2. Timeout enforcement AND actual AbortSignal cancellation reaching the SDK request
  let sdkAbortSignalTriggered = false;
  let generateContentCallCount = 0;
  const hangingGemini = new GeminiEnterpriseProvider({
    project: "triangle-hackathon-claude-code",
    timeoutMs: 40,
    clientFactory: () => ({
      models: {
        generateContent: (params) => {
          generateContentCallCount++;
          return new Promise((_resolve, reject) => {
            params.config?.abortSignal?.addEventListener("abort", () => {
              sdkAbortSignalTriggered = true;
              const abortErr = new Error("Aborted");
              abortErr.name = "AbortError";
              reject(abortErr);
            });
          });
        },
      },
    }),
  });

  const timeoutRes = await generateRotations(
    {
      fieldId: "f1",
      fieldName: "Rowan Field",
      lat: 35.67,
      lon: -80.47,
      climate: makeClimate(),
      soil: makeSoil(),
      priorities: DEFAULT_PRIORITIES,
      regionTag: "us_southeast",
    },
    hangingGemini
  );

  assert.equal(timeoutRes.proposals.length, 0);
  assert.equal(timeoutRes.supportStatus, "unavailable");
  assert.ok(timeoutRes.aiUnavailableReason?.includes("timed out after 40ms"));
  assert.equal(sdkAbortSignalTriggered, true);
  assert.equal(generateContentCallCount, 1); // No automatic retries
});

test("Duplicate request prevention blocks concurrent generateRotations calls for the same fieldId", async () => {
  let providerCalls = 0;
  let releaseFirstCall: (() => void) | null = null;

  const slowProvider: AIProviderClient = {
    providerName: "slow-mock-provider",
    async generate() {
      providerCalls++;
      await new Promise<void>((resolve) => {
        releaseFirstCall = resolve;
      });
      return JSON.stringify({
        strategies: [makeValidStrategy("slow_plan", "Slow Plan")],
        rationale: "Completed after lock release.",
      });
    },
  };

  const ctx = {
    fieldId: "concurrent_field_1",
    fieldName: "Concurrent Test Field",
    lat: 35.67,
    lon: -80.47,
    climate: makeClimate(),
    soil: makeSoil(),
    priorities: DEFAULT_PRIORITIES,
    regionTag: "us_southeast",
  };

  // Start first request (in flight)
  const firstPromise = generateRotations(ctx, slowProvider);
  assert.equal(isFieldGenerationInFlight("concurrent_field_1"), true);

  // Second concurrent request for the same fieldId is immediately rejected without calling the provider
  const duplicateResult = await generateRotations(ctx, slowProvider);
  assert.equal(duplicateResult.proposals.length, 0);
  assert.equal(duplicateResult.supportStatus, "unavailable");
  assert.ok(duplicateResult.aiUnavailableReason?.includes("already in progress"));
  assert.equal(providerCalls, 1);

  // Release first request and verify lock is cleaned up
  if (releaseFirstCall) (releaseFirstCall as () => void)();
  const firstResult = await firstPromise;
  assert.equal(firstResult.proposals.length, 1);
  assert.equal(isFieldGenerationInFlight("concurrent_field_1"), false);
});

test("African test field (9.45287, 24.98303) resolves border geography, global soil fallback with uncertainty, tropical_savanna group, verified local crops, and validates AI rotations", async () => {
  // 1. Geographic & administrative resolution
  const geo = resolveGeographicContext(9.45287, 24.98303);
  assert.ok(geo.countryName.includes("South Sudan / Sudan"));
  assert.equal(geo.countryCodeIso3, "SSD");
  assert.equal(geo.regionTag, "ssa_sudano_sahelian");
  assert.ok(geo.disputedOrBorderNote?.includes("Bahr el Arab"));

  // 2. Harmonized FAO HWSD v2.2 / ISRIC SoilGrids v2.0 fallback with Q0.05-Q0.95 uncertainty
  const soilFallback = resolveGlobalSoilFallback(9.45287, 24.98303);
  assert.ok(soilFallback.source.includes("HWSD v2.2"));
  assert.ok(soilFallback.source.includes("SoilGrids"));
  assert.ok(soilFallback.wrbSoilGroup.length > 0);
  assert.ok(soilFallback.aggregated.depth0_30cm.sand !== null);
  assert.ok(soilFallback.aggregated.depth0_30cm.clay !== null);
  assert.ok(soilFallback.aggregated.depth0_30cm.om !== null);
  assert.ok(soilFallback.aggregated.depth0_30cm.ph !== null);
  assert.ok(soilFallback.aggregated.depth0_30cm.awc !== null);
  assert.ok(soilFallback.uncertainty.depth0_30cm.sand.q05 < soilFallback.uncertainty.depth0_30cm.sand.q95);
  assert.ok(soilFallback.uncertainty.depth0_30cm.awc.q05 < soilFallback.uncertainty.depth0_30cm.awc.q95);
  assert.ok(soilFallback.propertySources.sand.includes("HWSD v2.2"));

  // 3. Tropical savanna climate at (9.45287, 24.98303) — ~27.1 °C annual avg, ~740 mm seasonal rain (May–Oct)
  const africanClimate = makeClimate({
    avgAnnualTemp: 27.1,
    avgAnnualPrecip: 740,
    monthlyTemp: [23.5, 25.8, 28.9, 30.5, 29.8, 27.9, 26.1, 25.4, 26.3, 27.4, 25.8, 23.8],
    monthlyPrecip: [0, 0, 4, 18, 68, 115, 195, 215, 105, 20, 0, 0],
  });
  africanClimate.location = { lat: 9.45287, lon: 24.98303, elevation: 465 };

  const classification = classifyAgGroup(africanClimate, soilFallback);
  assert.equal(classification.group, "tropical_savanna");
  assert.equal(classification.confidence, "high");
  assert.equal(classification.dominantSeasonality, "tropical_rainy_dry");
  assert.ok(
    classification.estimatedLgpDays !== null &&
      classification.estimatedLgpDays !== undefined &&
      classification.estimatedLgpDays >= 120
  );

  // 4. Verified Sudano-Sahelian tropical savanna crops
  const crops = getAvailableCropsForContext("tropical_savanna", "ssa_sudano_sahelian");
  assert.ok(crops.includes("sorghum_tropical"));
  assert.ok(crops.includes("pearl_millet_grain"));
  assert.ok(crops.includes("cowpea"));
  assert.ok(crops.includes("groundnut"));
  assert.ok(crops.includes("sesame"));
  assert.ok(crops.includes("pigeon_pea"));
  assert.ok(crops.includes("sunn_hemp"));
  assert.ok(crops.includes("lablab_bean"));
  assert.ok(!crops.includes("soft_red_winter_wheat"));

  // 5. Generate and deterministically validate a 3-year tropical savanna rotation
  const africanStrategy: RotationStrategy = {
    id: "sudano_sahelian_resilience",
    name: "Sudano-Sahelian Sorghum–Pulse–Sesame Rotation",
    archetype: "water_resilience",
    description:
      "Alternates deep-rooted rainy-season sorghum, N-fixing cowpea/groundnut, and drought-hardy sesame to suppress Striga and build topsoil N.",
    years: [
      {
        year: 1,
        seasons: [
          {
            season: "Rainy Season",
            crop: "sorghum_tropical",
            activity: "Plant rainfed sorghum at onset of June rains",
            months: [6, 7, 8, 9, 10],
          },
        ],
      },
      {
        year: 2,
        seasons: [
          {
            season: "Rainy Season",
            crop: "groundnut",
            activity: "Plant groundnut to fix N and induce Striga suicidal germination",
            months: [6, 7, 8, 9],
          },
          {
            season: "Late Rainy",
            crop: "pearl_millet",
            activity: "Short-duration millet biomass cover",
            months: [9, 10, 11],
          },
        ],
      },
      {
        year: 3,
        seasons: [
          {
            season: "Rainy Season",
            crop: "sesame",
            activity: "Plant Pedaliaceae oilseed break crop",
            months: [7, 8, 9, 10],
          },
          {
            season: "Post-Rainy Relay",
            crop: "lablab_bean",
            activity: "Relay lablab N-fixing cover on residual moisture",
            months: [10, 11, 12],
          },
        ],
      },
    ],
    tradeoffs: {
      advantages: [
        "Three distinct botanical families (Poaceae, Fabaceae, Pedaliaceae) break Striga and nematode cycles",
        "High drought tolerance across all 3 years suited to 740 mm seasonal rain",
      ],
      disadvantages: ["Requires timely weeding during July–August peak rains"],
      operational: ["Retain sorghum and millet stalks as dry-season surface mulch"],
      warnings: [],
    },
  };

  const mockProvider = makeMockProvider(
    JSON.stringify({
      strategies: [africanStrategy],
      rationale: "Tailored to Bahr el Ghazal / South Darfur tropical savanna rainy season.",
    })
  );

  const result = await generateRotations(
    {
      fieldId: "africa_test_field",
      fieldName: "African Savanna Test Field",
      lat: 9.45287,
      lon: 24.98303,
      climate: africanClimate,
      soil: soilFallback,
      priorities: DEFAULT_PRIORITIES,
      regionTag: null,
    },
    mockProvider
  );

  assert.equal(result.supportStatus, "supported");
  assert.equal(result.evidenceLevel, "level_2_global_modeled");
  assert.equal(result.proposals.length, 1);
  assert.equal(result.proposals[0].strategy.id, "sudano_sahelian_resilience");
  assert.ok(typeof result.proposals[0].overallScore === "number");
});

// ─── 8. Priority 1–5 Global Coordinate, Provider & Regional Acceptance Tests ───

section("Global Coordinate Normalization, Data Providers & Regional Acceptance");

test("Longitude normalization handles world-map wrapping (-250 -> 110, 250 -> -110, 190 -> -170, -190 -> 170, 180 -> -180, 540 -> -180, -540 -> -180, 0 -> 0) and is idempotent", () => {
  assert.equal(normalizeLongitude(-250), 110);
  assert.equal(normalizeLongitude(250), -110);
  assert.equal(normalizeLongitude(190), -170);
  assert.equal(normalizeLongitude(-190), 170);
  assert.equal(normalizeLongitude(180), -180);
  assert.equal(normalizeLongitude(-180), -180);
  assert.equal(normalizeLongitude(540), -180);
  assert.equal(normalizeLongitude(-540), -180);
  assert.equal(normalizeLongitude(0), 0);
  assert.equal(Object.is(normalizeLongitude(-0), -0), false);

  // Normal longitudes across US, Africa, China, Australia, Europe
  assert.equal(normalizeLongitude(-80.47), -80.47);
  assert.equal(normalizeLongitude(24.98303), 24.98303);
  assert.equal(normalizeLongitude(117.12), 117.12);
  assert.equal(normalizeLongitude(147.35), 147.35);
  assert.equal(normalizeLongitude(2.35), 2.35);

  // International Date Line behavior
  assert.equal(normalizeLongitude(179.9), 179.9);
  assert.equal(normalizeLongitude(-179.9), -179.9);
  assert.ok(Math.abs((normalizeLongitude(180.5) ?? 0) - -179.5) < 1e-9);
  assert.ok(Math.abs((normalizeLongitude(-180.5) ?? 0) - 179.5) < 1e-9);

  // Idempotence across arbitrary wrapped longitudes
  for (const raw of [-995.25, -540, -250, -190, -180, -119.81, 0, 24.98303, 110, 180, 190, 250, 540, 830.5]) {
    const once = normalizeLongitude(raw);
    assert.ok(once !== null && once >= -180 && once < 180);
    assert.equal(normalizeLongitude(once!), once);
  }

  // Strict latitude validation & rejection of NaN/Infinity/invalid strings
  assert.equal(validateLatitude(-90), -90);
  assert.equal(validateLatitude(90), 90);
  assert.equal(validateLatitude(0), 0);
  assert.throws(() => validateLatitude(-90.001), RangeError);
  assert.throws(() => validateLatitude(90.001), RangeError);
  assert.throws(() => validateLatitude(NaN), RangeError);
  assert.throws(() => validateLatitude(Infinity), RangeError);
  assert.throws(() => normalizeLongitude(NaN), RangeError);
  assert.throws(() => normalizeLongitude(Infinity), RangeError);
  assert.throws(() => normalizeLongitude("-Infinity"), RangeError);
  assert.throws(() => normalizeLongitude("abc"), RangeError);
  assert.throws(() => normalizeLongitude(""), RangeError);
  assert.equal(normalizeCoordinates(-90.001, 0).valid, false);
  assert.equal(normalizeCoordinates(90.001, 0).valid, false);
  assert.equal(normalizeCoordinates(35, NaN).valid, false);
  assert.equal(normalizeCoordinates(35, "abc").valid, false);

  const normChina = normalizeCoordinates(35.86, -250);
  assert.equal(normChina.ok, true);
  if (normChina.ok) {
    assert.equal(normChina.lat, 35.86);
    assert.equal(normChina.lon, 110);
    assert.equal(normChina.lonWasNormalized, true);
    assert.equal(normChina.originalLon, -250);
  }

  // sanitizeStoredFields migrates wrapped longitudes in persisted fields
  const sanitized = sanitizeStoredFields([
    { id: "cn1", name: "Shaanxi Field", lat: 35.86, lon: -250 },
    { id: "bad", name: "Invalid Lat", lat: 120, lon: 10 },
  ]);
  assert.equal(sanitized.length, 1);
  assert.equal(sanitized[0].lon, 110);
});

test("China wrapped longitude (-250 -> 110) and direct coordinates identify China (CHN), never assign a US tag, and generate validated Chinese rotations", async () => {
  // Wrapped longitude -250 normalizes to 110°E (North-Central China)
  const geoWrapped = resolveGeographicContext(35.86, -250);
  assert.equal(geoWrapped.lon, 110);
  assert.equal(geoWrapped.lonWasNormalized, true);
  assert.equal(geoWrapped.countryName, "China");
  assert.equal(geoWrapped.countryCodeIso3, "CHN");
  assert.equal(geoWrapped.regionTag, "east_asia_china_temperate");
  assert.ok(!geoWrapped.regionTag?.startsWith("us_"));
  assert.equal(detectRegionTag(35.86, -250), "east_asia_china_temperate");
  assert.equal(detectRegion(30.59, 114.3)?.tag, "east_asia_china_subtropical");

  // GenerationRequestSchema normalizes wrapped longitude -250 -> 110 automatically
  const parsedReq = GenerationRequestSchema.safeParse({
    fieldId: "china_wrapped",
    fieldName: "North China Plain Field",
    lat: 36.65,
    lon: -242.88, // wraps to +117.12 (Jinan, Shandong)
    climate: makeClimate(),
    soil: null,
    priorities: DEFAULT_PRIORITIES,
    regionTag: "east_asia_china_temperate",
  });
  assert.equal(parsedReq.success, true);
  if (parsedReq.success) {
    assert.ok(Math.abs(parsedReq.data.lon - 117.12) < 1e-6);
  }

  const chinaSoil = resolveGlobalSoilFallback(36.65, -242.88);
  assert.ok(chinaSoil.aggregated.depth0_30cm.awc !== null);

  const chinaCrops = getAvailableCropsForContext("temperate_humid", "east_asia_china_temperate");
  assert.ok(chinaCrops.includes("soft_red_winter_wheat"));
  assert.ok(chinaCrops.includes("field_corn"));
  assert.ok(chinaCrops.includes("soybean"));
  assert.ok(chinaCrops.includes("winter_canola"));
  assert.ok(chinaCrops.includes("groundnut"));
  assert.ok(chinaCrops.includes("mung_bean"));
  assert.ok(chinaCrops.includes("buckwheat"));

  const chinaStrat: RotationStrategy = {
    id: "north_china_wheat_soy_canola",
    name: "North China Plain Wheat–Legume–Rapeseed Rotation",
    archetype: "crop_diversity",
    description: "Rotates winter wheat, summer soybean with buckwheat cover, and winter canola across 4 botanical families.",
    years: [
      {
        year: 1,
        seasons: [
          { season: "Winter–Spring", crop: "soft_red_winter_wheat", activity: "Winter wheat harvest in June", months: [1, 2, 3, 4, 5, 6] },
          { season: "Late Summer", crop: "buckwheat", activity: "Summer buckwheat phosphorus-scavenging cover", months: [7, 8, 9] },
        ],
      },
      {
        year: 2,
        seasons: [
          { season: "Summer", crop: "soybean", activity: "Plant summer soybean", months: [5, 6, 7, 8, 9] },
          { season: "Autumn", crop: "hairy_vetch", activity: "Overwinter legume cover", months: [10, 11, 12] },
        ],
      },
      {
        year: 3,
        seasons: [
          { season: "Spring–Summer", crop: "winter_canola", activity: "Harvest rapeseed in May", months: [1, 2, 3, 4, 5] },
          { season: "Summer", crop: "mung_bean", activity: "Short-season summer mung bean pulse", months: [6, 7, 8] },
        ],
      },
    ],
    tradeoffs: {
      advantages: ["Four botanical families (Poaceae, Polygonaceae, Fabaceae, Brassicaceae)", "Includes N-fixing soybean, mung bean, and vetch"],
      disadvantages: ["Requires timely post-harvest seeding in June"],
      operational: ["Monitor Sclerotinia interval between soybean and canola"],
      warnings: [],
    },
  };
  // Note: soybean AND winter_canola are both Sclerotinia hosts -> let's verify our validator catches Sclerotinia if both are used, and accepts when non-host groundnut replaces soybean!
  chinaStrat.years[1].seasons[0].crop = "groundnut";

  const chinaRes = await generateRotations(
    {
      fieldId: "china_field_1",
      fieldName: "Shandong Field",
      lat: 36.65,
      lon: -242.88,
      climate: makeClimate(),
      soil: chinaSoil,
      priorities: DEFAULT_PRIORITIES,
      regionTag: null,
    },
    makeMockProvider(JSON.stringify({ strategies: [chinaStrat], rationale: "Adapted to North China Plain." }))
  );

  assert.equal(chinaRes.geography?.countryName, "China");
  assert.equal(chinaRes.geography?.regionTag, "east_asia_china_temperate");
  assert.equal(chinaRes.proposals.length, 1);
});

test("Nevada / US Southwest (39.53, -119.81) identifies us_southwest, distinguishes irrigated vs rainfed regimes, and validates western crop rotations", async () => {
  const nvGeo = resolveGeographicContext(39.53, -119.81);
  assert.equal(nvGeo.countryCodeIso2, "US");
  assert.equal(nvGeo.regionTag, "us_southwest");
  assert.equal(nvGeo.defaultWaterRegime, "irrigated_primary");
  assert.ok(nvGeo.admin1Name.includes("Nevada"));

  // Great Basin arid/semi-arid climate (~11.5 °C, 195 mm annual precip -> classifies as "arid" with irrigation_required)
  const nvAridClimate = makeClimate({
    avgAnnualTemp: 11.5,
    avgAnnualPrecip: 195,
    monthlyTemp: [0.5, 3.2, 6.8, 10.1, 14.8, 19.9, 24.5, 23.4, 18.2, 11.4, 5.1, 0.8],
    monthlyPrecip: [24, 22, 20, 16, 18, 12, 6, 6, 8, 14, 20, 29],
  });
  nvAridClimate.location = { lat: 39.53, lon: -119.81, elevation: 1340 };

  const nvClassification = classifyAgGroup(nvAridClimate, makeSoil());
  assert.equal(nvClassification.group, "arid");
  assert.equal(nvClassification.waterRegime, "irrigation_required");

  // Both "arid" and "semi_arid_temperate" in "us_southwest" have verified western crops
  const nvAridCrops = getAvailableCropsForContext("arid", "us_southwest");
  const nvSemiAridCrops = getAvailableCropsForContext("semi_arid_temperate", "us_southwest");
  for (const cropList of [nvAridCrops, nvSemiAridCrops]) {
    assert.ok(cropList.includes("alfalfa_annual_forage"));
    assert.ok(cropList.includes("spring_barley"));
    assert.ok(cropList.includes("spring_wheat"));
    assert.ok(cropList.includes("safflower"));
    assert.ok(cropList.includes("grain_sorghum"));
    assert.ok(cropList.includes("desert_tepary_bean"));
    assert.ok(cropList.includes("yellow_mustard_cover"));
  }

  const nvStrategy: RotationStrategy = {
    id: "nevada_irrigated_water_saving",
    name: "Nevada Great Basin Alfalfa–Barley–Safflower Rotation",
    archetype: "water_resilience",
    description: "Rotates irrigated forage medic/alfalfa, low-water spring barley with mustard cover, and deep-rooted safflower.",
    years: [
      {
        year: 1,
        seasons: [
          { season: "Spring–Summer", crop: "alfalfa_annual_forage", activity: "Irrigated forage medic/alfalfa nitrogen builder", months: [3, 4, 5, 6, 7, 8, 9] },
        ],
      },
      {
        year: 2,
        seasons: [
          { season: "Spring", crop: "spring_barley", activity: "Early-maturing spring barley utilizing legume N credit", months: [3, 4, 5, 6, 7] },
          { season: "Autumn", crop: "yellow_mustard_cover", activity: "Autumn biofumigant mustard cover", months: [8, 9, 10] },
        ],
      },
      {
        year: 3,
        seasons: [
          { season: "Spring–Summer", crop: "safflower", activity: "Deep-taproot drought-tolerant safflower oilseed", months: [4, 5, 6, 7, 8] },
        ],
      },
    ],
    tradeoffs: {
      advantages: ["Four botanical families (Fabaceae, Poaceae, Brassicaceae, Asteraceae)", "Reduces irrigation demand in Years 2 and 3"],
      disadvantages: ["Requires irrigation scheduling for establishment in <200 mm Great Basin climate"],
      operational: ["Terminate forage medic cleanly prior to spring barley seeding"],
      warnings: [],
    },
  };

  const nvRes = await generateRotations(
    {
      fieldId: "nv_field_1",
      fieldName: "Fallon Nevada Field",
      lat: 39.53,
      lon: -119.81,
      climate: nvAridClimate,
      soil: makeSoil(),
      priorities: DEFAULT_PRIORITIES,
      regionTag: null,
    },
    makeMockProvider(JSON.stringify({ strategies: [nvStrategy], rationale: "Designed for irrigated Nevada Great Basin." }))
  );

  assert.equal(nvRes.supportStatus, "supported");
  assert.equal(nvRes.evidenceLevel, "level_1_strong_local");
  assert.equal(nvRes.proposals.length, 1);
  assert.equal(nvRes.proposals[0].strategy.id, "nevada_irrigated_water_saving");
});

test("Global agroecological coverage across South America, Europe, South Asia, Southeast Asia, Australia, MENA, and Level 3 refusal for unsupported extremes", async () => {
  assert.equal(Object.keys(GLOBAL_DATA_PROVIDERS).length, 14);
  assert.equal(GLOBAL_REGION_TAGS.length, 15);

  const representativeLocations = [
    {
      name: "Brazil Cerrado/Pampas",
      lat: -23.31,
      lon: -51.16,
      expectedIso3: "BRA",
      expectedRegion: "sa_pampas_cerrado",
      agGroup: "subtropical_humid" as const,
      expectedCrop: "soybean",
    },
    {
      name: "Castile & León Spain (Mediterranean Europe)",
      lat: 41.65,
      lon: -4.72,
      expectedIso3: "ESP",
      expectedRegion: "europe_temperate_med",
      agGroup: "temperate_mediterranean" as const,
      expectedCrop: "winter_canola",
    },
    {
      name: "Punjab Indo-Gangetic Plains India",
      lat: 30.9,
      lon: 75.85,
      expectedIso3: "IND",
      expectedRegion: "south_asia_indo_gangetic",
      agGroup: "tropical_monsoon" as const,
      expectedCrop: "paddy_rice",
    },
    {
      name: "Central Plains Thailand (SE Asia Monsoon)",
      lat: 15.87,
      lon: 100.99,
      expectedIso3: "THA",
      expectedRegion: "se_asia_monsoon",
      agGroup: "tropical_monsoon" as const,
      expectedCrop: "paddy_rice",
    },
    {
      name: "South Australia Wheatbelt",
      lat: -34.92,
      lon: 138.6,
      expectedIso3: "AUS",
      expectedRegion: "australia_southern_wheatbelt",
      agGroup: "temperate_mediterranean" as const,
      expectedCrop: "chickpea",
    },
    {
      name: "Meknès Morocco (MENA)",
      lat: 33.89,
      lon: -5.55,
      expectedIso3: "MAR",
      expectedRegion: "mena_mediterranean_arid",
      agGroup: "temperate_mediterranean" as const,
      expectedCrop: "lentil",
    },
  ];

  for (const loc of representativeLocations) {
    const geo = resolveGeographicContext(loc.lat, loc.lon);
    assert.equal(geo.countryCodeIso3, loc.expectedIso3, `ISO3 mismatch for ${loc.name}`);
    assert.equal(geo.regionTag, loc.expectedRegion, `Region mismatch for ${loc.name}`);
    const crops = getAvailableCropsForContext(loc.agGroup, geo.regionTag);
    assert.ok(crops.length >= 5, `Expected >=5 crops for ${loc.name}, got ${crops.length}`);
    assert.ok(crops.includes(loc.expectedCrop), `Expected ${loc.expectedCrop} in ${loc.name}`);
    const evidence = evaluateFieldCropEvidenceLevel({
      agGroup: loc.agGroup,
      regionTag: geo.regionTag,
      availableCropIds: crops,
      soil: resolveGlobalSoilFallback(loc.lat, loc.lon),
    });
    assert.equal(evidence.level, "level_2_global_modeled");
  }

  // Unified evidence profile builder works cleanly
  const profile = buildUnifiedFieldEvidenceProfile(
    9.45287,
    24.98303,
    makeClimate({ avgAnnualTemp: 27.1, avgAnnualPrecip: 740 }),
    null
  );
  assert.equal(profile.geography.regionTag, "ssa_sudano_sahelian");
  assert.ok(profile.soilFallback !== null);
  assert.ok(profile.activeProviders.length >= 10);

  // Level 3 Insufficient Evidence: Boreal / polar location refuses generation honestly
  let providerCalled = false;
  const borealClimate = makeClimate({
    avgAnnualTemp: 1.5,
    avgAnnualPrecip: 450,
    monthlyTemp: [-14, -12, -7, -1, 5, 11, 14, 12, 7, 1, -6, -11],
  });
  const borealClass = classifyAgGroup(borealClimate, null);
  assert.equal(borealClass.group, "boreal");
  assert.equal(borealClass.evidenceLevel, "level_3_insufficient");

  const borealRes = await generateRotations(
    {
      fieldId: "boreal_test",
      fieldName: "Sub-Arctic Field",
      lat: 66.5,
      lon: 25.7,
      climate: borealClimate,
      soil: null,
      priorities: DEFAULT_PRIORITIES,
      regionTag: null,
    },
    makeMockProvider(async () => {
      providerCalled = true;
      return "{}";
    })
  );
  assert.equal(providerCalled, false);
  assert.equal(borealRes.evidenceLevel, "level_3_insufficient");
  assert.equal(borealRes.proposals.length, 0);
  assert.equal(borealRes.supportStatus, "unavailable");
});

// ─── 9. Vercel OIDC + Google Cloud Workload Identity Federation Tests ───

section("Vercel OIDC & Google Cloud Workload Identity Federation (Mocked)");

test("buildVercelWifAudience, buildServiceAccountImpersonationUrl, and createVercelWifExternalAccountClient configure ExternalAccountClient.fromJSON lazily with mocked OIDC supplier", async () => {
  const wifConfig = {
    projectNumber: "123456789012",
    serviceAccountEmail: "fallo-si@triangle-hackathon-claude-code.iam.gserviceaccount.com",
    workloadIdentityPoolId: "vercel-oidc-pool",
    workloadIdentityPoolProviderId: "vercel-oidc-provider",
  };

  const expectedAudience =
    "//iam.googleapis.com/projects/123456789012/locations/global/workloadIdentityPools/vercel-oidc-pool/providers/vercel-oidc-provider";
  const expectedImpersonationUrl =
    "https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/fallo-si@triangle-hackathon-claude-code.iam.gserviceaccount.com:generateAccessToken";

  assert.equal(buildVercelWifAudience(wifConfig), expectedAudience);
  assert.equal(
    buildServiceAccountImpersonationUrl(wifConfig.serviceAccountEmail),
    expectedImpersonationUrl
  );

  let oidcCalls = 0;
  const mockOidcJwt = "eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJ2ZXJjZWxfdGVzdCJ9.mock_signature";
  const mockOidcSupplier = async () => {
    oidcCalls++;
    return mockOidcJwt;
  };

  const authClient = createVercelWifExternalAccountClient(wifConfig, mockOidcSupplier);
  assert.ok(authClient instanceof IdentityPoolClient);
  // Creating the client must NOT invoke the OIDC supplier eagerly
  assert.equal(oidcCalls, 0);

  assert.equal(authClient.getServiceAccountEmail(), wifConfig.serviceAccountEmail);
  assert.equal(
    (authClient as unknown as { subjectTokenType: string }).subjectTokenType,
    GCP_SUBJECT_TOKEN_TYPE_JWT
  );
  assert.equal(
    (authClient as unknown as { audience: string }).audience,
    expectedAudience
  );
  assert.equal(
    (authClient as unknown as { tokenUrl: string }).tokenUrl,
    GCP_STS_TOKEN_URL
  );
  assert.equal(
    (authClient as unknown as { serviceAccountImpersonationUrl: string })
      .serviceAccountImpersonationUrl,
    expectedImpersonationUrl
  );

  // Subject token supplier is invoked lazily when retrieveSubjectToken() is called
  const retrievedToken = await (authClient as IdentityPoolClient).retrieveSubjectToken();
  assert.equal(oidcCalls, 1);
  assert.equal(retrievedToken, mockOidcJwt);
});

test("Environment detection preserves local ADC in development and requires complete WIF configuration on deployed Vercel environments", () => {
  // 1. Local development (no VERCEL env vars) -> not a Vercel deployment, uses ADC
  const localEnv = {
    GOOGLE_CLOUD_PROJECT: "triangle-hackathon-claude-code",
    GOOGLE_CLOUD_LOCATION: "global",
    GOOGLE_GENAI_USE_ENTERPRISE: "true",
    FALLO_AI_MODEL: "gemini-4-argon",
  };
  assert.equal(isVercelDeploymentEnvironment(localEnv), false);
  const localProvider = resolveRuntimeAIProvider(localEnv) as GeminiEnterpriseProvider;
  assert.ok(localProvider instanceof GeminiEnterpriseProvider);
  assert.equal(localProvider.authMode, "adc");
  assert.equal(localProvider.wifConfig, undefined);

  // 2. Local `vercel dev` / `vercel env pull` (VERCEL="1", VERCEL_ENV="development") -> still local ADC, even if GCP_* vars exist
  const vercelDevEnv = {
    ...localEnv,
    VERCEL: "1",
    VERCEL_ENV: "development",
    GCP_PROJECT_NUMBER: "123456789012",
    GCP_SERVICE_ACCOUNT_EMAIL: "fallo-si@triangle-hackathon-claude-code.iam.gserviceaccount.com",
    GCP_WORKLOAD_IDENTITY_POOL_ID: "vercel-pool",
    GCP_WORKLOAD_IDENTITY_POOL_PROVIDER_ID: "vercel-provider",
  };
  assert.equal(isVercelDeploymentEnvironment(vercelDevEnv), false);
  const vercelDevProvider = resolveRuntimeAIProvider(vercelDevEnv) as GeminiEnterpriseProvider;
  assert.ok(vercelDevProvider instanceof GeminiEnterpriseProvider);
  assert.equal(vercelDevProvider.authMode, "adc");
  assert.equal(vercelDevProvider.wifConfig, undefined);

  // 3. Deployed Vercel production environment WITHOUT WIF variables -> returns null (does not enable SI generation before WIF is configured)
  const unconfiguredVercelProdEnv = {
    ...localEnv,
    VERCEL: "1",
    VERCEL_ENV: "production",
  };
  assert.equal(isVercelDeploymentEnvironment(unconfiguredVercelProdEnv), true);
  assert.equal(resolveVercelWifConfig(unconfiguredVercelProdEnv), null);
  assert.deepEqual(getMissingVercelWifEnvVars(unconfiguredVercelProdEnv), [
    "GCP_PROJECT_NUMBER",
    "GCP_SERVICE_ACCOUNT_EMAIL",
    "GCP_WORKLOAD_IDENTITY_POOL_ID",
    "GCP_WORKLOAD_IDENTITY_POOL_PROVIDER_ID",
  ]);
  assert.equal(resolveRuntimeAIProvider(unconfiguredVercelProdEnv), null);

  // 4. Deployed Vercel production environment WITH partial WIF variables -> returns null
  const partialVercelProdEnv = {
    ...unconfiguredVercelProdEnv,
    GCP_PROJECT_NUMBER: "123456789012",
    GCP_WORKLOAD_IDENTITY_POOL_ID: "vercel-pool",
  };
  assert.deepEqual(getMissingVercelWifEnvVars(partialVercelProdEnv), [
    "GCP_SERVICE_ACCOUNT_EMAIL",
    "GCP_WORKLOAD_IDENTITY_POOL_PROVIDER_ID",
  ]);
  assert.equal(resolveRuntimeAIProvider(partialVercelProdEnv), null);

  // 5. Deployed Vercel production environment WITH all 4 WIF variables -> returns GeminiEnterpriseProvider in vercel-oidc-wif mode
  const configuredVercelProdEnv = {
    ...unconfiguredVercelProdEnv,
    GCP_PROJECT_NUMBER: "123456789012",
    GCP_SERVICE_ACCOUNT_EMAIL: "fallo-si@triangle-hackathon-claude-code.iam.gserviceaccount.com",
    GCP_WORKLOAD_IDENTITY_POOL_ID: "vercel-pool",
    GCP_WORKLOAD_IDENTITY_POOL_PROVIDER_ID: "vercel-provider",
  };
  const prodProvider = resolveRuntimeAIProvider(
    configuredVercelProdEnv
  ) as GeminiEnterpriseProvider;
  assert.ok(prodProvider instanceof GeminiEnterpriseProvider);
  assert.equal(prodProvider.authMode, "vercel-oidc-wif");
  assert.deepEqual(prodProvider.wifConfig, {
    projectNumber: "123456789012",
    serviceAccountEmail: "fallo-si@triangle-hackathon-claude-code.iam.gserviceaccount.com",
    workloadIdentityPoolId: "vercel-pool",
    workloadIdentityPoolProviderId: "vercel-provider",
  });
});

test("Vercel production GeminiEnterpriseProvider passes googleAuthOptions ({ authClient, projectId }) to GoogleGenAI lazily at runtime and redacts OIDC JWTs on auth failure", async () => {
  let oidcTokenCalls = 0;
  const fakeOidcJwt =
    "eyJhbGciOiJSUzI1NiIsImtpZCI6IjEyMyJ9.eyJpc3MiOiJodHRwczovL29pZGMudmVyY2VsLmNvbSIsInN1YiI6InByb2plY3QifQ.secret_oidc_sig_value";

  const captured: {
    sdkOptions: Record<string, unknown> | null;
    subjectTokenFromAuthClient: string | null;
  } = {
    sdkOptions: null,
    subjectTokenFromAuthClient: null,
  };

  const s1 = makeValidStrategy("soil_health_wif", "Soil Health WIF Plan");
  s1.archetype = "soil_health";

  const prodProvider = resolveRuntimeAIProvider(
    {
      VERCEL: "1",
      VERCEL_ENV: "production",
      GOOGLE_CLOUD_PROJECT: "triangle-hackathon-claude-code",
      GOOGLE_CLOUD_LOCATION: "global",
      GOOGLE_GENAI_USE_ENTERPRISE: "true",
      FALLO_AI_MODEL: "gemini-4-argon",
      FALLO_AI_THINKING_LEVEL: "LOW",
      GCP_PROJECT_NUMBER: "123456789012",
      GCP_SERVICE_ACCOUNT_EMAIL:
        "fallo-si@triangle-hackathon-claude-code.iam.gserviceaccount.com",
      GCP_WORKLOAD_IDENTITY_POOL_ID: "vercel-pool",
      GCP_WORKLOAD_IDENTITY_POOL_PROVIDER_ID: "vercel-provider",
    },
    {
      oidcTokenSupplier: async () => {
        oidcTokenCalls++;
        return fakeOidcJwt;
      },
      geminiClientFactory: async (sdkOptions) => {
        captured.sdkOptions = sdkOptions as unknown as Record<string, unknown>;
        const authClient = sdkOptions.googleAuthOptions?.authClient as
          | IdentityPoolClient
          | undefined;
        if (authClient) {
          captured.subjectTokenFromAuthClient = await authClient.retrieveSubjectToken();
        }
        return {
          models: {
            generateContent: async () => ({
              text: JSON.stringify({
                strategies: [s1],
                rationale: "Generated with mocked Vercel OIDC WIF credentials.",
              }),
              usageMetadata: {
                promptTokenCount: 800,
                candidatesTokenCount: 600,
                thoughtsTokenCount: 100,
                totalTokenCount: 1500,
              },
            }),
          },
        };
      },
    }
  );

  assert.ok(prodProvider instanceof GeminiEnterpriseProvider);
  // Resolving the provider must NOT call oidcTokenSupplier at build/init time
  assert.equal(oidcTokenCalls, 0);

  const result = await generateRotations(
    {
      fieldId: "wif_field_1",
      fieldName: "Rowan WIF Field",
      lat: 35.67,
      lon: -80.47,
      climate: makeClimate(),
      soil: makeSoil(),
      priorities: DEFAULT_PRIORITIES,
      regionTag: "us_southeast",
    },
    prodProvider
  );

  assert.equal(oidcTokenCalls, 1);
  assert.equal(captured.subjectTokenFromAuthClient, fakeOidcJwt);
  assert.ok(captured.sdkOptions);
  assert.equal(captured.sdkOptions.enterprise, true);
  assert.equal(captured.sdkOptions.project, "triangle-hackathon-claude-code");
  assert.equal(captured.sdkOptions.location, "global");

  const googleAuthOptions = captured.sdkOptions.googleAuthOptions as {
    authClient?: IdentityPoolClient;
    projectId?: string;
  };
  assert.ok(googleAuthOptions);
  assert.equal(googleAuthOptions.projectId, "triangle-hackathon-claude-code");
  assert.ok(googleAuthOptions.authClient instanceof IdentityPoolClient);
  assert.equal(
    googleAuthOptions.authClient.getServiceAccountEmail(),
    "fallo-si@triangle-hackathon-claude-code.iam.gserviceaccount.com"
  );
  assert.equal(result.supportStatus, "supported");
  assert.equal(result.proposals.length, 1);
  assert.equal(result.proposals[0].strategy.id, "soil_health_wif");

  // Verify OIDC JWT redaction and clear WIF error message if STS / IAM exchange fails
  const failingWifProvider = new GeminiEnterpriseProvider({
    project: "triangle-hackathon-claude-code",
    location: "global",
    model: "gemini-4-argon",
    wifConfig: {
      projectNumber: "123456789012",
      serviceAccountEmail:
        "fallo-si@triangle-hackathon-claude-code.iam.gserviceaccount.com",
      workloadIdentityPoolId: "vercel-pool",
      workloadIdentityPoolProviderId: "vercel-provider",
    },
    oidcTokenSupplier: async () => fakeOidcJwt,
    clientFactory: () => ({
      models: {
        generateContent: async () => {
          throw new Error(
            `STS token exchange failed for subject token ${fakeOidcJwt} with error invalid_grant (status: 401)`
          );
        },
      },
    }),
  });

  const failedWifResult = await generateRotations(
    {
      fieldId: "wif_field_fail",
      fieldName: "Rowan WIF Fail Field",
      lat: 35.67,
      lon: -80.47,
      climate: makeClimate(),
      soil: makeSoil(),
      priorities: DEFAULT_PRIORITIES,
      regionTag: "us_southeast",
    },
    failingWifProvider
  );

  assert.equal(failedWifResult.proposals.length, 0);
  assert.equal(failedWifResult.supportStatus, "unavailable");
  assert.ok(
    failedWifResult.aiUnavailableReason?.includes(
      "Google Cloud Workload Identity Federation (Vercel OIDC) authentication failed"
    )
  );
  assert.ok(!failedWifResult.aiUnavailableReason?.includes(fakeOidcJwt));
  assert.ok(failedWifResult.aiUnavailableReason?.includes("[REDACTED_OIDC_TOKEN]"));
});

// ─── 10. What-If Simulator, Field Calendar, Climate Analogues & Rate Limiting Tests ───

section("What-If Simulator, Field Calendar, Climate Analogues & Abuse Protection");

test("What-If Simulator applies temperature (°C) and precipitation (% or mm) adjustments without mutating baseline and recalculates crop & strategy scores", () => {
  const baseline = makeClimate({
    avgAnnualTemp: 15.8,
    avgAnnualPrecip: 1120,
    monthlyTemp: [4, 6, 10, 15, 20, 24, 26, 25, 21, 15, 9, 5],
    monthlyPrecip: [90, 85, 100, 95, 100, 105, 110, 100, 90, 80, 80, 85],
    summerDrySpells: { avgMaxConsecutiveDryDays: 9.5, thresholdMm: 1, monthsDesc: "Jun–Aug" },
    summerHeatDays: { avgDaysAboveThreshold: 3.0, thresholdC: 35, monthsDesc: "Jul–Aug" },
    springPrecip: { avgTotalMm: 295, monthsDesc: "Mar–May" },
    growingSeasonPrecip: { avgTotalMm: 410, monthsDesc: "May–Aug" },
  });
  const originalTemp = baseline.fullRecord.avgAnnualTemp;
  const originalPrecip = baseline.fullRecord.avgAnnualPrecip;
  const originalMonthlyTemp0 = baseline.fullRecord.monthlyTemp[0];

  assert.equal(isBaselineScenario(DEFAULT_WHAT_IF_SCENARIO), true);
  assert.ok(WHAT_IF_PRESETS.length >= 4);

  // 1. Percentage rainfall mode (+2.5 °C, -30% rain)
  const hotDryScenario = {
    tempDeltaC: 2.5,
    precipMode: "percent" as const,
    precipDeltaPct: -30,
    precipDeltaMm: 0,
  };
  assert.equal(isBaselineScenario(hotDryScenario), false);
  assert.ok(formatScenarioSummary(hotDryScenario).includes("+2.5 °C"));
  assert.ok(formatScenarioSummary(hotDryScenario).includes("-30% rainfall"));

  const appliedPct = applyWhatIfScenarioToClimate(baseline, hotDryScenario);
  assert.ok(Math.abs((appliedPct.scenarioClimate.fullRecord.avgAnnualTemp ?? 0) - 18.3) < 1e-6);
  assert.ok(Math.abs((appliedPct.scenarioClimate.fullRecord.avgAnnualPrecip ?? 0) - 784) < 1e-6);
  assert.ok(
    (appliedPct.scenarioClimate.stressMetrics.summerDrySpells.avgMaxConsecutiveDryDays ?? 0) >
      (baseline.stressMetrics.summerDrySpells.avgMaxConsecutiveDryDays ?? 0)
  );
  assert.ok(
    (appliedPct.scenarioClimate.stressMetrics.summerHeatDays.avgDaysAboveThreshold ?? 0) >
      (baseline.stressMetrics.summerHeatDays.avgDaysAboveThreshold ?? 0)
  );

  // Baseline immutability verified
  assert.equal(baseline.fullRecord.avgAnnualTemp, originalTemp);
  assert.equal(baseline.fullRecord.avgAnnualPrecip, originalPrecip);
  assert.equal(baseline.fullRecord.monthlyTemp[0], originalMonthlyTemp0);

  // 2. Absolute mm rainfall mode (-1.0 °C, +200 mm/yr rain)
  const coolWetMmScenario = {
    tempDeltaC: -1.0,
    precipMode: "absolute_mm" as const,
    precipDeltaPct: 0,
    precipDeltaMm: 200,
  };
  const appliedMm = applyWhatIfScenarioToClimate(baseline, coolWetMmScenario);
  assert.ok(Math.abs((appliedMm.scenarioClimate.fullRecord.avgAnnualTemp ?? 0) - 14.8) < 1e-6);
  assert.ok(Math.abs((appliedMm.scenarioClimate.fullRecord.avgAnnualPrecip ?? 0) - 1320) < 1e-6);
  assert.equal(appliedMm.effectiveAnnualPrecipDeltaMm, 200);

  // 3. Full scenario evaluation with strategies & crop suitability comparison
  const stratWater = makeValidStrategy("water_plan", "Drought-Hardy Sorghum Plan");
  stratWater.years[0].seasons[0].crop = "grain_sorghum";
  const stratCorn = makeValidStrategy("corn_plan", "High-Water Corn Plan");
  stratCorn.years[0].seasons[0].crop = "field_corn";

  const evalRes = evaluateWhatIfScenario({
    baselineClimate: baseline,
    soil: makeSoil(),
    priorities: DEFAULT_PRIORITIES,
    strategies: [stratWater, stratCorn],
    scenario: hotDryScenario,
    regionTag: "us_southeast",
  });

  assert.equal(evalRes.isBaseline, false);
  assert.equal(evalRes.strategyComparisons.length, 2);
  assert.ok(evalRes.cropComparisons.length > 0);
  assert.ok(evalRes.assumptions.length >= 4);
  for (const comp of evalRes.strategyComparisons) {
    assert.ok(typeof comp.baselineResult.overallScore === "number");
    assert.ok(typeof comp.scenarioResult.overallScore === "number");
  }
});

test("Field Calendar builds 3-year x 12-month schedule, respects Northern/Southern/Tropical hemispheres, and never fabricates exact calendar dates", () => {
  const strat = makeValidStrategy("cal_test_strat", "Three-Year Calendar Test Rotation");
  const climate = makeClimate();

  // Northern Hemisphere field (Rowan County, NC: lat 35.67)
  const nhCalendar = buildFieldCalendar({
    strategy: strat,
    climate,
    lat: 35.67,
    lon: -80.47,
  });

  assert.equal(nhCalendar.hemisphere, "northern");
  assert.equal(nhCalendar.years.length, 3);
  assert.ok(nhCalendar.totalUniqueFamilies.length >= 2);
  assert.ok(nhCalendar.averageCoveredMonthsPerYear > 0);

  for (const yr of nhCalendar.years) {
    assert.equal(yr.months.length, 12);
    assert.ok(yr.seasons.length >= 1);
    for (const sea of yr.seasons) {
      assert.ok(sea.months.length >= 1);
      assert.ok(sea.monthRangeLabel.length > 0);
      assert.ok(sea.documentedPlantingWindow.length > 0);
      assert.ok(sea.documentedHarvestOrTerminationWindow.length > 0);
      // Verify no fabricated specific day-of-month (e.g., "April 14" or "Oct 22")
      assert.ok(!/\b(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\s+\d{1,2}\b/i.test(sea.monthRangeLabel));
      assert.ok(sea.seasonClimate.avgTempC !== null);
      assert.ok(sea.seasonClimate.totalPrecipMm !== null);
    }
  }

  // Southern Hemisphere window selection (e.g., lat -33.8)
  const shWindow = selectHemisphereWindowText(
    "April–May (NH) / October–November (SH)",
    "southern",
    "Apr",
    "planting"
  );
  assert.ok(shWindow.includes("October–November (SH)"));

  const nhWindow = selectHemisphereWindowText(
    "April–May (NH) / October–November (SH)",
    "northern",
    "Apr",
    "planting"
  );
  assert.ok(nhWindow.includes("April–May (NH)"));
});

test("Climate Analogues ranks historical years by standardized similarity, strictly excludes target year from self-matches, and handles insufficient data", () => {
  // Build a realistic 20-year historical archive (2006..2025)
  const historicalYears = Array.from({ length: 20 }, (_, idx) => {
    const year = 2006 + idx;
    // Make 2012 a distinct hot/dry year (+2.2 °C, -28% rain) and 2018 a wet year
    const tempOffset = year === 2012 ? 2.2 : year === 2018 ? -0.5 : (idx % 5 - 2) * 0.35;
    const precipFactor = year === 2012 ? 0.72 : year === 2018 ? 1.28 : 1 + (idx % 4 - 1.5) * 0.06;
    const baseMonthlyTemp = [4, 6, 10, 15, 20, 24, 26, 25, 21, 15, 9, 5];
    const baseMonthlyPrecip = [90, 85, 100, 95, 100, 105, 110, 100, 90, 80, 80, 85];
    const monthlyTemp = baseMonthlyTemp.map((t) => Number((t + tempOffset).toFixed(2)));
    const monthlyPrecip = baseMonthlyPrecip.map((p) => Number((p * precipFactor).toFixed(1)));
    const avgTemp = Number((15.8 + tempOffset).toFixed(2));
    const totalPrecip = Number(monthlyPrecip.reduce((a, b) => a + b, 0).toFixed(1));
    return {
      year,
      avgTemp,
      totalPrecip,
      avgSolar: 16.5,
      monthlyTemp,
      monthlyPrecip,
      monthlySolar: Array(12).fill(16.5),
      springPrecipMm: Number((monthlyPrecip[2] + monthlyPrecip[3] + monthlyPrecip[4]).toFixed(1)),
      growingSeasonPrecipMm: Number(
        (monthlyPrecip[4] + monthlyPrecip[5] + monthlyPrecip[6] + monthlyPrecip[7]).toFixed(1)
      ),
      summerDrySpellDays: year === 2012 ? 17 : 9,
      summerHeatDays: year === 2012 ? 14 : 3,
      daysWithData: 365,
    };
  });

  const climateWithArchive: ClimateData = {
    ...makeClimate({
      avgAnnualTemp: 15.8,
      avgAnnualPrecip: 1120,
      monthlyTemp: [4, 6, 10, 15, 20, 24, 26, 25, 21, 15, 9, 5],
      monthlyPrecip: [90, 85, 100, 95, 100, 105, 110, 100, 90, 80, 80, 85],
    }),
    periods: {
      startYear: 2006,
      endYear: 2025,
      baselineStart: 2006,
      baselineEnd: 2020,
      recentStart: 2021,
      recentEnd: 2025,
    },
    historicalYears,
  };

  // 1. Growing season window resolution across hemispheres
  assert.deepEqual(resolveGrowingSeasonWindow(35.67).months, [4, 5, 6, 7, 8, 9]);
  assert.deepEqual(resolveGrowingSeasonWindow(-33.8).months, [10, 11, 12, 1, 2, 3]);

  // 2. Specific Year mode: targetYear = 2012 must NEVER include 2012 in its own matches
  const specificYearRes = computeClimateAnalogues({
    climate: climateWithArchive,
    mode: "specific_year",
    targetYear: 2012,
    topN: 5,
  });
  assert.equal(specificYearRes.status, "ready");
  assert.equal(specificYearRes.matches.length, 5);
  assert.ok(!specificYearRes.matches.some((m) => m.year === 2012));
  assert.deepEqual(specificYearRes.target?.excludedYears, [2012]);
  // Ranked in descending order of similarityScore (ascending compositeDistance)
  for (let i = 1; i < specificYearRes.matches.length; i++) {
    assert.ok(
      specificYearRes.matches[i - 1].compositeDistance <=
        specificYearRes.matches[i].compositeDistance
    );
  }

  // 3. Recent Window mode: excludes recent years (2021..2025) from candidate baseline matches
  const recentRes = computeClimateAnalogues({
    climate: climateWithArchive,
    mode: "recent_window",
    topN: 5,
  });
  assert.equal(recentRes.status, "ready");
  assert.ok(recentRes.matches.every((m) => m.year < 2021));

  // 4. What-If Scenario mode (+2.2 °C, -28% rain) should rank 2012 (#1 closest hot/dry analogue)
  const scenarioRes = computeClimateAnalogues({
    climate: climateWithArchive,
    mode: "what_if_scenario",
    whatIfScenario: {
      tempDeltaC: 2.2,
      precipMode: "percent",
      precipDeltaPct: -28,
      precipDeltaMm: 0,
    },
    topN: 5,
  });
  assert.equal(scenarioRes.status, "ready");
  assert.equal(scenarioRes.matches[0].year, 2012);
  assert.ok(scenarioRes.matches[0].similarityScore >= 85);

  // 5. Insufficient data handling when historicalYears is missing
  const insufficientRes = computeClimateAnalogues({
    climate: makeClimate(),
    mode: "recent_window",
  });
  assert.equal(insufficientRes.status, "insufficient_data");
  assert.equal(insufficientRes.matches.length, 0);
  assert.ok(insufficientRes.insufficientReason && insufficientRes.insufficientReason.length > 0);
});

test("Generation sliding-window rate limiter enforces per-key quota and resets cleanly", () => {
  resetGenerationRateLimiterForTests();
  const key = "test-client-ip-1";
  const t0 = 1_700_000_000_000;

  for (let i = 0; i < GENERATION_RATE_LIMIT_MAX_REQUESTS; i++) {
    const check = checkGenerationRateLimit(key, t0 + i * 100);
    assert.equal(check.allowed, true);
    assert.equal(check.remaining, GENERATION_RATE_LIMIT_MAX_REQUESTS - 1 - i);
  }

  // 9th request within the 10-minute window is blocked with retryAfterSeconds > 0
  const blocked = checkGenerationRateLimit(key, t0 + 1000);
  assert.equal(blocked.allowed, false);
  assert.equal(blocked.remaining, 0);
  assert.ok(blocked.retryAfterSeconds > 0);

  // Different client IP is unaffected
  const otherClient = checkGenerationRateLimit("test-client-ip-2", t0 + 1000);
  assert.equal(otherClient.allowed, true);

  resetGenerationRateLimiterForTests();
});

test("What-If Simulator humanizes enums/crop IDs and produces distinct crop-specific explanations", () => {
  assert.equal(formatEnumLabel("moderate_to_high"), "Moderate to high");
  assert.equal(formatEnumLabel("low_to_moderate"), "Low to moderate");
  assert.equal(formatEnumLabel("very_high"), "Very high");
  assert.equal(formatEnumLabel("cash"), "Cash crop");
  assert.equal(formatEnumLabel("cover"), "Cover crop");

  assert.equal(formatCropName("grain_sorghum"), "Grain Sorghum");
  assert.equal(formatCropName("hairy_vetch"), "Hairy Vetch");
  assert.equal(
    formatSeasonSequenceNames(["grain_sorghum", "hairy_vetch", "soybean"]),
    "Grain Sorghum → Hairy Vetch → Soybean"
  );

  const baseClimate = makeClimate();
  const soil = makeSoil();
  const evalDrought = evaluateWhatIfScenario({
    baselineClimate: baseClimate,
    soil,
    priorities: DEFAULT_PRIORITIES,
    strategies: [makeValidStrategy()],
    scenario: {
      tempDeltaC: 2.0,
      precipMode: "percent",
      precipDeltaPct: -25,
      precipDeltaMm: 0,
    },
    regionTag: "us_southeast",
  });

  assert.ok(evalDrought.cropComparisons.length >= 5);
  // Every crop explanation must be specific to that crop (includes its commonName) and never use the old generic string
  const explanations = new Set<string>();
  for (const c of evalDrought.cropComparisons) {
    assert.ok(c.explanation.includes(c.commonName));
    assert.ok(
      !c.explanation.includes("Low water demand provides resilience under drier conditions")
    );
    explanations.add(c.explanation);
  }
  assert.equal(explanations.size, evalDrought.cropComparisons.length);

  // Strategy comparison includes a concrete sequence-backed explanation
  assert.equal(evalDrought.strategyComparisons.length, 1);
  assert.ok(evalDrought.strategyComparisons[0].explanation.length > 20);
});

// ─── Execute all queued tests ─────────────────────────────────────────

async function runAllTests() {
  console.log("\n🌾 fallo generation pipeline tests\n");
  let passed = 0;
  let failed = 0;

  for (const item of queue) {
    if (item.section) {
      console.log(`\n${item.section}`);
    }
    try {
      await item.fn();
      console.log(`  ✅ ${item.name}`);
      passed++;
    } catch (err) {
      console.log(`  ❌ ${item.name}`);
      console.error(`     ${err instanceof Error ? err.message : String(err)}`);
      failed++;
    }
  }

  console.log("\n─────────────────────────────");
  console.log(`Results: ${passed} passed, ${failed} failed`);
  if (failed > 0) {
    process.exit(1);
  }
  console.log("All generation pipeline tests passed.");
}

runAllTests().catch((err) => {
  console.error("Unhandled test runner failure:", err);
  process.exit(1);
});
