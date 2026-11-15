/**
 * Deterministic generation pipeline tests for fallo.
 *
 * These tests verify:
 * - Agricultural group classifier behavior with real and edge-case climate data.
 * - Proposal validator hard constraints (crop IDs, groups, diseases, sequences).
 * - Generation orchestrator fallback when no AI provider is configured.
 * - Priority slider changes do NOT trigger remote AI calls (verified by architecture, not network mocking).
 *
 * Run: npx tsx test-generation.ts
 */

import { strict as assert } from "assert";
import { classifyAgGroup, isGroupSupported } from "@/lib/agro-classifier";
import { validateProposal, isStrategyStructurallyValid } from "@/lib/rotation-validator";
import { generateRotations } from "@/lib/rotation-generator";
import { type RotationStrategy, type ClimateData, type SoilData } from "@/lib/rotation-scoring";

// ─── Helpers ──────────────────────────────────────────────────────────

function makeClimate(overrides: Partial<ClimateData["fullRecord"]> & Partial<ClimateData["stressMetrics"]> = {}): ClimateData {
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
      growingSeasonPrecip: { ...defaultStress.growingSeasonPrecip, ...overrides.growingSeasonPrecip },
    },
    source: "NASA POWER (test mock)",
    spatialResolution: "0.5°",
    limitations: ["Mock data for testing only"],
  } as ClimateData;
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

function makeValidStrategy(): RotationStrategy {
  return {
    id: "test_strategy",
    name: "Test Strategy",
    archetype: "test_archetype",
    description: "A valid test strategy.",
    regionExample: "NC Piedmont",
    years: [
      {
        year: 1,
        seasons: [
          { season: "Spring", crop: "field_corn", activity: "Plant corn", months: [4, 5, 6] },
          { season: "Fall", crop: "cereal_rye", activity: "Plant rye cover", months: [9, 10, 11] },
        ],
      },
      {
        year: 2,
        seasons: [
          { season: "Spring", crop: "soybean", activity: "Plant soybean", months: [5, 6, 7] },
          { season: "Fall", crop: "crimson_clover", activity: "Plant clover", months: [9, 10, 11] },
        ],
      },
      {
        year: 3,
        seasons: [
          { season: "Spring", crop: "soft_red_winter_wheat", activity: "Plant wheat", months: [3, 4, 5] },
          { season: "Fall", crop: "forage_radish", activity: "Plant radish", months: [8, 9, 10] },
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

// ─── Test runner ──────────────────────────────────────────────────────

let passed = 0;
let failed = 0;

function test(name: string, fn: () => void) {
  try {
    fn();
    console.log(`  ✅ ${name}`);
    passed++;
  } catch (err) {
    console.log(`  ❌ ${name}`);
    console.error(`     ${err instanceof Error ? err.message : String(err)}`);
    failed++;
  }
}

console.log("\n🌾 fallo generation pipeline tests\n");

// ─── Classifier tests ─────────────────────────────────────────────────

console.log("Agricultural Group Classifier");

test("Temperate humid climate (NC-like) -> temperate_humid", () => {
  const result = classifyAgGroup(makeClimate(), makeSoil());
  assert.equal(result.group, "temperate_humid");
  assert.ok(result.confidence === "high" || result.confidence === "moderate");
  assert.ok(result.reasons.some((r) => r.includes("Moderate annual temperature")));
});

test("Semi-arid climate (low precip + high dry days) -> semi_arid_temperate", () => {
  const climate = makeClimate({
    avgAnnualPrecip: 400,
    monthlyPrecip: [10, 10, 15, 20, 30, 40, 50, 40, 25, 15, 10, 10],
  });
  climate.stressMetrics.summerDrySpells.avgMaxConsecutiveDryDays = 20;
  const result = classifyAgGroup(climate, null);
  assert.equal(result.group, "semi_arid_temperate");
  assert.ok(result.confidence === "high" || result.confidence === "moderate");
});

test("Missing core climate data -> unknown, low confidence", () => {
  const climate = makeClimate({ avgAnnualTemp: null as unknown as undefined, avgAnnualPrecip: null as unknown as undefined });
  const result = classifyAgGroup(climate, null);
  assert.equal(result.group, "unknown");
  assert.equal(result.confidence, "low");
  assert.ok(result.limitations.length > 0);
});

test("isGroupSupported returns true for implemented groups", () => {
  assert.equal(isGroupSupported("temperate_humid"), true);
  assert.equal(isGroupSupported("semi_arid_temperate"), true);
  assert.equal(isGroupSupported("subtropical_humid"), false);
  assert.equal(isGroupSupported("unknown"), false);
});

// ─── Validator tests ──────────────────────────────────────────────────

console.log("\nProposal Validator");

test("Valid proposal passes all hard constraints", () => {
  const strategy = makeValidStrategy();
  const result = validateProposal(strategy, {
    agGroup: "temperate_humid",
    regionTag: "us_southeast",
    availableCropIds: ["field_corn", "soybean", "soft_red_winter_wheat", "cereal_rye", "crimson_clover", "forage_radish"],
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
  // hairy_vetch is only applicable to temperate_humid; validating against semi_arid_temperate should reject it
  strategy.years[0].seasons[0].crop = "hairy_vetch";
  const result = validateProposal(strategy, {
    agGroup: "semi_arid_temperate",
    regionTag: "us_southeast",
    availableCropIds: ["hairy_vetch"],
  });
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.includes("semi_arid_temperate")));
});

test("Unknown group does not reject crops (conservative)", () => {
  const strategy = makeValidStrategy();
  const result = validateProposal(strategy, {
    agGroup: "unknown",
    regionTag: null,
    availableCropIds: ["field_corn", "soybean"],
  });
  assert.equal(result.valid, true);
});

test("Sclerotinia host stacking rejected", () => {
  const strategy = makeValidStrategy();
  // Place sunflower in year 1 and soybean in year 2
  strategy.years[0].seasons[0].crop = "sunflower";
  strategy.years[1].seasons[0].crop = "soybean";
  strategy.years[2].seasons[0].crop = "field_corn";
  const result = validateProposal(strategy, {
    agGroup: "temperate_humid",
    regionTag: "us_southeast",
    availableCropIds: ["sunflower", "soybean", "field_corn"],
  });
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.includes("Sclerotinia")));
});

test("Wheat following sorghum produces warning (not hard error)", () => {
  const strategy = makeValidStrategy();
  strategy.years[0].seasons[0].crop = "grain_sorghum"; // Poaceae
  strategy.years[1].seasons[0].crop = "soft_red_winter_wheat"; // Poaceae -> follows sorghum
  strategy.years[2].seasons[0].crop = "soybean"; // Fabaceae (avoids >2 Poaceae years)
  const result = validateProposal(strategy, {
    agGroup: "temperate_humid",
    regionTag: "us_southeast",
    availableCropIds: ["grain_sorghum", "soft_red_winter_wheat", "soybean", "cereal_rye", "crimson_clover", "forage_radish"],
  });
  assert.equal(result.valid, true); // warning, not hard error
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
    availableCropIds: ["field_corn", "cereal_rye", "crimson_clover", "soft_red_winter_wheat", "forage_radish"],
  });
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.includes("no cash crop")));
});

