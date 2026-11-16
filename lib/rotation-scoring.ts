/**
 * Pure, testable rotation scoring engine for fallo.
 *
 * Design principles:
 * - No side effects; all functions are pure.
 * - Missing data = explicit nulls, never treated as zero silently.
 * - All scores are heuristics (0–100) with transparent rubrics and citations.
 * - Confidence levels reflect data coverage.
 */

import cropsData from "@/data/crops.json";
import rotationsData from "@/data/rotations.json";

// ─── Types ────────────────────────────────────────────────────────────

export type CropEvidenceLevel =
  | "level_1_strong_local"
  | "level_2_global_modeled"
  | "level_3_insufficient";

export const DEFAULT_AI_TIMEOUT_MS = 120_000;

export interface Crop {
  id: string;
  commonName: string;
  synonyms?: string[];
  scientificName: string;
  family: string;
  type: "cash" | "cover";
  waterDemand: string;
  droughtTolerance: string;
  irrigationRegime?: "rainfed" | "irrigated_or_rainfed" | "irrigated_primary";
  evidenceLevel?: CropEvidenceLevel;
  nitrogenBehavior: {
    demand: string;
    demandCategory: string;
    residualNcredit?: { value: string; note: string; source: string } | null;
    immobilizationRisk?: string | null;
    note?: string | null;
  };
  residue: {
    quantity: string;
    persistence: string;
    description: string;
  };
  rootSystem: string;
  sensitivePeriods?: Record<string, { months: number[]; note: string; source: string }> | null;
  growingWindow: { planting?: string | null; harvest?: string | null; termination?: string | null; description: string };
  diseasePestNotes: string[];
  sources: { citation: string; url: string }[];
  supportedRegions: string[];
  /** Agricultural groups this crop is documented for (derived from supportedRegions + sources) */
  applicableGroups?: string[];
}

export interface RotationSeason {
  season: string;
  crop: string;
  activity: string;
  months: number[];
}

export interface RotationYear {
  year: number;
  seasons: RotationSeason[];
}

export interface AIUsageMetadata {
  promptTokenCount?: number;
  candidatesTokenCount?: number;
  thoughtsTokenCount?: number;
  totalTokenCount?: number;
  estimatedCostUsd?: number | null;
}

export interface GenerationInfo {
  source: "ai-assisted" | "static-archetype";
  generatedAt?: string;
  agGroup?: string;
  supportStatus?: "supported" | "limited-evidence" | "unavailable";
  validationStatus?: "passed" | "failed";
  validationErrors?: string[];
  validationWarnings?: string[];
  rationale?: string;
  aiProvider?: string;
  aiModel?: string;
  fieldId?: string;
  usageMetadata?: AIUsageMetadata;
}

export interface RotationStrategy {
  id: string;
  name: string;
  archetype: string;
  description: string;
  regionExample?: string;
  years: RotationYear[];
  tradeoffs: {
    advantages: string[];
    disadvantages: string[];
    operational: string[];
    warnings: (string | { severity: string; text: string })[];
  };
  /** Set when this strategy was generated (AI) or loaded statically */
  generationInfo?: GenerationInfo;
}

export interface HistoricalYearClimateRecord {
  year: number;
  avgTemp: number | null;
  totalPrecip: number | null;
  avgSolar: number | null;
  monthlyTemp: (number | null)[];
  monthlyPrecip: (number | null)[];
  monthlySolar: (number | null)[];
  springPrecipMm: number | null;
  growingSeasonPrecipMm: number | null;
  summerDrySpellDays: number | null;
  summerHeatDays: number | null;
  daysWithData: number;
}

export interface ClimatePeriodSummary {
  avgAnnualTemp: number | null;
  avgAnnualPrecip: number | null;
  avgDailySolar: number | null;
  monthlyTemp: (number | null)[];
  monthlyPrecip: (number | null)[];
  monthlySolar: (number | null)[];
  annualPrecipTotals?: { year: number; total: number | null }[];
  precipCV?: number | null;
}

export interface ClimateData {
  location: { lat: number; lon: number; elevation: number | null };
  periods?: {
    startYear: number;
    endYear: number;
    recentStart: number;
    recentEnd: number;
    baselineStart: number;
    baselineEnd: number;
  };
  fullRecord: ClimatePeriodSummary;
  baseline?: ClimatePeriodSummary;
  recent?: ClimatePeriodSummary;
  stressMetrics: {
    summerDrySpells: { avgMaxConsecutiveDryDays: number | null; thresholdMm: number; monthsDesc: string };
    summerHeatDays: { avgDaysAboveThreshold: number | null; thresholdC: number; monthsDesc: string };
    springPrecip: { avgTotalMm: number | null; monthsDesc: string };
    growingSeasonPrecip: { avgTotalMm: number | null; monthsDesc: string };
  };
  historicalYears?: HistoricalYearClimateRecord[];
  source: string;
  spatialResolution: string;
  limitations: string[];
}

export interface SoilData {
  aggregated: {
    depth0_30cm: { sand: number | null; silt: number | null; clay: number | null; om: number | null; ph: number | null; awc: number | null };
    drainage: string | null;
    slope: number | null;
  };
  dataCoverage: {
    depth0_30cm: { sand: number | null; silt: number | null; clay: number | null; om: number | null; ph: number | null; awc: number | null };
    drainage: number | null;
    slope: number | null;
  };
  totalComponentPercent: number;
  source: string;
  limitations: string[];
}

export type FactorKey = "waterSuitability" | "nitrogenContribution" | "soilCoverage" | "diversityPestBreak" | "climateRiskResilience";

export interface Citation {
  text: string;
  url?: string;
}

export interface FactorScore {
  score: number | null; // 0–100
  interpretation: string;
  inputsUsed: string[];
  rubric: string;
  positiveContributors: string[];
  negativeContributors: string[];
  dataCoverageLimitations: string[];
  coverage: "Good" | "Partial" | "Limited";
  citations: Citation[];
}

export interface StrategyResult {
  strategy: RotationStrategy;
  factorScores: Record<FactorKey, FactorScore>;
  overallScore: number | null;
  overallCoverage: "Good" | "Partial" | "Limited";
  overallFitLabel: "Strong fit" | "Moderate fit" | "Weak fit" | "Unavailable";
  rank: number;
  availableWeightPercent: number; // % of total priority weight actually used
}

export interface FarmerPriorities {
  waterSuitability: number;
  nitrogenContribution: number;
  soilCoverage: number;
  diversityPestBreak: number;
  climateRiskResilience: number;
}

export const DEFAULT_PRIORITIES: FarmerPriorities = {
  waterSuitability: 20,
  nitrogenContribution: 20,
  soilCoverage: 20,
  diversityPestBreak: 20,
  climateRiskResilience: 20,
};

export const FACTOR_LABELS: Record<FactorKey, string> = {
  waterSuitability: "Water Suitability",
  nitrogenContribution: "Nitrogen Contribution",
  soilCoverage: "Soil Coverage",
  diversityPestBreak: "Diversity / Pest Break",
  climateRiskResilience: "Climate Risk Resilience",
};

// ─── Data accessors ───────────────────────────────────────────────────

const cropLibrary: Record<string, Crop> = Object.fromEntries(
  (cropsData as { crops: Crop[] }).crops.map((c) => [c.id, c])
);

const strategies: RotationStrategy[] = (rotationsData as { strategies: RotationStrategy[] }).strategies;

export { strategies, cropLibrary };

function getCrop(id: string): Crop | undefined {
  return cropLibrary[id];
}

// ─── Utility ──────────────────────────────────────────────────────────

function clamp(n: number, min = 0, max = 100): number {
  return Math.max(min, Math.min(max, n));
}

function avg(arr: number[]): number {
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}

function uniqueFamilies(cropIds: string[]): string[] {
  return Array.from(
    new Set(
      cropIds
        .map((id) => getCrop(id)?.family)
        .filter((f): f is string => typeof f === "string")
    )
  );
}

// ─── Field condition helpers ──────────────────────────────────────────

function gsPrecipMm(climate: ClimateData): number | null {
  return climate.stressMetrics.growingSeasonPrecip.avgTotalMm;
}

function avgMaxDryDays(climate: ClimateData): number | null {
  return climate.stressMetrics.summerDrySpells.avgMaxConsecutiveDryDays;
}

function avgHeatDays(climate: ClimateData): number | null {
  return climate.stressMetrics.summerHeatDays.avgDaysAboveThreshold;
}

function awcValue(soil: SoilData | null): number | null {
  return soil?.aggregated.depth0_30cm.awc ?? null;
}

function slopeValue(soil: SoilData | null): number | null {
  return soil?.aggregated.slope ?? null;
}

function soilCoverage(soil: SoilData | null): { hasData: boolean; coveragePercent: number | null } {
  if (!soil) return { hasData: false, coveragePercent: null };
  const awcCov = soil.dataCoverage.depth0_30cm.awc;
  const slopeCov = soil.dataCoverage.slope;
  const total = soil.totalComponentPercent;
  const coverage = awcCov !== null ? awcCov : slopeCov;
  return { hasData: true, coveragePercent: coverage };
}

// ─── 1. Water Suitability ─────────────────────────────────────────────

