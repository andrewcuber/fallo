/**
 * Deterministic unit test for the rotation scoring engine.
 * Uses Rowan County, NC-like mock data (35.67, -80.47).
 */

import {
  scoreAllStrategies,
  FarmerPriorities,
  DEFAULT_PRIORITIES,
} from "./lib/rotation-scoring";

const rowanClimate = {
  location: { lat: 35.67, lon: -80.47, elevation: 244 },
  fullRecord: {
    avgAnnualTemp: 15.8,
    avgAnnualPrecip: 1112,
    avgDailySolar: 15.4,
    monthlyTemp: [5.2, 6.8, 10.5, 15.2, 19.8, 24.1, 26.2, 25.5, 22.1, 16.3, 10.8, 6.5],
    monthlyPrecip: [88, 82, 102, 92, 98, 108, 110, 102, 95, 78, 82, 75],
    monthlySolar: [9.2, 11.8, 15.5, 18.9, 21.2, 22.8, 22.1, 20.5, 17.2, 13.1, 10.2, 8.5],
  },
  stressMetrics: {
    summerDrySpells: {
      avgMaxConsecutiveDryDays: 8.5,
      thresholdMm: 1.0,
      monthsDesc: "Jun–Aug",
    },
    summerHeatDays: {
      avgDaysAboveThreshold: 12.3,
      thresholdC: 35.0,
      monthsDesc: "Jul–Aug",
    },
    springPrecip: {
      avgTotalMm: 292,
      monthsDesc: "Mar–May",
    },
    growingSeasonPrecip: {
      avgTotalMm: 418,
      monthsDesc: "May–Aug",
    },
  },
  source: "NASA POWER Daily API (mock test data)",
  spatialResolution: "0.5° grid (~55 km). Regional context.",
  limitations: ["Mock data for testing only."],
};

const rowanSoil = {
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
  dataCoverage: {
    depth0_30cm: {
      sand: 92,
      silt: 92,
      clay: 92,
      om: 88,
      ph: 92,
      awc: 92,
    },
    drainage: 100,
    slope: 100,
  },
  totalComponentPercent: 95,
  source: "USDA SSURGO (mock test data)",
  limitations: ["Mock data for testing only."],
};

function test(label: string, fn: () => boolean) {
  try {
    const ok = fn();
    console.log(ok ? `  ✓ ${label}` : `  ✗ ${label}`);
    return ok;
  } catch (err) {
    console.log(`  ✗ ${label} — ${err instanceof Error ? err.message : String(err)}`);
    return false;
  }
}

let passed = 0;
let failed = 0;

function run(name: string, fn: () => boolean) {
  console.log(`\n${name}`);
  if (fn()) passed++; else failed++;
}

// Test 1: Default priorities return 3 strategies
run("Default priorities produce 3 ranked strategies", () => {
  const results = scoreAllStrategies(rowanClimate, rowanSoil, DEFAULT_PRIORITIES);
  return test("Length is 3", () => results.length === 3);
});

// Test 2: All strategies have overall scores
run("All strategies receive overall scores", () => {
  const results = scoreAllStrategies(rowanClimate, rowanSoil, DEFAULT_PRIORITIES);
  return test("All overall scores are numbers", () =>
    results.every((r) => r.overallScore !== null && typeof r.overallScore === "number")
  );
});

// Test 3: Scores are in valid range
run("All factor scores are within 0–100", () => {
  const results = scoreAllStrategies(rowanClimate, rowanSoil, DEFAULT_PRIORITIES);
  return test("Factor scores in range", () =>
    results.every((r) =>
      Object.values(r.factorScores).every(
        (fs) => fs.score === null || (fs.score >= 0 && fs.score <= 100)
      )
    )
  );
});