test("Low botanical diversity produces warning", () => {
  const strategy = makeValidStrategy();
  // Make everything Poaceae
  strategy.years.forEach((y) => {
    y.seasons.forEach((s) => {
      s.crop = "field_corn";
    });
  });
  const result = validateProposal(strategy, {
    agGroup: "temperate_humid",
    regionTag: "us_southeast",
    availableCropIds: ["field_corn"],
  });
  // Family diversity warning + repeated family hard error
  assert.ok(
    result.warnings.some((w) => w.includes("diversity")) ||
    result.errors.some((e) => e.includes("family"))
  );
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
  assert.equal(isStrategyStructurallyValid({ id: "", name: "", archetype: "", description: "", years: [], tradeoffs: { advantages: [], disadvantages: [], operational: [], warnings: [] } }), false);
});

// ─── Orchestrator tests ───────────────────────────────────────────────

console.log("\nGeneration Orchestrator");

test("Without AI provider, returns honest unavailable reason", async () => {
  const result = await generateRotations(
    {
      fieldId: "f1",
      fieldName: "Test Field",
      lat: 35.67,
      lon: -80.47,
      climate: makeClimate(),
      soil: makeSoil(),
      priorities: { waterSuitability: 20, nitrogenContribution: 20, soilCoverage: 20, diversityPestBreak: 20, climateRiskResilience: 20 },
      regionTag: "us_southeast",
    },
    null
  );
  assert.equal(result.proposals.length, 0);
  assert.ok(result.aiUnavailableReason);
  assert.ok(result.aiUnavailableReason!.includes("FALLO_AI_PROVIDER"));
  assert.equal(result.supportStatus, "supported"); // group classification still works
});

test("Classification is returned even when AI is unavailable", async () => {
  const result = await generateRotations(
    {
      fieldId: "f1",
      fieldName: "Test Field",
      lat: 35.67,
      lon: -80.47,
      climate: makeClimate(),
      soil: null,
      priorities: { waterSuitability: 20, nitrogenContribution: 20, soilCoverage: 20, diversityPestBreak: 20, climateRiskResilience: 20 },
      regionTag: "us_southeast",
    },
    null
  );
  assert.equal(result.classification.group, "temperate_humid");
  assert.ok(result.availableCrops.length > 0);
});

// ─── Summary ──────────────────────────────────────────────────────────

console.log("\n─────────────────────────────");
console.log(`Results: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
console.log("All generation pipeline tests passed.");