function scoreWaterSuitability(strategy: RotationStrategy, climate: ClimateData, soil: SoilData | null): FactorScore {
  const gsPrecip = gsPrecipMm(climate);
  const dryDays = avgMaxDryDays(climate);
  const heatDays = avgHeatDays(climate);
  const awc = awcValue(soil);
  const { hasData: hasSoil, coveragePercent: soilCov } = soilCoverage(soil);

  const cashCrops = strategy.years
    .flatMap((y) => y.seasons)
    .filter((s) => s.crop !== "winter_fallow")
    .map((s) => getCrop(s.crop))
    .filter((c): c is Crop => !!c && c.type === "cash");

  if (cashCrops.length === 0) {
    return {
      score: null,
      interpretation: "No cash crops found in this rotation.",
      inputsUsed: [],
      rubric: "Requires at least one defined cash crop for water-demand comparison.",
      positiveContributors: [],
      negativeContributors: [],
      dataCoverageLimitations: ["Rotation contains no recognized cash crops."],
      coverage: "Limited",
      citations: [],
    };
  }

  const inputsUsed: string[] = [];
  const positive: string[] = [];
  const negative: string[] = [];
  const limitations: string[] = [];
  const citations: Citation[] = [{ text: "NASA POWER Daily API — regional climate context" }];

  if (gsPrecip !== null) inputsUsed.push(`Growing-season (May–Aug) precipitation: ${gsPrecip.toFixed(0)} mm`);
  else limitations.push("Growing-season precipitation data unavailable.");

  if (dryDays !== null) inputsUsed.push(`Avg max consecutive dry days (Jun–Aug, <1 mm): ${dryDays.toFixed(1)} days`);
  else limitations.push("Dry-spell data unavailable.");

  if (heatDays !== null) inputsUsed.push(`Avg heat-stress days (Jul–Aug, max temp >35 °C): ${heatDays.toFixed(1)} days`);
  else limitations.push("Heat-stress day count unavailable.");

  if (hasSoil) {
    const isSsurgo = soil?.source?.toUpperCase().includes("SSURGO") ?? false;
    if (awc !== null) inputsUsed.push(`Available water capacity (0–30 cm): ${awc.toFixed(3)} cm/cm`);
    else limitations.push("AWC data unavailable (0–30 cm only).");
    if (isSsurgo) {
      if (soilCov !== null && soilCov < 80) {
        limitations.push(`Soil data coverage is ${soilCov.toFixed(0)}%; properties may not represent the full field.`);
      }
      citations.push({ text: "USDA NRCS SSURGO — depth-weighted 0–30 cm averages", url: "https://sdmdataaccess.sc.egov.usda.gov" });
    } else {
      limitations.push("Soil properties use a macro-regional topsoil reference estimate rather than a field-specific soil survey.");
      citations.push({
        text: "FAO/IIASA HWSD v2.2 & ISRIC SoilGrids v2.0 — regional topsoil reference estimates",
        url: "https://www.fao.org/agroinformatics/training-and-resources/data-sets/en",
      });
    }
  } else {
    limitations.push("No soil data available; AWC and slope not included in scoring.");
  }

  // Compute per-crop scores
  const cropScores: number[] = [];

  for (const crop of cashCrops) {
    let s = 55;

    // Field water availability
    if (gsPrecip !== null) {
      if (gsPrecip > 550) s += 15;
      else if (gsPrecip > 450) s += 10;
      else if (gsPrecip > 350) s += 5;
      else if (gsPrecip > 250) s -= 5;
      else s -= 15;
    }

    // Dry spell penalty
    if (dryDays !== null) {
      if (dryDays > 18) s -= 15;
      else if (dryDays > 12) s -= 10;
      else if (dryDays > 8) s -= 5;
      else s += 5;
    }

    // Heat stress during sensitive periods
    if (heatDays !== null && crop.sensitivePeriods) {
      const hasSummerSensitivity = Object.values(crop.sensitivePeriods).some((sp) =>
        sp.months.some((m) => m >= 6 && m <= 8)
      );
      if (hasSummerSensitivity) {
        if (heatDays > 12) s -= 15;
        else if (heatDays > 7) s -= 10;
        else if (heatDays > 3) s -= 5;
        else s += 5;
      }
    }

    // Crop drought tolerance
    if (crop.droughtTolerance === "high") {
      if (dryDays !== null && dryDays > 12) s += 10;
      else s += 5;
    } else if (crop.droughtTolerance === "moderate") {
      if (dryDays !== null && dryDays > 12) s -= 5;
    } else if (crop.droughtTolerance === "low") {
      if (dryDays !== null && dryDays > 8) s -= 5;
    }

    // Water demand
    if (crop.waterDemand === "high") {
      if (gsPrecip !== null && gsPrecip < 400) s -= 10;
    } else if (crop.waterDemand === "low" || crop.waterDemand === "low_to_moderate") {
      if (gsPrecip !== null && gsPrecip < 400) s += 5;
    }

    // AWC modifier
    if (awc !== null) {
      if (awc > 0.16) s += 8;
      else if (awc > 0.12) s += 4;
      else if (awc > 0.08) s += 0;
      else s -= 6;
    }

    cropScores.push(clamp(s));
  }

  const finalScore = Math.round(avg(cropScores));

  // Build contributors
  if (gsPrecip !== null && gsPrecip > 450) positive.push("Growing-season precipitation is relatively abundant.");
  if (gsPrecip !== null && gsPrecip < 350) negative.push("Growing-season precipitation is limited.");
  if (dryDays !== null && dryDays > 12) negative.push("Extended dry spells occur during the summer growing season.");
  if (dryDays !== null && dryDays <= 8) positive.push("Dry spells are typically short in this region.");
  if (heatDays !== null && heatDays > 7) negative.push("Frequent heat-stress days during summer sensitive periods.");
  if (heatDays !== null && heatDays <= 3) positive.push("Low frequency of extreme heat days.");
  if (awc !== null && awc > 0.14) positive.push("Soil available water capacity supports summer crops.");
  if (awc !== null && awc < 0.10) negative.push("Low soil available water capacity intensifies drought risk.");

  cashCrops.forEach((c) => {
    if (c.droughtTolerance === "high") positive.push(`${c.commonName} has high drought tolerance.`);
    if (c.waterDemand === "high") negative.push(`${c.commonName} has high water demand during peak summer.`);
  });

  const conf = limitations.length === 0 ? "Good" : limitations.length <= 2 ? "Partial" : "Limited";

  return {
    score: finalScore,
    interpretation:
      conf === "Limited"
        ? `Water suitability estimated at ${finalScore}/100 with limited data. See coverage notes.`
        : `This rotation scores ${finalScore}/100 for water suitability based on growing-season precipitation${dryDays !== null ? `, dry-spell frequency` : ""}${heatDays !== null ? `, and heat-stress exposure` : ""}.`,
    inputsUsed,
    rubric:
      "Each cash crop is scored against growing-season precipitation, average maximum consecutive dry days, heat-stress day frequency, soil AWC, crop water demand, and crop drought tolerance. The rotation score is the average across cash crops. Scores are heuristics, not calibrated water-balance models.",
    positiveContributors: positive,
    negativeContributors: negative,
    dataCoverageLimitations: limitations,
    coverage: conf,
    citations,
  };
}

// ─── 2. Nitrogen Contribution ─────────────────────────────────────────

function scoreNitrogen(strategy: RotationStrategy, _climate: ClimateData, soil: SoilData | null): FactorScore {
  const { hasData: hasSoil } = soilCoverage(soil);
  const allSeasons = strategy.years.flatMap((y) => y.seasons);
  const crops = allSeasons.map((s) => getCrop(s.crop)).filter((c): c is Crop => !!c);

  const inputsUsed: string[] = [];
  const positive: string[] = [];
  const negative: string[] = [];
  const limitations: string[] = [];
  const citations: Citation[] = [];

  let score = 50;

  // Legume N credits (cover crops and cash)
  let legumeCount = 0;
  for (const crop of crops) {
    if (crop.family === "Fabaceae") {
      legumeCount++;
      const credit = crop.nitrogenBehavior.residualNcredit;
      if (credit) {
        inputsUsed.push(`${crop.commonName}: estimated ${credit.value}`);
        const sourceEntry = crop.sources.find((s) => s.citation === credit.source);
        citations.push({ text: `${credit.source}: ${credit.value}`, url: sourceEntry?.url });
        if (crop.id === "crimson_clover") {
          score += 12;
          positive.push(
            `Crimson clover has a conditional ~60–75 lb N/acre upper-range potential for a subsequent crop after termination (actual available N depends on establishment, stand vigor, biomass, termination, and mineralization).`
          );
        } else if (crop.id === "hairy_vetch") {
          score += 15;
          positive.push(
            `Hairy vetch has a conditional ~80–100 lb N/acre upper-range potential for a subsequent crop after termination (not a guaranteed contribution; actual available N depends on establishment, stand vigor, biomass, termination, and subsequent mineralization).`
          );
        } else if (crop.id === "soybean") {
          score += 5;
          positive.push(
            `Soybean leaves a modest residual N credit (~15–30 lb N/acre, contextual estimate) but most fixed N is removed with grain.`
          );
        } else {
          score += 6;
          positive.push(`${crop.commonName} contributes nitrogen via biological fixation.`);
        }
      }
    }
  }

  // Check concurrent legume cover-crop overlap vs. post-termination subsequent-crop N availability,
  // and conditional malting barley excess-N / grain protein quality risk
  for (let yIdx = 0; yIdx < strategy.years.length; yIdx++) {
    const yr = strategy.years[yIdx];
    const prevYr = yIdx > 0 ? strategy.years[yIdx - 1] : null;
    const cashSeasons = yr.seasons.filter((s) => getCrop(s.crop)?.type === "cash");
    const legumeCovers = yr.seasons.filter((s) => {
      const c = getCrop(s.crop);
      return c?.type === "cover" && c.family === "Fabaceae";
    });

    for (const legSea of legumeCovers) {
      const legCrop = getCrop(legSea.crop);
      if (!legCrop) continue;
      for (const cashSea of cashSeasons) {
        const cashCrop = getCrop(cashSea.crop);
        if (!cashCrop) continue;
        const shared = cashSea.months.filter((m) => legSea.months.includes(m));
        const coverTermMonth = legSea.months[legSea.months.length - 1];
        const cashInterior =
          cashSea.months.length > 2 ? cashSea.months.slice(1, -1) : [];
        if (
          shared.length >= 2 &&
          (shared.includes(cashSea.months[0]) ||
            cashInterior.includes(coverTermMonth))
        ) {
          const creditDeduction =
            legCrop.id === "hairy_vetch"
              ? 15
              : legCrop.id === "crimson_clover"
                ? 12
                : 6;
          score -= creditDeduction;
          negative.push(
            `Year ${yr.year}: ${legCrop.commonName}'s residual N credit (${legCrop.nitrogenBehavior.residualNcredit?.value ?? "80–100 lb N/acre"}) is a post-termination credit mineralized for a subsequent crop—it is NOT assigned or available to concurrently growing ${cashCrop.commonName} during their ${shared.length}-month overlap, when living ${legCrop.commonName} competes with the cash crop.`
          );
        }
      }
    }

    const barleySeason = yr.seasons.find(
      (s) => s.crop === "spring_barley" || s.crop === "winter_barley"
    );
    if (barleySeason) {
      const barleyCrop = getCrop(barleySeason.crop);
      const highNLegume =
        yr.seasons.find(
          (s) => s.crop === "hairy_vetch" || s.crop === "alfalfa_annual_forage"
        ) ??
        prevYr?.seasons.find(
          (s) => s.crop === "hairy_vetch" || s.crop === "alfalfa_annual_forage"
        );
      if (barleyCrop && highNLegume) {
        const legCrop = getCrop(highNLegume.crop);
        negative.push(
          `Year ${yr.year}: ${barleyCrop.commonName} is paired with or follows ${legCrop?.commonName ?? "Hairy Vetch"}. If grown for malting, acceptable grain protein specifications depend on the maltster, buyer, barley class, and contract, and excess or late-mineralizing legume nitrogen increases the risk of exceeding buyer specifications and lodging.`
        );
      }
    }
  }

  if (legumeCount === 0) {
    negative.push("No legume crops or cover crops in this rotation to contribute nitrogen.");
  }

  // High N demand penalties
  for (const crop of crops) {
    if (crop.type === "cash" && crop.nitrogenBehavior.demand === "high") {
      score -= 10;
      negative.push(`${crop.commonName} has high nitrogen demand, requiring external N inputs.`);
    } else if (crop.type === "cash" && crop.nitrogenBehavior.demand === "moderate") {
      score -= 5;
      negative.push(`${crop.commonName} has moderate nitrogen demand.`);
    }
  }

  // Cereal rye immobilization risk
  const hasRye = crops.some((c) => c.id === "cereal_rye");
  if (hasRye) {
    const ryeCrop = getCrop("cereal_rye");
    if (ryeCrop?.nitrogenBehavior.immobilizationRisk) {
      score -= 8;
      negative.push("Cereal rye can temporarily immobilize available nitrogen if terminated late (high C:N ratio).");
      citations.push({ text: "NC State Extension Organic Grains — Cover Crops", url: "https://content.ces.ncsu.edu/organic-grains" });
    }
  }

  // Residue persistence (organic matter return)
  const highResidueCrops = crops.filter((c) => c.residue.quantity === "high" && c.residue.persistence === "high");
  if (highResidueCrops.length >= 2) {
    score += 6;
    positive.push("High levels of persistent residue help maintain soil organic matter and nutrient pools.");
  }

  if (!hasSoil) {
    limitations.push("No soil organic matter data available for N-mineralization context.");
  }

  score = clamp(score);

  const conf = limitations.length > 1 ? "Partial" : "Good";

  return {
    score,
    interpretation:
      conf === "Partial"
        ? `Nitrogen balance estimated at ${score}/100. Legume contributions and N demands are scored directionally.`
        : `Nitrogen contribution score: ${score}/100. Accounts for legume credits, crop N demands, and immobilization risks.`,
    inputsUsed,
    rubric:
      "Legume cover crops add directional N credit based on published estimates (crimson clover ~60–75 lb N/acre, hairy vetch ~80–100 lb N/acre, soybean ~15–30 lb N/acre). High-N-demand cash crops subtract points. Cereal rye late-termination immobilization risk subtracts points. Persistent residue adds modest points. Scores are planning heuristics, not guaranteed fertilizer savings.",
    positiveContributors: positive,
    negativeContributors: negative,
    dataCoverageLimitations: limitations,
    coverage: conf,
    citations: citations.length > 0 ? citations : [{ text: "NC State Extension Cover Crop and Soybean Production Guides", url: "https://content.ces.ncsu.edu/" }],
  };
}

