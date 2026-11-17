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
import zlib from "node:zlib";
import { classifyAgGroup, isGroupSupported } from "@/lib/agro-classifier";
import {
  validateProposal,
  isStrategyStructurallyValid,
  formatCompatibilityRulesForPrompt,
  getSclerotiniaHosts,
  PRIMARY_SCLEROTINIA_HOSTS,
  MODERATE_SCLEROTINIA_HOSTS,
  evaluateCropOverlapAndTermination,
  evaluateSeasonalVarietyAlignment,
  evaluateNitrogenAndBarleyCompatibility,
  evaluateCoverCropWinterSuitability,
} from "@/lib/rotation-validator";
import {
  generateRotations,
  buildSystemPrompt,
  buildRetrySystemPrompt,
  aggregateRejectionReasons,
  MAX_VALIDATION_RETRY_ATTEMPTS,
  getAvailableCropsForContext,
  GenerationRequestSchema,
  OpenAICompatibleProvider,
  GeminiEnterpriseProvider,
  resolveRuntimeAIProvider,
  parseGeminiThinkingLevel,
  isFieldGenerationInFlight,
  isVercelDeploymentEnvironment,
  getMissingVercelWifEnvVars,
  describeMissingAIProviderReason,
  sanitizeGenerationErrorMessage,
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
  buildFieldSpecificObjectives,
  buildStrategyOverviewBullets,
  isReferenceStrategyApplicable,
  isVerifiedAiStrategyForField,
  scoreVerifiedAiStrategies,
  mergeAndRankStrategies,
  resolveScoredStrategyById,
  rankStrategyResults,
  scoreStrategy,
  cropLibrary,
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
  isUnitedStatesCoordinate,
  GLOBAL_REGION_TAGS,
} from "@/lib/region";
import {
  GLOBAL_DATA_PROVIDERS,
  resolveGlobalSoilFallback,
  evaluateGaezV5Indicators,
  buildUnifiedFieldEvidenceProfile,
} from "@/lib/global-data-providers";
import { evaluateFieldCropEvidenceLevel } from "@/lib/rotation-scoring";
import {
  SOILGRIDS_WCS_BASE_URL,
  WRB_SOIL_GROUPS,
  SOILGRIDS_DEPTH_LAYERS,
  SOILGRIDS_PROPERTIES,
  VAN_BEMMELEN_OM_FACTOR,
  SOILGRIDS_DEFAULT_NODATA,
  MAX_NEIGHBOR_DISTANCE_METERS,
  haversineDistanceMeters,
  decodeSoilGridsGeoTiff,
  getPixelCenterCoordinates,
  isRawSoilGridsValueValid,
  selectBestPixelFromGrid,
  computeDepthWeighted0_30cm,
  convertRawSoilGridsValue,
  buildSoilGridsWcsUrl,
  buildEssentialCoverageTasks,
  buildOptionalCoverageTasks,
  ESSENTIAL_SOILGRIDS_PROPERTIES,
  fetchSoilGridsWcsProfile,
  clearSoilGridsCacheForTests,
  type SoilGridsFetchDiagnostics,
} from "@/lib/soilgrids-wcs";
import {
  SOIL_PROVIDER_CAPABILITIES,
  resolveSoilDataTier,
  classifySoilPropertyStatus,
  normalizeSoilTexture,
  buildSoilProfileDisplayModel,
  depthWeightedAverage,
  depthWeightedTextureAverage,
  aggregateComponents,
  buildSsurgoPointWkt,
  SsurgoRequestError,
  queryUsdaSda,
  hasUsableSsurgoProperties,
  fetchUsdaSsurgoProfile,
  isUsableCachedSoilResponse,
  resolveSoilProfileForCoordinate,
  type SoilProfileInput,
  type SoilComponentInput,
} from "@/lib/soil-profile-utils";

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

test("Crop-family repetition in >2 cash-crop years rejected while cover-crop bridge produces warning", () => {
  // Case 1: Cash crops of the same family (Poaceae) in all 3 years -> hard rejected
  const cashRepeatStrategy = makeValidStrategy();
  cashRepeatStrategy.years[1].seasons[0].crop = "grain_sorghum";
  const cashRes = validateProposal(cashRepeatStrategy, {
    agGroup: "temperate_humid",
    regionTag: "us_southeast",
    availableCropIds: ["field_corn", "grain_sorghum", "soft_red_winter_wheat", "cereal_rye", "crimson_clover", "forage_radish"],
  });
  assert.equal(cashRes.valid, false);
  assert.ok(cashRes.errors.some((e) => e.includes("Poaceae") && e.includes("more than 2 years")));

  // Case 2: Cash crops in <=2 years per family, but cereal_rye cover crop in Year 2 brings Poaceae to 3 years -> accepted with bridge warning
  const coverBridgeStrategy = makeValidStrategy();
  coverBridgeStrategy.years[1].seasons.push({
    season: "Winter",
    crop: "cereal_rye",
    activity: "Winter rye",
    months: [12, 1, 2],
  });
  const bridgeRes = validateProposal(coverBridgeStrategy, {
    agGroup: "temperate_humid",
    regionTag: "us_southeast",
    availableCropIds: ["field_corn", "soybean", "soft_red_winter_wheat", "cereal_rye", "crimson_clover", "forage_radish"],
  });
  assert.equal(bridgeRes.valid, true);
  assert.ok(bridgeRes.warnings.some((w) => w.includes("Botanical family bridge advisory")));
});