// Test 4: Water conservation strategy has advantage in water suitability
run("Water resilience strategy scores well for water suitability", () => {
  const results = scoreAllStrategies(rowanClimate, rowanSoil, DEFAULT_PRIORITIES);
  const waterStrat = results.find((r) => r.strategy.id === "water_resilience");
  const convStrat = results.find((r) => r.strategy.id === "soil_health_building");
  return test("Water strategy exists", () => !!waterStrat) &&
    test("Water score >= 40", () => (waterStrat?.factorScores.waterSuitability.score ?? 0) >= 40) &&
    test("Water strategy beats or ties soil_health on water", () =>
      (waterStrat?.factorScores.waterSuitability.score ?? 0) >= (convStrat?.factorScores.waterSuitability.score ?? 999)
    );
});

// Test 5: Soil health strategy scores well for nitrogen
run("Soil health strategy scores well for nitrogen", () => {
  const results = scoreAllStrategies(rowanClimate, rowanSoil, DEFAULT_PRIORITIES);
  const soilStrat = results.find((r) => r.strategy.id === "soil_health_building");
  return test("Soil health strategy exists", () => !!soilStrat) &&
    test("Nitrogen score >= 50", () => (soilStrat?.factorScores.nitrogenContribution.score ?? 0) >= 50);
});

// Test 6: Strategy with Fusarium warning has lower diversity score
run("Water resilience strategy is flagged for Fusarium risk", () => {
  const results = scoreAllStrategies(rowanClimate, rowanSoil, DEFAULT_PRIORITIES);
  const waterStrat = results.find((r) => r.strategy.id === "water_resilience");
  const warnings = waterStrat?.strategy.tradeoffs.warnings ?? [];
  const hasFusarium = warnings.some((w: any) =>
    typeof w === "object" && w.text && (w.text as string).toLowerCase().includes("fusarium")
  );
  return test("Has Fusarium warning in tradeoffs", () => hasFusarium);
});

// Test 7: Changing priorities changes rankings (or verify the top strategy wins on its priority)
run("Priority adjustment changes scores", () => {
  const resultsDefault = scoreAllStrategies(rowanClimate, rowanSoil, DEFAULT_PRIORITIES);
  const waterHeavy: FarmerPriorities = {
    waterSuitability: 80,
    nitrogenContribution: 5,
    soilCoverage: 5,
    diversityPestBreak: 5,
    climateRiskResilience: 5,
  };
  const resultsWater = scoreAllStrategies(rowanClimate, rowanSoil, waterHeavy);
  const waterStratDefault = resultsDefault.find((r) => r.strategy.id === "water_resilience");
  const waterStratHeavy = resultsWater.find((r) => r.strategy.id === "water_resilience");
  return test("Water strategy score changes with water-heavy priorities", () =>
    (waterStratDefault?.overallScore ?? 0) !== (waterStratHeavy?.overallScore ?? 0)
  );
});

// Test 8: Missing soil data still produces scores (graceful degradation)
run("Missing soil data produces lower-coverage scores", () => {
  const results = scoreAllStrategies(rowanClimate, null, DEFAULT_PRIORITIES);
  return test("Still produces 3 results", () => results.length === 3) &&
    test("At least one Partial or Limited coverage", () =>
      results.some((r) => r.overallCoverage !== "Good" ||
        Object.values(r.factorScores).some((fs) => fs.coverage !== "Good")
      )
    );
});

// Test 9: Strategy details contain all required factor scores
run("All factor scores include interpretive metadata", () => {
  const results = scoreAllStrategies(rowanClimate, rowanSoil, DEFAULT_PRIORITIES);
  return test("Every factor has interpretation string", () =>
    results.every((r) =>
      Object.values(r.factorScores).every(
        (fs) => typeof fs.interpretation === "string" && fs.interpretation.length > 0
      )
    )
  ) && test("Every factor has rubric string", () =>
    results.every((r) =>
      Object.values(r.factorScores).every(
        (fs) => typeof fs.rubric === "string" && fs.rubric.length > 0
      )
    )
  );
});

console.log(`\n${"=".repeat(50)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);
if (failed === 0) {
  console.log("All rotation scoring tests passed ✓");
  process.exit(0);
} else {
  console.log("Some tests failed ✗");
  process.exit(1);
}