// ─── 3. Soil Coverage ─────────────────────────────────────────────────

function scoreSoilCoverage(strategy: RotationStrategy, _climate: ClimateData, soil: SoilData | null): FactorScore {
  const allSeasons = strategy.years.flatMap((y) => y.seasons);
  const crops = allSeasons.map((s) => getCrop(s.crop)).filter((c): c is Crop => !!c);

  const inputsUsed: string[] = [];
  const positive: string[] = [];
  const negative: string[] = [];
  const limitations: string[] = [];

  let livingCoverMonths = 0;
  const coveredMonths = new Set<number>();

  for (const season of allSeasons) {
    for (const m of season.months) {
      const monthIndex = (m - 1) % 12;
      if (!coveredMonths.has(monthIndex)) {
        coveredMonths.add(monthIndex);
        if (season.crop !== "winter_fallow") livingCoverMonths++;
      }
    }
  }

  // Count unique months covered (approximate, could overlap across years)
  // Better: count total month slots across the 3-year period
  const totalSlots = 36; // 3 years × 12 months
  const activeSlots = allSeasons.reduce((sum, s) => sum + s.months.length, 0);
  // Adjust for overlaps within same month across years
  const monthYearSlots = new Set(allSeasons.flatMap((s) => s.months.map((m) => `${s.season}-${m}`))).size;

  let score = 40;

  // Living cover percentage
  const coverRatio = Math.min(activeSlots / totalSlots, 1);
  if (coverRatio > 0.85) score += 20;
  else if (coverRatio > 0.7) score += 15;
  else if (coverRatio > 0.55) score += 10;
  else if (coverRatio > 0.4) score += 5;
  else score -= 5;

  inputsUsed.push(`Approximate living cover ratio: ${Math.round(coverRatio * 100)}% of the 3-year period`);

  // Residue persistence
  const highPersistCrops = crops.filter((c) => c.residue.persistence === "high");
  if (highPersistCrops.length >= 2) {
    score += 10;
    positive.push("Multiple crops with high-persistence residue maintain soil coverage between growing seasons.");
  } else if (highPersistCrops.length === 1) {
    score += 5;
    positive.push("One high-persistence residue crop (e.g., cereal rye) helps maintain surface cover.");
  }

  const lowResidueCrops = crops.filter((c) => c.residue.quantity === "low" && c.type === "cash");
  if (lowResidueCrops.length >= 2) {
    score -= 8;
    negative.push("Multiple low-residue cash crops leave the soil surface more exposed post-harvest.");
  }

  // Slope/erosion consideration
  const slope = slopeValue(soil);
  if (slope !== null) {
    inputsUsed.push(`Slope: ${slope.toFixed(1)}%`);
    if (slope > 8) {
      // High slope makes soil coverage more important
      if (coverRatio < 0.6) {
        score -= 10;
        negative.push(`Slope is ${slope.toFixed(0)}% — limited living cover increases erosion risk.`);
      } else {
        score += 5;
        positive.push(`Good soil coverage despite ${slope.toFixed(0)}% slope reduces erosion potential.`);
      }
    }
  } else {
    limitations.push("Slope data unavailable; erosion risk not included in coverage scoring.");
  }

  // Winter coverage gaps
  const winterMonths = [12, 1, 2];
  const hasWinterCover = allSeasons.some(
    (s) => s.crop !== "winter_fallow" && s.months.some((m) => winterMonths.includes(m))
  );
  if (!hasWinterCover) {
    score -= 8;
    negative.push("No living winter cover; winter fallow period exposes soil to erosion and compaction.");
  } else {
    score += 5;
    positive.push("Living winter cover protects soil during vulnerable winter/spring transition.");
  }

  score = clamp(score);

  const conf = slope === null ? "Partial" : "Good";

  return {
    score,
    interpretation: `Soil coverage score: ${score}/100 based on months of living cover, residue persistence, and slope considerations.`,
    inputsUsed,
    rubric:
      "Soil coverage is scored from the proportion of the 3-year rotation with living plants or persistent residue, winter-cover presence, residue persistence categories, and slope (if available). Higher scores mean more months with physical soil protection.",
    positiveContributors: positive,
    negativeContributors: negative,
    dataCoverageLimitations: limitations,
    coverage: conf,
    citations: [{ text: "USDA NRCS Cover Crop and Soil Health guidance", url: "https://www.nrcs.usda.gov/programs-initiatives/cover-crops" }],
  };
}

// ─── 4. Diversity / Pest Break ────────────────────────────────────────