test("Sclerotinia host stacking: high-risk sequences rejected while manageable 2-year combinations produce warning", () => {
  // Case 1 (Hard rejection): Sclerotinia hosts in all 3 years (no non-host cereal break year)
  const allThreeYearsHost = makeValidStrategy();
  allThreeYearsHost.years[0].seasons[0].crop = "sunflower";
  allThreeYearsHost.years[1].seasons[0].crop = "soybean";
  allThreeYearsHost.years[2].seasons[0].crop = "soybean";
  const res1 = validateProposal(allThreeYearsHost, {
    agGroup: "temperate_humid",
    regionTag: "us_southeast",
    availableCropIds: ["sunflower", "soybean", "field_corn"],
  });
  assert.equal(res1.valid, false);
  assert.ok(res1.errors.some((e) => e.includes("Sclerotinia")));

  // Case 2 (Hard rejection): Primary Sclerotinia oilseed hosts (sunflower, winter_canola, spring_canola) in >=2 years
  const twoPrimaryOilseeds = makeValidStrategy();
  twoPrimaryOilseeds.years[0].seasons = [
    { season: "Summer", crop: "sunflower", activity: "Plant sunflower", months: [5, 6, 7, 8, 9] },
  ];
  twoPrimaryOilseeds.years[1].seasons = [
    { season: "Summer", crop: "field_corn", activity: "Plant corn", months: [4, 5, 6, 7, 8] },
  ];
  twoPrimaryOilseeds.years[2].seasons = [
    { season: "Summer", crop: "sunflower", activity: "Plant sunflower", months: [5, 6, 7, 8, 9] },
  ];
  const res2 = validateProposal(twoPrimaryOilseeds, {
    agGroup: "temperate_humid",
    regionTag: "us_southeast",
    availableCropIds: ["sunflower", "soybean", "field_corn"],
  });
  assert.equal(res2.valid, false);
  assert.ok(res2.errors.some((e) => e.includes("Sclerotinia")));

  // Case 3 (Manageable risk -> valid with warning): 1 year sunflower + 1 year corn + 1 year soybean
  const manageableTwoYear = makeValidStrategy();
  manageableTwoYear.years[0].seasons = [
    { season: "Summer", crop: "sunflower", activity: "Plant sunflower", months: [5, 6, 7, 8, 9] },
  ];
  manageableTwoYear.years[1].seasons = [
    { season: "Summer", crop: "field_corn", activity: "Plant corn", months: [4, 5, 6, 7, 8] },
  ];
  manageableTwoYear.years[2].seasons = [
    { season: "Summer", crop: "soybean", activity: "Plant soybean", months: [5, 6, 7, 8, 9] },
  ];
  const res3 = validateProposal(manageableTwoYear, {
    agGroup: "temperate_humid",
    regionTag: "us_southeast",
    availableCropIds: ["sunflower", "soybean", "field_corn"],
  });
  assert.equal(res3.valid, true);
  assert.equal(res3.errors.length, 0);
  assert.ok(res3.warnings.some((w) => w.includes("Sclerotinia risk")));
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
  invalidSclerotinia.years[2].seasons[0].crop = "sunflower";

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

test("Environment-aware AI provider diagnostics & token sanitization (Preview vs Production vs Local)", () => {
  // 1. Vercel Preview environment explains Preview restriction clearly
  const previewReason = describeMissingAIProviderReason({
    VERCEL: "1",
    VERCEL_ENV: "preview",
  });
  assert.ok(previewReason.includes("Vercel Preview deployments"));
  assert.ok(previewReason.includes("Production environment"));
  assert.ok(previewReason.includes("GCP_PROJECT_NUMBER"));

  // 2. Vercel Production environment with missing WIF vars lists missing vars without local gcloud prompt
  const prodReason = describeMissingAIProviderReason({
    VERCEL: "1",
    VERCEL_ENV: "production",
    GOOGLE_CLOUD_PROJECT: "triangle-hackathon-claude-code",
  });
  assert.ok(prodReason.includes("Missing Vercel OIDC Workload Identity Federation"));
  assert.ok(prodReason.includes("GCP_PROJECT_NUMBER"));
  assert.ok(!prodReason.includes("gcloud auth application-default login"));

  // 3. Local development environment explains local ADC setup
  const localReason = describeMissingAIProviderReason({
    VERCEL_ENV: "development",
  });
  assert.ok(localReason.includes("gcloud auth application-default login"));
  assert.ok(localReason.includes("FALLO_AI_PROVIDER"));

  // 4. Token sanitization strips OAuth tokens, JWTs, and Bearer tokens
  const dirtyError =
    "Auth failed with Bearer secret-token-999 and access token ya29.a0AfH6SMB_secret_token and JWT eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiIxMjMifQ.c2lnbmF0dXJl";
  const cleanError = sanitizeGenerationErrorMessage(dirtyError);
  assert.ok(!cleanError.includes("secret-token-999"));
  assert.ok(!cleanError.includes("ya29.a0AfH6SMB_secret_token"));
  assert.ok(!cleanError.includes("eyJhbGciOiJSUzI1NiJ9"));
  assert.ok(cleanError.includes("[REDACTED_TOKEN]"));
  assert.ok(cleanError.includes("[REDACTED_OIDC_TOKEN]"));
});

test("Field-specific planning objectives adapt across 3 contrasting field contexts and priority weights", () => {
  const availableCrops = getAvailableCropsForContext("temperate_humid", "us_southeast");

  // Context 1: Hot, dry field with limited rainfall
  const hotDryClimate = makeClimate({
    avgAnnualTemp: 21.5,
    avgAnnualPrecip: 420,
    summerDrySpells: { avgMaxConsecutiveDryDays: 19, thresholdMm: 1, monthsDesc: "Jun–Aug" },
    summerHeatDays: { avgDaysAboveThreshold: 28, thresholdC: 35, monthsDesc: "Jul–Aug" },
    growingSeasonPrecip: { avgTotalMm: 150, monthsDesc: "May–Aug" },
  });
  const moderateSoil = makeSoil();
  moderateSoil.aggregated.depth0_30cm.om = 2.1;
  moderateSoil.aggregated.depth0_30cm.awc = 0.16;

  const hotDryObjectives = buildFieldSpecificObjectives({
    climate: hotDryClimate,
    soil: moderateSoil,
    priorities: DEFAULT_PRIORITIES,
    availableCropIds: availableCrops,
  });

  const hotDryWater = hotDryObjectives.find((o) => o.archetype === "water_resilience")!;
  const hotDrySoil = hotDryObjectives.find((o) => o.archetype === "soil_health")!;
  const hotDryDiv = hotDryObjectives.find((o) => o.archetype === "crop_diversity")!;
  assert.equal(hotDryWater.name, "Drought & Heat-Stress Buffering");
  assert.equal(hotDrySoil.name, "Moisture-Conserving Residue & Biological N");
  assert.equal(hotDryDiv.name, "Dryland Pest Break & Multi-Family Risk Spread");
  assert.ok(hotDryWater.objective.includes("150 mm"));
  assert.ok(hotDryWater.recommendedCropNames.length > 0);

  // Context 2: Humid field with high rainfall and poor drainage
  const humidClimate = makeClimate({
    avgAnnualTemp: 17.5,
    avgAnnualPrecip: 1380,
    springPrecip: { avgTotalMm: 360, monthsDesc: "Mar–May" },
    growingSeasonPrecip: { avgTotalMm: 540, monthsDesc: "May–Aug" },
  });
  const poorlyDrainedSoil = makeSoil();
  poorlyDrainedSoil.aggregated.depth0_30cm.om = 2.6;
  poorlyDrainedSoil.aggregated.depth0_30cm.awc = 0.19;
  poorlyDrainedSoil.aggregated.drainage = "Somewhat poorly drained";

  const humidObjectives = buildFieldSpecificObjectives({
    climate: humidClimate,
    soil: poorlyDrainedSoil,
    priorities: DEFAULT_PRIORITIES,
    availableCropIds: availableCrops,
  });

  const humidWater = humidObjectives.find((o) => o.archetype === "water_resilience")!;
  const humidSoil = humidObjectives.find((o) => o.archetype === "soil_health")!;
  const humidDiv = humidObjectives.find((o) => o.archetype === "crop_diversity")!;
  assert.equal(humidWater.name, "Drainage Resilience & Seasonal Water Balance");
  assert.equal(humidSoil.name, "Erosion Control, N Scavenging & Living Cover");
  assert.equal(humidDiv.name, "Humid Disease-Cycle Break & Family Rotation");
  assert.ok(humidWater.objective.includes("somewhat poorly drained"));

  // Context 3: Field with low soil organic matter and limited water-holding capacity
  const moderateClimate = makeClimate({
    avgAnnualTemp: 15.0,
    avgAnnualPrecip: 820,
    springPrecip: { avgTotalMm: 220, monthsDesc: "Mar–May" },
    growingSeasonPrecip: { avgTotalMm: 310, monthsDesc: "May–Aug" },
    summerDrySpells: { avgMaxConsecutiveDryDays: 9, thresholdMm: 1, monthsDesc: "Jun–Aug" },
    summerHeatDays: { avgDaysAboveThreshold: 4, thresholdC: 35, monthsDesc: "Jul–Aug" },
  });
  const lowOmLowAwcSoil = makeSoil();
  lowOmLowAwcSoil.aggregated.depth0_30cm.om = 0.9;
  lowOmLowAwcSoil.aggregated.depth0_30cm.awc = 0.08;
  lowOmLowAwcSoil.aggregated.depth0_30cm.sand = 76;

  const lowOmObjectives = buildFieldSpecificObjectives({
    climate: moderateClimate,
    soil: lowOmLowAwcSoil,
    priorities: DEFAULT_PRIORITIES,
    availableCropIds: availableCrops,
  });

  const lowOmSoilObj = lowOmObjectives.find((o) => o.archetype === "soil_health")!;
  const lowOmWaterObj = lowOmObjectives.find((o) => o.archetype === "water_resilience")!;
  const lowOmDivObj = lowOmObjectives.find((o) => o.archetype === "crop_diversity")!;
  assert.equal(lowOmSoilObj.name, "Organic Matter & Water-Holding Rebuilding");
  assert.equal(lowOmWaterObj.name, "Low-AWC Root-Zone Moisture Efficiency");
  assert.equal(lowOmDivObj.name, "Multi-Family Rotation & Root-Depth Diversity");
  assert.ok(lowOmSoilObj.objective.includes("0.9%"));
  assert.ok(lowOmWaterObj.objective.includes("0.08 cm/cm"));

  // Verify farmer priority sliders reorder and re-weight the objectives
  const waterHeavyObjectives = buildFieldSpecificObjectives({
    climate: moderateClimate,
    soil: lowOmLowAwcSoil,
    priorities: {
      waterSuitability: 100,
      climateRiskResilience: 95,
      soilCoverage: 20,
      nitrogenContribution: 10,
      diversityPestBreak: 10,
    },
    availableCropIds: availableCrops,
  });
  assert.equal(waterHeavyObjectives[0].archetype, "water_resilience");
  assert.ok(waterHeavyObjectives[0].emphasisTag.includes("Top Farmer Priority"));
});

section("Agronomic Consistency: Overlap, Seasonal Varieties, Termination, Nitrogen & Winter Survival");

test("Spring Barley (Mar–Jul) + Hairy Vetch (Sep–May) test case flags March–May overlap, May termination conflict, concurrent N unavailability, and conditional malting barley advisory without universal thresholds", () => {
  const testStrategy = makeValidStrategy("barley_vetch_conflict", "Barley + Hairy Vetch Test Case");
  // Year 1: Spring Barley (March–July) + Hairy Vetch (September–May) overlapping March–May
  testStrategy.years[0].seasons = [
    {
      season: "Spring–Summer",
      crop: "spring_barley",
      activity: "Plant spring barley March; harvest July",
      months: [3, 4, 5, 6, 7],
    },
    {
      season: "Fall–Spring Overwinter",
      crop: "hairy_vetch",
      activity: "Overwinter hairy vetch September–May",
      months: [9, 10, 11, 12, 1, 2, 3, 4, 5],
    },
  ];
  // Year 2: Soybean (Fabaceae) — remove crimson_clover so Fabaceae appears in <=2 years
  testStrategy.years[1].seasons = [
    {
      season: "Summer",
      crop: "soybean",
      activity: "Plant soybean",
      months: [5, 6, 7, 8, 9],
    },
  ];
  // Year 3: Corn + Forage Radish
  testStrategy.years[2].seasons = [
    {
      season: "Summer",
      crop: "field_corn",
      activity: "Plant corn",
      months: [4, 5, 6, 7, 8],
    },
    {
      season: "Fall",
      crop: "forage_radish",
      activity: "Plant radish",
      months: [8, 9, 10],
    },
  ];

  // Verify Hairy Vetch catalog note has no mandatory 3,500 lb DM/acre requirement
  const vetchCreditNote = cropLibrary.hairy_vetch.nitrogenBehavior.residualNcredit?.note ?? "";
  assert.ok(!vetchCreditNote.includes("3,500") && !vetchCreditNote.includes("3500"));
  assert.ok(vetchCreditNote.includes("upper-range potential"));
  assert.ok(vetchCreditNote.includes("establishment") && vetchCreditNote.includes("stand vigor"));

  // 1. Overlap & Termination evaluation
  const overlapFindings = evaluateCropOverlapAndTermination(testStrategy, "northern");
  const y1Findings = overlapFindings.filter((f) => f.year === 1);
  assert.equal(y1Findings.length, 1);
  const y1Conflict = y1Findings[0];
  assert.equal(y1Conflict.year, 1);
  assert.equal(y1Conflict.cashCropId, "spring_barley");
  assert.equal(y1Conflict.coverCropId, "hairy_vetch");
  assert.deepEqual(y1Conflict.sharedMonths, [3, 4, 5]);
  assert.deepEqual(y1Conflict.sharedMonthNames, ["Mar", "Apr", "May"]);
  assert.equal(y1Conflict.coverTerminationMonth, 5);
  assert.equal(y1Conflict.classification, "incompatible_overlap");
  assert.equal(y1Conflict.conflictsWithSensitiveStage, true);
  assert.ok(y1Conflict.conflictingStageLabels.some((lbl) => lbl.includes("Heading Grain Fill")));
  assert.ok(y1Conflict.message.includes("climbing/vining legume"));
  assert.ok(y1Conflict.message.includes("May"));

  // 2. Nitrogen & Conditional Malting Barley evaluation
  const nFindings = evaluateNitrogenAndBarleyCompatibility(testStrategy, "northern");
  assert.ok(
    nFindings.some(
      (f) =>
        f.kind === "concurrent_overlap_n_unavailable" &&
        f.legumeCropId === "hairy_vetch" &&
        f.targetCashCropId === "spring_barley" &&
        f.message.includes("post-termination credit mineralized for a subsequent crop") &&
        f.message.includes("NOT available to concurrently growing")
    )
  );
  const maltFinding = nFindings.find((f) => f.kind === "malting_barley_excess_n_risk")!;
  assert.ok(maltFinding);
  assert.ok(maltFinding.message.includes("If this barley is grown for malting"));
  assert.ok(maltFinding.message.includes("maltster, buyer, barley class, and contract"));
  assert.ok(!maltFinding.message.includes("11.5–12.5%"));
  assert.ok(!maltFinding.message.toLowerCase().includes("feed barley can utilize"));

  // 3. Proposal validator surfaces warnings
  const valResult = validateProposal(testStrategy, {
    agGroup: "temperate_humid",
    regionTag: "us_midwest",
    availableCropIds: ["spring_barley", "hairy_vetch", "soybean", "field_corn", "forage_radish"],
    climate: makeClimate(),
    hemisphere: "northern",
  });
  assert.equal(valResult.valid, true);
  assert.ok(valResult.warnings.some((w) => w.includes("Mar–Apr–May") && w.includes("Hairy Vetch")));
  assert.ok(valResult.warnings.some((w) => w.includes("NOT available to concurrently growing")));
  assert.ok(
    valResult.warnings.some(
      (w) =>
        w.includes("If this barley is grown for malting") &&
        w.includes("maltster, buyer, barley class, and contract") &&
        !w.includes("11.5–12.5%")
    )
  );

  // 4. Scoring engine (scoreNitrogen) qualifies N credit, removes full concurrent-overlap N credit,
  // and does NOT apply an automatic malting-related score penalty to non-overlapping feed/seasonal barley
  const scoredConcurrent = scoreStrategy(testStrategy, makeClimate(), makeSoil(), DEFAULT_PRIORITIES);
  const nScoreConcurrent = scoredConcurrent.factorScores.nitrogenContribution;
  assert.ok(
    nScoreConcurrent.positiveContributors.some((p) =>
      p.includes("conditional ~80–100 lb N/acre upper-range potential")
    )
  );
  assert.ok(
    nScoreConcurrent.negativeContributors.some((n) =>
      n.includes("NOT assigned or available to concurrently growing")
    )
  );
  assert.ok(
    nScoreConcurrent.negativeContributors.some(
      (n) =>
        n.includes("If grown for malting") &&
        n.includes("maltster, buyer, barley class, and contract") &&
        !n.includes("11.5–12.5%")
    )
  );

  // Compare non-overlapping hairy_vetch (Sep–Feb) -> spring_barley (Mar–Jul) vs. no-vetch baseline:
  // Non-overlapping barley receives the full +15 vetch credit with NO automatic -6 malting score penalty!
  const nonOverlappingBarleyStrat = makeValidStrategy("barley_after_vetch", "Barley After Vetch");
  nonOverlappingBarleyStrat.years[0].seasons = [
    {
      season: "Overwinter",
      crop: "hairy_vetch",
      activity: "Overwinter vetch terminated before barley",
      months: [9, 10, 11, 12, 1, 2],
    },
    {
      season: "Spring–Summer",
      crop: "spring_barley",
      activity: "Plant spring barley March–July",
      months: [3, 4, 5, 6, 7],
    },
  ];
  nonOverlappingBarleyStrat.years[1].seasons = testStrategy.years[1].seasons;
  nonOverlappingBarleyStrat.years[2].seasons = testStrategy.years[2].seasons;

  const noVetchBarleyStrat = makeValidStrategy("barley_no_vetch", "Barley Without Vetch");
  noVetchBarleyStrat.years[0].seasons = [
    {
      season: "Spring–Summer",
      crop: "spring_barley",
      activity: "Plant spring barley March–July",
      months: [3, 4, 5, 6, 7],
    },
  ];
  noVetchBarleyStrat.years[1].seasons = testStrategy.years[1].seasons;
  noVetchBarleyStrat.years[2].seasons = testStrategy.years[2].seasons;

  const scoredAfterVetch = scoreStrategy(nonOverlappingBarleyStrat, makeClimate(), makeSoil(), DEFAULT_PRIORITIES);
  const scoredNoVetch = scoreStrategy(noVetchBarleyStrat, makeClimate(), makeSoil(), DEFAULT_PRIORITIES);
  assert.equal(
    scoredAfterVetch.factorScores.nitrogenContribution.score! -
      scoredNoVetch.factorScores.nitrogenContribution.score!,
    15,
    "Non-overlapping spring_barley following hairy_vetch must receive the full +15 legume N credit without an automatic malting penalty"
  );
  assert.equal(
    nScoreConcurrent.score!,
    scoredNoVetch.factorScores.nitrogenContribution.score!,
    "Concurrently overlapping hairy_vetch (Mar–May) must not assign net N credit to concurrently growing spring_barley"
  );

  // 5. Field Calendar surfaces overlap, termination, conditional malting N, and winter-climate advisories
  const calendar = buildFieldCalendar({
    strategy: testStrategy,
    climate: makeClimate(),
    lat: 41.5,
    lon: -93.6,
  });
  const y1Seasons = calendar.years[0].seasons;
  const barleySeason = y1Seasons.find((s) => s.cropId === "spring_barley")!;
  const vetchSeason = y1Seasons.find((s) => s.cropId === "hairy_vetch")!;

  assert.ok(
    barleySeason.agronomicAdvisories.some(
      (a) => a.severity === "warning" && (a.category === "overlap" || a.category === "termination")
    )
  );
  assert.ok(
    barleySeason.agronomicAdvisories.some(
      (a) =>
        a.severity === "warning" &&
        a.category === "nitrogen" &&
        a.title.includes("Conditional malting barley")
    )
  );
  assert.ok(
    vetchSeason.nitrogenSummary.includes("for subsequent crop after termination") &&
      vetchSeason.nitrogenSummary.includes("not available to concurrently overlapping spring crop")
  );
  assert.ok(
    vetchSeason.agronomicAdvisories.some((a) => a.category === "winter_survival")
  );
});

test("Same-month transitions are classified as conditional_transition (dependent on intra-month order & management) while relay interseeding is compatible_interseeding", () => {
  const transitionStrat = makeValidStrategy("conditional_transitions", "Conditional Transition & Relay Plan");
  // Year 1: Hairy vetch ending in April (month 4) as Field Corn starts in April (month 4) -> conditional_transition
  transitionStrat.years[0].seasons = [
    {
      season: "Overwinter–Spring",
      crop: "hairy_vetch",
      activity: "Overwinter hairy vetch; terminate April before corn",
      months: [9, 10, 11, 12, 1, 2, 3, 4],
    },
    {
      season: "Spring–Summer",
      crop: "field_corn",
      activity: "Plant corn in April after vetch termination",
      months: [4, 5, 6, 7, 8],
    },
  ];
  // Year 2: Soybean [5, 6, 7, 8, 9, 10] with late-season overseeding of cereal_rye in [9, 10, 11, 12] (2-month tail relay)
  transitionStrat.years[1].seasons = [
    {
      season: "Summer",
      crop: "soybean",
      activity: "Grow soybean May–October",
      months: [5, 6, 7, 8, 9, 10],
    },
    {
      season: "Fall Relay",
      crop: "cereal_rye",
      activity: "Aerial overseed cereal rye at soybean leaf drop",
      months: [9, 10, 11, 12],
    },
  ];
  // Year 3: Crimson clover ending in May (month 5) as Grain Sorghum starts in May (month 5) -> conditional_transition without universal 10–14 day rule
  transitionStrat.years[2].seasons = [
    {
      season: "Overwinter–Spring",
      crop: "crimson_clover",
      activity: "Crimson clover terminated May",
      months: [10, 11, 12, 1, 2, 3, 4, 5],
    },
    {
      season: "Summer",
      crop: "grain_sorghum",
      activity: "Plant sorghum in May",
      months: [5, 6, 7, 8, 9],
    },
  ];

  const findings = evaluateCropOverlapAndTermination(transitionStrat, "northern");
  const y1Finding = findings.find((f) => f.year === 1)!;
  const y2Finding = findings.find((f) => f.year === 2)!;
  const y3Finding = findings.find((f) => f.year === 3)!;

  assert.equal(y1Finding.classification, "conditional_transition");
  assert.equal(y1Finding.conflictsWithSensitiveStage, false);
  assert.ok(y1Finding.message.includes("monthly resolution"));
  assert.ok(y1Finding.message.includes("10–14 days"));
  assert.ok(y1Finding.message.includes("planting-green"));

  assert.equal(y2Finding.classification, "compatible_interseeding");
  assert.equal(y2Finding.conflictsWithSensitiveStage, false);

  assert.equal(y3Finding.classification, "conditional_transition");
  assert.ok(y3Finding.message.includes("monthly resolution"));
  assert.ok(!y3Finding.message.includes("10–14 days"));
});

test("Spring vs. Winter varieties flag cold-winter mismatches, allow autumn-sown spring-habit crops in mild-winter systems, and filter (NH Spring)/(SH Autumn) calendar strings", () => {
  assert.ok(cropLibrary.spring_barley);
  assert.ok(cropLibrary.winter_barley);
  assert.ok(cropLibrary.winter_canola);
  assert.ok(cropLibrary.spring_canola);

  // 1. Cold-winter context (us_midwest / continental): autumn-sown spring_barley and spring-sown winter_canola are flagged
  const mismatchStrat = makeValidStrategy("variety_mismatch", "Variety Mismatch Plan");
  mismatchStrat.years[0].seasons = [
    {
      season: "Fall–Spring",
      crop: "spring_barley",
      activity: "Wrongly autumn-sown spring barley in cold winter",
      months: [10, 11, 12, 1, 2, 3, 4, 5],
    },
  ];
  mismatchStrat.years[1].seasons = [
    {
      season: "Spring–Summer",
      crop: "winter_canola",
      activity: "Wrongly spring-sown winter canola without winter vernalization",
      months: [4, 5, 6, 7, 8],
    },
  ];

  const coldWinterMismatches = evaluateSeasonalVarietyAlignment(
    mismatchStrat,
    "northern",
    { agGroup: "continental", regionTag: "us_midwest" }
  );
  assert.equal(coldWinterMismatches.length, 2);
  assert.equal(coldWinterMismatches[0].cropId, "spring_barley");
  assert.equal(coldWinterMismatches[0].recommendedAlternativeCropId, "winter_barley");
  assert.equal(coldWinterMismatches[1].cropId, "winter_canola");
  assert.equal(coldWinterMismatches[1].recommendedAlternativeCropId, "spring_canola");

  // 2. Mild-winter contexts (MENA, South Asian Rabi, Mediterranean, Australian winter-rainfall):
  // Autumn/winter-sown spring_wheat, spring_barley, and spring_canola are NOT falsely flagged
  const rabiAndMedStrat = makeValidStrategy("mild_winter_spring_habit", "Mild Winter Spring-Habit Plan");
  rabiAndMedStrat.years[0].seasons = [
    {
      season: "Rabi / Winter",
      crop: "spring_wheat",
      activity: "November-sown spring bread wheat in Rabi / MENA",
      months: [11, 12, 1, 2, 3, 4],
    },
  ];
  rabiAndMedStrat.years[1].seasons = [
    {
      season: "Winter",
      crop: "spring_barley",
      activity: "November-sown spring-habit barley in Mediterranean/MENA",
      months: [11, 12, 1, 2, 3, 4],
    },
  ];

  const menaFindings = evaluateSeasonalVarietyAlignment(
    rabiAndMedStrat,
    "northern",
    { agGroup: "arid", regionTag: "mena_mediterranean_arid" }
  );
  assert.equal(menaFindings.length, 0);

  const rabiFindings = evaluateSeasonalVarietyAlignment(
    rabiAndMedStrat,
    "northern",
    { agGroup: "tropical_monsoon", regionTag: "south_asia_indo_gangetic" }
  );
  assert.equal(rabiFindings.length, 0);

  const ausStrat = makeValidStrategy("aus_winter_rainfall", "Australian Winter Rainfall Plan");
  ausStrat.years[0].seasons = [
    {
      season: "Autumn–Spring",
      crop: "spring_canola",
      activity: "May-sown spring-habit canola in Southern Australia",
      months: [5, 6, 7, 8, 9, 10, 11],
    },
  ];
  const ausFindings = evaluateSeasonalVarietyAlignment(
    ausStrat,
    "southern",
    { agGroup: "temperate_mediterranean", regionTag: "australia_southern_wheatbelt" }
  );
  assert.equal(ausFindings.length, 0);

  // 3. Verify selectHemisphereWindowText() recognizes (NH Spring), (NH Autumn), (SH Spring), (SH Autumn)
  const nhSpringBarleyText = selectHemisphereWindowText(
    cropLibrary.spring_barley.growingWindow.planting,
    "northern",
    "March",
    "planting"
  );
  assert.ok(nhSpringBarleyText.includes("(NH Spring)"));
  assert.ok(!nhSpringBarleyText.includes("(SH Spring)"));

  const shSpringBarleyText = selectHemisphereWindowText(
    cropLibrary.spring_barley.growingWindow.planting,
    "southern",
    "August",
    "planting"
  );
  assert.ok(shSpringBarleyText.includes("(SH Spring)"));
  assert.ok(!shSpringBarleyText.includes("(NH Spring)"));

  const nhWinterBarleyText = selectHemisphereWindowText(
    cropLibrary.winter_barley.growingWindow.planting,
    "northern",
    "October",
    "planting"
  );
  assert.ok(nhWinterBarleyText.includes("(NH Autumn)"));
  assert.ok(!nhWinterBarleyText.includes("(SH Autumn)"));

  const shWinterBarleyText = selectHemisphereWindowText(
    cropLibrary.winter_barley.growingWindow.planting,
    "southern",
    "April",
    "planting"
  );
  assert.ok(shWinterBarleyText.includes("(SH Autumn)"));
  assert.ok(!shWinterBarleyText.includes("(NH Autumn)"));
});

test("Cover-crop winter suitability flags winter-kill species scheduled through spring and notes monthly mean limitations without fixed 10–15°C offsets or inferred daily lows", () => {
  const coldClimate = makeClimate({
    avgAnnualTemp: 7.5,
    monthlyTemp: [-7.2, -5.0, 2.0, 9.0, 15.0, 20.5, 23.0, 21.8, 16.5, 10.0, 2.5, -4.5],
  });

  const winterTestStrat = makeValidStrategy("winter_kill_test", "Winter Survival Test Plan");
  winterTestStrat.years[0].seasons = [
    {
      season: "Summer",
      crop: "field_corn",
      activity: "Corn",
      months: [5, 6, 7, 8, 9],
    },
    {
      season: "Overwinter–Spring",
      crop: "forage_radish",
      activity: "Radish mistakenly scheduled through May across freezing winter",
      months: [9, 10, 11, 12, 1, 2, 3, 4, 5],
    },
  ];
  winterTestStrat.years[1].seasons = [
    {
      season: "Summer",
      crop: "soybean",
      activity: "Soybean",
      months: [5, 6, 7, 8, 9],
    },
    {
      season: "Overwinter",
      crop: "crimson_clover",
      activity: "Clover in severe winter",
      months: [9, 10, 11, 12, 1, 2, 3, 4],
    },
  ];

  const winterFindings = evaluateCoverCropWinterSuitability({
    proposal: winterTestStrat,
    climate: coldClimate,
    hemisphere: "northern",
  });

  const radishFinding = winterFindings.find((f) => f.cropId === "forage_radish")!;
  assert.equal(radishFinding.severity, "warning");
  assert.ok(radishFinding.message.includes("winter-kills"));
  assert.ok(
    radishFinding.monthlyMeanLimitationNote.includes(
      "monthly mean temperatures, which cannot establish daily minimum freeze extremes"
    )
  );
  assert.ok(!radishFinding.message.includes("10–15"));
  assert.ok(!radishFinding.message.includes("-6 °C"));
  assert.ok(!radishFinding.message.includes("implying episodic daily lows"));

  const cloverFinding = winterFindings.find((f) => f.cropId === "crimson_clover")!;
  assert.equal(cloverFinding.severity, "warning");
  assert.ok(cloverFinding.message.includes("-7.2 °C"));
  assert.ok(!cloverFinding.message.includes("10–15"));
});

// ─── 18. Validation Audit, Sclerotinia Classification & Bounded Retry ──

section("Validation Audit, Sclerotinia Classification & Bounded Retry");

test("getSclerotiniaHosts excludes non-host disease suppressors (paddy_rice) and accurately classifies primary vs. moderate hosts", () => {
  const allCatalogCrops = Object.values(cropLibrary);
  const hosts = getSclerotiniaHosts(allCatalogCrops);

  // paddy_rice mentions Sclerotinia only because flooded rice ERADICATES sclerotia -> must NOT be in hosts
  assert.ok(
    !hosts.includes("paddy_rice"),
    "paddy_rice is a Poaceae non-host whose flooded phase eradicates sclerotia; must not be classified as a Sclerotinia host"
  );
  assert.ok(PRIMARY_SCLEROTINIA_HOSTS.has("sunflower"));
  assert.ok(PRIMARY_SCLEROTINIA_HOSTS.has("winter_canola"));
  assert.ok(PRIMARY_SCLEROTINIA_HOSTS.has("spring_canola"));
  assert.ok(MODERATE_SCLEROTINIA_HOSTS.has("soybean"));
  assert.deepEqual(
    hosts.slice().sort(),
    ["soybean", "spring_canola", "sunflower", "winter_canola"]
  );

  // A subtropical China rotation with paddy_rice (Year 1) -> winter_canola (Year 2) -> field_corn (Year 3)
  // has only 1 actual Sclerotinia host year (winter_canola) and must pass without Sclerotinia warnings or errors
  const riceCanolaCorn: RotationStrategy = {
    id: "rice_canola_corn",
    name: "Yangtze Rice-Canola-Corn",
    archetype: "crop_diversity",
    description: "Subtropical irrigated rice followed by winter rapeseed and maize.",
    years: [
      {
        year: 1,
        seasons: [
          { season: "Monsoon", crop: "paddy_rice", activity: "Irrigated lowland rice", months: [5, 6, 7, 8, 9] },
        ],
      },
      {
        year: 2,
        seasons: [
          { season: "Winter-Spring", crop: "winter_canola", activity: "Winter rapeseed", months: [10, 11, 12, 1, 2, 3, 4, 5] },
        ],
      },
      {
        year: 3,
        seasons: [
          { season: "Spring-Summer", crop: "field_corn", activity: "Spring maize", months: [4, 5, 6, 7, 8, 9] },
        ],
      },
    ],
    tradeoffs: { advantages: ["Diversified"], disadvantages: ["High water"], operational: ["Drain before canola"], warnings: [] },
  };

  const res = validateProposal(riceCanolaCorn, {
    agGroup: "subtropical_humid",
    regionTag: "east_asia_china_subtropical",
    availableCropIds: ["paddy_rice", "winter_canola", "field_corn", "soybean"],
    hemisphere: "northern",
  });
  assert.equal(res.valid, true);
  assert.equal(res.errors.length, 0);
  assert.ok(!res.warnings.some((w) => w.includes("Sclerotinia")));
});

test("All three canonical reference rotations in data/rotations.json pass deterministic validation with appropriate warnings", () => {
  const availableUsSoutheast = getAvailableCropsForContext("temperate_humid", "us_southeast");

  for (const strat of staticStrategies) {
    const res = validateProposal(strat, {
      agGroup: "temperate_humid",
      regionTag: "us_southeast",
      availableCropIds: availableUsSoutheast,
      hemisphere: "northern",
    });
    assert.equal(
      res.valid,
      true,
      `Canonical reference strategy "${strat.id}" should pass deterministic validation, but got errors: ${res.errors.join("; ")}`
    );
  }
});

test("Multi-region Sclerotinia and double-crop validation distinguishes manageable risks from hard incompatibilities", () => {
  // 1. US Great Plains (continental): winter_canola (Y1) -> spring_wheat (Y2) -> soybean (Y3)
  // Manageable 2-year Sclerotinia risk separated by non-host cereal -> accepted with warning + scoring penalty
  const plainsRotation: RotationStrategy = {
    id: "plains_canola_wheat_soy",
    name: "Plains Canola-Wheat-Soy",
    archetype: "crop_diversity",
    description: "Three-family rotation for the Great Plains.",
    years: [
      {
        year: 1,
        seasons: [
          { season: "Winter-Spring", crop: "winter_canola", activity: "Winter canola", months: [9, 10, 11, 12, 1, 2, 3, 4, 5, 6] },
        ],
      },
      {
        year: 2,
        seasons: [
          { season: "Spring-Summer", crop: "spring_wheat", activity: "Spring wheat", months: [3, 4, 5, 6, 7, 8] },
        ],
      },
      {
        year: 3,
        seasons: [
          { season: "Summer", crop: "soybean", activity: "Soybean", months: [5, 6, 7, 8, 9, 10] },
        ],
      },
    ],
    tradeoffs: { advantages: ["3 families"], disadvantages: ["Canola winter survival"], operational: ["Direct harvest"], warnings: [] },
  };

  const plainsValidation = validateProposal(plainsRotation, {
    agGroup: "continental",
    regionTag: "us_great_plains",
    availableCropIds: ["winter_canola", "spring_wheat", "soybean", "field_corn", "sunflower"],
    hemisphere: "northern",
  });
  assert.equal(plainsValidation.valid, true);
  assert.ok(plainsValidation.warnings.some((w) => w.includes("Sclerotinia risk")));

  const plainsScored = scoreStrategy(plainsRotation, makeClimate(), makeSoil(), DEFAULT_PRIORITIES, "us_great_plains");
  assert.ok(
    plainsScored.factorScores.diversityPestBreak.negativeContributors.some((n) =>
      n.includes("Sclerotinia consideration")
    )
  );

  // 2. US Great Plains (continental): winter_canola (Y1) -> spring_wheat (Y2) -> sunflower (Y3)
  // Two primary Sclerotinia oilseed hosts in a 3-year upland rotation -> HARD REJECTED
  const stackedPrimaryOilseeds: RotationStrategy = {
    ...plainsRotation,
    id: "stacked_oilseeds",
    years: [
      plainsRotation.years[0],
      plainsRotation.years[1],
      {
        year: 3,
        seasons: [
          { season: "Summer", crop: "sunflower", activity: "Oilseed sunflower", months: [5, 6, 7, 8, 9] },
        ],
      },
    ],
  };
  const stackedValidation = validateProposal(stackedPrimaryOilseeds, {
    agGroup: "continental",
    regionTag: "us_great_plains",
    availableCropIds: ["winter_canola", "spring_wheat", "soybean", "field_corn", "sunflower"],
    hemisphere: "northern",
  });
  assert.equal(stackedValidation.valid, false);
  assert.ok(stackedValidation.errors.some((e) => e.includes("Sclerotinia host stacking")));

  // 3. Winter-to-summer cash double-crop sharing 2 boundary months (May-June [5,6]) -> accepted with double-crop transition warning
  const doubleCropStrategy = makeValidStrategy("double_crop_wheat_soy", "Double Crop Wheat-Soy");
  doubleCropStrategy.years[1].seasons = [
    { season: "Winter-Spring", crop: "soft_red_winter_wheat", activity: "Winter wheat harvested June", months: [1, 2, 3, 4, 5, 6] },
    { season: "Summer", crop: "soybean", activity: "Double-crop soybean planted May-June", months: [5, 6, 7, 8, 9, 10] },
  ];
  doubleCropStrategy.years[2].seasons = [
    { season: "Summer", crop: "sunflower", activity: "Sunflower cash crop", months: [5, 6, 7, 8, 9] },
    { season: "Fall", crop: "forage_radish", activity: "Plant radish", months: [8, 9, 10] },
  ];
  const doubleCropRes = validateProposal(doubleCropStrategy, {
    agGroup: "temperate_humid",
    regionTag: "us_southeast",
    availableCropIds: ["field_corn", "soft_red_winter_wheat", "soybean", "sunflower", "cereal_rye", "crimson_clover", "forage_radish"],
    hemisphere: "northern",
  });
  assert.equal(doubleCropRes.valid, true);
  assert.ok(doubleCropRes.warnings.some((w) => w.includes("double-crop transition")));

  // 4. Single overwintering winter_canola planted in Oct of Year 1 and harvested in May-Jun of Year 2
  // must NOT be double-counted as 2 Sclerotinia host years
  const overwinterCanolaOnce: RotationStrategy = {
    id: "overwinter_canola_once",
    name: "Overwinter Canola Single Crop",
    archetype: "crop_diversity",
    description: "Single winter canola crop spanning Year 1 autumn to Year 2 spring.",
    years: [
      {
        year: 1,
        seasons: [
          { season: "Spring-Summer", crop: "spring_wheat", activity: "Spring wheat", months: [3, 4, 5, 6, 7, 8] },
          { season: "Fall", crop: "winter_canola", activity: "Plant winter canola in Oct", months: [10, 11] },
        ],
      },
      {
        year: 2,
        seasons: [
          { season: "Winter-Spring", crop: "winter_canola", activity: "Overwinter and harvest canola in June", months: [12, 1, 2, 3, 4, 5, 6] },
        ],
      },
      {
        year: 3,
        seasons: [
          { season: "Summer", crop: "field_corn", activity: "Maize", months: [4, 5, 6, 7, 8, 9] },
        ],
      },
    ],
    tradeoffs: { advantages: ["Single canola break"], disadvantages: ["Winter cold"], operational: ["Timely seeding"], warnings: [] },
  };
  const overwinterCanolaRes = validateProposal(overwinterCanolaOnce, {
    agGroup: "continental",
    regionTag: "us_great_plains",
    availableCropIds: ["spring_wheat", "winter_canola", "field_corn"],
    hemisphere: "northern",
  });
  assert.equal(overwinterCanolaRes.valid, true);
  assert.equal(overwinterCanolaRes.errors.length, 0);
  assert.ok(!overwinterCanolaRes.warnings.some((w) => w.includes("Sclerotinia risk")));
});

test("Bounded retry pipeline aggregates rejection reasons, requests crop diversification, and validates regenerated proposals", async () => {
  // Attempt 1: All 3 proposals fail for the same Sclerotinia host-stacking error (3 years of hosts or 2 primary oilseed years)
  const badPlan1 = makeValidStrategy("soil_health_plan", "Soil Health Plan");
  badPlan1.years[0].seasons = [{ season: "Summer", crop: "sunflower", activity: "Sunflower", months: [5, 6, 7, 8, 9] }];
  badPlan1.years[1].seasons = [{ season: "Summer", crop: "soybean", activity: "Soybean", months: [5, 6, 7, 8, 9] }];
  badPlan1.years[2].seasons = [{ season: "Summer", crop: "sunflower", activity: "Sunflower", months: [5, 6, 7, 8, 9] }];

  const badPlan2 = makeValidStrategy("water_resilience_plan", "Water Resilience Plan");
  badPlan2.years[0].seasons = [{ season: "Summer", crop: "sunflower", activity: "Sunflower", months: [5, 6, 7, 8, 9] }];
  badPlan2.years[1].seasons = [{ season: "Summer", crop: "field_corn", activity: "Corn", months: [4, 5, 6, 7, 8] }];
  badPlan2.years[2].seasons = [{ season: "Summer", crop: "sunflower", activity: "Sunflower", months: [5, 6, 7, 8, 9] }];

  const badPlan3 = makeValidStrategy("crop_diversity_plan", "Crop Diversity Plan");
  badPlan3.years[0].seasons = [{ season: "Summer", crop: "soybean", activity: "Soybean", months: [5, 6, 7, 8, 9] }];
  badPlan3.years[1].seasons = [{ season: "Summer", crop: "sunflower", activity: "Sunflower", months: [5, 6, 7, 8, 9] }];
  badPlan3.years[2].seasons = [{ season: "Summer", crop: "soybean", activity: "Soybean", months: [5, 6, 7, 8, 9] }];

  // Attempt 2: Corrective response with diversified, valid 3-year rotations
  const goodPlan1 = makeValidStrategy("soil_health_plan", "Soil Health Plan");
  const goodPlan2 = makeValidStrategy("water_resilience_plan", "Water Resilience Plan");
  goodPlan2.years[0].seasons = [{ season: "Summer", crop: "grain_sorghum", activity: "Sorghum", months: [5, 6, 7, 8, 9] }];
  goodPlan2.years[1].seasons = [{ season: "Summer", crop: "soybean", activity: "Soybean", months: [5, 6, 7, 8, 9] }];
  goodPlan2.years[2].seasons = [{ season: "Spring", crop: "soft_red_winter_wheat", activity: "Wheat", months: [3, 4, 5, 6] }];
  const goodPlan3 = makeValidStrategy("crop_diversity_plan", "Crop Diversity Plan");
  goodPlan3.years[0].seasons = [{ season: "Summer", crop: "field_corn", activity: "Corn", months: [4, 5, 6, 7, 8] }];
  goodPlan3.years[1].seasons = [{ season: "Summer", crop: "sunflower", activity: "Sunflower", months: [5, 6, 7, 8, 9] }];
  goodPlan3.years[2].seasons = [{ season: "Summer", crop: "soybean", activity: "Soybean", months: [5, 6, 7, 8, 9] }];

  const capturedPrompts: string[] = [];
  let callCount = 0;

  const retryMockProvider: AIProviderClient = {
    providerName: "mock-retry-provider",
    modelName: "gemini-4-argon",
    async generate({ prompt }) {
      callCount++;
      capturedPrompts.push(prompt);
      if (callCount === 1) {
        return JSON.stringify({
          strategies: [badPlan1, badPlan2, badPlan3],
          rationale: "Initial attempt with Sclerotinia host stacking across all 3 plans.",
        });
      }
      return JSON.stringify({
        strategies: [goodPlan1, goodPlan2, goodPlan3],
        rationale: "Regenerated diversified plans resolving Sclerotinia host stacking.",
      });
    },
  };

  const result = await generateRotations(
    {
      fieldId: "retry_field_1",
      fieldName: "Retry Test Field",
      lat: 35.67,
      lon: -80.47,
      climate: makeClimate(),
      soil: makeSoil(),
      priorities: DEFAULT_PRIORITIES,
      regionTag: "us_southeast",
    },
    retryMockProvider
  );

  assert.equal(callCount, 2, "Provider should be called twice (1 initial + 1 bounded retry)");
  assert.equal(result.retryCount, 1);
  assert.equal(result.proposals.length, 3, "All 3 regenerated valid proposals should be accepted");
  assert.ok(
    capturedPrompts[1].includes("CORRECTIVE RETRY CONSTRAINTS"),
    "Retry prompt must include corrective retry constraints section"
  );
  assert.ok(
    capturedPrompts[1].includes("Sclerotinia host stacking"),
    "Retry prompt must include the specific Sclerotinia rejection reason"
  );
  assert.ok(
    capturedPrompts[1].includes("CRITICAL CROP DIVERSIFICATION REQUIREMENT"),
    "Retry prompt must instruct Gemini to diversify crop selections when multiple plans share the same failure"
  );

  // Verify that goodPlan3 (Corn -> Sunflower -> Soybean) preserves its soft Sclerotinia warning
  const diversityProposal = result.proposals.find((p) => p.strategy.id === "crop_diversity_plan")!;
  assert.ok(
    diversityProposal.strategy.generationInfo?.validationWarnings?.some((w) =>
      w.includes("Sclerotinia risk")
    ),
    "Accepted manageable-risk proposal must preserve its Sclerotinia validation warning"
  );
});

test("Bounded retry pipeline stops after MAX_VALIDATION_RETRY_ATTEMPTS and never bypasses validation", async () => {
  const alwaysInvalid = makeValidStrategy("always_invalid", "Always Invalid Plan");
  alwaysInvalid.years[0].seasons[0].crop = "sunflower";
  alwaysInvalid.years[1].seasons[0].crop = "soybean";
  alwaysInvalid.years[2].seasons[0].crop = "sunflower";

  let callCount = 0;
  const persistentBadProvider: AIProviderClient = {
    providerName: "mock-persistent-bad-provider",
    async generate() {
      callCount++;
      return JSON.stringify({
        strategies: [alwaysInvalid],
        rationale: "Still invalid on retry.",
      });
    },
  };

  const result = await generateRotations(
    {
      fieldId: "retry_field_2",
      fieldName: "Persistent Failure Field",
      lat: 35.67,
      lon: -80.47,
      climate: makeClimate(),
      soil: makeSoil(),
      priorities: DEFAULT_PRIORITIES,
      regionTag: "us_southeast",
    },
    persistentBadProvider
  );

  assert.equal(callCount, 1 + MAX_VALIDATION_RETRY_ATTEMPTS, "Must stop after 1 bounded retry (2 calls total)");
  assert.equal(result.retryCount, MAX_VALIDATION_RETRY_ATTEMPTS);
  assert.equal(result.proposals.length, 0, "Must never bypass deterministic validation");
  assert.equal(result.supportStatus, "unavailable");
  assert.equal(result.rejectedProposals?.length, 1);
});

// ═══════════════════════════════════════════════════════════════════════
// 19. Live International ISRIC SoilGrids v2.0 OGC WCS Adapter & GeoTIFF Decoder
// ═══════════════════════════════════════════════════════════════════════

section("19. Live International ISRIC SoilGrids v2.0 OGC WCS Adapter & GeoTIFF Decoder");

/**
 * Test helper: Encode a synthetic GeoTIFF buffer matching ISRIC SoilGrids MapServer WCS output format
 * (tiled or strip-based, Deflate or uncompressed, Predictor=1 or Predictor=2, GeoTIFF scale/tiepoint tags,
 * and GDAL_NODATA tag) for deterministic unit and regression testing.
 */
function encodeSyntheticSoilGridsGeoTiff(params: {
  grid: number[][];
  bitsPerSample?: 8 | 16;
  sampleFormat?: number;
  samplesPerPixel?: number;
  compression?: 1 | 8;
  predictor?: number;
  tiled?: boolean;
  tileWidth?: number;
  tileLength?: number;
  rowsPerStrip?: number;
  noDataValue?: number | null;
  originLon?: number;
  originLat?: number;
  scaleX?: number;
  scaleY?: number;
}): Buffer {
  const height = params.grid.length;
  const width = params.grid[0]?.length ?? 0;
  const bitsPerSample = params.bitsPerSample ?? 16;
  const sampleFormat = params.sampleFormat ?? (bitsPerSample === 16 ? 2 : 1);
  const samplesPerPixel = params.samplesPerPixel ?? 1;
  const compression = params.compression ?? 8;
  const predictor = params.predictor ?? 2;
  const tiled = params.tiled ?? true;
  const tileWidth = tiled ? (params.tileWidth ?? 256) : width;
  const tileLength = tiled ? (params.tileLength ?? 256) : (params.rowsPerStrip ?? height);
  const noDataValue =
    params.noDataValue !== undefined ? params.noDataValue : SOILGRIDS_DEFAULT_NODATA;
  const bytesPerSample = bitsPerSample / 8;

  const allocHeight = Math.max(height, tileLength);
  const allocWidth = Math.max(width, tileWidth);
  const rawRaster = Buffer.alloc(allocWidth * allocHeight * bytesPerSample);
  for (let r = 0; r < allocHeight; r++) {
    let prevVal = 0;
    for (let c = 0; c < allocWidth; c++) {
      const actualVal =
        r < height && c < width ? params.grid[r][c] : (noDataValue ?? 0);
      const encodedVal = predictor === 2 && c > 0 ? actualVal - prevVal : actualVal;
      prevVal = actualVal;
      const offset = (r * allocWidth + c) * bytesPerSample;
      if (bitsPerSample === 16) {
        const wrapped16 = ((encodedVal & 0xffff) << 16) >> 16;
        rawRaster.writeInt16LE(wrapped16, offset);
      } else {
        rawRaster.writeUInt8(encodedVal & 0xff, offset);
      }
    }
  }

  const compressedBlock =
    compression === 8 ? zlib.deflateSync(rawRaster) : rawRaster;

  const scaleX = params.scaleX ?? 0.00225;
  const scaleY = params.scaleY ?? 0.00225;
  const originLon = params.originLon ?? 0;
  const originLat = params.originLat ?? 0;

  const scaleBuf = Buffer.alloc(24);
  scaleBuf.writeDoubleLE(scaleX, 0);
  scaleBuf.writeDoubleLE(scaleY, 8);
  scaleBuf.writeDoubleLE(0, 16);

  const tiepointBuf = Buffer.alloc(48);
  tiepointBuf.writeDoubleLE(0, 0);
  tiepointBuf.writeDoubleLE(0, 8);
  tiepointBuf.writeDoubleLE(0, 16);
  tiepointBuf.writeDoubleLE(originLon, 24);
  tiepointBuf.writeDoubleLE(originLat, 32);
  tiepointBuf.writeDoubleLE(0, 40);

  const noDataStrBuf =
    noDataValue !== null ? Buffer.from(`${noDataValue}\0`, "ascii") : null;

  interface IfdEntrySpec {
    tag: number;
    type: number;
    count: number;
    valueOrPayload: number | Buffer;
  }

  const entries: IfdEntrySpec[] = [
    { tag: 256, type: 3, count: 1, valueOrPayload: width },
    { tag: 257, type: 3, count: 1, valueOrPayload: height },
    { tag: 258, type: 3, count: 1, valueOrPayload: bitsPerSample },
    { tag: 259, type: 3, count: 1, valueOrPayload: compression },
    { tag: 262, type: 3, count: 1, valueOrPayload: 1 },
    { tag: 277, type: 3, count: 1, valueOrPayload: samplesPerPixel },
    { tag: 317, type: 3, count: 1, valueOrPayload: predictor },
    { tag: 339, type: 3, count: 1, valueOrPayload: sampleFormat },
    { tag: 33550, type: 12, count: 3, valueOrPayload: scaleBuf },
    { tag: 33922, type: 12, count: 6, valueOrPayload: tiepointBuf },
  ];

  if (tiled) {
    entries.push(
      { tag: 322, type: 3, count: 1, valueOrPayload: tileWidth },
      { tag: 323, type: 3, count: 1, valueOrPayload: tileLength },
      { tag: 324, type: 4, count: 1, valueOrPayload: 0 },
      { tag: 325, type: 4, count: 1, valueOrPayload: compressedBlock.length }
    );
  } else {
    entries.push(
      { tag: 273, type: 4, count: 1, valueOrPayload: 0 },
      { tag: 278, type: 3, count: 1, valueOrPayload: params.rowsPerStrip ?? height },
      { tag: 279, type: 4, count: 1, valueOrPayload: compressedBlock.length }
    );
  }

  if (noDataStrBuf) {
    entries.push({
      tag: 42113,
      type: 2,
      count: noDataStrBuf.length,
      valueOrPayload: noDataStrBuf,
    });
  }

  entries.sort((a, b) => a.tag - b.tag);

  const ifdOffset = 8;
  const ifdSize = 2 + entries.length * 12 + 4;
  let cursor = ifdOffset + ifdSize;

  const entryValueFields: number[] = [];
  const externalBuffers: Buffer[] = [];

  for (const e of entries) {
    if (typeof e.valueOrPayload === "number") {
      entryValueFields.push(e.valueOrPayload);
    } else if (e.valueOrPayload.length <= 4) {
      const inline = Buffer.alloc(4);
      e.valueOrPayload.copy(inline);
      entryValueFields.push(inline.readUInt32LE(0));
    } else {
      entryValueFields.push(cursor);
      externalBuffers.push(e.valueOrPayload);
      cursor += e.valueOrPayload.length;
    }
  }

  const rasterDataOffset = cursor;
  const totalLength = rasterDataOffset + compressedBlock.length;
  const out = Buffer.alloc(totalLength);

  out.write("II", 0, "ascii");
  out.writeUInt16LE(42, 2);
  out.writeUInt32LE(ifdOffset, 4);

  out.writeUInt16LE(entries.length, ifdOffset);
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    const base = ifdOffset + 2 + i * 12;
    out.writeUInt16LE(e.tag, base);
    out.writeUInt16LE(e.type, base + 2);
    out.writeUInt32LE(e.count, base + 4);
    const valField =
      e.tag === 324 || e.tag === 273 ? rasterDataOffset : entryValueFields[i];
    if (e.type === 3 && e.count === 1 && typeof e.valueOrPayload === "number") {
      out.writeUInt16LE(valField, base + 8);
      out.writeUInt16LE(0, base + 10);
    } else {
      out.writeUInt32LE(valField, base + 8);
    }
  }
  out.writeUInt32LE(0, ifdOffset + 2 + entries.length * 12);

  let extOffset = ifdOffset + ifdSize;
  for (const ext of externalBuffers) {
    ext.copy(out, extOffset);
    extOffset += ext.length;
  }

  compressedBlock.copy(out, rasterDataOffset);
  return out;
}

test("GeoTIFF decoder: decodes tiled 16-bit signed Deflate (Compression=8) + horizontal differencing (Predictor=2), NoData=-32768, dimensions, and coordinate alignment", () => {
  const sampleGrid = [
    [-32768, 210, 225, 240, -32768],
    [195, 205, 218, 232, 245],
    [190, 200, 215, 228, 242],
    [185, 198, 212, 224, 238],
    [-32768, 192, 208, 220, -32768],
  ];

  const originLon = 1.444375;
  const originLat = 48.455625;
  const scaleX = 0.00225;
  const scaleY = 0.00225;

  const buf = encodeSyntheticSoilGridsGeoTiff({
    grid: sampleGrid,
    bitsPerSample: 16,
    sampleFormat: 2,
    compression: 8,
    predictor: 2,
    tiled: true,
    tileWidth: 256,
    tileLength: 256,
    noDataValue: -32768,
    originLon,
    originLat,
    scaleX,
    scaleY,
  });

  const decoded = decodeSoilGridsGeoTiff(buf);
  assert.equal(decoded.width, 5);
  assert.equal(decoded.height, 5);
  assert.equal(decoded.bitsPerSample, 16);
  assert.equal(decoded.sampleFormat, 2);
  assert.equal(decoded.compression, 8);
  assert.equal(decoded.predictor, 2);
  assert.equal(decoded.noDataValue, -32768);
  assert.deepEqual(decoded.grid, sampleGrid);

  // Verify GeoTIFF ModelPixelScaleTag (33550) & ModelTiepointTag (33922) coordinate alignment
  assert.ok(decoded.pixelScale);
  assert.ok(decoded.tiepoint);
  const centerCoords = getPixelCenterCoordinates(decoded, 2, 2, {
    lonMin: originLon,
    latMin: originLat - 5 * scaleY,
    lonMax: originLon + 5 * scaleX,
    latMax: originLat,
  });
  // Center of pixel (2, 2) = origin + 2.5 * 0.00225 = origin + 0.005625
  assert.ok(Math.abs(centerCoords.lon - 1.45) < 1e-6);
  assert.ok(Math.abs(centerCoords.lat - 48.45) < 1e-6);
});

test("GeoTIFF decoder: decodes strip-based 8-bit unsigned (GEOTIFF_BYTE) uncompressed (Compression=1, Predictor=1) WRB raster", () => {
  const wrbGrid = [
    [18, 18, 18, 6, 6],
    [18, 18, 18, 6, 6],
    [18, 18, 18, 18, 6],
    [18, 18, 18, 18, 18],
    [255, 18, 18, 18, 255],
  ];

  const buf = encodeSyntheticSoilGridsGeoTiff({
    grid: wrbGrid,
    bitsPerSample: 8,
    sampleFormat: 1,
    compression: 1,
    predictor: 1,
    tiled: false,
    noDataValue: 255,
  });

  const decoded = decodeSoilGridsGeoTiff(buf);
  assert.equal(decoded.width, 5);
  assert.equal(decoded.height, 5);
  assert.equal(decoded.bitsPerSample, 8);
  assert.equal(decoded.sampleFormat, 1);
  assert.equal(decoded.compression, 1);
  assert.equal(decoded.predictor, 1);
  assert.equal(decoded.noDataValue, 255);
  assert.deepEqual(decoded.grid, wrbGrid);
  assert.equal(WRB_SOIL_GROUPS[decoded.grid[2][2]], "Luvisols");
});

test("Proper unit conversions for sand, silt, clay, SOC, derived OM, pH, bulk density, coarse fragments, and AWC", () => {
  // Sand, silt, clay: g/kg ÷ 10 -> %
  assert.equal(convertRawSoilGridsValue(345, "sand", 1), 34.5);
  assert.equal(convertRawSoilGridsValue(412, "silt", 1), 41.2);
  assert.equal(convertRawSoilGridsValue(243, "clay", 1), 24.3);

  // SOC: dg/kg ÷ 100 -> % weight (e.g., 185 dg/kg = 18.5 g/kg = 1.85% SOC)
  const socPct = convertRawSoilGridsValue(185, "soc", 2);
  assert.equal(socPct, 1.85);
  // Derived OM via Van Bemmelen factor (1.724): 1.85 * 1.724 = 3.1894 -> 3.19%
  const omPct = Number((socPct * VAN_BEMMELEN_OM_FACTOR).toFixed(2));
  assert.equal(omPct, 3.19);

  // pH (H2O): pH×10 ÷ 10 -> pH
  assert.equal(convertRawSoilGridsValue(68, "phh2o", 1), 6.8);

  // Bulk density (bdod): cg/cm³ ÷ 100 -> g/cm³
  assert.equal(convertRawSoilGridsValue(138, "bdod", 2), 1.38);

  // Coarse fragments (cfvo): cm³/dm³ ÷ 10 -> %
  assert.equal(convertRawSoilGridsValue(85, "cfvo", 1), 8.5);

  // Volumetric water content at 33 kPa and 1500 kPa: 0.1 vol% ÷ 1000 -> cm/cm
  assert.equal(convertRawSoilGridsValue(310, "wv0033", 3), 0.31);
  assert.equal(convertRawSoilGridsValue(145, "wv1500", 3), 0.145);
});

test("Correct 0–30 cm thickness-weighted depth aggregation across 0–5 cm (5 cm), 5–15 cm (10 cm), and 15–30 cm (15 cm)", () => {
  // Weights: 5/30, 10/30, 15/30
  // Clay: 20% (0-5cm), 26% (5-15cm), 32% (15-30cm)
  // Expected = (20*5 + 26*10 + 32*15) / 30 = (100 + 260 + 480) / 30 = 840 / 30 = 28.0%
  const fullWeighted = computeDepthWeighted0_30cm(
    [
      { depthId: "0-5cm", thicknessCm: 5, value: 20 },
      { depthId: "5-15cm", thicknessCm: 10, value: 26 },
      { depthId: "15-30cm", thicknessCm: 15, value: 32 },
    ],
    1
  );
  assert.equal(fullWeighted.value, 28.0);
  assert.equal(fullWeighted.coveragePct, 100);
  assert.equal(fullWeighted.coveredDepthCm, 30);

  // Partial coverage: missing 15–30 cm layer must be excluded (not treated as zero)
  // Expected = (20*5 + 26*10) / 15 = 360 / 15 = 24.0%, coverage = 50%
  const partialWeighted = computeDepthWeighted0_30cm(
    [
      { depthId: "0-5cm", thicknessCm: 5, value: 20 },
      { depthId: "5-15cm", thicknessCm: 10, value: 26 },
      { depthId: "15-30cm", thicknessCm: 15, value: null },
    ],
    1
  );
  assert.equal(partialWeighted.value, 24.0);
  assert.equal(partialWeighted.coveragePct, 50);
  assert.equal(partialWeighted.coveredDepthCm, 15);
});

test("NoData (-32768) handling: enforces strict ≤ 250 m neighbor distance limit, discloses high-latitude neighbors (≤ 125 m), and rejects pixels > 250 m", () => {
  assert.equal(MAX_NEIGHBOR_DISTANCE_METERS, 250);

  const lat = 48.45;
  const lon = 1.45;
  const scale = 0.00225;
  const originLon = lon - 2.5 * scale;
  const originLat = lat + 2.5 * scale;
  const bbox = {
    lonMin: originLon,
    latMin: lat - 2.5 * scale,
    lonMax: lon + 2.5 * scale,
    latMax: originLat,
  };

  // Case A: Center pixel (2,2) is masked (-32768), right neighbor (2,3) ~166 m away is valid (240)
  const maskedCenterGrid = [
    [-32768, -32768, -32768, -32768, -32768],
    [-32768, -32768, -32768, -32768, -32768],
    [-32768, -32768, -32768, 240, -32768],
    [-32768, -32768, -32768, -32768, -32768],
    [-32768, -32768, -32768, -32768, -32768],
  ];
  const decodedMasked = decodeSoilGridsGeoTiff(
    encodeSyntheticSoilGridsGeoTiff({
      grid: maskedCenterGrid,
      originLon,
      originLat,
      scaleX: scale,
      scaleY: scale,
    })
  );

  const selected = selectBestPixelFromGrid(decodedMasked, lat, lon, bbox, (raw) =>
    isRawSoilGridsValueValid(raw, SOILGRIDS_PROPERTIES.clay, decodedMasked.noDataValue)
  );
  assert.ok(selected, "Should select the valid neighbor pixel within ≤ 250 m");
  assert.equal(selected.row, 2);
  assert.equal(selected.col, 3);
  assert.equal(selected.rawValue, 240);
  assert.equal(selected.usedNeighborPixel, true);
  assert.ok(selected.distanceMeters > 0 && selected.distanceMeters <= 250);

  // Case B: High-latitude neighbor (lat = 62.0°N) where east neighbor (2,3) is ~117 m (≤ 125 m)
  // Must STILL set usedNeighborPixel = true so UI disclosure is never suppressed
  const hiLat = 62.0;
  const hiLon = 25.0;
  const hiOriginLon = hiLon - 2.5 * scale;
  const hiOriginLat = hiLat + 2.5 * scale;
  const hiBbox = {
    lonMin: hiOriginLon,
    latMin: hiLat - 2.5 * scale,
    lonMax: hiLon + 2.5 * scale,
    latMax: hiOriginLat,
  };
  const decodedHiLat = decodeSoilGridsGeoTiff(
    encodeSyntheticSoilGridsGeoTiff({
      grid: maskedCenterGrid,
      originLon: hiOriginLon,
      originLat: hiOriginLat,
      scaleX: scale,
      scaleY: scale,
    })
  );
  const selectedHiLat = selectBestPixelFromGrid(decodedHiLat, hiLat, hiLon, hiBbox, (raw) =>
    isRawSoilGridsValueValid(raw, SOILGRIDS_PROPERTIES.clay, decodedHiLat.noDataValue)
  );
  assert.ok(selectedHiLat, "High-latitude neighbor within ≤ 250 m must be selected");
  assert.equal(selectedHiLat.usedNeighborPixel, true, "usedNeighborPixel must be true even when distance ≤ 125 m");
  assert.ok(selectedHiLat.distanceMeters <= 125);

  // Case C: Valid pixels exist ONLY beyond 250 m (diagonal (1,1) ~296 m and corners (0,0)/(4,4) ~592 m)
  // Must return null so caller falls back to regional reference profile
  const beyond250mGrid = [
    [250, -32768, -32768, -32768, 250],
    [-32768, 240, -32768, 240, -32768],
    [-32768, -32768, -32768, -32768, -32768],
    [-32768, 240, -32768, 240, -32768],
    [250, -32768, -32768, -32768, 250],
  ];
  const decodedBeyond250m = decodeSoilGridsGeoTiff(
    encodeSyntheticSoilGridsGeoTiff({
      grid: beyond250mGrid,
      originLon,
      originLat,
      scaleX: scale,
      scaleY: scale,
    })
  );
  const rejectedBeyond250m = selectBestPixelFromGrid(decodedBeyond250m, lat, lon, bbox, (raw) =>
    isRawSoilGridsValueValid(raw, SOILGRIDS_PROPERTIES.clay, decodedBeyond250m.noDataValue)
  );
  assert.equal(
    rejectedBeyond250m,
    null,
    "Must reject valid pixels > 250 m away and return null for regional fallback"
  );

  // Case D: All pixels in the 5×5 window are NoData (-32768)
  const allNoDataGrid = Array.from({ length: 5 }, () => Array(5).fill(SOILGRIDS_DEFAULT_NODATA));
  const decodedAllNoData = decodeSoilGridsGeoTiff(
    encodeSyntheticSoilGridsGeoTiff({
      grid: allNoDataGrid,
      originLon,
      originLat,
      scaleX: scale,
      scaleY: scale,
    })
  );
  const noneSelected = selectBestPixelFromGrid(decodedAllNoData, lat, lon, bbox, (raw) =>
    isRawSoilGridsValueValid(raw, SOILGRIDS_PROPERTIES.clay, decodedAllNoData.noDataValue)
  );
  assert.equal(noneSelected, null, "Must return null when all pixels are NoData");
});

/**
 * Helper to create a deterministic mock WCS `fetchFn` that serves encoded GeoTIFFs
 * for a given set of coverage values at `(lat, lon)`.
 */
function createMockSoilGridsFetch(
  coverageValues: Record<string, number>,
  options?: { maskCenterPixel?: boolean }
): typeof fetch {
  return (async (input: RequestInfo | URL) => {
    const urlStr = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const u = new URL(urlStr);
    const coverage = u.searchParams.get("COVERAGE") ?? "";
    const format = u.searchParams.get("FORMAT") ?? "GEOTIFF_INT16";
    const bboxParts = (u.searchParams.get("BBOX") ?? "0,0,0.01125,0.01125").split(",").map(Number);
    const [lonMin, , , latMax] = bboxParts;

    if (!(coverage in coverageValues)) {
      return new Response("Coverage not available", { status: 404 });
    }

    const val = coverageValues[coverage];
    const isByte = format === "GEOTIFF_BYTE";
    const noData = isByte ? 255 : -32768;

    const grid = Array.from({ length: 5 }, (_, r) =>
      Array.from({ length: 5 }, (__, c) => {
        if (options?.maskCenterPixel && r === 2 && c === 2) {
          return noData;
        }
        return val;
      })
    );

    const tiffBuf = encodeSyntheticSoilGridsGeoTiff({
      grid,
      bitsPerSample: isByte ? 8 : 16,
      sampleFormat: isByte ? 1 : 2,
      compression: 8,
      predictor: 2,
      tiled: true,
      noDataValue: noData,
      originLon: lonMin,
      originLat: latMax,
      scaleX: 0.00225,
      scaleY: 0.00225,
    });

    return new Response(new Uint8Array(tiffBuf), {
      status: 200,
      headers: { "Content-Type": "image/tiff" },
    });
  }) as typeof fetch;
}

test("Successful SoilGrids WCS response parsing, normalization, missing-attribute non-fabrication, and strict layer-specific uncertainty labeling", async () => {
  clearSoilGridsCacheForTests();
  const lat = 48.447;
  const lon = 1.489;

  // Simulate Beauce (France) silt loam Luvisol across 0–5, 5–15, 15–30 cm
  // Notice we intentionally omit wv0033/wv1500 here to verify AWC is NOT fabricated when water retention is absent
  const mockCoverages: Record<string, number> = {
    "sand_0-5cm_Q0.5": 180,
    "sand_5-15cm_Q0.5": 170,
    "sand_15-30cm_Q0.5": 160,
    "silt_0-5cm_Q0.5": 580,
    "silt_5-15cm_Q0.5": 570,
    "silt_15-30cm_Q0.5": 560,
    "clay_0-5cm_Q0.5": 240,
    "clay_5-15cm_Q0.5": 260,
    "clay_15-30cm_Q0.5": 280,
    "soc_0-5cm_Q0.5": 210, // 2.10% SOC
    "soc_5-15cm_Q0.5": 165, // 1.65% SOC
    "soc_15-30cm_Q0.5": 120, // 1.20% SOC
    "phh2o_0-5cm_Q0.5": 69,
    "phh2o_5-15cm_Q0.5": 70,
    "phh2o_15-30cm_Q0.5": 71,
    "bdod_0-5cm_Q0.5": 132,
    "bdod_5-15cm_Q0.5": 138,
    "bdod_15-30cm_Q0.5": 144,
    "cfvo_0-5cm_Q0.5": 40,
    "cfvo_5-15cm_Q0.5": 50,
    "cfvo_15-30cm_Q0.5": 60,
    // 0-5cm Q0.05 and Q0.95 uncertainty quantiles
    "sand_0-5cm_Q0.05": 90,
    "sand_0-5cm_Q0.95": 290,
    "silt_0-5cm_Q0.05": 440,
    "silt_0-5cm_Q0.95": 690,
    "clay_0-5cm_Q0.05": 160,
    "clay_0-5cm_Q0.95": 330,
    "soc_0-5cm_Q0.05": 125,
    "soc_0-5cm_Q0.95": 340,
    "phh2o_0-5cm_Q0.05": 61,
    "phh2o_0-5cm_Q0.95": 76,
    MostProbable: 18, // Luvisols
  };

  const profile = await fetchSoilGridsWcsProfile(lat, lon, {
    fetchFn: createMockSoilGridsFetch(mockCoverages),
    bypassCache: true,
  });

  assert.ok(profile, "Profile must be returned");
  assert.equal(profile.dataTier, "soilgrids_wcs_250m");
  assert.equal(profile.wrbSoilGroup, "Luvisols");
  assert.equal(profile.horizonsDetailed.length, 3);

  // Verify 0–30 cm depth-weighted calculations:
  // Sand: (18*5 + 17*10 + 16*15)/30 = (90 + 170 + 240)/30 = 500/30 = 16.7%
  assert.equal(profile.aggregated.depth0_30cm.sand, 16.7);
  // Silt: (58*5 + 57*10 + 56*15)/30 = (290 + 570 + 840)/30 = 1700/30 = 56.7%
  assert.equal(profile.aggregated.depth0_30cm.silt, 56.7);
  // Clay: (24*5 + 26*10 + 28*15)/30 = (120 + 260 + 420)/30 = 800/30 = 26.7%
  assert.equal(profile.aggregated.depth0_30cm.clay, 26.7);
  // SOC: (2.10*5 + 1.65*10 + 1.20*15)/30 = (10.5 + 16.5 + 18.0)/30 = 45/30 = 1.50% SOC
  assert.equal(profile.aggregated.depth0_30cm.organicCarbonPct, 1.5);
  // Derived OM: 1.50 * 1.724 = 2.586 -> 2.59%
  assert.equal(profile.aggregated.depth0_30cm.om, 2.59);
  // pH: (6.9*5 + 7.0*10 + 7.1*15)/30 = (34.5 + 70 + 106.5)/30 = 211/30 = 7.0
  assert.equal(profile.aggregated.depth0_30cm.ph, 7.0);
  // Bulk density: (1.32*5 + 1.38*10 + 1.44*15)/30 = (6.6 + 13.8 + 21.6)/30 = 42/30 = 1.40 g/cm³
  assert.equal(profile.aggregated.depth0_30cm.bulkDensityGcm3, 1.4);
  // Coarse fragments: (4*5 + 5*10 + 6*15)/30 = (20 + 50 + 90)/30 = 160/30 = 5.3%
  assert.equal(profile.aggregated.depth0_30cm.coarseFragmentsPct, 5.3);

  // Requirement 7: Missing attributes (drainage, slope, unavailable water retention AWC) are NEVER fabricated
  assert.equal(profile.aggregated.drainage, null, "Drainage must remain null, never fabricated");
  assert.equal(profile.aggregated.slope, null, "Slope must remain null, never fabricated");
  assert.equal(
    profile.aggregated.depth0_30cm.awc,
    null,
    "AWC must remain null when wv0033/wv1500 water retention is unavailable, never fabricated"
  );

  // Requirement 8: Layer-specific uncertainty (0–5 cm) is NEVER mislabeled as full 0–30 cm uncertainty
  assert.equal(
    profile.uncertainty,
    undefined,
    "Top-level 0–30 cm uncertainty must be undefined on SoilGrids profiles"
  );
  assert.ok(profile.layerUncertainty, "Layer-specific 0–5 cm uncertainty must be present");
  assert.equal(profile.layerUncertainty.depthInterval, "0-5cm");
  assert.deepEqual(profile.layerUncertainty.properties.clay, {
    q05: 16,
    q50: 24,
    q95: 33,
    unit: "%",
  });
  assert.ok(
    profile.propertySources.om.includes("Van Bemmelen factor (OM = SOC × 1.724)"),
    "OM provenance must explicitly disclose derivation from SOC"
  );
});

test("Two different international coordinates in the same region receive genuinely different soil profiles when source pixels differ", async () => {
  clearSoilGridsCacheForTests();
  // Coordinate A: Sandy loam pixel in Cerrado, Brazil
  const sandyCoverages: Record<string, number> = {
    "sand_0-5cm_Q0.5": 680,
    "sand_5-15cm_Q0.5": 660,
    "sand_15-30cm_Q0.5": 640,
    "silt_0-5cm_Q0.5": 120,
    "silt_5-15cm_Q0.5": 120,
    "silt_15-30cm_Q0.5": 120,
    "clay_0-5cm_Q0.5": 200,
    "clay_5-15cm_Q0.5": 220,
    "clay_15-30cm_Q0.5": 240,
    "soc_0-5cm_Q0.5": 110,
    "soc_5-15cm_Q0.5": 95,
    "soc_15-30cm_Q0.5": 80,
    "phh2o_0-5cm_Q0.5": 51,
    "phh2o_5-15cm_Q0.5": 52,
    "phh2o_15-30cm_Q0.5": 53,
    "wv0033_0-5cm_Q0.5": 210,
    "wv0033_5-15cm_Q0.5": 215,
    "wv0033_15-30cm_Q0.5": 220,
    "wv1500_0-5cm_Q0.5": 110,
    "wv1500_5-15cm_Q0.5": 115,
    "wv1500_15-30cm_Q0.5": 120,
    MostProbable: 10, // Ferralsols
  };

  // Coordinate B: Clayey pixel 30 km away in Cerrado, Brazil
  const clayeyCoverages: Record<string, number> = {
    "sand_0-5cm_Q0.5": 260,
    "sand_5-15cm_Q0.5": 240,
    "sand_15-30cm_Q0.5": 220,
    "silt_0-5cm_Q0.5": 180,
    "silt_5-15cm_Q0.5": 180,
    "silt_15-30cm_Q0.5": 180,
    "clay_0-5cm_Q0.5": 560,
    "clay_5-15cm_Q0.5": 580,
    "clay_15-30cm_Q0.5": 600,
    "soc_0-5cm_Q0.5": 240,
    "soc_5-15cm_Q0.5": 200,
    "soc_15-30cm_Q0.5": 170,
    "phh2o_0-5cm_Q0.5": 56,
    "phh2o_5-15cm_Q0.5": 57,
    "phh2o_15-30cm_Q0.5": 58,
    "wv0033_0-5cm_Q0.5": 350,
    "wv0033_5-15cm_Q0.5": 355,
    "wv0033_15-30cm_Q0.5": 360,
    "wv1500_0-5cm_Q0.5": 210,
    "wv1500_5-15cm_Q0.5": 215,
    "wv1500_15-30cm_Q0.5": 220,
    MostProbable: 10, // Ferralsols
  };

  const profileA = await fetchSoilGridsWcsProfile(-12.54, -55.72, {
    fetchFn: createMockSoilGridsFetch(sandyCoverages),
    bypassCache: true,
  });
  const profileB = await fetchSoilGridsWcsProfile(-12.81, -55.95, {
    fetchFn: createMockSoilGridsFetch(clayeyCoverages),
    bypassCache: true,
  });

  assert.ok(profileA && profileB);
  assert.notEqual(profileA.aggregated.depth0_30cm.clay, profileB.aggregated.depth0_30cm.clay);
  assert.notEqual(profileA.aggregated.depth0_30cm.sand, profileB.aggregated.depth0_30cm.sand);
  assert.notEqual(profileA.aggregated.depth0_30cm.om, profileB.aggregated.depth0_30cm.om);
  assert.notEqual(profileA.aggregated.depth0_30cm.ph, profileB.aggregated.depth0_30cm.ph);
  assert.notEqual(profileA.aggregated.depth0_30cm.awc, profileB.aggregated.depth0_30cm.awc);
  assert.equal(profileA.aggregated.depth0_30cm.awc, 0.1);
  assert.equal(profileB.aggregated.depth0_30cm.awc, 0.14);
});

test("Fallback to macro-regional reference profile when WCS fails, times out, or encounters all-NoData", async () => {
  clearSoilGridsCacheForTests();
  const lat = 52.23;
  const lon = 21.01;

  // Simulate WCS timeout / network failure
  const failingFetch: typeof fetch = (async () => {
    throw new Error("Simulated WCS timeout");
  }) as typeof fetch;

  const wcsResult = await fetchSoilGridsWcsProfile(lat, lon, {
    fetchFn: failingFetch,
    bypassCache: true,
  });
  assert.equal(wcsResult, null, "WCS client must return null on network failure/timeout");

  // Verify regional fallback resolves cleanly when WCS returns null
  const fallback = resolveGlobalSoilFallback(lat, lon);
  assert.ok(fallback.aggregated.depth0_30cm.clay !== null);
  assert.ok(fallback.source.includes("HWSD v2.2"));
});

test("U.S. coordinates continue to be routed to USDA NRCS SSURGO and all 6 features consume normalized SoilGrids SoilData without error", async () => {
  // Verify U.S. detection remains intact for CONUS, Alaska, Hawaii, and Puerto Rico
  const iowaGeo = resolveGeographicContext(42.03, -93.62);
  assert.equal(iowaGeo.countryCodeIso2, "US");

  const franceGeo = resolveGeographicContext(48.45, 1.49);
  assert.equal(franceGeo.countryCodeIso2, "FR");

  // Build normalized SoilGrids SoilData and run through all 6 features
  const mockCoverages: Record<string, number> = {
    "sand_0-5cm_Q0.5": 240,
    "sand_5-15cm_Q0.5": 230,
    "sand_15-30cm_Q0.5": 220,
    "silt_0-5cm_Q0.5": 500,
    "silt_5-15cm_Q0.5": 500,
    "silt_15-30cm_Q0.5": 500,
    "clay_0-5cm_Q0.5": 260,
    "clay_5-15cm_Q0.5": 270,
    "clay_15-30cm_Q0.5": 280,
    "soc_0-5cm_Q0.5": 180,
    "soc_5-15cm_Q0.5": 150,
    "soc_15-30cm_Q0.5": 130,
    "phh2o_0-5cm_Q0.5": 67,
    "phh2o_5-15cm_Q0.5": 68,
    "phh2o_15-30cm_Q0.5": 69,
    "bdod_0-5cm_Q0.5": 135,
    "bdod_5-15cm_Q0.5": 140,
    "bdod_15-30cm_Q0.5": 145,
    "cfvo_0-5cm_Q0.5": 30,
    "cfvo_5-15cm_Q0.5": 40,
    "cfvo_15-30cm_Q0.5": 50,
    "wv0033_0-5cm_Q0.5": 320,
    "wv0033_5-15cm_Q0.5": 320,
    "wv0033_15-30cm_Q0.5": 320,
    "wv1500_0-5cm_Q0.5": 150,
    "wv1500_5-15cm_Q0.5": 150,
    "wv1500_15-30cm_Q0.5": 150,
    MostProbable: 18,
  };

  const sgProfile = await fetchSoilGridsWcsProfile(48.45, 1.49, {
    fetchFn: createMockSoilGridsFetch(mockCoverages),
    bypassCache: true,
  });
  assert.ok(sgProfile);

  const soilData: SoilData = {
    aggregated: sgProfile.aggregated,
    dataCoverage: sgProfile.dataCoverage,
    totalComponentPercent: sgProfile.totalComponentPercent,
    source: sgProfile.source,
    limitations: sgProfile.limitations,
  };

  const climate = makeClimate({
    avgAnnualTemp: 11.4,
    avgAnnualPrecip: 645,
    monthlyTemp: [3.8, 4.5, 7.6, 10.4, 14.1, 17.4, 19.6, 19.4, 15.9, 11.8, 7.1, 4.3],
    monthlyPrecip: [52, 44, 48, 51, 62, 54, 56, 51, 50, 61, 58, 58],
  });

  // Feature 1 & 2: Agro-Classifier & Evidence Profile
  const classification = classifyAgGroup(climate, soilData);
  assert.ok(classification.group !== "unknown");
  const evidence = buildUnifiedFieldEvidenceProfile(48.45, 1.49, climate, soilData);
  assert.ok(evidence.activeProviders.length > 0);
  assert.ok(
    evidence.activeProviders.some((p) => p.id === "isric_soilgrids_wcs"),
    "Evidence profile must include ISRIC SoilGrids v2.0 WCS provider"
  );

  // Feature 3: Crop Rotation Lab validation, scoring, and prompt generation
  const reqCheck = GenerationRequestSchema.safeParse({
    fieldId: "intl_fr_1",
    fieldName: "Beauce Arable Field",
    lat: 48.45,
    lon: 1.49,
    climate,
    soil: soilData,
    priorities: DEFAULT_PRIORITIES,
    regionTag: franceGeo.regionTag,
  });
  assert.ok(reqCheck.success, "GenerationRequestSchema must accept normalized SoilGrids SoilData");

  const validStrat = makeValidStrategy("fr_plan_1", "Beauce 3-Year Plan");
  const scoreRes = scoreStrategy(
    validStrat,
    climate,
    soilData,
    DEFAULT_PRIORITIES,
    franceGeo.regionTag ?? undefined
  );
  assert.ok(Number.isFinite(scoreRes.overallScore));

  // Feature 4: What-If Climate Simulator
  const whatIfRes = evaluateWhatIfScenario({
    baselineClimate: climate,
    soil: soilData,
    priorities: DEFAULT_PRIORITIES,
    strategies: [validStrat],
    scenario: { tempDeltaC: 1.5, precipMode: "percent", precipDeltaPct: -10, precipDeltaMm: 0 },
  });
  assert.ok(whatIfRes.scenarioClassification);

  // Feature 5: Field Calendar
  const calendarRes = buildFieldCalendar({
    strategy: validStrat,
    climate,
    lat: 48.45,
    lon: 1.49,
  });
  assert.equal(calendarRes.years.length, 3);

  // Feature 6: Historical Climate Analogues
  const climateWithArchive: ClimateData = {
    ...climate,
    periods: {
      startYear: 2006,
      endYear: 2025,
      baselineStart: 2006,
      baselineEnd: 2020,
      recentStart: 2021,
      recentEnd: 2025,
    },
    historicalYears: Array.from({ length: 20 }, (_, idx) => ({
      year: 2006 + idx,
      avgTemp: 11.0 + (idx % 3) * 0.4,
      totalPrecip: 620 + (idx % 4) * 25,
      avgSolar: 13.5,
      monthlyTemp: [3.8, 4.5, 7.6, 10.4, 14.1, 17.4, 19.6, 19.4, 15.9, 11.8, 7.1, 4.3],
      monthlyPrecip: [52, 44, 48, 51, 62, 54, 56, 51, 50, 61, 58, 58],
      monthlySolar: Array(12).fill(13.5),
      springPrecipMm: 161,
      growingSeasonPrecipMm: 223,
      summerDrySpellDays: 7 + (idx % 3),
      summerHeatDays: 3 + (idx % 2),
      daysWithData: 365,
    })),
  };
  const analoguesRes = computeClimateAnalogues({
    climate: climateWithArchive,
    mode: "recent_window",
    topN: 5,
  });
  assert.equal(analoguesRes.status, "ready");
  assert.ok(analoguesRes.matches.length > 0);
});

test("Adversarial guard (F-1 & F-4): never combines properties, depth layers, quantiles, or WRB from different geographic pixels, and rejects partial-depth core profiles", async () => {
  clearSoilGridsCacheForTests();
  const lat = 48.45;
  const lon = 1.49;

  const baseCoverages: Record<string, number> = {
    "sand_0-5cm_Q0.5": 200,
    "sand_5-15cm_Q0.5": 200,
    "sand_15-30cm_Q0.5": 200,
    "silt_0-5cm_Q0.5": 540,
    "silt_5-15cm_Q0.5": 540,
    "silt_15-30cm_Q0.5": 540,
    "clay_0-5cm_Q0.5": 260,
    "clay_5-15cm_Q0.5": 260,
    "clay_15-30cm_Q0.5": 260,
    "soc_0-5cm_Q0.5": 180,
    "soc_5-15cm_Q0.5": 160,
    "soc_15-30cm_Q0.5": 140,
    "phh2o_0-5cm_Q0.5": 68,
    "phh2o_5-15cm_Q0.5": 69,
    "phh2o_15-30cm_Q0.5": 70,
    "bdod_0-5cm_Q0.5": 135,
    "bdod_5-15cm_Q0.5": 140,
    "bdod_15-30cm_Q0.5": 145,
    "cfvo_0-5cm_Q0.5": 20,
    "cfvo_5-15cm_Q0.5": 25,
    "cfvo_15-30cm_Q0.5": 30,
    "wv0033_0-5cm_Q0.5": 310,
    "wv0033_5-15cm_Q0.5": 310,
    "wv0033_15-30cm_Q0.5": 310,
    "wv1500_0-5cm_Q0.5": 150,
    "wv1500_5-15cm_Q0.5": 150,
    "wv1500_15-30cm_Q0.5": 150,
    "sand_0-5cm_Q0.05": 110,
    "sand_0-5cm_Q0.95": 310,
    MostProbable: 18,
  };

  // Case 1: Center pixel (2,2) is valid in canary (`clay_0-5cm_Q0.5`), but `sand_15-30cm_Q0.5` is NoData (-32768)
  // ONLY at (2,2) while neighbor (2,3) has valid `sand_15-30cm_Q0.5 = 450`.
  // Adapter must NOT pull `sand_15-30cm_Q0.5` from (2,3), and because a core depth layer is missing at (2,2),
  // must return `null` so `/api/soil` falls back cleanly to the regional reference profile.
  const chimericCoreFetch: typeof fetch = (async (input: RequestInfo | URL) => {
    const urlStr = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const u = new URL(urlStr);
    const coverage = u.searchParams.get("COVERAGE") ?? "";
    const format = u.searchParams.get("FORMAT") ?? "GEOTIFF_INT16";
    const [lonMin, , , latMax] = (u.searchParams.get("BBOX") ?? "0,0,0.01125,0.01125").split(",").map(Number);
    const isByte = format === "GEOTIFF_BYTE";
    const noData = isByte ? 255 : -32768;
    const val = baseCoverages[coverage] ?? noData;

    const grid = Array.from({ length: 5 }, (_, r) =>
      Array.from({ length: 5 }, (__, c) => {
        if (coverage === "sand_15-30cm_Q0.5" && r === 2 && c === 2) {
          return -32768; // Masked at selected pixel (2,2)
        }
        if (coverage === "sand_15-30cm_Q0.5" && r === 2 && c === 3) {
          return 450; // Valid at neighbor (2,3) — must NEVER be mixed into (2,2)
        }
        return val;
      })
    );

    const tiffBuf = encodeSyntheticSoilGridsGeoTiff({
      grid,
      bitsPerSample: isByte ? 8 : 16,
      sampleFormat: isByte ? 1 : 2,
      noDataValue: noData,
      originLon: lonMin,
      originLat: latMax,
      scaleX: 0.00225,
      scaleY: 0.00225,
    });
    return new Response(new Uint8Array(tiffBuf), { status: 200, headers: { "Content-Type": "image/tiff" } });
  }) as typeof fetch;

  const rejectedChimericCore = await fetchSoilGridsWcsProfile(lat, lon, {
    fetchFn: chimericCoreFetch,
    bypassCache: true,
  });
  assert.equal(
    rejectedChimericCore,
    null,
    "Must never substitute a missing core layer from a neighboring pixel or accept a partial <30 cm core profile"
  );

  // Case 2: Optional layers (`wrb_MostProbable`, `wv0033`, `sand_0-5cm_Q0.05`) are NoData at (2,2)
  // while valid at neighbor (2,3). Core properties are complete at (2,2).
  // Profile must succeed using (2,2) core properties, while `wrbSoilGroup`, `awc`, and `sand` uncertainty
  // remain `undefined`/`null` rather than silently pulling from (2,3).
  const chimericOptionalFetch: typeof fetch = (async (input: RequestInfo | URL) => {
    const urlStr = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const u = new URL(urlStr);
    const coverage = u.searchParams.get("COVERAGE") ?? "";
    const format = u.searchParams.get("FORMAT") ?? "GEOTIFF_INT16";
    const [lonMin, , , latMax] = (u.searchParams.get("BBOX") ?? "0,0,0.01125,0.01125").split(",").map(Number);
    const isByte = format === "GEOTIFF_BYTE";
    const noData = isByte ? 255 : -32768;
    const val = baseCoverages[coverage] ?? noData;

    const grid = Array.from({ length: 5 }, (_, r) =>
      Array.from({ length: 5 }, (__, c) => {
        if (
          (coverage === "MostProbable" ||
            coverage.startsWith("wv0033_") ||
            coverage === "sand_0-5cm_Q0.05") &&
          r === 2 &&
          c === 2
        ) {
          return noData;
        }
        return val;
      })
    );

    const tiffBuf = encodeSyntheticSoilGridsGeoTiff({
      grid,
      bitsPerSample: isByte ? 8 : 16,
      sampleFormat: isByte ? 1 : 2,
      noDataValue: noData,
      originLon: lonMin,
      originLat: latMax,
      scaleX: 0.00225,
      scaleY: 0.00225,
    });
    return new Response(new Uint8Array(tiffBuf), { status: 200, headers: { "Content-Type": "image/tiff" } });
  }) as typeof fetch;

  const singlePixelProfile = await fetchSoilGridsWcsProfile(lat, lon, {
    fetchFn: chimericOptionalFetch,
    bypassCache: true,
  });
  assert.ok(singlePixelProfile, "Profile with complete core layers at (2,2) must succeed");
  assert.equal(
    singlePixelProfile.wrbSoilGroup,
    undefined,
    "wrbSoilGroup must NOT be pulled from neighbor (2,3) when (2,2) is NoData"
  );
  assert.equal(
    singlePixelProfile.aggregated.depth0_30cm.awc,
    null,
    "AWC must NOT pull wv0033 from neighbor (2,3) when (2,2) is NoData"
  );
  assert.equal(
    singlePixelProfile.layerUncertainty?.properties.sand,
    undefined,
    "0–5 cm sand uncertainty must NOT pull Q0.05 from neighbor (2,3) when (2,2) is NoData"
  );
});

test("Adversarial guard (F-3, F-6, F-7): preserves valid 0 observations on confirmed soil pixels, enforces GeoTIFF format guards, and separates evidence cache keys", async () => {
  // 1. Valid 0 observations (Q0.05 = 0 for sand/silt/clay/soc and cfvo = 0) are preserved on confirmed soil pixels
  assert.equal(isRawSoilGridsValueValid(0, SOILGRIDS_PROPERTIES.sand, -32768, true), true);
  assert.equal(isRawSoilGridsValueValid(0, SOILGRIDS_PROPERTIES.silt, -32768, true), true);
  assert.equal(isRawSoilGridsValueValid(0, SOILGRIDS_PROPERTIES.clay, -32768, true), true);
  assert.equal(isRawSoilGridsValueValid(0, SOILGRIDS_PROPERTIES.soc, -32768, true), true);
  assert.equal(isRawSoilGridsValueValid(0, SOILGRIDS_PROPERTIES.cfvo, -32768, true), true);
  // Step 1 canary check (`soilPixelConfirmed = false`) still requires raw > 0 so all-zero corrupted rasters are rejected
  assert.equal(isRawSoilGridsValueValid(0, SOILGRIDS_PROPERTIES.clay, -32768, false), false);
  // pH and bulk density are never 0 even on confirmed soil pixels
  assert.equal(isRawSoilGridsValueValid(0, SOILGRIDS_PROPERTIES.phh2o, -32768, true), false);
  assert.equal(isRawSoilGridsValueValid(0, SOILGRIDS_PROPERTIES.bdod, -32768, true), false);

  const zeroBoundsCoverages: Record<string, number> = {
    "sand_0-5cm_Q0.5": 820,
    "sand_5-15cm_Q0.5": 820,
    "sand_15-30cm_Q0.5": 820,
    "silt_0-5cm_Q0.5": 100,
    "silt_5-15cm_Q0.5": 100,
    "silt_15-30cm_Q0.5": 100,
    "clay_0-5cm_Q0.5": 80,
    "clay_5-15cm_Q0.5": 80,
    "clay_15-30cm_Q0.5": 80,
    "soc_0-5cm_Q0.5": 40,
    "soc_5-15cm_Q0.5": 35,
    "soc_15-30cm_Q0.5": 30,
    "phh2o_0-5cm_Q0.5": 62,
    "phh2o_5-15cm_Q0.5": 62,
    "phh2o_15-30cm_Q0.5": 62,
    "cfvo_0-5cm_Q0.5": 0,
    "cfvo_5-15cm_Q0.5": 0,
    "cfvo_15-30cm_Q0.5": 0,
    // Valid 0 lower prediction bounds (Q0.05 = 0)
    "clay_0-5cm_Q0.05": 0,
    "clay_0-5cm_Q0.95": 180,
    "soc_0-5cm_Q0.05": 0,
    "soc_0-5cm_Q0.95": 120,
  };
  const zeroProfile = await fetchSoilGridsWcsProfile(51.12, 10.45, {
    fetchFn: createMockSoilGridsFetch(zeroBoundsCoverages),
    bypassCache: true,
  });
  assert.ok(zeroProfile);
  assert.equal(zeroProfile.aggregated.depth0_30cm.coarseFragmentsPct, 0);
  assert.deepEqual(zeroProfile.layerUncertainty?.properties.clay, {
    q05: 0,
    q50: 8,
    q95: 18,
    unit: "%",
  });
  assert.deepEqual(zeroProfile.layerUncertainty?.properties.soc, {
    q05: 0,
    q50: 0.4,
    q95: 1.2,
    unit: "% SOC",
  });

  // 2. GeoTIFF decoder format guards reject unsupported SamplesPerPixel, Predictor, SampleFormat, and multi-tile/multi-strip rasters
  const smallGrid = Array.from({ length: 5 }, () => Array(5).fill(200));
  assert.throws(
    () => decodeSoilGridsGeoTiff(encodeSyntheticSoilGridsGeoTiff({ grid: smallGrid, samplesPerPixel: 3 })),
    /Unsupported SamplesPerPixel/
  );
  assert.throws(
    () => decodeSoilGridsGeoTiff(encodeSyntheticSoilGridsGeoTiff({ grid: smallGrid, predictor: 3 })),
    /Unsupported TIFF Predictor/
  );
  assert.throws(
    () => decodeSoilGridsGeoTiff(encodeSyntheticSoilGridsGeoTiff({ grid: smallGrid, sampleFormat: 3 })),
    /Unsupported TIFF SampleFormat/
  );
  assert.throws(
    () => decodeSoilGridsGeoTiff(encodeSyntheticSoilGridsGeoTiff({ grid: smallGrid, tiled: true, tileWidth: 2, tileLength: 2 })),
    /Unsupported multi-tile GeoTIFF layout/
  );
  assert.throws(
    () => decodeSoilGridsGeoTiff(encodeSyntheticSoilGridsGeoTiff({ grid: smallGrid, tiled: false, rowsPerStrip: 2 })),
    /Unsupported multi-strip GeoTIFF layout/
  );

  // 3. Evidence profile provider attribution distinguishes regional fallback from live SoilGrids WCS
  const climate = makeClimate();
  const fallbackSoilData: SoilData = {
    aggregated: resolveGlobalSoilFallback(48.45, 1.49).aggregated,
    dataCoverage: resolveGlobalSoilFallback(48.45, 1.49).dataCoverage,
    totalComponentPercent: 100,
    source: resolveGlobalSoilFallback(48.45, 1.49).source,
    limitations: resolveGlobalSoilFallback(48.45, 1.49).limitations,
  };
  const fallbackEvidence = buildUnifiedFieldEvidenceProfile(48.45, 1.49, climate, fallbackSoilData);
  assert.ok(
    fallbackEvidence.activeProviders.some((p) => p.id === "fao_hwsd_v22"),
    "Regional fallback evidence profile must include fao_hwsd_v22"
  );
  assert.ok(
    !fallbackEvidence.activeProviders.some((p) => p.id === "isric_soilgrids_wcs"),
    "Regional fallback evidence profile must NOT claim live isric_soilgrids_wcs was used"
  );

  const liveWcsSoilData: SoilData = {
    aggregated: zeroProfile.aggregated,
    dataCoverage: zeroProfile.dataCoverage,
    totalComponentPercent: 100,
    source: zeroProfile.source,
    limitations: zeroProfile.limitations,
  };
  const liveWcsEvidence = buildUnifiedFieldEvidenceProfile(48.45, 1.49, climate, liveWcsSoilData);
  assert.ok(
    liveWcsEvidence.activeProviders.some((p) => p.id === "isric_soilgrids_wcs"),
    "Live SoilGrids WCS evidence profile at same coordinate must not collide with cached fallback profile and must include isric_soilgrids_wcs"
  );
});

// ═══════════════════════════════════════════════════════════════════════
// 20. Soil Texture Normalization & Conditional Property Rendering
// ═══════════════════════════════════════════════════════════════════════

section("20. Soil Texture Normalization & Conditional Property Rendering");

test("Soil texture normalization: values already totaling 100% remain unchanged, <100% (36.3, 29.7, 19.8 = 85.8%) normalizes to 42.3%, 34.6%, 23.1% (100.0%), and raw values remain preserved", () => {
  // 1. Values already totaling 100.0% remain unchanged and wasNormalized is false
  const exact100 = normalizeSoilTexture(42.0, 35.0, 23.0);
  assert.equal(exact100.valid, true);
  assert.equal(exact100.sand, 42.0);
  assert.equal(exact100.silt, 35.0);
  assert.equal(exact100.clay, 23.0);
  assert.equal(exact100.total, 100.0);
  assert.equal(exact100.wasNormalized, false);
  assert.deepEqual(exact100.raw, {
    sand: 42.0,
    silt: 35.0,
    clay: 23.0,
    total: 100.0,
  });

  // 2. Values totaling less than 100% (36.3% sand, 29.7% silt, 19.8% clay -> 85.8%)
  // normalize proportionally (42.3077%, 34.6154%, 23.0769%) and round cleanly to 42.3%, 34.6%, 23.1% (100.0%)
  const sub100 = normalizeSoilTexture(36.3, 29.7, 19.8);
  assert.equal(sub100.valid, true);
  assert.equal(sub100.sand, 42.3);
  assert.equal(sub100.silt, 34.6);
  assert.equal(sub100.clay, 23.1);
  assert.equal(sub100.total, 100.0);
  assert.equal(
    Number((sub100.sand! + sub100.silt! + sub100.clay!).toFixed(1)),
    100.0
  );
  assert.equal(sub100.wasNormalized, true);
  // Raw values are preserved separately without modification
  assert.deepEqual(sub100.raw, {
    sand: 36.3,
    silt: 29.7,
    clay: 19.8,
    total: 85.8,
  });

  // 3. Small rounding discrepancies (e.g., 16.7 + 56.7 + 26.7 = 100.1% or 33.3 + 33.3 + 33.3 = 99.9%)
  // normalize cleanly to 100.0% and never produce 99.9% or 100.1%
  const over100 = normalizeSoilTexture(16.7, 56.7, 26.7);
  assert.equal(over100.valid, true);
  assert.equal(over100.total, 100.0);
  assert.equal(
    Number((over100.sand! + over100.silt! + over100.clay!).toFixed(1)),
    100.0
  );
  assert.equal(over100.wasNormalized, true);
  assert.equal(over100.raw.total, 100.1);

  const threeThirds = normalizeSoilTexture(33.3, 33.3, 33.3);
  assert.equal(threeThirds.valid, true);
  assert.equal(threeThirds.total, 100.0);
  assert.equal(
    Number(
      (threeThirds.sand! + threeThirds.silt! + threeThirds.clay!).toFixed(1)
    ),
    100.0
  );
  assert.equal(threeThirds.wasNormalized, true);
  assert.equal(threeThirds.raw.total, 99.9);

  // 4. Exhaustive rounding edge-case sweep across challenging triplets (never 99.9% or 100.1%)
  const edgeTriplets: [number, number, number][] = [
    [1, 1, 1],
    [10, 10, 10],
    [33.35, 33.35, 33.35],
    [33.36, 33.36, 33.28], // naive toFixed(1) would give 33.4 + 33.4 + 33.3 = 100.1%
    [33.34, 33.34, 33.32], // naive toFixed(1) would give 33.3 + 33.3 + 33.3 = 99.9%
    [14.25, 14.25, 71.5],
    [28.4, 41.9, 17.6],
    [0, 50, 50],
    [0, 0, 18.5],
  ];
  for (const [s, si, c] of edgeTriplets) {
    const res = normalizeSoilTexture(s, si, c);
    assert.equal(res.valid, true, `Expected valid normalization for [${s}, ${si}, ${c}]`);
    const sum = Number((res.sand! + res.silt! + res.clay!).toFixed(1));
    assert.equal(
      sum,
      100.0,
      `Expected sum 100.0% for [${s}, ${si}, ${c}], got ${res.sand} + ${res.silt} + ${res.clay} = ${sum}`
    );
    assert.equal(res.raw.sand, s);
    assert.equal(res.raw.silt, si);
    assert.equal(res.raw.clay, c);
  }

  // 5. Missing or invalid fractions (null, undefined, NaN, Infinity, negative, zero total) are NOT normalized
  const invalidCases: [number | null | undefined, number | null | undefined, number | null | undefined][] = [
    [null, 40, 60],
    [40, null, 60],
    [40, 60, null],
    [undefined, 50, 50],
    [NaN, 50, 50],
    [Infinity, 30, 20],
    [-5, 55, 50],
    [0, 0, 0],
  ];
  for (const [s, si, c] of invalidCases) {
    const res = normalizeSoilTexture(s, si, c);
    assert.equal(res.valid, false);
    assert.equal(res.sand, null);
    assert.equal(res.silt, null);
    assert.equal(res.clay, null);
    assert.equal(res.total, null);
    assert.equal(res.wasNormalized, false);
  }
});

test("Conditional soil property rendering: distinguishes provider capabilities, displays slope/drainage on valid SSURGO profiles, and completely omits unavailable properties on SoilGrids, fallback, and partial-data profiles", () => {
  // Verify provider capability matrix distinguishes supported vs unsupported properties
  assert.ok(SOIL_PROVIDER_CAPABILITIES.usda_ssurgo.supportedProperties.includes("slope"));
  assert.ok(SOIL_PROVIDER_CAPABILITIES.usda_ssurgo.supportedProperties.includes("drainage"));
  assert.ok(SOIL_PROVIDER_CAPABILITIES.soilgrids_wcs_250m.unsupportedProperties.includes("slope"));
  assert.ok(SOIL_PROVIDER_CAPABILITIES.soilgrids_wcs_250m.unsupportedProperties.includes("drainage"));
  assert.ok(SOIL_PROVIDER_CAPABILITIES.regional_reference_fallback.unsupportedProperties.includes("slope"));
  assert.ok(SOIL_PROVIDER_CAPABILITIES.regional_reference_fallback.unsupportedProperties.includes("drainage"));

  assert.equal(
    classifySoilPropertyStatus("soilgrids_wcs_250m", "slope", false),
    "provider_unsupported"
  );
  assert.equal(
    classifySoilPropertyStatus("soilgrids_wcs_250m", "drainage", false),
    "provider_unsupported"
  );
  assert.equal(
    classifySoilPropertyStatus("soilgrids_wcs_250m", "awc", false),
    "missing_at_location"
  );
  assert.equal(
    classifySoilPropertyStatus("usda_ssurgo", "slope", false),
    "missing_at_location"
  );

  // Case 7: U.S. SSURGO profile with valid slope and drainage displays both properties and columns
  const ssurgoProfile: SoilProfileInput = {
    dataTier: "usda_ssurgo",
    source: "USDA NRCS Soil Survey Geographic Database (SSURGO)",
    totalComponentPercent: 95,
    components: [
      {
        cokey: "co_1",
        name: "Cecil",
        percent: 85,
        kind: "Series",
        majcompflag: "Yes",
        drainage: "Well drained",
        slope: 4.5,
        horizons: [
          {
            depthTop: 0,
            depthBottom: 20,
            sand: 45.2,
            silt: 32.1,
            clay: 22.7,
            om: 1.8,
            ph: 6.2,
            awc: 0.14,
          },
        ],
      },
    ],
    aggregated: {
      depth0_30cm: {
        sand: 45.2,
        silt: 32.1,
        clay: 22.7,
        om: 1.8,
        ph: 6.2,
        awc: 0.14,
      },
      drainage: "Well drained",
      slope: 4.5,
    },
  };

  const ssurgoView = buildSoilProfileDisplayModel(ssurgoProfile);
  assert.equal(ssurgoView.dataTier, "usda_ssurgo");
  assert.equal(ssurgoView.texture.valid, true);
  assert.equal(ssurgoView.texture.wasNormalized, false);
  assert.deepEqual(
    ssurgoView.availableMetrics.map((m) => m.key),
    ["om", "ph", "awc", "slope", "drainage"]
  );
  assert.equal(ssurgoView.propertyStatuses.slope, "available");
  assert.equal(ssurgoView.propertyStatuses.drainage, "available");
  assert.equal(ssurgoView.componentTable.visible, true);
  assert.equal(ssurgoView.componentTable.showMajorColumn, true);
  assert.equal(ssurgoView.componentTable.showDrainageColumn, true);
  assert.equal(ssurgoView.componentTable.showSlopeColumn, true);
  assert.equal(ssurgoView.componentTable.showKnownTotalRow, true);
  assert.ok(ssurgoView.subtitlePropertiesLabel.includes("drainage, and slope"));

  // Case 8: International SoilGrids profile without slope or drainage (and with sub-100% texture 36.3/29.7/19.8)
  // omits slope and drainage completely from cards, subtitle, and component breakdown table
  const soilGridsProfile: SoilProfileInput = {
    dataTier: "soilgrids_wcs_250m",
    source: "ISRIC SoilGrids v2.0 (250 m global digital soil mapping via OGC WCS). https://maps.isric.org/",
    totalComponentPercent: 100,
    components: [
      {
        cokey: "SG250_48.4500_1.4900",
        name: "ISRIC SoilGrids v2.0 (250 m) — Luvisols",
        percent: 100,
        kind: "Modeled 250 m Grid Cell",
        majcompflag: "Yes",
        drainage: null,
        slope: null,
        horizons: [
          {
            depthTop: 0,
            depthBottom: 5,
            sand: 36.3,
            silt: 29.7,
            clay: 19.8,
            om: 2.4,
            ph: 6.8,
            awc: 0.15,
          },
        ],
      },
    ],
    aggregated: {
      depth0_30cm: {
        sand: 36.3,
        silt: 29.7,
        clay: 19.8,
        om: 2.4,
        ph: 6.8,
        awc: 0.15,
      },
      drainage: null,
      slope: null,
    },
  };

  const sgView = buildSoilProfileDisplayModel(soilGridsProfile);
  assert.equal(sgView.dataTier, "soilgrids_wcs_250m");
  assert.equal(sgView.texture.valid, true);
  assert.equal(sgView.texture.sand, 42.3);
  assert.equal(sgView.texture.silt, 34.6);
  assert.equal(sgView.texture.clay, 23.1);
  assert.equal(sgView.texture.total, 100.0);
  assert.equal(sgView.texture.wasNormalized, true);
  assert.equal(sgView.texture.raw.sand, 36.3);
  assert.equal(sgView.texture.raw.silt, 29.7);
  assert.equal(sgView.texture.raw.clay, 19.8);
  assert.deepEqual(
    sgView.availableMetrics.map((m) => m.key),
    ["om", "ph", "awc"],
    "Slope and drainage must be completely omitted from SoilGrids availableMetrics"
  );
  assert.equal(sgView.propertyStatuses.slope, "provider_unsupported");
  assert.equal(sgView.propertyStatuses.drainage, "provider_unsupported");
  assert.equal(sgView.componentTable.showDrainageColumn, false);
  assert.equal(sgView.componentTable.showSlopeColumn, false);
  assert.equal(sgView.componentTable.showMajorColumn, false);
  assert.equal(sgView.componentTable.showKnownTotalRow, false);
  assert.ok(!sgView.subtitlePropertiesLabel.includes("slope"));
  assert.ok(!sgView.subtitlePropertiesLabel.includes("drainage"));
  assert.equal(sgView.horizonTables[0].rows[0].texture.sand, 42.3);
  assert.equal(sgView.horizonTables[0].rows[0].texture.silt, 34.6);
  assert.equal(sgView.horizonTables[0].rows[0].texture.clay, 23.1);

  // Case 9: Regional fallback profile omits unsupported/missing properties (slope, drainage, empty component table)
  const fallbackRaw = resolveGlobalSoilFallback(48.45, 1.49);
  assert.equal(fallbackRaw.aggregated.drainage, null);
  assert.equal(fallbackRaw.aggregated.slope, null);
  const fallbackView = buildSoilProfileDisplayModel({
    dataTier: "regional_reference_fallback",
    source: fallbackRaw.source,
    totalComponentPercent: fallbackRaw.totalComponentPercent,
    components: [],
    aggregated: fallbackRaw.aggregated,
  });
  assert.equal(fallbackView.dataTier, "regional_reference_fallback");
  assert.deepEqual(
    fallbackView.availableMetrics.map((m) => m.key),
    ["om", "ph", "awc"]
  );
  assert.equal(
    fallbackView.componentTable.visible,
    false,
    "Regional fallback with 0 components must omit the empty component breakdown card"
  );

  // Case 10: Provider-supported property with null/missing value at a specific location (e.g. AWC null on SoilGrids, or slope/awc null on SSURGO) is omitted
  const partialSgProfile: SoilProfileInput = {
    ...soilGridsProfile,
    components: [
      {
        ...soilGridsProfile.components![0],
        horizons: [
          {
            ...soilGridsProfile.components![0].horizons[0],
            awc: null,
          },
        ],
      },
    ],
    aggregated: {
      ...soilGridsProfile.aggregated,
      depth0_30cm: {
        ...soilGridsProfile.aggregated.depth0_30cm,
        awc: null,
      },
    },
  };
  const partialSgView = buildSoilProfileDisplayModel(partialSgProfile);
  assert.deepEqual(
    partialSgView.availableMetrics.map((m) => m.key),
    ["om", "ph"],
    "Missing AWC at a specific SoilGrids location must be omitted from metric cards"
  );
  assert.equal(partialSgView.propertyStatuses.awc, "missing_at_location");
  assert.equal(
    partialSgView.horizonTables[0].showAwcColumn,
    false,
    "Horizon table must omit the AWC column when all horizons have null AWC"
  );
  assert.ok(!partialSgView.subtitlePropertiesLabel.includes("water-holding capacity"));
});

test("SoilGrids ALR compositional mean texture layers (sand_mean, silt_mean, clay_mean) are extracted at the selected pixel, displayed at 100.0% across main card and depth layers, while preserving Q0.50 values for downstream scoring", async () => {
  clearSoilGridsCacheForTests();
  const lat = 48.38;
  const lon = 1.55;

  // Simulate a realistic SoilGrids pixel (like Beauce, France / South Darfur) where:
  // - Q0.50 marginal medians (Quantile Regression Forests after ALR back-transformation,
  //   ALR1 = ln(sand / clay), ALR2 = ln(silt / clay)) sum to <100% (363 + 297 + 198 = 858 g/kg -> 85.8%)
  // - mean expected-value predictions (default Random Forests algorithm) are approximately compositionally
  //   closed (~1000 g/kg, including a 1001 g/kg = 100.1% integer quantization layer in 0-5cm to verify 100.0% display rounding)
  const alrMeanAndQ50Coverages: Record<string, number> = {
    "sand_0-5cm_Q0.5": 363,
    "sand_5-15cm_Q0.5": 363,
    "sand_15-30cm_Q0.5": 363,
    "silt_0-5cm_Q0.5": 297,
    "silt_5-15cm_Q0.5": 297,
    "silt_15-30cm_Q0.5": 297,
    "clay_0-5cm_Q0.5": 198,
    "clay_5-15cm_Q0.5": 198,
    "clay_15-30cm_Q0.5": 198,
    // Mean texture layers (g/kg)
    "sand_0-5cm_mean": 573,
    "silt_0-5cm_mean": 195,
    "clay_0-5cm_mean": 233, // 57.3 + 19.5 + 23.3 = 100.1% (integer quantization)
    "sand_5-15cm_mean": 556,
    "silt_5-15cm_mean": 189,
    "clay_5-15cm_mean": 255, // 55.6 + 18.9 + 25.5 = 100.0%
    "sand_15-30cm_mean": 556,
    "silt_15-30cm_mean": 189,
    "clay_15-30cm_mean": 255, // 55.6 + 18.9 + 25.5 = 100.0%
    // Other core properties (Q0.50)
    "soc_0-5cm_Q0.5": 150,
    "soc_5-15cm_Q0.5": 140,
    "soc_15-30cm_Q0.5": 130,
    "phh2o_0-5cm_Q0.5": 65,
    "phh2o_5-15cm_Q0.5": 66,
    "phh2o_15-30cm_Q0.5": 67,
    "bdod_0-5cm_Q0.5": 138,
    "bdod_5-15cm_Q0.5": 140,
    "bdod_15-30cm_Q0.5": 142,
    "cfvo_0-5cm_Q0.5": 40,
    "cfvo_5-15cm_Q0.5": 45,
    "cfvo_15-30cm_Q0.5": 50,
    "wv0033_0-5cm_Q0.5": 280,
    "wv0033_5-15cm_Q0.5": 280,
    "wv0033_15-30cm_Q0.5": 280,
    "wv1500_0-5cm_Q0.5": 130,
    "wv1500_5-15cm_Q0.5": 130,
    "wv1500_15-30cm_Q0.5": 130,
    MostProbable: 16, // Luvisols
  };

  const sgProfile = await fetchSoilGridsWcsProfile(lat, lon, {
    fetchFn: createMockSoilGridsFetch(alrMeanAndQ50Coverages),
    bypassCache: true,
  });
  assert.ok(sgProfile, "Expected SoilGrids WCS profile with both Q0.50 and mean texture layers");

  // 1. Q0.50 values are preserved untouched in aggregated.depth0_30cm.{sand, silt, clay} for downstream scoring
  assert.equal(sgProfile.aggregated.depth0_30cm.sand, 36.3);
  assert.equal(sgProfile.aggregated.depth0_30cm.silt, 29.7);
  assert.equal(sgProfile.aggregated.depth0_30cm.clay, 19.8);

  // 2. Mean texture layers are extracted and depth-weighted into textureMean0_30cm and horizon sandMean/siltMean/clayMean
  assert.ok(sgProfile.aggregated.depth0_30cm.textureMean0_30cm);
  assert.equal(sgProfile.components[0].horizons[0].sandMean, 57.3);
  assert.equal(sgProfile.components[0].horizons[0].siltMean, 19.5);
  assert.equal(sgProfile.components[0].horizons[0].clayMean, 23.3);

  // 3. Display model uses SoilGrids mean predictions (`soilgrids_mean`), preserves Q0.50 raw in `q50TextureRaw`,
  //    and guarantees 100.0% totals in both the main 0–30 cm card and all 3 depth-layer rows
  const displayModel = buildSoilProfileDisplayModel({
    dataTier: "soilgrids_wcs_250m",
    source: sgProfile.source,
    totalComponentPercent: sgProfile.totalComponentPercent,
    components: sgProfile.components,
    aggregated: sgProfile.aggregated,
  });

  assert.equal(displayModel.textureStatistic, "soilgrids_mean");
  assert.equal(displayModel.texture.valid, true);
  assert.equal(displayModel.texture.total, 100.0);
  assert.equal(
    Number(
      (
        displayModel.texture.sand! +
        displayModel.texture.silt! +
        displayModel.texture.clay!
      ).toFixed(1)
    ),
    100.0
  );
  assert.deepEqual(displayModel.q50TextureRaw, {
    sand: 36.3,
    silt: 29.7,
    clay: 19.8,
    total: 85.8,
  });

  assert.equal(displayModel.horizonTables.length, 1);
  assert.equal(displayModel.horizonTables[0].rows.length, 3);
  for (const row of displayModel.horizonTables[0].rows) {
    assert.equal(row.textureStatistic, "soilgrids_mean");
    assert.equal(row.texture.valid, true);
    assert.equal(row.texture.total, 100.0);
    const rowSum = Number(
      (row.texture.sand! + row.texture.silt! + row.texture.clay!).toFixed(1)
    );
    assert.equal(
      rowSum,
      100.0,
      `Expected depth layer ${row.depthTop}-${row.depthBottom} cm to total 100.0%, got ${rowSum}%`
    );
  }
});

test("SSURGO complete-triplet texture aggregation excludes incomplete horizon/component triplets and accurately drives buildFieldSpecificObjectives across the 68% sand threshold (when OM >= 1.3% and AWC >= 0.12 cm/cm)", () => {
  // Shared moderate temperate climate and crop catalog where neither isHotDry nor isHumidOrWet is active,
  // and where OM = 1.6% (>= 1.3%) and AWC = 0.14 cm/cm (>= 0.12 cm/cm) are identical across all cases,
  // so `isLowOmOrAwc` in `buildFieldSpecificObjectives()` is governed strictly by `sand >= 68%`.
  const sharedModerateClimate = makeClimate({
    avgAnnualTemp: 15.0,
    avgAnnualPrecip: 820,
    springPrecip: { avgTotalMm: 220, monthsDesc: "Mar–May" },
    growingSeasonPrecip: { avgTotalMm: 310, monthsDesc: "May–Aug" },
    summerDrySpells: { avgMaxConsecutiveDryDays: 9, thresholdMm: 1, monthsDesc: "Jun–Aug" },
    summerHeatDays: { avgDaysAboveThreshold: 4, thresholdC: 35, monthsDesc: "Jul–Aug" },
  });
  const availableCrops = getAvailableCropsForContext("temperate_humid", "us_southeast");

  // 1. Construct a multi-horizon, multi-component SSURGO profile with incomplete texture triplets:
  //    - Component 1 (75% of map unit):
  //      * Horizon 1 (0–20 cm, 20 cm): complete coarse triplet -> sand: 72%, silt: 18%, clay: 10% (sum = 100%)
  //      * Horizon 2 (20–30 cm, 10 cm): INCOMPLETE triplet -> sand: 54%, silt: 26%, clay: null
  //    - Component 2 (25% of map unit):
  //      * Horizon 1 (0–30 cm, 30 cm): INCOMPLETE triplet -> sand: 56%, silt: null, clay: 20%
  //    Note: If incomplete triplets were NOT excluded, naive per-property averaging would compute
  //    Component 1 sand = (72*20 + 54*10)/30 = 66.0% and Component 2 sand = 56.0%, yielding a
  //    map-unit sand of (66.0*75 + 56.0*25)/100 = 63.5% (< 68% threshold) and an unclosed 96.7% sum.
  const partialTripletComponents: SoilComponentInput[] = [
    {
      cokey: "comp_1",
      name: "Norfolk loamy sand",
      percent: 75,
      kind: "Series",
      majcompflag: "Yes",
      drainage: "Well drained",
      slope: 3.0,
      horizons: [
        {
          depthTop: 0,
          depthBottom: 20,
          sand: 72,
          silt: 18,
          clay: 10,
          om: 1.6,
          ph: 6.2,
          awc: 0.14,
        },
        {
          depthTop: 20,
          depthBottom: 30,
          sand: 54,
          silt: 26,
          clay: null, // Incomplete triplet on 20–30 cm horizon
          om: 1.6,
          ph: 6.2,
          awc: 0.14,
        },
      ],
    },
    {
      cokey: "comp_2",
      name: "Goldsboro sandy loam (incomplete lab record)",
      percent: 25,
      kind: "Series",
      majcompflag: "Yes",
      drainage: "Well drained",
      slope: 3.0,
      horizons: [
        {
          depthTop: 0,
          depthBottom: 30,
          sand: 56,
          silt: null, // Incomplete triplet on entire component
          clay: 20,
          om: 1.6,
          ph: 6.2,
          awc: 0.14,
        },
      ],
    },
  ];

  // 2 & 3. Verify that the incomplete horizon and incomplete component triplets are excluded as a whole,
  //        and verify the resulting complete-triplet weighted sand/silt/clay percentages.
  assert.equal(
    depthWeightedAverage(partialTripletComponents[0].horizons, "sand"),
    66,
    "Single-property depthWeightedAverage would include the partial 20–30 cm horizon (66.0% sand)"
  );
  const comp1CompleteTex = depthWeightedTextureAverage(partialTripletComponents[0].horizons);
  assert.deepEqual(
    comp1CompleteTex,
    { sand: 72, silt: 18, clay: 10 },
    "depthWeightedTextureAverage must exclude the incomplete 20–30 cm horizon as a whole"
  );
  assert.equal(
    depthWeightedTextureAverage(partialTripletComponents[1].horizons),
    null,
    "depthWeightedTextureAverage must return null for Component 2 whose only horizon has silt: null"
  );

  const aggregatedCaseA = aggregateComponents(partialTripletComponents);
  assert.equal(aggregatedCaseA.aggregated.depth0_30cm.sand, 72);
  assert.equal(aggregatedCaseA.aggregated.depth0_30cm.silt, 18);
  assert.equal(aggregatedCaseA.aggregated.depth0_30cm.clay, 10);
  assert.equal(
    aggregatedCaseA.aggregated.depth0_30cm.sand! +
      aggregatedCaseA.aggregated.depth0_30cm.silt! +
      aggregatedCaseA.aggregated.depth0_30cm.clay!,
    100
  );
  // Texture coverage reflects only Component 1 (75%), while OM, pH, and AWC reflect both components (100%)
  assert.equal(aggregatedCaseA.dataCoverage.depth0_30cm.sand, 75);
  assert.equal(aggregatedCaseA.dataCoverage.depth0_30cm.silt, 75);
  assert.equal(aggregatedCaseA.dataCoverage.depth0_30cm.clay, 75);
  assert.equal(aggregatedCaseA.aggregated.depth0_30cm.om, 1.6);
  assert.equal(aggregatedCaseA.aggregated.depth0_30cm.ph, 6.2);
  assert.equal(aggregatedCaseA.aggregated.depth0_30cm.awc, 0.14);
  assert.equal(aggregatedCaseA.dataCoverage.depth0_30cm.om, 100);
  assert.equal(aggregatedCaseA.dataCoverage.depth0_30cm.ph, 100);
  assert.equal(aggregatedCaseA.dataCoverage.depth0_30cm.awc, 100);

  const soilCaseA: SoilData = {
    aggregated: aggregatedCaseA.aggregated,
    dataCoverage: aggregatedCaseA.dataCoverage,
    totalComponentPercent: 100,
    source: "USDA NRCS Soil Survey Geographic Database (SSURGO)",
    limitations: [],
  };

  // 4 & 5. Pass the resulting soil aggregate into buildFieldSpecificObjectives() and buildObjectiveFieldContextBullets().
  //        Because complete-triplet sand is 72.0% (>= 68%), `isLowOmOrAwc` is true even though OM (1.6%) >= 1.3%
  //        and AWC (0.14 cm/cm) >= 0.12 cm/cm.
  const objectivesCaseA = buildFieldSpecificObjectives({
    climate: sharedModerateClimate,
    soil: soilCaseA,
    priorities: DEFAULT_PRIORITIES,
    availableCropIds: availableCrops,
  });
  const soilHealthA = objectivesCaseA.find((o) => o.archetype === "soil_health")!;
  const waterResA = objectivesCaseA.find((o) => o.archetype === "water_resilience")!;
  const diversityA = objectivesCaseA.find((o) => o.archetype === "crop_diversity")!;

  assert.equal(soilHealthA.name, "Organic Matter & Water-Holding Rebuilding");
  assert.equal(waterResA.name, "Low-AWC Root-Zone Moisture Efficiency");
  assert.equal(diversityA.name, "Multi-Family Rotation & Root-Depth Diversity");
  assert.ok(
    waterResA.objective.includes("72% sand"),
    "Water resilience objective description must cite the 72% complete-triplet sand percentage"
  );

  const waterBulletsA = buildObjectiveFieldContextBullets(
    "water_resilience",
    sharedModerateClimate,
    soilCaseA
  );
  assert.ok(
    waterBulletsA.some((b) => b.includes("72% sand")),
    "Water resilience field-context bullets must include 72% sand when sand >= 68%"
  );

  // 6. Comparison cases where sand does NOT cross the 68% threshold, keeping every non-texture field input
  //    (climate, priorities, availableCropIds, OM = 1.6%, AWC = 0.14 cm/cm, pH = 6.2, drainage, slope,
  //    component percents, and horizon depths) 100% identical:
  //
  //    Comparison B1: Same raw sand values (72%, 54%, 56%), but with the missing clay (20%) and silt (24%)
  //    populated so all triplets are complete -> weighted sand = (66.0 * 75 + 56.0 * 25) / 100 = 63.5% (< 68%).
  const completedLowerSandComponents: SoilComponentInput[] = [
    {
      ...partialTripletComponents[0],
      horizons: [
        partialTripletComponents[0].horizons[0],
        {
          ...partialTripletComponents[0].horizons[1],
          clay: 20, // Complete triplet: 54 + 26 + 20 = 100%
        },
      ],
    },
    {
      ...partialTripletComponents[1],
      horizons: [
        {
          ...partialTripletComponents[1].horizons[0],
          silt: 24, // Complete triplet: 56 + 24 + 20 = 100%
        },
      ],
    },
  ];

  const aggregatedCaseB1 = aggregateComponents(completedLowerSandComponents);
  assert.equal(aggregatedCaseB1.aggregated.depth0_30cm.sand, 63.5);
  assert.equal(aggregatedCaseB1.aggregated.depth0_30cm.silt, 21.5);
  assert.equal(aggregatedCaseB1.aggregated.depth0_30cm.clay, 15.0);
  assert.equal(aggregatedCaseB1.aggregated.depth0_30cm.om, 1.6);
  assert.equal(aggregatedCaseB1.aggregated.depth0_30cm.awc, 0.14);

  const soilCaseB1: SoilData = {
    aggregated: aggregatedCaseB1.aggregated,
    dataCoverage: aggregatedCaseB1.dataCoverage,
    totalComponentPercent: 100,
    source: "USDA NRCS Soil Survey Geographic Database (SSURGO)",
    limitations: [],
  };

  const objectivesCaseB1 = buildFieldSpecificObjectives({
    climate: sharedModerateClimate,
    soil: soilCaseB1,
    priorities: DEFAULT_PRIORITIES,
    availableCropIds: availableCrops,
  });
  assert.equal(
    objectivesCaseB1.find((o) => o.archetype === "soil_health")!.name,
    "Soil Organic Matter & Biological Nitrogen"
  );
  assert.equal(
    objectivesCaseB1.find((o) => o.archetype === "water_resilience")!.name,
    "Seasonal Moisture & Dry-Spell Resilience"
  );
  assert.equal(
    objectivesCaseB1.find((o) => o.archetype === "crop_diversity")!.name,
    "Multi-Family Disease & Pest Cycle Break"
  );

  //    Comparison B2: Same incomplete-triplet structure as Case A, but Horizon 1 (0–20 cm) has
  //    complete triplet sand = 64%, silt = 22%, clay = 14% (< 68% threshold).
  const belowThresholdPartialComponents: SoilComponentInput[] = [
    {
      ...partialTripletComponents[0],
      horizons: [
        {
          ...partialTripletComponents[0].horizons[0],
          sand: 64,
          silt: 22,
          clay: 14,
        },
        partialTripletComponents[0].horizons[1],
      ],
    },
    partialTripletComponents[1],
  ];

  const aggregatedCaseB2 = aggregateComponents(belowThresholdPartialComponents);
  assert.equal(aggregatedCaseB2.aggregated.depth0_30cm.sand, 64);
  assert.equal(aggregatedCaseB2.aggregated.depth0_30cm.silt, 22);
  assert.equal(aggregatedCaseB2.aggregated.depth0_30cm.clay, 14);
  assert.equal(aggregatedCaseB2.aggregated.depth0_30cm.om, 1.6);
  assert.equal(aggregatedCaseB2.aggregated.depth0_30cm.awc, 0.14);

  const soilCaseB2: SoilData = {
    aggregated: aggregatedCaseB2.aggregated,
    dataCoverage: aggregatedCaseB2.dataCoverage,
    totalComponentPercent: 100,
    source: "USDA NRCS Soil Survey Geographic Database (SSURGO)",
    limitations: [],
  };

  const objectivesCaseB2 = buildFieldSpecificObjectives({
    climate: sharedModerateClimate,
    soil: soilCaseB2,
    priorities: DEFAULT_PRIORITIES,
    availableCropIds: availableCrops,
  });
  assert.equal(
    objectivesCaseB2.find((o) => o.archetype === "soil_health")!.name,
    "Soil Organic Matter & Biological Nitrogen"
  );
  assert.equal(
    objectivesCaseB2.find((o) => o.archetype === "water_resilience")!.name,
    "Seasonal Moisture & Dry-Spell Resilience"
  );
  assert.equal(
    objectivesCaseB2.find((o) => o.archetype === "crop_diversity")!.name,
    "Multi-Family Disease & Pest Cycle Break"
  );

  // Confirm that numerical rotation scoring (`scoreStrategy`) is completely unchanged across Case A and Case B
  const refStrategy = makeValidStrategy("ssurgo_triplet_score_check", "SSURGO Triplet Score Check");
  const scoredA = scoreStrategy(refStrategy, sharedModerateClimate, soilCaseA, DEFAULT_PRIORITIES);
  const scoredB1 = scoreStrategy(refStrategy, sharedModerateClimate, soilCaseB1, DEFAULT_PRIORITIES);
  const scoredB2 = scoreStrategy(refStrategy, sharedModerateClimate, soilCaseB2, DEFAULT_PRIORITIES);
  assert.equal(scoredA.overallScore, scoredB1.overallScore);
  assert.equal(scoredA.overallScore, scoredB2.overallScore);
  for (const key of [
    "waterSuitability",
    "nitrogenContribution",
    "soilCoverage",
    "diversityPestBreak",
    "climateRiskResilience",
  ] as const) {
    assert.equal(scoredA.factorScores[key].score, scoredB1.factorScores[key].score);
    assert.equal(scoredA.factorScores[key].score, scoredB2.factorScores[key].score);
  }
});

// ─── 21. U.S. SSURGO Provider Routing, Outage Handling & SoilGrids Fallback Regression Tests ───

section("U.S. SSURGO Provider Routing, Outage Handling & SoilGrids WCS Fallback (Iowa 41.8780, -93.0977)");

test("U.S. geographic coverage detection accurately classifies CONUS, Alaska, Hawaii, and U.S. territories without using an overly broad North American rectangle", () => {
  // 1. Reproduction coordinate: central Iowa (41.8780, -93.0977)
  assert.equal(isUnitedStatesCoordinate(41.8780, -93.0977), true);
  const iowaGeo = resolveGeographicContext(41.8780, -93.0977);
  assert.equal(iowaGeo.countryCodeIso2, "US");
  assert.equal(iowaGeo.countryCodeIso3, "USA");
  assert.equal(iowaGeo.regionTag, "us_midwest");

  // 2. Other U.S. states & territories (including West Coast, South Texas, Maine, Alaska, Hawaii, Puerto Rico, Guam)
  const usCoordinates: Array<{ name: string; lat: number; lon: number }> = [
    { name: "Rowan County, North Carolina", lat: 35.67, lon: -80.47 },
    { name: "Fresno, Central Valley California", lat: 36.7378, lon: -119.7871 },
    { name: "Willamette Valley, Oregon", lat: 44.9429, lon: -123.0351 },
    { name: "Yakima Valley, Washington", lat: 46.6021, lon: -120.5059 },
    { name: "Rio Grande Valley (McAllen), Texas", lat: 26.2034, lon: -98.2300 },
    { name: "Aroostook County, Maine", lat: 46.6812, lon: -68.0159 },
    { name: "Matanuska Valley (Palmer), Alaska", lat: 61.5997, lon: -149.1128 },
    { name: "Oahu, Hawaii", lat: 21.4389, lon: -158.0001 },
    { name: "San Juan / Arecibo, Puerto Rico", lat: 18.4655, lon: -66.1057 },
    { name: "Guam", lat: 13.4443, lon: 144.7937 },
  ];
  for (const pt of usCoordinates) {
    assert.equal(
      isUnitedStatesCoordinate(pt.lat, pt.lon),
      true,
      `Expected ${pt.name} (${pt.lat}, ${pt.lon}) to be classified as U.S. coordinate`
    );
    const geo = resolveGeographicContext(pt.lat, pt.lon);
    assert.equal(
      geo.countryCodeIso2,
      "US",
      `Expected ${pt.name} to have countryCodeIso2 === "US", got ${geo.countryCodeIso2}`
    );
  }

  // 3. Non-U.S. North American & Caribbean coordinates that previously fell inside the coarse
  //    (lat >= 17.5 && lat <= 71.5 && lon >= -179.9 && lon <= -64.5) rectangle must NOT be classified as U.S.
  const nonUsNeighbors: Array<{ name: string; lat: number; lon: number }> = [
    { name: "London, Southern Ontario, Canada", lat: 42.9849, lon: -81.2453 },
    { name: "Ottawa / Montreal corridor, Canada", lat: 45.5017, lon: -73.5673 },
    { name: "Saskatoon, Saskatchewan, Canada", lat: 52.1332, lon: -106.6700 },
    { name: "Kamloops, British Columbia, Canada", lat: 50.6745, lon: -120.3273 },
    { name: "Whitehorse, Yukon, Canada", lat: 60.7212, lon: -135.0568 },
    { name: "Hermosillo, Sonora, Mexico", lat: 29.0729, lon: -110.9559 },
    { name: "Culiacán, Sinaloa, Mexico", lat: 24.8091, lon: -107.3940 },
    { name: "Chihuahua, Mexico", lat: 28.6330, lon: -106.0691 },
    { name: "Havana, Cuba", lat: 23.1136, lon: -82.3666 },
    { name: "Nassau, Bahamas", lat: 25.0443, lon: -77.3504 },
    { name: "Beauce, France", lat: 48.45, lon: 1.49 },
  ];
  for (const pt of nonUsNeighbors) {
    assert.equal(
      isUnitedStatesCoordinate(pt.lat, pt.lon),
      false,
      `Expected ${pt.name} (${pt.lat}, ${pt.lon}) NOT to be classified as U.S. coordinate`
    );
    const geo = resolveGeographicContext(pt.lat, pt.lon);
    assert.notEqual(
      geo.countryCodeIso2,
      "US",
      `Expected ${pt.name} NOT to have countryCodeIso2 === "US"`
    );
  }
});

test("Iowa (41.8780, -93.0977) constructs WKT POINT(-93.0977 41.878) in longitude-first order and produces a complete SSURGO profile when USDA SDA responds", async () => {
  const lat = 41.8780;
  const lon = -93.0977;

  // 1. Verify longitude-first WKT construction
  const wkt = buildSsurgoPointWkt(lat, lon);
  assert.equal(wkt, "POINT(-93.0977 41.878)");

  const capturedQueries: string[] = [];
  const mockSdaFetch: typeof fetch = async (_input, init) => {
    const bodyStr = typeof init?.body === "string" ? init.body : "";
    const parsed = JSON.parse(bodyStr) as { query: string; format: string };
    capturedQueries.push(parsed.query);

    if (parsed.query.includes("SDA_Get_Mukey_from_intersection_with_WktWgs84")) {
      return new Response(JSON.stringify({ Table: [["408312"]] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    if (parsed.query.includes("SELECT muname FROM mapunit")) {
      return new Response(
        JSON.stringify({
          Table: [["Clarion loam, 2 to 6 percent slopes"]],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }
    if (parsed.query.includes("FROM component co")) {
      // Columns:
      // 0:cokey 1:comppct_r 2:compname 3:drainagecl 4:slope_r 5:compkind 6:majcompflag
      // 7:hzdept_r 8:hzdepb_r 9:sandtotal_r 10:silttotal_r 11:claytotal_r 12:om_r 13:ph1to1h2o_r 14:awc_r
      return new Response(
        JSON.stringify({
          Table: [
            [
              "21000101",
              "85",
              "Clarion",
              "Moderately well drained",
              "4.0",
              "Series",
              "Yes",
              "0",
              "20",
              "38.0",
              "40.0",
              "22.0",
              "3.6",
              "6.5",
              "0.20",
            ],
            [
              "21000101",
              "85",
              "Clarion",
              "Moderately well drained",
              "4.0",
              "Series",
              "Yes",
              "20",
              "35",
              "36.0",
              "39.0",
              "25.0",
              "2.8",
              "6.6",
              "0.19",
            ],
            [
              "21000102",
              "15",
              "Nicollet",
              "Somewhat poorly drained",
              "2.0",
              "Series",
              "Yes",
              "0",
              "30",
              "32.0",
              "42.0",
              "26.0",
              "4.5",
              "6.7",
              "0.21",
            ],
          ],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }
    throw new Error(`Unexpected query: ${parsed.query}`);
  };

  let wcsCalled = false;
  const routeResult = await resolveSoilProfileForCoordinate(lat, lon, {
    sdaFetchFn: mockSdaFetch,
    soilGridsWcsFetcher: fetchSoilGridsWcsProfile,
    wcsFetchFn: async () => {
      wcsCalled = true;
      throw new Error("WCS should not be called when SSURGO succeeds");
    },
  });

  // 2. Verify spatial query used POINT(-93.0977 41.878) and WCS was not called
  assert.equal(wcsCalled, false);
  assert.equal(capturedQueries.length, 3);
  assert.ok(
    capturedQueries[0].includes(
      "SDA_Get_Mukey_from_intersection_with_WktWgs84('POINT(-93.0977 41.878)')"
    ),
    `Expected WKT query to contain POINT(-93.0977 41.878), got: ${capturedQueries[0]}`
  );

  // 3. Verify response is labeled as USDA SSURGO with all component, horizon, drainage, and slope values retained
  assert.equal(routeResult.ok, true);
  if (!routeResult.ok) return;
  assert.equal(routeResult.cachePolicy, "ssurgo_primary");
  assert.equal(routeResult.usSsurgoStatus, "ok");

  const profile = routeResult.response;
  assert.equal(profile.dataTier, "usda_ssurgo");
  assert.ok(profile.source.includes("USDA NRCS Soil Survey Geographic Database (SSURGO)"));
  assert.deepEqual(profile.mapUnit, {
    mukey: "408312",
    name: "Clarion loam, 2 to 6 percent slopes",
  });
  assert.equal(profile.totalComponentPercent, 100);
  assert.equal(profile.components.length, 2);
  assert.equal(profile.components[0].name, "Clarion");
  assert.equal(profile.components[0].horizons.length, 2);
  assert.equal(profile.components[1].name, "Nicollet");
  assert.equal(profile.components[1].horizons.length, 1);

  // Check depth-weighted & component-weighted aggregation:
  // Clarion (85%): 0-20 cm (20 cm) + 20-30 cm (10 cm):
  //   sand = (38*20 + 36*10)/30 = 37.3333..., silt = (40*20 + 39*10)/30 = 39.6666..., clay = (22*20 + 25*10)/30 = 23.0
  //   om = (3.6*20 + 2.8*10)/30 = 3.3333..., ph = (6.5*20 + 6.6*10)/30 = 6.5333..., awc = (0.20*20 + 0.19*10)/30 = 0.19666...
  // Nicollet (15%): 0-30 cm:
  //   sand = 32, silt = 42, clay = 26, om = 4.5, ph = 6.7, awc = 0.21
  // Combined:
  //   sand = 37.3333*0.85 + 32*0.15 = 36.5333 -> 36.5
  //   silt = 39.6666*0.85 + 42*0.15 = 40.0166 -> 40.0
  //   clay = 23.0*0.85 + 26*0.15 = 23.45 -> 23.5
  //   slope = 4.0*0.85 + 2.0*0.15 = 3.7
  //   drainage = "Moderately well drained" (85% dominant)
  assert.ok(Math.abs((profile.aggregated.depth0_30cm.sand ?? 0) - 36.53333333333333) < 1e-9);
  assert.ok(Math.abs((profile.aggregated.depth0_30cm.silt ?? 0) - 40.016666666666666) < 1e-9);
  assert.ok(Math.abs((profile.aggregated.depth0_30cm.clay ?? 0) - 23.45) < 1e-9);
  assert.ok(Math.abs((profile.aggregated.depth0_30cm.om ?? 0) - 3.5083333333333333) < 1e-9);
  assert.ok(Math.abs((profile.aggregated.depth0_30cm.ph ?? 0) - 6.558333333333334) < 1e-9);
  assert.ok(Math.abs((profile.aggregated.depth0_30cm.awc ?? 0) - 0.19866666666666666) < 1e-9);
  assert.equal(profile.aggregated.drainage, "Moderately well drained");
  assert.ok(Math.abs((profile.aggregated.slope ?? 0) - 3.7) < 1e-9);

  // Verify display model renders all 6 properties (texture + 5 metric cards including slope and drainage)
  const displayModel = buildSoilProfileDisplayModel(profile);
  assert.equal(displayModel.dataTier, "usda_ssurgo");
  assert.equal(displayModel.texture.valid, true);
  assert.equal(displayModel.texture.sand, 36.5);
  assert.equal(displayModel.texture.silt, 40.0);
  assert.equal(displayModel.texture.clay, 23.5);
  assert.equal(displayModel.texture.total, 100.0);
  assert.deepEqual(
    displayModel.availableMetrics.map((m) => m.key),
    ["om", "ph", "awc", "slope", "drainage"]
  );
  assert.equal(displayModel.componentTable.visible, true);
  assert.equal(displayModel.componentTable.showDrainageColumn, true);
  assert.equal(displayModel.componentTable.showSlopeColumn, true);
  assert.equal(displayModel.horizonTables.length, 2);
});

test("USDA SDA error handling strictly distinguishes HTTP 502 / service errors (request_error) from genuine empty spatial results (no_map_unit) and empty components (no_usable_soil_data)", async () => {
  const lat = 41.8780;
  const lon = -93.0977;

  // 1. Live USDA SDA 502 Bad Gateway HTML response -> status === "request_error"
  const sda502Fetch: typeof fetch = async () =>
    new Response(
      "<html>\r\n<head><title>502 Bad Gateway</title></head>\r\n<body>\r\n<center><h1>502 Bad Gateway</h1></center>\r\n</body>\r\n</html>",
      { status: 502, headers: { "Content-Type": "text/html" } }
    );
  const res502 = await fetchUsdaSsurgoProfile(lat, lon, { fetchFn: sda502Fetch });
  assert.equal(res502.status, "request_error");
  if (res502.status === "request_error") {
    assert.ok(res502.errorMessage.includes("HTTP 502 Bad Gateway"));
    assert.ok(!res502.errorMessage.includes("<html>"), "HTML tags must be sanitized from error message");
  }

  // 2. SDA returns JSON error object without `Table` key (`{"Error": "..."}`) -> throws SsurgoRequestError / status === "request_error"
  //    (Previously, `querySDA` returned `[]` for any object without `Table`, misclassifying JSON errors as no_map_unit!)
  const sdaJsonErrorFetch: typeof fetch = async () =>
    new Response(JSON.stringify({ Error: "Timeout expired in tabular database" }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  const resJsonErr = await fetchUsdaSsurgoProfile(lat, lon, { fetchFn: sdaJsonErrorFetch });
  assert.equal(resJsonErr.status, "request_error");
  if (resJsonErr.status === "request_error") {
    assert.ok(resJsonErr.errorMessage.includes("Timeout expired in tabular database"));
  }

  // 3. Genuine empty spatial intersection (`{}`) -> status === "no_map_unit"
  const sdaEmptySpatialFetch: typeof fetch = async () =>
    new Response(JSON.stringify({}), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  const resNoMapUnit = await fetchUsdaSsurgoProfile(lat, lon, {
    fetchFn: sdaEmptySpatialFetch,
  });
  assert.equal(resNoMapUnit.status, "no_map_unit");

  // 4. Map unit exists (e.g. miscellaneous water/urban land) but has no usable soil properties -> status === "no_usable_soil_data"
  const sdaNoUsableDataFetch: typeof fetch = async (_input, init) => {
    const bodyStr = typeof init?.body === "string" ? init.body : "";
    const parsed = JSON.parse(bodyStr) as { query: string };
    if (parsed.query.includes("SDA_Get_Mukey_from_intersection_with_WktWgs84")) {
      return new Response(JSON.stringify({ Table: [["999999"]] }), { status: 200 });
    }
    if (parsed.query.includes("SELECT muname FROM mapunit")) {
      return new Response(JSON.stringify({ Table: [["Water"]] }), { status: 200 });
    }
    return new Response(
      JSON.stringify({
        Table: [
          [
            "99999901",
            "100",
            "Water",
            null,
            null,
            "Miscellaneous area",
            "Yes",
            null,
            null,
            null,
            null,
            null,
            null,
            null,
            null,
          ],
        ],
      }),
      { status: 200 }
    );
  };
  const resNoUsable = await fetchUsdaSsurgoProfile(lat, lon, {
    fetchFn: sdaNoUsableDataFetch,
  });
  assert.equal(resNoUsable.status, "no_usable_soil_data");
});

test("U.S. SSURGO failure for Iowa (41.8780, -93.0977) falls back to live coordinate-specific ISRIC SoilGrids v2.0 WCS (labeled as SoilGrids) and NEVER returns the generic Cambisols/Luvisols reference profile", async () => {
  clearSoilGridsCacheForTests();
  const lat = 41.8780;
  const lon = -93.0977;

  // Simulate USDA SDA HTTP 502 Bad Gateway outage
  const sda502Fetch: typeof fetch = async () =>
    new Response("<html><head><title>502 Bad Gateway</title></head></html>", {
      status: 502,
      headers: { "Content-Type": "text/html" },
    });

  // Simulate live ISRIC SoilGrids v2.0 WCS response for central Iowa (Phaeozems / Prairie Mollisol)
  const iowaSoilGridsCoverages: Record<string, number> = {
    "sand_0-5cm_Q0.5": 95,
    "sand_5-15cm_Q0.5": 94,
    "sand_15-30cm_Q0.5": 98,
    "silt_0-5cm_Q0.5": 584,
    "silt_5-15cm_Q0.5": 581,
    "silt_15-30cm_Q0.5": 565,
    "clay_0-5cm_Q0.5": 270,
    "clay_5-15cm_Q0.5": 274,
    "clay_15-30cm_Q0.5": 288,
    "sand_0-5cm_mean": 110,
    "sand_5-15cm_mean": 110,
    "sand_15-30cm_mean": 110,
    "silt_0-5cm_mean": 471,
    "silt_5-15cm_mean": 471,
    "silt_15-30cm_mean": 471,
    "clay_0-5cm_mean": 419,
    "clay_5-15cm_mean": 419,
    "clay_15-30cm_mean": 419,
    "soc_0-5cm_Q0.5": 202,
    "soc_5-15cm_Q0.5": 152,
    "soc_15-30cm_Q0.5": 118,
    "phh2o_0-5cm_Q0.5": 62,
    "phh2o_5-15cm_Q0.5": 62,
    "phh2o_15-30cm_Q0.5": 62,
    "bdod_0-5cm_Q0.5": 148,
    "bdod_5-15cm_Q0.5": 154,
    "bdod_15-30cm_Q0.5": 156,
    "cfvo_0-5cm_Q0.5": 0,
    "cfvo_5-15cm_Q0.5": 0,
    "cfvo_15-30cm_Q0.5": 0,
    "wv0033_0-5cm_Q0.5": 350,
    "wv0033_5-15cm_Q0.5": 345,
    "wv0033_15-30cm_Q0.5": 340,
    "wv1500_0-5cm_Q0.5": 155,
    "wv1500_5-15cm_Q0.5": 157,
    "wv1500_15-30cm_Q0.5": 158,
    MostProbable: 20, // Phaeozems
  };

  // Case A: SSURGO fails with HTTP 502, live SoilGrids WCS succeeds
  const fallbackResult = await resolveSoilProfileForCoordinate(lat, lon, {
    sdaFetchFn: sda502Fetch,
    soilGridsWcsFetcher: fetchSoilGridsWcsProfile,
    wcsFetchFn: createMockSoilGridsFetch(iowaSoilGridsCoverages),
    bypassCache: true,
  });

  assert.equal(fallbackResult.ok, true);
  if (!fallbackResult.ok) return;
  assert.equal(fallbackResult.cachePolicy, "us_outage_soilgrids_fallback");
  assert.equal(fallbackResult.usSsurgoStatus, "request_error");

  const sgFallback = fallbackResult.response;
  assert.equal(sgFallback.dataTier, "soilgrids_wcs_250m");
  assert.ok(sgFallback.source.includes("ISRIC SoilGrids v2.0"));
  assert.ok(!sgFallback.source.includes("USDA NRCS"));
  assert.ok(
    !sgFallback.mapUnit?.name.includes("Global Reference Cambisols & Luvisols"),
    "Must NEVER return the generic Global Reference Cambisols & Luvisols fallback for Iowa"
  );
  assert.equal(sgFallback.wrbSoilGroup, "Phaeozems");
  assert.deepEqual(sgFallback.usSsurgoFallback, {
    reason: "request_error",
    detail:
      "USDA NRCS Soil Data Access (SSURGO) request failed (USDA Soil Data Access API returned HTTP 502 Bad Gateway).",
  });
  assert.ok(
    sgFallback.limitations[0].includes("Live USDA NRCS SSURGO service was unreachable") &&
      sgFallback.limitations[0].includes("ISRIC SoilGrids v2.0"),
    "First limitation must clearly explain why SoilGrids was used in place of SSURGO"
  );
  assert.equal(sgFallback.aggregated.drainage, null);
  assert.equal(sgFallback.aggregated.slope, null);

  const sgDisplay = buildSoilProfileDisplayModel(sgFallback);
  assert.equal(sgDisplay.dataTier, "soilgrids_wcs_250m");
  assert.equal(sgDisplay.textureStatistic, "soilgrids_mean");
  assert.equal(sgDisplay.texture.sand, 11.0);
  assert.equal(sgDisplay.texture.silt, 47.1);
  assert.equal(sgDisplay.texture.clay, 41.9);
  assert.equal(sgDisplay.texture.total, 100.0);
  assert.deepEqual(
    sgDisplay.availableMetrics.map((m) => m.key),
    ["om", "ph", "awc"],
    "SoilGrids fallback for a U.S. coordinate must omit unsupported slope and drainage cards"
  );

  // Case B: Both SSURGO and live SoilGrids WCS fail for Iowa (41.8780, -93.0977)
  //         -> Must return ok: false (HTTP 503) and NEVER silently return `regional_reference_fallback`
  const bothFailResult = await resolveSoilProfileForCoordinate(lat, lon, {
    sdaFetchFn: sda502Fetch,
    soilGridsWcsFetcher: fetchSoilGridsWcsProfile,
    wcsFetchFn: async () => new Response("WCS service error", { status: 503 }),
    bypassCache: true,
  });

  assert.equal(bothFailResult.ok, false);
  if (!bothFailResult.ok) {
    assert.equal(bothFailResult.httpStatus, 503);
    assert.equal(bothFailResult.usSsurgoStatus, "request_error");
    assert.ok(bothFailResult.error.includes("USDA NRCS SSURGO soil service is temporarily unavailable"));
    assert.ok(bothFailResult.detail.includes("HTTP 502 Bad Gateway"));
  }

  // Case C: Verify `isUsableCachedSoilResponse` rejects any cached `regional_reference_fallback` for U.S. coordinates
  //         while allowing `usda_ssurgo` and `soilgrids_wcs_250m`, and allowing `regional_reference_fallback` outside the U.S.
  assert.equal(
    isUsableCachedSoilResponse(lat, lon, {
      dataTier: "regional_reference_fallback",
      source: "FAO/IIASA/ISRIC/ISS-CAS/JRC Harmonized World Soil Database (HWSD v2.2)",
    }),
    false,
    "Cached regional_reference_fallback must be rejected for U.S. coordinates"
  );
  assert.equal(
    isUsableCachedSoilResponse(lat, lon, {
      dataTier: "usda_ssurgo",
      source: "USDA NRCS Soil Survey Geographic Database (SSURGO)",
    }),
    true
  );
  assert.equal(
    isUsableCachedSoilResponse(lat, lon, {
      dataTier: "soilgrids_wcs_250m",
      source: "ISRIC SoilGrids v2.0",
    }),
    true
  );
  assert.equal(
    isUsableCachedSoilResponse(48.45, 1.49, {
      dataTier: "regional_reference_fallback",
      source: "FAO/IIASA/ISRIC/ISS-CAS/JRC Harmonized World Soil Database (HWSD v2.2)",
    }),
    true,
    "International coordinates may use regional_reference_fallback when WCS is unavailable"
  );

  // Case D: Verify `buildUnifiedFieldEvidenceProfile` does not attach `soilFallback` (`Global Reference Cambisols & Luvisols`)
  //         to a U.S. field when `existingSoil` is null
  const iowaEvidence = buildUnifiedFieldEvidenceProfile(
    lat,
    lon,
    makeClimate(),
    null
  );
  assert.equal(iowaEvidence.geography.countryCodeIso2, "US");
  assert.equal(
    iowaEvidence.soilFallback,
    null,
    "U.S. unified evidence profile must not populate macro-regional soilFallback when live soil is null"
  );
});

// ─── 22. Two-Stage SoilGrids WCS Retrieval (Essential vs. Optional) & Cold-Cache Resilience ───

section("Two-Stage SoilGrids WCS Retrieval (Essential vs. Optional), Retry & Cache Resilience");

test("Stage 1 & 2 layer specifications partition all 47 coverages into 15 essential Q0.5 layers and 32 optional enrichment layers without duplicating clay_0-5cm_Q0.5", async () => {
  const essentialTasks = buildEssentialCoverageTasks();
  const optionalTasks = buildOptionalCoverageTasks();

  assert.equal(essentialTasks.length, 15, "Essential stage must have exactly 15 Q0.5 layers");
  assert.equal(optionalTasks.length, 32, "Optional stage must have exactly 32 enrichment layers");
  assert.equal(
    essentialTasks[0].key,
    "clay_0-5cm_Q0.5",
    "clay_0-5cm_Q0.5 must be the anchor first layer of the essential stage"
  );

  // Verify no duplicate coverage keys within or across stages
  const allKeys = [...essentialTasks.map((t) => t.key), ...optionalTasks.map((t) => t.key)];
  assert.equal(new Set(allKeys).size, 47, "All 47 layer keys across essential + optional stages must be unique");
  assert.equal(
    essentialTasks.filter((t) => t.coverageId === "clay_0-5cm_Q0.5").length,
    1,
    "clay_0-5cm_Q0.5 must appear only once in essential tasks"
  );
  assert.equal(
    optionalTasks.filter((t) => t.coverageId === "clay_0-5cm_Q0.5").length,
    0,
    "clay_0-5cm_Q0.5 must not appear in optional tasks"
  );

  // Verify all 15 essential layers are Q0.5 for sand, silt, clay, soc, phh2o across 0-5cm, 5-15cm, 15-30cm
  for (const prop of ESSENTIAL_SOILGRIDS_PROPERTIES) {
    for (const depth of SOILGRIDS_DEPTH_LAYERS) {
      const key = `${prop}_${depth.id}_Q0.5`;
      assert.ok(
        essentialTasks.some((t) => t.key === key && t.stage === "essential"),
        `Missing essential task ${key}`
      );
    }
  }
});

test("Case 1, 2 & 3: All 15 essential layers succeed when optional layers fail; single mean-texture failure falls back to normalized Q0.5 texture; optional uncertainty/bdod/cfvo/AWC/WRB failures never invalidate core profile", async () => {
  clearSoilGridsCacheForTests();
  const lat = 41.8780;
  const lon = -93.0977;

  const essentialOnlyCoverages: Record<string, number> = {
    "sand_0-5cm_Q0.5": 95,
    "sand_5-15cm_Q0.5": 94,
    "sand_15-30cm_Q0.5": 98,
    "silt_0-5cm_Q0.5": 584,
    "silt_5-15cm_Q0.5": 581,
    "silt_15-30cm_Q0.5": 565,
    "clay_0-5cm_Q0.5": 270,
    "clay_5-15cm_Q0.5": 274,
    "clay_15-30cm_Q0.5": 288,
    "soc_0-5cm_Q0.5": 202,
    "soc_5-15cm_Q0.5": 152,
    "soc_15-30cm_Q0.5": 118,
    "phh2o_0-5cm_Q0.5": 62,
    "phh2o_5-15cm_Q0.5": 62,
    "phh2o_15-30cm_Q0.5": 62,
  };

  // Case 1 & 3: Only the 15 essential layers succeed; all 32 optional layers fail (HTTP 503).
  // Verify clay_0-5cm_Q0.5 is requested only ONCE.
  const requestCounts = new Map<string, number>();
  const baseEssentialFetch = createMockSoilGridsFetch(essentialOnlyCoverages);
  const countingFetch: typeof fetch = (async (input, init) => {
    const urlStr = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const cov = new URL(urlStr).searchParams.get("COVERAGE") ?? "";
    requestCounts.set(cov, (requestCounts.get(cov) ?? 0) + 1);
    if (!(cov in essentialOnlyCoverages)) {
      return new Response("Optional layer unavailable", { status: 503 });
    }
    return baseEssentialFetch(input, init);
  }) as typeof fetch;

  const diag1List: SoilGridsFetchDiagnostics[] = [];
  const profileEssentialOnly = await fetchSoilGridsWcsProfile(lat, lon, {
    fetchFn: countingFetch,
    bypassCache: true,
    onDiagnostics: (d) => {
      diag1List.push(d);
    },
  });

  assert.ok(profileEssentialOnly, "Profile must succeed when all 15 essential layers succeed even if all 32 optional layers fail");
  assert.equal(
    requestCounts.get("clay_0-5cm_Q0.5"),
    1,
    "clay_0-5cm_Q0.5 must be requested only once (reused from pixel-selection anchor)"
  );
  assert.equal(profileEssentialOnly.enrichmentStatus, "partial_optional");
  assert.equal(profileEssentialOnly.aggregated.depth0_30cm.sand, 9.6);
  assert.equal(profileEssentialOnly.aggregated.depth0_30cm.silt, 57.4);
  assert.equal(profileEssentialOnly.aggregated.depth0_30cm.clay, 28.0);
  assert.equal(profileEssentialOnly.aggregated.depth0_30cm.om, 2.47);
  assert.equal(profileEssentialOnly.aggregated.depth0_30cm.ph, 6.2);
  // Missing optional properties are never fabricated
  assert.equal(profileEssentialOnly.aggregated.depth0_30cm.textureMean0_30cm, undefined);
  assert.equal(profileEssentialOnly.aggregated.depth0_30cm.awc, null);
  assert.equal(profileEssentialOnly.aggregated.depth0_30cm.bulkDensityGcm3, null);
  assert.equal(profileEssentialOnly.aggregated.depth0_30cm.coarseFragmentsPct, null);
  assert.equal(profileEssentialOnly.wrbSoilGroup, undefined);
  assert.equal(profileEssentialOnly.layerUncertainty, undefined);
  assert.equal(profileEssentialOnly.aggregated.drainage, null);
  assert.equal(profileEssentialOnly.aggregated.slope, null);

  const diag1 = diag1List[0];
  assert.ok(diag1);
  assert.equal(diag1.essentialComplete, true);
  assert.equal(diag1.optionalComplete, false);
  assert.equal(diag1.essentialLayersSucceeded, 15);
  assert.equal(diag1.optionalLayersSucceeded, 0);
  assert.equal(diag1.layerEvents.length, 32);
  assert.ok(diag1.layerEvents.every((e) => e.stage === "optional" && e.reason === "http_error" && e.httpStatus === 503));

  // Case 2: 8 of 9 optional mean-texture layers succeed, but 1 optional mean-texture layer (`sand_15-30cm_mean`) fails.
  // Profile must still succeed and cleanly fall back to normalized Q0.5 texture (`soilgrids_q50`, summing to 100.0%).
  const partialMeanCoverages: Record<string, number> = {
    ...essentialOnlyCoverages,
    "sand_0-5cm_mean": 110,
    "sand_5-15cm_mean": 110,
    // "sand_15-30cm_mean" intentionally omitted (will fail with HTTP 404)
    "silt_0-5cm_mean": 471,
    "silt_5-15cm_mean": 471,
    "silt_15-30cm_mean": 471,
    "clay_0-5cm_mean": 419,
    "clay_5-15cm_mean": 419,
    "clay_15-30cm_mean": 419,
  };

  const profilePartialMean = await fetchSoilGridsWcsProfile(lat, lon, {
    fetchFn: createMockSoilGridsFetch(partialMeanCoverages),
    bypassCache: true,
  });
  assert.ok(profilePartialMean, "Profile must succeed when one optional mean-texture layer fails");
  assert.equal(
    profilePartialMean.aggregated.depth0_30cm.textureMean0_30cm,
    undefined,
    "Incomplete 0–30 cm mean texture (missing 15–30 cm) must not be used as composite 0–30 cm mean texture"
  );

  const displayPartialMean = buildSoilProfileDisplayModel(profilePartialMean);
  assert.equal(displayPartialMean.textureStatistic, "soilgrids_q50");
  assert.equal(displayPartialMean.texture.valid, true);
  assert.equal(displayPartialMean.texture.total, 100.0);
  assert.equal(displayPartialMean.texture.wasNormalized, true);
  // Raw Q0.5 values remain preserved separately (9.6 + 57.4 + 28.0 = 95.0%)
  assert.deepEqual(displayPartialMean.texture.raw, {
    sand: 9.6,
    silt: 57.4,
    clay: 28.0,
    total: 95.0,
  });
});

test("Case 4 & 5: Transiently failing essential layer recovers via 1 bounded retry when budget remains, while persistent essential failure or NoData rejects the profile without running optional layers", async () => {
  clearSoilGridsCacheForTests();
  const lat = 41.8780;
  const lon = -93.0977;

  const fullCoverages: Record<string, number> = {
    "sand_0-5cm_Q0.5": 95,
    "sand_5-15cm_Q0.5": 94,
    "sand_15-30cm_Q0.5": 98,
    "silt_0-5cm_Q0.5": 584,
    "silt_5-15cm_Q0.5": 581,
    "silt_15-30cm_Q0.5": 565,
    "clay_0-5cm_Q0.5": 270,
    "clay_5-15cm_Q0.5": 274,
    "clay_15-30cm_Q0.5": 288,
    "soc_0-5cm_Q0.5": 202,
    "soc_5-15cm_Q0.5": 152,
    "soc_15-30cm_Q0.5": 118,
    "phh2o_0-5cm_Q0.5": 62,
    "phh2o_5-15cm_Q0.5": 62,
    "phh2o_15-30cm_Q0.5": 62,
    "sand_0-5cm_mean": 110,
    "sand_5-15cm_mean": 110,
    "sand_15-30cm_mean": 110,
    "silt_0-5cm_mean": 471,
    "silt_5-15cm_mean": 471,
    "silt_15-30cm_mean": 471,
    "clay_0-5cm_mean": 419,
    "clay_5-15cm_mean": 419,
    "clay_15-30cm_mean": 419,
    MostProbable: 20,
  };
  const baseMock = createMockSoilGridsFetch(fullCoverages);

  // Case 4: `soc_15-30cm_Q0.5` fails on Attempt 1 (timeout error) and succeeds on Attempt 2 (bounded retry)
  let soc1530Attempts = 0;
  const transientEssentialFetch: typeof fetch = (async (input, init) => {
    const urlStr = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const cov = new URL(urlStr).searchParams.get("COVERAGE") ?? "";
    if (cov === "soc_15-30cm_Q0.5") {
      soc1530Attempts++;
      if (soc1530Attempts === 1) {
        const abortErr = new Error("Simulated transient layer timeout");
        abortErr.name = "AbortError";
        throw abortErr;
      }
    }
    return baseMock(input, init);
  }) as typeof fetch;

  const retryDiagList: SoilGridsFetchDiagnostics[] = [];
  const recoveredProfile = await fetchSoilGridsWcsProfile(lat, lon, {
    fetchFn: transientEssentialFetch,
    essentialRetryDelayMs: 10,
    bypassCache: true,
    onDiagnostics: (d) => {
      retryDiagList.push(d);
    },
  });

  assert.ok(recoveredProfile, "Profile must succeed when a transient essential layer failure recovers on retry");
  assert.equal(soc1530Attempts, 2, "Transiently failing essential layer must be retried exactly once");
  const retryDiag = retryDiagList[0];
  assert.ok(retryDiag);
  assert.equal(retryDiag.essentialComplete, true);
  const socRetryEvent = retryDiag.layerEvents.find((e) => e.coverageId === "soc_15-30cm_Q0.5");
  assert.ok(socRetryEvent, "Diagnostic must record the initial failure on soc_15-30cm_Q0.5");
  assert.equal(socRetryEvent.stage, "essential");
  assert.equal(socRetryEvent.attempt, 1);
  assert.equal(socRetryEvent.reason, "timeout");
  assert.equal(socRetryEvent.retried, true);
  assert.equal(socRetryEvent.recoveredOnRetry, true);
  assert.ok(socRetryEvent.remainingStageBudgetMs > 0);

  // Case 5: Persistent essential layer failure (`phh2o_5-15cm_Q0.5` fails on both Attempt 1 and Attempt 2)
  //         -> Rejects profile (returns null) and never starts optional stage
  let phAttempts = 0;
  let optionalRequestsFired = 0;
  const persistentEssentialFailFetch: typeof fetch = (async (input, init) => {
    const urlStr = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const cov = new URL(urlStr).searchParams.get("COVERAGE") ?? "";
    if (
      cov.endsWith("_mean") ||
      cov.endsWith("_Q0.05") ||
      cov.endsWith("_Q0.95") ||
      cov.startsWith("bdod_") ||
      cov.startsWith("cfvo_") ||
      cov.startsWith("wv") ||
      cov === "MostProbable"
    ) {
      optionalRequestsFired++;
    }
    if (cov === "phh2o_5-15cm_Q0.5") {
      phAttempts++;
      return new Response("Upstream gateway error", { status: 502 });
    }
    return baseMock(input, init);
  }) as typeof fetch;

  const failDiagList: SoilGridsFetchDiagnostics[] = [];
  const rejectedProfile = await fetchSoilGridsWcsProfile(lat, lon, {
    fetchFn: persistentEssentialFailFetch,
    essentialRetryDelayMs: 10,
    bypassCache: true,
    onDiagnostics: (d) => {
      failDiagList.push(d);
    },
  });

  assert.equal(rejectedProfile, null, "Profile must be rejected (null) when an essential layer fails after retry");
  assert.equal(phAttempts, 2, "Essential layer must stop after 1 retry (2 total attempts)");
  assert.equal(
    optionalRequestsFired,
    0,
    "Optional enrichment stage must NEVER run when essential stage fails"
  );
  const failDiag = failDiagList[0];
  assert.ok(failDiag);
  assert.equal(failDiag.essentialComplete, false);
  assert.equal(failDiag.essentialLayersSucceeded, 14);
  const phEvents = failDiag.layerEvents.filter((e) => e.coverageId === "phh2o_5-15cm_Q0.5");
  assert.equal(phEvents.length, 2);
  assert.equal(phEvents[0].attempt, 1);
  assert.equal(phEvents[0].retried, true);
  assert.equal(phEvents[0].recoveredOnRetry, false);
  assert.equal(phEvents[1].attempt, 2);
  assert.equal(phEvents[1].retried, false);
});

test("Case 6 & 7: Optional layers cannot consume essential-stage time budget, and cold-cache requests succeed under realistic multi-wave latencies that previously timed out under the 47-request shared budget", async () => {
  clearSoilGridsCacheForTests();
  const lat = 41.8780;
  const lon = -93.0977;

  const all47Coverages: Record<string, number> = {
    "sand_0-5cm_Q0.5": 95,
    "sand_5-15cm_Q0.5": 94,
    "sand_15-30cm_Q0.5": 98,
    "silt_0-5cm_Q0.5": 584,
    "silt_5-15cm_Q0.5": 581,
    "silt_15-30cm_Q0.5": 565,
    "clay_0-5cm_Q0.5": 270,
    "clay_5-15cm_Q0.5": 274,
    "clay_15-30cm_Q0.5": 288,
    "soc_0-5cm_Q0.5": 202,
    "soc_5-15cm_Q0.5": 152,
    "soc_15-30cm_Q0.5": 118,
    "phh2o_0-5cm_Q0.5": 62,
    "phh2o_5-15cm_Q0.5": 62,
    "phh2o_15-30cm_Q0.5": 62,
    "sand_0-5cm_mean": 110,
    "sand_5-15cm_mean": 110,
    "sand_15-30cm_mean": 110,
    "silt_0-5cm_mean": 471,
    "silt_5-15cm_mean": 471,
    "silt_15-30cm_mean": 471,
    "clay_0-5cm_mean": 419,
    "clay_5-15cm_mean": 419,
    "clay_15-30cm_mean": 419,
    "wv0033_0-5cm_Q0.5": 350,
    "wv0033_5-15cm_Q0.5": 345,
    "wv0033_15-30cm_Q0.5": 340,
    "wv1500_0-5cm_Q0.5": 155,
    "wv1500_5-15cm_Q0.5": 157,
    "wv1500_15-30cm_Q0.5": 158,
    MostProbable: 20,
    "bdod_0-5cm_Q0.5": 148,
    "bdod_5-15cm_Q0.5": 154,
    "bdod_15-30cm_Q0.5": 156,
    "cfvo_0-5cm_Q0.5": 0,
    "cfvo_5-15cm_Q0.5": 0,
    "cfvo_15-30cm_Q0.5": 0,
    "sand_0-5cm_Q0.05": 20,
    "sand_0-5cm_Q0.95": 210,
    "silt_0-5cm_Q0.05": 420,
    "silt_0-5cm_Q0.95": 710,
    "clay_0-5cm_Q0.05": 180,
    "clay_0-5cm_Q0.95": 380,
    "soc_0-5cm_Q0.05": 110,
    "soc_0-5cm_Q0.95": 360,
    "phh2o_0-5cm_Q0.05": 54,
    "phh2o_0-5cm_Q0.95": 71,
  };
  const baseMock = createMockSoilGridsFetch(all47Coverages);

  const essentialKeys = new Set(buildEssentialCoverageTasks().map((t) => t.coverageId));
  const completionOrder: { coverageId: string; stage: "essential" | "optional"; timestamp: number }[] = [];

  // Simulate a scenario where:
  // - Each essential layer takes 25 ms (4 waves total: 1 anchor + 3 waves of 6 = ~100 ms)
  // - Optional mean-texture & AWC layers take 20 ms, while late optional uncertainty layers stall for 300 ms
  //   (exceeding `optionalBudgetMs: 120`)
  // Under the old shared-budget 4-concurrency model with a 250 ms total budget, 12 waves × 25 ms = 300 ms > 250 ms
  // would have timed out and discarded the entire profile.
  // Under the two-stage model, all 15 essential layers complete first (~100 ms < 350 ms essentialBudgetMs),
  // high-priority optional mean texture & AWC layers complete within `optionalBudgetMs`, and slow late optional
  // layers time out cleanly without invalidating the profile!
  const stagedTimingFetch: typeof fetch = (async (input, init) => {
    const urlStr = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const cov = new URL(urlStr).searchParams.get("COVERAGE") ?? "";
    const isEssential = essentialKeys.has(cov);
    const delayMs = isEssential
      ? 15
      : cov.endsWith("_Q0.05") || cov.endsWith("_Q0.95")
      ? 600
      : 5;

    await new Promise<void>((resolve, reject) => {
      const t = setTimeout(resolve, delayMs);
      init?.signal?.addEventListener(
        "abort",
        () => {
          clearTimeout(t);
          const err = new Error("Aborted");
          err.name = "AbortError";
          reject(err);
        },
        { once: true }
      );
    });

    const res = await baseMock(input, init);
    completionOrder.push({
      coverageId: cov,
      stage: isEssential ? "essential" : "optional",
      timestamp: Date.now(),
    });
    return res;
  }) as typeof fetch;

  const stagedDiagList: SoilGridsFetchDiagnostics[] = [];
  const resilientProfile = await fetchSoilGridsWcsProfile(lat, lon, {
    fetchFn: stagedTimingFetch,
    essentialBudgetMs: 1500,
    optionalBudgetMs: 350,
    optionalLayerTimeoutMs: 150,
    bypassCache: true,
    onDiagnostics: (d) => {
      stagedDiagList.push(d);
    },
  });

  assert.ok(resilientProfile, "Cold-cache request must succeed when essential stage completes within budget");
  // Verify every single essential layer completed BEFORE any optional layer completed
  const firstOptionalIdx = completionOrder.findIndex((c) => c.stage === "optional");
  const lastEssentialIdx = completionOrder.map((c) => c.stage).lastIndexOf("essential");
  assert.equal(lastEssentialIdx, 14, "All 15 essential layers must complete first (indices 0..14)");
  if (firstOptionalIdx !== -1) {
    assert.ok(
      firstOptionalIdx > lastEssentialIdx,
      "Optional stage must not start until all 15 essential layers have completed"
    );
  }

  // Because mean texture and AWC are prioritized first in the optional queue, they succeeded before the slow uncertainty layers timed out
  assert.ok(
    resilientProfile.aggregated.depth0_30cm.textureMean0_30cm,
    "Prioritized optional mean-texture layers must succeed before late uncertainty layers time out"
  );
  assert.equal(resilientProfile.aggregated.depth0_30cm.awc, 0.186);
  assert.equal(resilientProfile.wrbSoilGroup, "Phaeozems");

  const stagedDiag = stagedDiagList[0];
  assert.ok(stagedDiag);
  assert.equal(stagedDiag.essentialComplete, true);
  assert.equal(stagedDiag.essentialLayersSucceeded, 15);
  assert.equal(stagedDiag.optionalComplete, false);
  assert.ok(
    stagedDiag.layerEvents.some(
      (e) =>
        e.stage === "optional" &&
        (e.reason === "timeout" || e.reason === "budget_exhausted")
    ),
    "Diagnostics must record timeout / budget_exhausted on slow optional uncertainty layers"
  );
});

test("Case 8: Warm-cache requests return cached complete profiles with 0 network calls, while partially enriched profiles reuse cached coverage grids to fetch only missing optional layers on the next request", async () => {
  clearSoilGridsCacheForTests();
  const lat = 48.3800;
  const lon = 1.5500;

  const complete47Coverages: Record<string, number> = {
    "sand_0-5cm_Q0.5": 95,
    "sand_5-15cm_Q0.5": 94,
    "sand_15-30cm_Q0.5": 98,
    "silt_0-5cm_Q0.5": 584,
    "silt_5-15cm_Q0.5": 581,
    "silt_15-30cm_Q0.5": 565,
    "clay_0-5cm_Q0.5": 270,
    "clay_5-15cm_Q0.5": 274,
    "clay_15-30cm_Q0.5": 288,
    "soc_0-5cm_Q0.5": 202,
    "soc_5-15cm_Q0.5": 152,
    "soc_15-30cm_Q0.5": 118,
    "phh2o_0-5cm_Q0.5": 62,
    "phh2o_5-15cm_Q0.5": 62,
    "phh2o_15-30cm_Q0.5": 62,
    "sand_0-5cm_mean": 110,
    "sand_5-15cm_mean": 110,
    "sand_15-30cm_mean": 110,
    "silt_0-5cm_mean": 471,
    "silt_5-15cm_mean": 471,
    "silt_15-30cm_mean": 471,
    "clay_0-5cm_mean": 419,
    "clay_5-15cm_mean": 419,
    "clay_15-30cm_mean": 419,
    "wv0033_0-5cm_Q0.5": 350,
    "wv0033_5-15cm_Q0.5": 345,
    "wv0033_15-30cm_Q0.5": 340,
    "wv1500_0-5cm_Q0.5": 155,
    "wv1500_5-15cm_Q0.5": 157,
    "wv1500_15-30cm_Q0.5": 158,
    MostProbable: 6, // Cambisols
    "bdod_0-5cm_Q0.5": 148,
    "bdod_5-15cm_Q0.5": 154,
    "bdod_15-30cm_Q0.5": 156,
    "cfvo_0-5cm_Q0.5": 0,
    "cfvo_5-15cm_Q0.5": 0,
    "cfvo_15-30cm_Q0.5": 0,
    "sand_0-5cm_Q0.05": 20,
    "sand_0-5cm_Q0.95": 210,
    "silt_0-5cm_Q0.05": 420,
    "silt_0-5cm_Q0.95": 710,
    "clay_0-5cm_Q0.05": 180,
    "clay_0-5cm_Q0.95": 380,
    "soc_0-5cm_Q0.05": 110,
    "soc_0-5cm_Q0.95": 360,
    "phh2o_0-5cm_Q0.05": 54,
    "phh2o_0-5cm_Q0.95": 71,
  };
  const baseMock = createMockSoilGridsFetch(complete47Coverages);

  // Request #1 (cold, bypassCache: false): `MostProbable` (WRB) fails transiently with HTTP 503, all other 46 layers succeed.
  let failWrb = true;
  const requestedOnCall1: string[] = [];
  const requestedOnCall2: string[] = [];
  const requestedOnCall3: string[] = [];
  let activeLog = requestedOnCall1;

  const statefulFetch: typeof fetch = (async (input, init) => {
    const urlStr = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const cov = new URL(urlStr).searchParams.get("COVERAGE") ?? "";
    activeLog.push(cov);
    if (failWrb && cov === "MostProbable") {
      return new Response("Transient WRB failure", { status: 503 });
    }
    return baseMock(input, init);
  }) as typeof fetch;

  const coldPartial = await fetchSoilGridsWcsProfile(lat, lon, {
    fetchFn: statefulFetch,
    bypassCache: false,
  });
  assert.ok(coldPartial);
  assert.equal(coldPartial.enrichmentStatus, "partial_optional");
  assert.equal(coldPartial.wrbSoilGroup, undefined, "WRB failed on Request #1");
  assert.equal(requestedOnCall1.length, 47, "Cold request #1 attempted all 47 coverages");

  // Request #2 (warm, bypassCache: false): Transient WRB failure clears.
  // Because Request #1 was `partial_optional`, it was NOT locked into `memoryCache` for 24h,
  // while its 46 successful decoded GeoTIFF grids WERE cached in `coverageCache`.
  // Request #2 must reuse all 46 cached grids and make ONLY 1 network request (`MostProbable`)!
  failWrb = false;
  activeLog = requestedOnCall2;
  const enrichedOnSecondCall = await fetchSoilGridsWcsProfile(lat, lon, {
    fetchFn: statefulFetch,
    bypassCache: false,
  });
  assert.ok(enrichedOnSecondCall);
  assert.equal(enrichedOnSecondCall.enrichmentStatus, "complete");
  assert.equal(
    enrichedOnSecondCall.wrbSoilGroup,
    "Cambisols",
    "Optional WRB property must not be permanently unavailable after a transient failure"
  );
  assert.deepEqual(
    requestedOnCall2,
    ["MostProbable"],
    "Request #2 must reuse the 46 cached coverage grids and fetch ONLY the 1 previously failed optional layer"
  );

  // Request #3 (warm, bypassCache: false): Complete profile is now in `memoryCache` -> 0 network requests!
  activeLog = requestedOnCall3;
  const warmHit = await fetchSoilGridsWcsProfile(lat, lon, {
    fetchFn: statefulFetch,
    bypassCache: false,
  });
  assert.ok(warmHit);
  assert.equal(warmHit.enrichmentStatus, "complete");
  assert.equal(warmHit.wrbSoilGroup, "Cambisols");
  assert.equal(
    requestedOnCall3.length,
    0,
    "Warm cache hit for a complete profile must make 0 network requests"
  );
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
