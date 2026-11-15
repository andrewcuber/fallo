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
  GenerationRequestSchema,
  OpenAICompatibleProvider,
  type AIProviderClient,
} from "@/lib/rotation-generator";
import {
  type RotationStrategy,
  type ClimateData,
  type SoilData,
  type FarmerPriorities,
  DEFAULT_PRIORITIES,
  mergeAndRankStrategies,
  resolveScoredStrategyById,
  rankStrategyResults,
  scoreStrategy,
} from "@/lib/rotation-scoring";
import { applyFieldRotationsUpdate, type Field, type StoredRotations } from "@/components/providers";

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

test("isGroupSupported returns true only for groups with verified catalog crops", () => {
  assert.equal(isGroupSupported("temperate_humid"), true);
  assert.equal(isGroupSupported("semi_arid_temperate"), true);
  assert.equal(isGroupSupported("subtropical_humid"), false);
  assert.equal(isGroupSupported("temperate_mediterranean"), false);
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

test("applyFieldRotationsUpdate updates both fields and activeField consistently", () => {
  const f1: Field = { id: "f1", name: "Field 1", lat: 35.67, lon: -80.47 };
  const f2: Field = { id: "f2", name: "Field 2", lat: 36.0, lon: -79.0 };
  const stored: StoredRotations = {
    strategies: [makeValidStrategy("ai_gen_1", "AI Generated 1")],
    generatedAt: "2026-11-14T00:00:00.000Z",
    agGroup: "temperate_humid",
    version: "1.0",
  };

  const updated = applyFieldRotationsUpdate([f1, f2], f1, "f1", stored);
  assert.equal(updated.fields[0].generatedRotations?.strategies.length, 1);
  assert.equal(updated.activeField?.generatedRotations?.strategies.length, 1);
  assert.equal(updated.fields[1].generatedRotations, undefined);

  // Clearing sets both to null
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

test("resolveScoredStrategyById resolves generated strategies first, falls back to static, and handles clear", () => {
  const climate = makeClimate();
  const soil = makeSoil();
  const genStrat: RotationStrategy = {
    ...makeValidStrategy("ai_custom_detail", "AI Custom Detail Plan"),
    generationInfo: {
      source: "ai-assisted",
      agGroup: "temperate_humid",
      validationWarnings: ["Sample warning for detail view"],
    },
  };

  // 1. Resolves generated strategy and preserves metadata + recalculates with custom priorities
  const customPriorities: FarmerPriorities = {
    waterSuitability: 10,
    nitrogenContribution: 60,
    soilCoverage: 10,
    diversityPestBreak: 10,
    climateRiskResilience: 10,
  };
  const resolvedGen = resolveScoredStrategyById(
    "ai_custom_detail",
    [genStrat],
    climate,
    soil,
    customPriorities,
    "us_southeast"
  );
  assert.ok(resolvedGen);
  assert.equal(resolvedGen!.strategy.id, "ai_custom_detail");
  assert.equal(resolvedGen!.strategy.generationInfo?.source, "ai-assisted");
  assert.deepEqual(resolvedGen!.strategy.generationInfo?.validationWarnings, [
    "Sample warning for detail view",
  ]);

  // 2. Falls back to static catalog when strategyId is a static archetype
  const resolvedStatic = resolveScoredStrategyById(
    "soil_health_building",
    [genStrat],
    climate,
    soil,
    customPriorities,
    "us_southeast"
  );
  assert.ok(resolvedStatic);
  assert.equal(resolvedStatic!.strategy.id, "soil_health_building");

  // 3. Returns null when generated strategies are cleared
  const afterClear = resolveScoredStrategyById(
    "ai_custom_detail",
    null,
    climate,
    soil,
    customPriorities,
    "us_southeast"
  );
  assert.equal(afterClear, null);
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