function scoreDiversityPestBreak(strategy: RotationStrategy): FactorScore {
  const allSeasons = strategy.years.flatMap((y) => y.seasons);
  const cropIds = allSeasons.map((s) => s.crop).filter((id) => id !== "winter_fallow");
  const crops = cropIds.map((id) => getCrop(id)).filter((c): c is Crop => !!c);

  const inputsUsed: string[] = [];
  const positive: string[] = [];
  const negative: string[] = [];
  const limitations: string[] = [];

  if (crops.length === 0) {
    return {
      score: null,
      interpretation: "No recognized crops in rotation.",
      inputsUsed: [],
      rubric: "Requires defined crops to evaluate diversity.",
      positiveContributors: [],
      negativeContributors: [],
      dataCoverageLimitations: ["Rotation contains no recognized crops."],
      coverage: "Limited",
      citations: [],
    };
  }

  const families = uniqueFamilies(cropIds);
  inputsUsed.push(`Botanical families present: ${families.join(", ")}`);
  inputsUsed.push(`Cash and cover crops: ${crops.map((c) => c.commonName).join(", ")}`);

  let score = 40;

  // Family diversity
  if (families.length >= 4) {
    score += 20;
    positive.push("High botanical diversity (4+ families) supports broader pest and disease suppression.");
  } else if (families.length === 3) {
    score += 15;
    positive.push("Good botanical diversity (3 families).");
  } else if (families.length === 2) {
    score += 8;
    positive.push("Moderate diversity (2 families).");
  } else {
    score += 0;
    negative.push("Low botanical diversity (1 family) limits pest-break effectiveness.");
  }

  // Specific disease/pest sequence checks
  // Check for soybean followed by soybean or sunflower by soybean (Sclerotinia)
  const sequence = allSeasons.filter((s) => s.crop !== "winter_fallow").map((s) => s.crop);

  // Fusarium head blight: wheat immediately after corn or sorghum
  for (let i = 1; i < sequence.length; i++) {
    const prev = sequence[i - 1];
    const curr = sequence[i];
    if (curr === "soft_red_winter_wheat" && (prev === "field_corn" || prev === "grain_sorghum")) {
      score -= 15;
      negative.push(
        `Fusarium head blight risk: wheat follows ${getCrop(prev)?.commonName || prev}. Shared Fusarium inoculum in residue is a documented concern.`
      );
    }
  }

  // Sclerotinia: sunflower, canola, and soybean proximity across years
  const sclerotiniaHosts = ["soybean", "sunflower", "winter_canola", "spring_canola"];
  const hostIndices = sequence
    .map((id, idx) => (sclerotiniaHosts.includes(id) ? idx : -1))
    .filter((i) => i >= 0);
  if (hostIndices.length >= 2) {
    const minGap = hostIndices.reduce((min, curr, i) => {
      if (i === 0) return Infinity;
      return Math.min(min, curr - hostIndices[i - 1]);
    }, Infinity);
    if (minGap <= 3) {
      const hasPaddyRiceBreak = sequence.includes("paddy_rice");
      const hostNames = Array.from(
        new Set(
          sequence
            .filter((id) => sclerotiniaHosts.includes(id))
            .map((id) => getCrop(id)?.commonName || id)
        )
      ).join(" and ");
      score -= hasPaddyRiceBreak ? 6 : 12;
      negative.push(
        `Sclerotinia consideration: ${hostNames} are Sclerotinia-susceptible hosts. Short rotation intervals may not provide a complete disease break${hasPaddyRiceBreak ? " (though the flooded rice phase helps degrade soil sclerotia)" : ""}.`
      );
      limitations.push("Sclerotinia host-interval recommendations vary by region, canopy moisture, and field history.");
    }
  }

  // Soybean cyst nematode: repeated soybean without adequate break
  const soybeanCount = sequence.filter((id) => id === "soybean").length;
  if (soybeanCount >= 2) {
    const nonHostBreak = sequence.some(
      (id) => id !== "soybean" && getCrop(id)?.family !== "Fabaceae"
    );
    if (!nonHostBreak) {
      score -= 10;
      negative.push("Repeated soybean without a non-host break increases soybean cyst nematode risk.");
    } else {
      score -= 3;
      negative.push("Multiple soybean appearances in the sequence; SCN populations can build with frequent soybean.");
    }
  }

  // Cover crops as pest breaks
  const coverCrops = crops.filter((c) => c.type === "cover");
  if (coverCrops.length >= 2) {
    score += 8;
    positive.push("Multiple cover crops provide breaks from cash-crop pest and disease cycles.");
  }

  score = clamp(score);

  return {
    score,
    interpretation: `Diversity / pest-break score: ${score}/100. Evaluates botanical family diversity and known crop-sequence disease risks.`,
    inputsUsed,
    rubric:
      "Family diversity is rewarded (more families = better pest/disease breaks). Specific sequence penalties are applied for: wheat immediately after corn/sorghum (Fusarium head blight), sunflower close to soybean (Sclerotinia), and repeated soybean (SCN). Cover crops add modest bonuses as break crops. Scores are heuristics based on documented host relationships.",
    positiveContributors: positive,
    negativeContributors: negative,
    dataCoverageLimitations: limitations,
    coverage: "Partial",
    citations: [
      { text: "NC State Extension Small Grain Production Guide — Fusarium head blight", url: "https://content.ces.ncsu.edu/small-grain-production" },
      { text: "NC State Extension Soybean Disease and Nematode Management", url: "https://content.ces.ncsu.edu/soybean-disease-and-nematode-management" },
      { text: "NC State Extension Plant Pathology — Sclerotinia", url: "https://content.ces.ncsu.edu/sclerotinia" },
    ],
  };
}

// ─── 5. Climate Risk Resilience ───────────────────────────────────────

function scoreClimateRiskResilience(strategy: RotationStrategy, climate: ClimateData, soil: SoilData | null): FactorScore {
  const dryDays = avgMaxDryDays(climate);
  const heatDays = avgHeatDays(climate);
  const gsPrecip = gsPrecipMm(climate);
  const awc = awcValue(soil);

  const cashCrops = strategy.years
    .flatMap((y) => y.seasons)
    .filter((s) => s.crop !== "winter_fallow")
    .map((s) => getCrop(s.crop))
    .filter((c): c is Crop => !!c && c.type === "cash");

  const inputsUsed: string[] = [];
  const positive: string[] = [];
  const negative: string[] = [];
  const limitations: string[] = [];
  const citations: Citation[] = [];

  if (dryDays !== null)
    inputsUsed.push(`Avg max consecutive dry days (Jun–Aug): ${dryDays.toFixed(1)} days`);
  else limitations.push("Dry-spell data unavailable.");

  if (heatDays !== null)
    inputsUsed.push(`Avg heat-stress days (Jul–Aug, >35 °C): ${heatDays.toFixed(1)} days`);
  else limitations.push("Heat-stress day count unavailable.");

  if (gsPrecip !== null)
    inputsUsed.push(`Growing-season precipitation (May–Aug): ${gsPrecip.toFixed(0)} mm`);
  else limitations.push("Growing-season precipitation data unavailable.");

  if (cashCrops.length === 0) {
    return {
      score: null,
      interpretation: "No cash crops found for climate resilience evaluation.",
      inputsUsed: [],
      rubric: "Requires cash crops with defined sensitive periods.",
      positiveContributors: [],
      negativeContributors: [],
      dataCoverageLimitations: ["Rotation contains no recognized cash crops."],
      coverage: "Limited",
      citations: [],
    };
  }

  let score = 55;

  for (const crop of cashCrops) {
    // Drought resilience
    if (crop.droughtTolerance === "high") {
      if (dryDays !== null && dryDays > 10) {
        score += 8;
        positive.push(`${crop.commonName} has high drought tolerance, an advantage in a region with summer dry spells.`);
      }
    } else if (crop.droughtTolerance === "low") {
      if (dryDays !== null && dryDays > 10) {
        score -= 8;
        negative.push(`${crop.commonName} has low drought tolerance and is vulnerable to summer dry spells.`);
      }
    }

    // Heat sensitivity during reproductive periods
    if (crop.sensitivePeriods) {
      for (const [period, info] of Object.entries(crop.sensitivePeriods)) {
        const isSummerSensitive = info.months.some((m) => m >= 6 && m <= 8);
        if (isSummerSensitive && heatDays !== null) {
          if (heatDays > 10) {
            score -= 8;
            negative.push(
              `${crop.commonName} is sensitive to heat during ${period} (${info.months
                .map((m) => ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][m - 1])
                .join("/")}), and this region averages ${heatDays.toFixed(0)} heat-stress days.`
            );
          } else if (heatDays < 3) {
            score += 5;
            positive.push(`${crop.commonName}'s ${period} period benefits from low heat-stress frequency.`);
          }
        }
      }
    }

    // Water demand vs supply
    if (crop.waterDemand === "high" && gsPrecip !== null) {
      if (gsPrecip < 400) {
        score -= 6;
        negative.push(`${crop.commonName} demands abundant water, but growing-season precipitation is limited.`);
      }
    }

    // Deep root advantage
    if (crop.rootSystem.includes("deep taproot") && awc !== null && awc < 0.12) {
      score += 5;
      positive.push(`${crop.commonName}'s deep taproot can access water below the shallow profile.`);
    }
  }

  // Overall field resilience context
  if (gsPrecip !== null && gsPrecip > 500 && dryDays !== null && dryDays < 8) {
    score += 5;
    positive.push("This location has a relatively favorable water balance for summer cropping.");
  }

  if (heatDays !== null && heatDays > 15) {
    score -= 10;
    negative.push("Frequent extreme heat days (>15 per year) during July–August increase climate risk for heat-sensitive crops.");
  }

  score = clamp(score);

  const conf = limitations.length === 0 ? "Good" : limitations.length <= 1 ? "Partial" : "Limited";

  return {
    score,
    interpretation:
      conf === "Limited"
        ? `Climate risk resilience estimated at ${score}/100 with incomplete data.`
        : `Climate risk resilience: ${score}/100. Accounts for historical dry spells, heat-stress days, and crop tolerance traits.`,
    inputsUsed,
    rubric:
      "Each cash crop is evaluated against historical summer dry-spell frequency, heat-stress day counts during sensitive reproductive windows, growing-season precipitation, and crop-specific drought/heat tolerance. Deep-rooted crops receive modest bonuses in low-AWC soils. Scores describe historical exposure, not future weather forecasts.",
    positiveContributors: positive,
    negativeContributors: negative,
    dataCoverageLimitations: limitations,
    coverage: conf,
    citations: citations.length > 0 ? citations : [
      { text: "NASA POWER Daily API — historical daily records", url: "https://power.larc.nasa.gov/" },
      { text: "NC State Extension crop production guides", url: "https://content.ces.ncsu.edu/" },
    ],
  };
}

// ─── Region applicability & field-context helpers ────────────────────

export interface StrategyObjectiveDefinition {
  archetype: "soil_health" | "water_resilience" | "crop_diversity";
  name: string;
  objective: string;
}

export interface FieldAdaptiveObjective extends StrategyObjectiveDefinition {
  emphasisTag: string;
  priorityEmphasisScore: number;
  bullets: string[];
  recommendedCropIds: string[];
  recommendedCropNames: string[];
}

export const STRATEGY_OBJECTIVES: StrategyObjectiveDefinition[] = [
  {
    archetype: "soil_health",
    name: "Soil Health Building",
    objective:
      "Prioritizes building soil organic matter, biological nitrogen credits, and continuous living cover between cash crops.",
  },
  {
    archetype: "water_resilience",
    name: "Water Resilience",
    objective:
      "Emphasizes drought-tolerant crops, reduces peak summer water demand, and protects soil moisture with seasonal cover.",
  },
  {
    archetype: "crop_diversity",
    name: "Crop Diversity & Pest Break",
    objective:
      "Maximizes botanical family diversity across three cash-crop families to break pest, weed, and disease cycles.",
  },
];

function selectObjectiveCandidateCrops(
  archetype: "soil_health" | "water_resilience" | "crop_diversity",
  availableCropIds: string[]
): { ids: string[]; names: string[] } {
  const validCrops = availableCropIds
    .map((id) => getCrop(id))
    .filter((c): c is Crop => Boolean(c));

  if (validCrops.length === 0) {
    return { ids: [], names: [] };
  }

  if (archetype === "soil_health") {
    const scored = validCrops
      .map((c) => {
        let score = 0;
        if (c.family === "Fabaceae" || c.nitrogenBehavior.residualNcredit) score += 4;
        if (c.type === "cover") score += 3;
        if (c.residue.quantity.toLowerCase().includes("high")) score += 2;
        if (c.rootSystem.toLowerCase().includes("deep") || c.rootSystem.toLowerCase().includes("fibrous")) {
          score += 1;
        }
        return { crop: c, score };
      })
      .sort((a, b) => b.score - a.score || a.crop.commonName.localeCompare(b.crop.commonName));
    const chosen = scored.slice(0, 4).map((s) => s.crop);
    return { ids: chosen.map((c) => c.id), names: chosen.map((c) => c.commonName) };
  }

  if (archetype === "water_resilience") {
    const scored = validCrops
      .map((c) => {
        let score = 0;
        const dt = c.droughtTolerance.toLowerCase();
        const wd = c.waterDemand.toLowerCase();
        if (dt === "very_high" || dt === "high") score += 4;
        else if (dt.includes("moderate")) score += 2;
        if (wd === "low" || wd === "very_low" || wd === "low_to_moderate") score += 3;
        else if (wd === "moderate") score += 1;
        if (c.type === "cover" && c.residue.persistence.toLowerCase().includes("high")) score += 2;
        return { crop: c, score };
      })
      .sort((a, b) => b.score - a.score || a.crop.commonName.localeCompare(b.crop.commonName));
    const chosen = scored.slice(0, 4).map((s) => s.crop);
    return { ids: chosen.map((c) => c.id), names: chosen.map((c) => c.commonName) };
  }

  // crop_diversity: pick crops from distinct botanical families first,
  // avoiding stacking multiple Sclerotinia hosts in the candidate list when
  // non-host family representatives are available.
  const sclerotiniaSet = new Set(["soybean", "sunflower", "winter_canola", "spring_canola"]);
  const seenFamilies = new Set<string>();
  const diverseChosen: Crop[] = [];
  let hasSclerotiniaHost = false;

  // Pass 1: pick distinct families, preferring non-Sclerotinia crops once 1 Sclerotinia host is chosen
  for (const crop of validCrops) {
    if (seenFamilies.has(crop.family)) continue;
    const isSclerotinia = sclerotiniaSet.has(crop.id);
    if (isSclerotinia && hasSclerotiniaHost) {
      const hasNonHostAlternativeInFamily = validCrops.some(
        (c) => c.family === crop.family && !sclerotiniaSet.has(c.id)
      );
      const hasOtherUnseenNonHostFamily = validCrops.some(
        (c) => !seenFamilies.has(c.family) && c.family !== crop.family && !sclerotiniaSet.has(c.id)
      );
      if (hasNonHostAlternativeInFamily || hasOtherUnseenNonHostFamily) {
        continue;
      }
    }
    seenFamilies.add(crop.family);
    diverseChosen.push(crop);
    if (isSclerotinia) hasSclerotiniaHost = true;
    if (diverseChosen.length === 4) break;
  }

  // Pass 2: fill any remaining slots from unseen families first, then remaining crops
  if (diverseChosen.length < 4) {
    for (const crop of validCrops) {
      if (!seenFamilies.has(crop.family) && !diverseChosen.some((c) => c.id === crop.id)) {
        seenFamilies.add(crop.family);
        diverseChosen.push(crop);
        if (diverseChosen.length === 4) break;
      }
    }
  }
  if (diverseChosen.length < 4) {
    for (const crop of validCrops) {
      if (!diverseChosen.some((c) => c.id === crop.id)) {
        diverseChosen.push(crop);
        if (diverseChosen.length === 4) break;
      }
    }
  }
  return {
    ids: diverseChosen.map((c) => c.id),
    names: diverseChosen.map((c) => c.commonName),
  };
}

/**
 * Deterministically build 2–3 short field-specific context bullets for a strategy
 * archetype using the field's actual climate, soil, and available crop catalog (no AI call required).
 */
export function buildObjectiveFieldContextBullets(
  archetype: string,
  climate: ClimateData | null | undefined,
  soil: SoilData | null | undefined,
  availableCropIds: string[] = []
): string[] {
  const gsPrecip = climate?.stressMetrics.growingSeasonPrecip.avgTotalMm ?? null;
  const springPrecip = climate?.stressMetrics.springPrecip.avgTotalMm ?? null;
  const dryDays = climate?.stressMetrics.summerDrySpells.avgMaxConsecutiveDryDays ?? null;
  const heatDays = climate?.stressMetrics.summerHeatDays.avgDaysAboveThreshold ?? null;
  const annualTemp = climate?.fullRecord.avgAnnualTemp ?? null;
  const annualPrecip = climate?.fullRecord.avgAnnualPrecip ?? null;

  const om = soil?.aggregated.depth0_30cm.om ?? null;
  const awc = soil?.aggregated.depth0_30cm.awc ?? null;
  const ph = soil?.aggregated.depth0_30cm.ph ?? null;
  const sand = soil?.aggregated.depth0_30cm.sand ?? null;
  const slope = soil?.aggregated.slope ?? null;
  const drainage = soil?.aggregated.drainage ?? null;

  const drainageLower = drainage?.toLowerCase() ?? "";
  const isPoorDrainage =
    drainageLower.includes("poorly") || drainageLower.includes("restricted");
  const isHumidOrWet =
    (annualPrecip !== null && annualPrecip >= 1200) ||
    (springPrecip !== null && springPrecip >= 320) ||
    isPoorDrainage;
  const isHotDry =
    (annualPrecip !== null && annualPrecip < 600) ||
    (gsPrecip !== null && gsPrecip < 260) ||
    (dryDays !== null && dryDays >= 14 && (heatDays ?? 0) >= 10);
  const isLowOmOrAwc =
    (om !== null && om < 1.3) ||
    (awc !== null && awc < 0.12) ||
    (sand !== null && sand >= 68);

  const normalizedArchetype: "soil_health" | "water_resilience" | "crop_diversity" =
    archetype === "soil_health" || archetype === "soil_health_building"
      ? "soil_health"
      : archetype === "water_resilience"
        ? "water_resilience"
        : "crop_diversity";

  const candidateCrops = selectObjectiveCandidateCrops(normalizedArchetype, availableCropIds);

  if (normalizedArchetype === "soil_health") {
    const b1 =
      isLowOmOrAwc && om !== null && awc !== null
        ? `Rebuilds low organic matter (${om.toFixed(1)}%) and limited water capacity (${awc.toFixed(2)} cm/cm AWC) with cover residue.`
        : om !== null
          ? `Targets topsoil organic matter (${om.toFixed(1)}% in 0–30 cm) with winter legume and grass residue.`
          : "Builds topsoil organic matter and biological N supply with legume and high-residue covers.";
    const b2 =
      isHumidOrWet && springPrecip !== null
        ? `Maintains living roots across ${springPrecip.toFixed(0)} mm spring rain${slope !== null ? ` and ${slope.toFixed(1)}% slope` : ""} to scavenge soluble N and curb runoff.`
        : isHotDry
          ? `Uses low-transpiration surface mulch to shield topsoil carbon across ${dryDays !== null ? `${dryDays.toFixed(1)}-day summer dry spells` : "dry windows"}.`
          : slope !== null && springPrecip !== null
            ? `Protects ${slope.toFixed(1)}% slope during ${springPrecip.toFixed(0)} mm average spring rainfall.`
            : slope !== null
              ? `Protects ${slope.toFixed(1)}% field slope with living winter and spring cover.`
              : "Maintains living roots through winter and spring transitions to limit erosion.";
    const b3 =
      candidateCrops.names.length > 0
        ? `Prioritizes N-fixing and high-residue options such as ${candidateCrops.names.slice(0, 3).join(", ")}.`
        : "Pairs biological nitrogen fixation ahead of high-demand summer cash crops.";
    return [b1, b2, b3];
  }

  if (normalizedArchetype === "water_resilience") {
    const b1 =
      isHotDry && gsPrecip !== null && dryDays !== null
        ? `Buffers low growing-season rain (${gsPrecip.toFixed(0)} mm May–Aug) and ${dryDays.toFixed(1)}-day dry spells with drought-tolerant crops.`
        : isHumidOrWet && gsPrecip !== null && dryDays !== null
          ? `Balances ${gsPrecip.toFixed(0)} mm May–Aug rainfall${drainage ? ` on ${drainage.toLowerCase()} soils` : ""} with ${dryDays.toFixed(1)}-day dry spells.`
          : gsPrecip !== null && dryDays !== null
            ? `Adapts to ${gsPrecip.toFixed(0)} mm May–Aug rainfall and ${dryDays.toFixed(1)}-day average summer dry spells.`
            : "Selects lower-water-demand summer crops to buffer against mid-season dry spells.";
    const b2 =
      isLowOmOrAwc && awc !== null
        ? `Compensates for low topsoil water storage (${awc.toFixed(2)} cm/cm AWC${sand !== null ? `, ${sand.toFixed(0)}% sand` : ""}) using deep roots and surface mulch.`
        : isPoorDrainage && drainage
          ? `Accounts for ${drainage.toLowerCase()} conditions${springPrecip !== null ? ` (${springPrecip.toFixed(0)} mm spring rain)` : ""} to avoid spring root stress.`
          : heatDays !== null && awc !== null
            ? `Accounts for ${heatDays.toFixed(1)} summer heat days (>35 °C) and ${awc.toFixed(2)} cm/cm topsoil AWC.`
            : heatDays !== null
              ? `Reduces reproductive heat exposure across ${heatDays.toFixed(1)} average summer heat days (>35 °C).`
              : "Matches rooting depth and drought tolerance to field water-holding capacity.";
    const b3 =
      candidateCrops.names.length > 0
        ? `Draws on water-resilient catalog crops including ${candidateCrops.names.slice(0, 3).join(", ")}.`
        : "Uses persistent surface residue to reduce summer soil moisture evaporation.";
    return [b1, b2, b3];
  }

  // Default / crop_diversity
  const b1 =
    isHumidOrWet
      ? `Rotates non-host families over 3 years to break foliar and root-rot pressure in a ${annualPrecip !== null ? `${annualPrecip.toFixed(0)} mm/yr` : "humid"} climate.`
      : isHotDry
        ? `Spreads heat and moisture risk across distinct botanical families adapted to ${annualPrecip !== null ? `${annualPrecip.toFixed(0)} mm/yr` : "semi-arid"} rainfall.`
        : "Rotates across distinct botanical families over 3 years to disrupt pest and disease cycles.";
  const b2 =
    annualTemp !== null && annualPrecip !== null
      ? `Staggers cool- and warm-season planting windows for a ${annualTemp.toFixed(1)} °C, ${annualPrecip.toFixed(0)} mm/yr climate.`
      : "Alternates summer and winter planting windows to suppress weed and pathogen buildup.";
  const b3 =
    candidateCrops.names.length > 0
      ? `Combines multi-family options (${candidateCrops.names.slice(0, 3).join(", ")}) suited to ${drainage ? `${drainage.toLowerCase()} soils` : "local topsoil"}${ph !== null ? ` at pH ${ph.toFixed(1)}` : ""}.`
      : drainage !== null && ph !== null
        ? `Selects non-host break crops suited to ${drainage.toLowerCase()} soils (topsoil pH ${ph.toFixed(1)}).`
        : "Avoids back-to-back host crops to limit soilborne disease and nematode pressure.";
  return [b1, b2, b3];
}

/**
 * Deterministically build three tailored, field-specific planning objectives
 * ("soil_health", "water_resilience", "crop_diversity") whose titles, descriptions,
 * emphasis tags, context bullets, and recommended catalog crops adapt to the field's
 * actual climate, soil properties, and farmer priority weights.
 */
export function buildFieldSpecificObjectives(params: {
  climate: ClimateData | null | undefined;
  soil: SoilData | null | undefined;
  priorities?: FarmerPriorities | null;
  availableCropIds?: string[];
}): FieldAdaptiveObjective[] {
  const { climate, soil, priorities, availableCropIds = [] } = params;

  const gsPrecip = climate?.stressMetrics.growingSeasonPrecip.avgTotalMm ?? null;
  const springPrecip = climate?.stressMetrics.springPrecip.avgTotalMm ?? null;
  const dryDays = climate?.stressMetrics.summerDrySpells.avgMaxConsecutiveDryDays ?? null;
  const heatDays = climate?.stressMetrics.summerHeatDays.avgDaysAboveThreshold ?? null;
  const annualTemp = climate?.fullRecord.avgAnnualTemp ?? null;
  const annualPrecip = climate?.fullRecord.avgAnnualPrecip ?? null;

  const om = soil?.aggregated.depth0_30cm.om ?? null;
  const awc = soil?.aggregated.depth0_30cm.awc ?? null;
  const ph = soil?.aggregated.depth0_30cm.ph ?? null;
  const sand = soil?.aggregated.depth0_30cm.sand ?? null;
  const slope = soil?.aggregated.slope ?? null;
  const drainage = soil?.aggregated.drainage ?? null;

  const drainageLower = drainage?.toLowerCase() ?? "";
  const isPoorDrainage =
    drainageLower.includes("poorly") || drainageLower.includes("restricted");
  const isHumidOrWet =
    (annualPrecip !== null && annualPrecip >= 1200) ||
    (springPrecip !== null && springPrecip >= 320) ||
    isPoorDrainage;
  const isHotDry =
    (annualPrecip !== null && annualPrecip < 600) ||
    (gsPrecip !== null && gsPrecip < 260) ||
    (dryDays !== null && dryDays >= 14 && (heatDays ?? 0) >= 10);
  const isLowOmOrAwc =
    (om !== null && om < 1.3) ||
    (awc !== null && awc < 0.12) ||
    (sand !== null && sand >= 68);

  const p: FarmerPriorities = priorities ?? DEFAULT_PRIORITIES;
  const soilPriorityScore = Math.round(
    p.nitrogenContribution * 0.45 + p.soilCoverage * 0.45 + p.waterSuitability * 0.1
  );
  const waterPriorityScore = Math.round(
    p.waterSuitability * 0.55 + p.climateRiskResilience * 0.35 + p.soilCoverage * 0.1
  );
  const diversityPriorityScore = Math.round(
    p.diversityPestBreak * 0.6 + p.climateRiskResilience * 0.25 + p.nitrogenContribution * 0.15
  );

  const maxPriorityScore = Math.max(
    soilPriorityScore,
    waterPriorityScore,
    diversityPriorityScore
  );

  // 1. Soil Health objective adaptation
  let soilName = "Soil Organic Matter & Biological Nitrogen";
  let soilDesc =
    "Prioritizes building topsoil organic matter, biological nitrogen credits, and continuous living cover between cash crops.";
  let soilRegimeTag = "Soil Carbon & N Focus";

  if (isLowOmOrAwc) {
    soilName = "Organic Matter & Water-Holding Rebuilding";
    soilRegimeTag =
      om !== null && om < 1.8
        ? `Low-OM Topsoil Rebuilding (${om.toFixed(1)}% OM)`
        : awc !== null
          ? `Low-AWC Pore Rebuilding (${awc.toFixed(2)} cm/cm)`
          : "Coarse-Topsoil Carbon Rebuilding";
    soilDesc = `Rebuilds low 0–30 cm organic matter (${om !== null ? `${om.toFixed(1)}%` : "low OM"}) and water-holding capacity (${awc !== null ? `${awc.toFixed(2)} cm/cm AWC` : "limited AWC"}) using high-residue cover crops and nitrogen-fixing legumes.`;
  } else if (isHumidOrWet) {
    soilName = "Erosion Control, N Scavenging & Living Cover";
    soilRegimeTag =
      springPrecip !== null
        ? `High-Rainfall Soil Protection (${springPrecip.toFixed(0)} mm spring)`
        : "Humid-Season Soil Protection";
    soilDesc = `Protects topsoil structure${slope !== null ? ` across ${slope.toFixed(1)}% slope` : ""} and scavenges soluble nitrogen during ${annualPrecip !== null ? `${annualPrecip.toFixed(0)} mm/yr` : "high"} rainfall while building ${om !== null ? `${om.toFixed(1)}%` : "topsoil"} organic matter.`;
  } else if (isHotDry) {
    soilName = "Moisture-Conserving Residue & Biological N";
    soilRegimeTag = "Dryland Residue & N Focus";
    soilDesc = `Builds biological nitrogen and protective surface mulch for a ${annualPrecip !== null ? `${annualPrecip.toFixed(0)} mm/yr` : "moisture-limited"} regime without exhausting stored soil water prior to cash planting.`;
  } else if (om !== null) {
    soilDesc = `Maintains and builds ${om.toFixed(1)}% topsoil organic matter (${slope !== null ? `${slope.toFixed(1)}% slope` : "0–30 cm profile"}) through winter legume nitrogen fixation and continuous living roots.`;
  }

  // 2. Water Resilience objective adaptation
  let waterName = "Seasonal Moisture & Dry-Spell Resilience";
  let waterDesc =
    "Emphasizes drought-tolerant crops, reduces peak summer water demand, and protects soil moisture with seasonal cover.";
  let waterRegimeTag = "Moisture Balance Focus";

  if (isHotDry) {
    waterName = "Drought & Heat-Stress Buffering";
    waterRegimeTag =
      gsPrecip !== null
        ? `Low-Rainfall & Heat Buffer (${gsPrecip.toFixed(0)} mm May–Aug)`
        : "Dryland & Heat-Stress Buffer";
    waterDesc = `Centers on low-water-demand, heat-tolerant crops to withstand ${gsPrecip !== null ? `${gsPrecip.toFixed(0)} mm growing-season rain` : "limited rainfall"}, ${dryDays !== null ? `${dryDays.toFixed(1)}-day dry spells` : "prolonged dry spells"}, and ${heatDays !== null ? `${heatDays.toFixed(1)} summer heat days (>35 °C)` : "high summer heat"}.`;
  } else if (isHumidOrWet) {
    waterName = isPoorDrainage
      ? "Drainage Resilience & Seasonal Water Balance"
      : "High-Rainfall Balance & Summer Dry-Spell Buffer";
    waterRegimeTag = isPoorDrainage
      ? `Drainage-Adapted (${drainage})`
      : `Humid Regime (${annualPrecip !== null ? `${annualPrecip.toFixed(0)} mm/yr` : "High Rain"})`;
    waterDesc = isPoorDrainage
      ? `Adapts crop rooting and planting windows to ${drainage?.toLowerCase() ?? "restricted-drainage"} topsoil (${springPrecip !== null ? `${springPrecip.toFixed(0)} mm spring rain` : "wet springs"}) while buffering ${dryDays !== null ? `${dryDays.toFixed(1)}-day` : "mid-summer"} dry spells.`
      : `Manages ${annualPrecip !== null ? `${annualPrecip.toFixed(0)} mm/yr` : "abundant"} rainfall and ${springPrecip !== null ? `${springPrecip.toFixed(0)} mm spring moisture` : "wet planting windows"} while protecting yield during ${dryDays !== null ? `${dryDays.toFixed(1)}-day summer dry spells` : "summer dry intervals"}.`;
  } else if (isLowOmOrAwc) {
    waterName = "Low-AWC Root-Zone Moisture Efficiency";
    waterRegimeTag =
      awc !== null
        ? `Low Water Storage (${awc.toFixed(2)} cm/cm AWC)`
        : "Coarse-Soil Moisture Efficiency";
    waterDesc = `Compensates for limited 0–30 cm available water capacity (${awc !== null ? `${awc.toFixed(2)} cm/cm` : "low AWC"}${sand !== null ? `, ${sand.toFixed(0)}% sand` : ""}) by pairing deep-rooted drought-tolerant crops with moisture-retaining surface residue.`;
  } else if (gsPrecip !== null && dryDays !== null) {
    waterDesc = `Aligns crop water demand with ${gsPrecip.toFixed(0)} mm May–Aug rainfall, ${dryDays.toFixed(1)}-day summer dry spells, and ${awc !== null ? `${awc.toFixed(2)} cm/cm topsoil AWC` : "local moisture storage"}.`;
  }

  // 3. Crop Diversity objective adaptation
  let diversityName = "Multi-Family Disease & Pest Cycle Break";
  let diversityDesc =
    "Maximizes botanical family diversity across three cash-crop families to break pest, weed, and disease cycles.";
  let diversityRegimeTag = "3-Year Botanical Diversity";

  if (isHumidOrWet) {
    diversityName = "Humid Disease-Cycle Break & Family Rotation";
    diversityRegimeTag = "Humid Pathogen & Pest Break";
    diversityDesc = `Alternates distinct non-host botanical families to interrupt foliar, stem, and root-rot disease cycles favored by ${annualPrecip !== null ? `${annualPrecip.toFixed(0)} mm/yr` : "humid"} rainfall${drainage ? ` and ${drainage.toLowerCase()} soils` : ""}.`;
  } else if (isHotDry) {
    diversityName = "Dryland Pest Break & Multi-Family Risk Spread";
    diversityRegimeTag = "Dryland Multi-Family Spread";
    diversityDesc = `Rotates drought-adapted botanical families across cool and warm windows to break pest and weed cycles while spreading rainfall-timing risk in a ${annualPrecip !== null ? `${annualPrecip.toFixed(0)} mm/yr` : "dry"} climate.`;
  } else if (isLowOmOrAwc) {
    diversityName = "Multi-Family Rotation & Root-Depth Diversity";
    diversityRegimeTag = "Root-Architecture & Pest Break";
    diversityDesc = `Alternates taproot and fibrous-rooted botanical families suited to ${om !== null ? `${om.toFixed(1)}% OM` : "low-OM"} topsoil${ph !== null ? ` (pH ${ph.toFixed(1)})` : ""} to suppress nematodes, weeds, and soilborne pathogens.`;
  } else if (annualTemp !== null && annualPrecip !== null) {
    diversityDesc = `Sequences three distinct cash-crop families across a ${annualTemp.toFixed(1)} °C, ${annualPrecip.toFixed(0)} mm/yr climate to break weed, nematode, and soilborne disease carryover.`;
  }

  const formatEmphasisTag = (regimeTag: string, score: number) => {
    const isTop = score === maxPriorityScore && maxPriorityScore > 0;
    return isTop
      ? `${regimeTag} · Top Farmer Priority (${score}%)`
      : `${regimeTag} · ${score}% Priority Weight`;
  };

  const soilCrops = selectObjectiveCandidateCrops("soil_health", availableCropIds);
  const waterCrops = selectObjectiveCandidateCrops("water_resilience", availableCropIds);
  const diversityCrops = selectObjectiveCandidateCrops("crop_diversity", availableCropIds);

  const objectives: FieldAdaptiveObjective[] = [
    {
      archetype: "soil_health",
      name: soilName,
      emphasisTag: formatEmphasisTag(soilRegimeTag, soilPriorityScore),
      priorityEmphasisScore: soilPriorityScore,
      objective: soilDesc,
      bullets: buildObjectiveFieldContextBullets("soil_health", climate, soil, availableCropIds),
      recommendedCropIds: soilCrops.ids,
      recommendedCropNames: soilCrops.names,
    },
    {
      archetype: "water_resilience",
      name: waterName,
      emphasisTag: formatEmphasisTag(waterRegimeTag, waterPriorityScore),
      priorityEmphasisScore: waterPriorityScore,
      objective: waterDesc,
      bullets: buildObjectiveFieldContextBullets(
        "water_resilience",
        climate,
        soil,
        availableCropIds
      ),
      recommendedCropIds: waterCrops.ids,
      recommendedCropNames: waterCrops.names,
    },
    {
      archetype: "crop_diversity",
      name: diversityName,
      emphasisTag: formatEmphasisTag(diversityRegimeTag, diversityPriorityScore),
      priorityEmphasisScore: diversityPriorityScore,
      objective: diversityDesc,
      bullets: buildObjectiveFieldContextBullets(
        "crop_diversity",
        climate,
        soil,
        availableCropIds
      ),
      recommendedCropIds: diversityCrops.ids,
      recommendedCropNames: diversityCrops.names,
    },
  ];

  const canonicalOrder: Record<FieldAdaptiveObjective["archetype"], number> = {
    soil_health: 0,
    water_resilience: 1,
    crop_diversity: 2,
  };

  return objectives.sort(
    (a, b) =>
      b.priorityEmphasisScore - a.priorityEmphasisScore ||
      canonicalOrder[a.archetype] - canonicalOrder[b.archetype]
  );
}

/**
 * Deterministically build 2–3 concise overview bullets for a StrategyCard.
 * Combines the strategy's concrete 3-year crop structure with field-specific context.
 */
export function buildStrategyOverviewBullets(
  strategy: RotationStrategy,
  climate?: ClimateData | null,
  soil?: SoilData | null
): string[] {
  const allSeasons = strategy.years.flatMap((y) => y.seasons);
  const cropIds = allSeasons.map((s) => s.crop).filter((id) => id !== "winter_fallow");
  const crops = cropIds.map((id) => getCrop(id)).filter((c): c is Crop => !!c);

  // Per-year primary cash crops
  const cashByYear = strategy.years
    .map((y) => {
      const cashNames = Array.from(
        new Set(
          y.seasons
            .map((s) => getCrop(s.crop))
            .filter((c): c is Crop => !!c && c.type === "cash")
            .map((c) => c.commonName)
        )
      );
      return cashNames.length > 0 ? `Y${y.year} ${cashNames.join("/")}` : null;
    })
    .filter((entry): entry is string => entry !== null);

  const families = uniqueFamilies(cropIds);
  const coverNames = Array.from(
    new Set(crops.filter((c) => c.type === "cover").map((c) => c.commonName))
  );

  const bullets: string[] = [];

  if (cashByYear.length > 0) {
    bullets.push(`Cash sequence: ${cashByYear.join(" → ")}.`);
  }

  if (coverNames.length > 0) {
    bullets.push(
      `Covers & diversity: ${coverNames.slice(0, 3).join(", ")} (${families.length} botanical ${families.length === 1 ? "family" : "families"}).`
    );
  } else if (families.length > 0) {
    bullets.push(
      `Botanical diversity: ${families.length} ${families.length === 1 ? "family" : "families"} (${families.join(", ")}).`
    );
  }

  if (climate || soil) {
    const fieldContext = buildObjectiveFieldContextBullets(strategy.archetype, climate, soil);
    if (fieldContext.length > 0) {
      bullets.push(fieldContext[0]);
    }
  } else if (strategy.tradeoffs.advantages.length > 0) {
    bullets.push(strategy.tradeoffs.advantages[0]);
  }

  return bullets.slice(0, 3);
}

/**
 * Deterministically filter the verified crop catalog for a classified
 * agroecological group and geographic region tag.
 */
export function getAvailableCropsForContext(
  agGroup: string | null | undefined,
  regionTag: string | null | undefined
): string[] {
  if (!agGroup || agGroup === "unknown" || agGroup === "boreal") return [];
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
 * Evaluate the 3-tier evidence level for a field's crop & environmental context:
 * - level_1_strong_local: Regionally documented crops (>=3 families) + matching climate/seasonality + field-scale soil survey (e.g. SSURGO) or complete local agronomic record.
 * - level_2_global_modeled: Regionally/nationally documented crops (>=2 families, >=3 crops) supported by global modeled soil/climate baselines (FAO HWSD v2.2 / ISRIC SoilGrids / GAEZ v5) with explicit caveats.
 * - level_3_insufficient: Unclassified/unsupported agroecological regime or fewer than 3 eligible crops across at least 2 botanical families; rotation generation is refused.
 */
export function evaluateFieldCropEvidenceLevel(params: {
  agGroup: string | null | undefined;
  regionTag: string | null | undefined;
  availableCropIds: string[];
  soil: SoilData | null;
}): {
  level: CropEvidenceLevel;
  label: string;
  summary: string;
  distinctFamilies: string[];
} {
  const { agGroup, regionTag, availableCropIds, soil } = params;
  const distinctFamilies = uniqueFamilies(availableCropIds);
  const hasCashCrop = availableCropIds.some((id) => getCrop(id)?.type === "cash");

  if (
    !agGroup ||
    agGroup === "unknown" ||
    agGroup === "boreal" ||
    availableCropIds.length < 3 ||
    distinctFamilies.length < 2 ||
    !hasCashCrop
  ) {
    return {
      level: "level_3_insufficient",
      label: "Level 3 — Insufficient evidence",
      summary:
        "Insufficient verified crop or agroecological evidence to generate a defensible 3-year rotation for this location.",
      distinctFamilies,
    };
  }

  const hasFieldScaleSoilSurvey =
    soil !== null &&
    soil.aggregated.depth0_30cm.awc !== null &&
    soil.source.toUpperCase().includes("SSURGO");

  if (
    regionTag &&
    distinctFamilies.length >= 3 &&
    availableCropIds.length >= 5 &&
    hasFieldScaleSoilSurvey
  ) {
    return {
      level: "level_1_strong_local",
      label: "Level 1 — Strong local evidence",
      summary: `Strong regional crop catalog (${availableCropIds.length} verified crops across ${distinctFamilies.length} botanical families) paired with USDA SSURGO survey soil data and NASA POWER / GAEZ v5 climate records.`,
      distinctFamilies,
    };
  }

  return {
    level: "level_2_global_modeled",
    label: "Level 2 — Regional reference & modeled climate evidence",
    summary: `Supported by ${availableCropIds.length} regionally documented crops (${distinctFamilies.length} botanical families) using NASA POWER / GAEZ v5 climate regimes and ${
      soil
        ? "macro-regional topsoil reference estimates (compiled from FAO HWSD v2.2 & ISRIC SoilGrids v2.0 regional summaries)"
        : "climate-only baseline (soil profile unavailable)"
    }. Verify local cultivar maturity and on-site soil tests.`,
    distinctFamilies,
  };
}

/**
 * Determine whether a static reference strategy template is genuinely applicable
 * to the selected field's agroecological group and geographic region.
 */
export function isReferenceStrategyApplicable(
  strategy: RotationStrategy,
  agGroup: string | null | undefined,
  regionTag: string | null | undefined
): boolean {
  if (!agGroup || agGroup === "unknown" || !regionTag) return false;
  if (getUnsupportedCrops(strategy, regionTag).length > 0) return false;

  const cropIds = strategy.years
    .flatMap((y) => y.seasons)
    .map((s) => s.crop)
    .filter((id) => id !== "winter_fallow");

  if (cropIds.length === 0) return false;

  for (const id of cropIds) {
    const crop = getCrop(id);
    if (!crop) return false;
    const groups = crop.applicableGroups ?? ["temperate_humid"];
    if (!groups.includes(agGroup)) return false;
  }

  return true;
}

export function getUnsupportedCrops(strategy: RotationStrategy, regionTag?: string | null): string[] {
  if (!regionTag) return [];
  const unsupported: string[] = [];
  const seen = new Set<string>();
  for (const year of strategy.years) {
    for (const season of year.seasons) {
      const crop = getCrop(season.crop);
      if (!crop) continue;
      if (seen.has(crop.id)) continue;
      seen.add(crop.id);
      if (!crop.supportedRegions.includes(regionTag)) {
        unsupported.push(crop.commonName);
      }
    }
  }
  return unsupported;
}

function addRegionLimitations(
  factorScores: Record<FactorKey, FactorScore>,
  unsupportedCrops: string[]
): void {
  if (unsupportedCrops.length === 0) return;
  const note = `Strategy includes crops not documented for this region: ${unsupportedCrops.join(", ")}. This is an archetype example; crops should be substituted with locally adapted alternatives.`;
  for (const key of Object.keys(factorScores) as FactorKey[]) {
    if (factorScores[key].dataCoverageLimitations.indexOf(note) === -1) {
      factorScores[key].dataCoverageLimitations.push(note);
    }
  }
}

// ─── Composite scoring ────────────────────────────────────────────────

function fitLabel(score: number | null): "Strong fit" | "Moderate fit" | "Weak fit" | "Unavailable" {
  if (score === null) return "Unavailable";
  if (score >= 70) return "Strong fit";
  if (score >= 50) return "Moderate fit";
  return "Weak fit";
}

export function scoreStrategy(
  strategy: RotationStrategy,
  climate: ClimateData,
  soil: SoilData | null,
  priorities: FarmerPriorities,
  regionTag?: string | null
): StrategyResult {
  const water = scoreWaterSuitability(strategy, climate, soil);
  const nitrogen = scoreNitrogen(strategy, climate, soil);
  const coverage = scoreSoilCoverage(strategy, climate, soil);
  const diversity = scoreDiversityPestBreak(strategy);
  const risk = scoreClimateRiskResilience(strategy, climate, soil);

  const factorScores: Record<FactorKey, FactorScore> = {
    waterSuitability: water,
    nitrogenContribution: nitrogen,
    soilCoverage: coverage,
    diversityPestBreak: diversity,
    climateRiskResilience: risk,
  };

  // Region applicability
  const unsupportedCrops = getUnsupportedCrops(strategy, regionTag);
  addRegionLimitations(factorScores, unsupportedCrops);

  // Normalize weights and compute composite
  const rawTotalWeight = Object.values(priorities).reduce((a, b) => a + b, 0);
  // If all priorities are zero, fall back to equal weighting so scores remain computable
  const useEqualWeights = rawTotalWeight <= 0;
  const totalWeight = useEqualWeights ? 100 : rawTotalWeight;
  const effectivePriorities: FarmerPriorities = useEqualWeights ? DEFAULT_PRIORITIES : priorities;

  const keys: FactorKey[] = [
    "waterSuitability",
    "nitrogenContribution",
    "soilCoverage",
    "diversityPestBreak",
    "climateRiskResilience",
  ];

  let weightedSum = 0;
  let usedWeight = 0;
  let missingScoreCount = 0;

  for (const key of keys) {
    const score = factorScores[key].score;
    const weight = effectivePriorities[key];
    if (score !== null && totalWeight > 0) {
      const normalizedWeight = weight / totalWeight;
      weightedSum += score * normalizedWeight;
      usedWeight += normalizedWeight;
    }
    if (score === null) missingScoreCount++;
  }

  const overallScore = usedWeight > 0 ? Math.round(weightedSum / usedWeight) : null;
  const availableWeightPercent = usedWeight > 0 ? Math.round(usedWeight * 100) : 0;

  const coverageLevels = [water.coverage, nitrogen.coverage, coverage.coverage, diversity.coverage, risk.coverage];
  const limitedCount = coverageLevels.filter((c) => c === "Limited").length;
  const overallCoverage: "Good" | "Partial" | "Limited" =
    limitedCount >= 2 || missingScoreCount >= 2 ? "Limited" : limitedCount >= 1 ? "Partial" : "Good";

  return {
    strategy,
    factorScores,
    overallScore,
    overallCoverage,
    overallFitLabel: fitLabel(overallScore),
    rank: 0, // filled by caller after sorting
    availableWeightPercent,
  };
}

export function rankStrategyResults(results: StrategyResult[]): StrategyResult[] {
  const sorted = [...results].sort((a, b) => {
    if (a.overallScore === null && b.overallScore === null) {
      return a.strategy.id.localeCompare(b.strategy.id);
    }
    if (a.overallScore === null) return 1;
    if (b.overallScore === null) return -1;
    if (b.overallScore !== a.overallScore) {
      return b.overallScore - a.overallScore;
    }
    // Deterministic tie-breaker: static archetypes before AI-assisted on exact tie, then by ID
    const aIsAi = a.strategy.generationInfo?.source === "ai-assisted" ? 1 : 0;
    const bIsAi = b.strategy.generationInfo?.source === "ai-assisted" ? 1 : 0;
    if (aIsAi !== bIsAi) return aIsAi - bIsAi;
    return a.strategy.id.localeCompare(b.strategy.id);
  });

  return sorted.map((r, i) => ({
    ...r,
    rank: i + 1,
  }));
}

export function scoreAllStrategies(
  climate: ClimateData,
  soil: SoilData | null,
  priorities: FarmerPriorities,
  regionTag?: string | null
): StrategyResult[] {
  const results = strategies.map((s) => scoreStrategy(s, climate, soil, priorities, regionTag));
  return rankStrategyResults(results);
}

/**
 * Score and merge persisted generated strategies with the static archetype catalog,
 * sorting by overallScore descending (nulls last) and assigning unified ranks.
 */
export function mergeAndRankStrategies(
  generatedStrategies: RotationStrategy[] | null | undefined,
  climate: ClimateData,
  soil: SoilData | null,
  priorities: FarmerPriorities,
  regionTag?: string | null
): StrategyResult[] {
  const staticResults = strategies.map((s) =>
    scoreStrategy(s, climate, soil, priorities, regionTag)
  );
  const seenIds = new Set(staticResults.map((r) => r.strategy.id));
  const generatedResults: StrategyResult[] = [];
  for (const gen of generatedStrategies ?? []) {
    if (seenIds.has(gen.id)) continue;
    seenIds.add(gen.id);
    generatedResults.push(scoreStrategy(gen, climate, soil, priorities, regionTag));
  }
  return rankStrategyResults([...generatedResults, ...staticResults]);
}

/**
 * Verify that a rotation strategy is a genuinely AI-generated strategy
 * that passed deterministic validation for the target field.
 * Predefined static archetypes or failed proposals are never eligible
 * for farmer-facing display.
 */
export function isVerifiedAiStrategyForField(
  strategy: RotationStrategy | null | undefined,
  fieldId?: string
): boolean {
  if (!strategy || !strategy.generationInfo) return false;
  if (strategy.generationInfo.source !== "ai-assisted") return false;
  if (strategy.generationInfo.validationStatus === "failed") return false;
  if (strategy.generationInfo.supportStatus === "unavailable") return false;
  if (
    fieldId &&
    strategy.generationInfo.fieldId &&
    strategy.generationInfo.fieldId !== fieldId
  ) {
    return false;
  }
  return Array.isArray(strategy.years) && strategy.years.length === 3;
}

/**
 * Score and rank ONLY verified AI-generated strategies for a specific field.
 * Never merges or falls back to static reference rotations.
 */
export function scoreVerifiedAiStrategies(
  storedStrategies: RotationStrategy[] | null | undefined,
  fieldId: string | undefined,
  climate: ClimateData,
  soil: SoilData | null,
  priorities: FarmerPriorities,
  regionTag?: string | null
): StrategyResult[] {
  if (!storedStrategies || storedStrategies.length === 0) return [];
  const validAi = storedStrategies.filter((s) =>
    isVerifiedAiStrategyForField(s, fieldId)
  );
  if (validAi.length === 0) return [];
  const seenIds = new Set<string>();
  const uniqueValid: RotationStrategy[] = [];
  for (const s of validAi) {
    if (!seenIds.has(s.id)) {
      seenIds.add(s.id);
      uniqueValid.push(s);
    }
  }
  return rankStrategyResults(
    uniqueValid.map((s) => scoreStrategy(s, climate, soil, priorities, regionTag))
  );
}

/**
 * Resolve a single verified AI-generated strategy by ID for the given field
 * and return its scored and ranked result. Never falls back to static templates.
 */
export function resolveScoredStrategyById(
  strategyId: string,
  generatedStrategies: RotationStrategy[] | null | undefined,
  climate: ClimateData,
  soil: SoilData | null,
  priorities: FarmerPriorities,
  regionTag?: string | null,
  fieldId?: string
): StrategyResult | null {
  const ranked = scoreVerifiedAiStrategies(
    generatedStrategies,
    fieldId,
    climate,
    soil,
    priorities,
    regionTag
  );
  return ranked.find((r) => r.strategy.id === strategyId) ?? null;
}

export function normalizePriorities(p: FarmerPriorities): FarmerPriorities {
  const total = Object.values(p).reduce((a, b) => a + b, 0);
  if (total <= 0) return { ...DEFAULT_PRIORITIES };
  const keys = Object.keys(p) as FactorKey[];
  const normalized: Partial<FarmerPriorities> = {};
  for (const key of keys) {
    normalized[key] = Math.round((p[key] / total) * 100);
  }
  return normalized as FarmerPriorities;
}
