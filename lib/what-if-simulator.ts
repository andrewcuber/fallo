/**
 * Pure, deterministic What-If Climate Scenario Simulator for fallo.
 *
 * Responsibilities:
 * - Apply hypothetical temperature (°C) and precipitation (% or mm) adjustments
 *   to an observed NASA POWER ClimateData record without mutating the baseline record.
 * - Document all physical/heuristic assumptions transparently.
 * - Compare baseline vs. scenario agroecological classification, GAEZ v5 moisture/LGP
 *   indicators, water regime, crop-level suitability, and 5-factor rotation strategy scores.
 */

import {
  type ClimateData,
  type SoilData,
  type FarmerPriorities,
  type RotationStrategy,
  type StrategyResult,
  type FactorKey,
  type Crop,
  cropLibrary,
  scoreStrategy,
  rankStrategyResults,
  getAvailableCropsForContext,
} from "@/lib/rotation-scoring";
import {
  classifyAgGroup,
  formatAgGroupLabel,
  formatMoistureZoneLabel,
  formatWaterRegimeLabel,
  type ClassificationResult,
} from "@/lib/agro-classifier";
import { detectRegionTag } from "@/lib/region";

export type PrecipAdjustmentMode = "percent" | "absolute_mm";

export interface WhatIfScenario {
  /** Temperature change in °C (e.g. -3.0 to +5.0 °C) */
  tempDeltaC: number;
  /** Whether precipitation is adjusted by percentage or absolute annual mm */
  precipMode: PrecipAdjustmentMode;
  /** Percentage change in precipitation (e.g. -50 to +50 %) when precipMode === "percent" */
  precipDeltaPct: number;
  /** Absolute annual precipitation change in mm (e.g. -400 to +400 mm) when precipMode === "absolute_mm" */
  precipDeltaMm: number;
  /** Optional preset label if chosen from a scenario preset */
  presetName?: string;
}

export const DEFAULT_WHAT_IF_SCENARIO: WhatIfScenario = {
  tempDeltaC: 0,
  precipMode: "percent",
  precipDeltaPct: 0,
  precipDeltaMm: 0,
};

export interface WhatIfPreset {
  id: string;
  name: string;
  shortDesc: string;
  scenario: WhatIfScenario;
}

export const WHAT_IF_PRESETS: WhatIfPreset[] = [
  {
    id: "warmer_drier_moderate",
    name: "Moderate Warming & Drying (+1.5 °C, −15% rain)",
    shortDesc: "Mid-century warmer, drier growing season with longer summer dry spells.",
    scenario: {
      tempDeltaC: 1.5,
      precipMode: "percent",
      precipDeltaPct: -15,
      precipDeltaMm: -150,
      presetName: "Moderate Warming & Drying",
    },
  },
  {
    id: "severe_heat_drought",
    name: "Hot & Dry Stress (+2.5 °C, −30% rain)",
    shortDesc: "Severe heat and moisture deficit testing drought-hardy crop sequences.",
    scenario: {
      tempDeltaC: 2.5,
      precipMode: "percent",
      precipDeltaPct: -30,
      precipDeltaMm: -300,
      presetName: "Hot & Dry Stress",
    },
  },
  {
    id: "warmer_wetter",
    name: "Warmer & Wetter Season (+1.5 °C, +20% rain)",
    shortDesc: "Higher thermal accumulation paired with heavier seasonal rainfall.",
    scenario: {
      tempDeltaC: 1.5,
      precipMode: "percent",
      precipDeltaPct: 20,
      precipDeltaMm: 200,
      presetName: "Warmer & Wetter",
    },
  },
  {
    id: "cooler_wet_spring",
    name: "Cooler & Moister (−1.0 °C, +15% rain)",
    shortDesc: "Reduced evaporative demand and higher soil moisture availability.",
    scenario: {
      tempDeltaC: -1.0,
      precipMode: "percent",
      precipDeltaPct: 15,
      precipDeltaMm: 150,
      presetName: "Cooler & Moister",
    },
  },
];

const SHORT_MONTHS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
] as const;

/**
 * Convert machine-readable enum values (e.g. "moderate_to_high", "very_high", "cash")
 * into clean, consistent human-readable labels ("Moderate to high", "Very high", "Cash crop").
 */
export function formatEnumLabel(value: string | null | undefined): string {
  if (!value) return "—";
  const normalized = value.trim().toLowerCase();
  switch (normalized) {
    case "cash":
      return "Cash crop";
    case "cover":
      return "Cover crop";
    case "fallow":
    case "winter_fallow":
      return "Managed fallow";
    case "very_high":
      return "Very high";
    case "moderate_to_high":
      return "Moderate to high";
    case "low_to_moderate":
      return "Low to moderate";
    case "high":
      return "High";
    case "moderate":
      return "Moderate";
    case "low":
      return "Low";
    case "irrigated_or_rainfed":
      return "Irrigated or rainfed";
    case "rainfed_or_supplemental":
      return "Rainfed or supplemental";
    case "irrigated_primary":
      return "Primarily irrigated";
    default: {
      const spaced = normalized.replace(/_/g, " ");
      return spaced.charAt(0).toUpperCase() + spaced.slice(1);
    }
  }
}

/**
 * Humanize a crop identifier (e.g. "grain_sorghum", "hairy_vetch", "desert_tepary_bean")
 * into its proper common name from `cropLibrary`.
 */
export function formatCropName(cropIdOrName: string | null | undefined): string {
  if (!cropIdOrName) return "—";
  if (cropIdOrName === "winter_fallow" || cropIdOrName === "fallow") {
    return "Managed Fallow";
  }
  const found = cropLibrary[cropIdOrName];
  if (found?.commonName) return found.commonName;
  return cropIdOrName
    .split("_")
    .map((part) => (part ? part.charAt(0).toUpperCase() + part.slice(1) : ""))
    .join(" ");
}

/**
 * Format a list of crop IDs into a readable sequence of proper crop names.
 */
export function formatSeasonSequenceNames(cropIds: string[]): string {
  if (cropIds.length === 0) return "—";
  return cropIds.map((id) => formatCropName(id)).join(" → ");
}

export function isBaselineScenario(scenario: WhatIfScenario): boolean {
  const tempZero = Math.abs(scenario.tempDeltaC) < 1e-6;
  const precipZero =
    scenario.precipMode === "percent"
      ? Math.abs(scenario.precipDeltaPct) < 1e-6
      : Math.abs(scenario.precipDeltaMm) < 1e-6;
  return tempZero && precipZero;
}

export function formatScenarioSummary(scenario: WhatIfScenario): string {
  if (isBaselineScenario(scenario)) {
    return "Baseline (Observed 20-year climate record, 0 °C / 0% change)";
  }
  const tempPart =
    scenario.tempDeltaC >= 0
      ? `+${scenario.tempDeltaC.toFixed(1)} °C`
      : `${scenario.tempDeltaC.toFixed(1)} °C`;
  const precipPart =
    scenario.precipMode === "percent"
      ? scenario.precipDeltaPct >= 0
        ? `+${scenario.precipDeltaPct.toFixed(0)}% rainfall`
        : `${scenario.precipDeltaPct.toFixed(0)}% rainfall`
      : scenario.precipDeltaMm >= 0
        ? `+${scenario.precipDeltaMm.toFixed(0)} mm/yr rainfall`
        : `${scenario.precipDeltaMm.toFixed(0)} mm/yr rainfall`;
  return `Hypothetical Scenario (${tempPart}, ${precipPart})`;
}

/**
 * Pure function that constructs a hypothetical ClimateData object from a baseline
 * observed ClimateData record and a WhatIfScenario. Never mutates `baseline`.
 */
export function applyWhatIfScenarioToClimate(
  baseline: ClimateData,
  scenario: WhatIfScenario
): {
  scenarioClimate: ClimateData;
  effectivePrecipMultiplier: number;
  effectiveAnnualPrecipDeltaMm: number;
  assumptions: string[];
} {
  const tempDelta = Number.isFinite(scenario.tempDeltaC) ? scenario.tempDeltaC : 0;
  const baseAnnualPrecip = baseline.fullRecord.avgAnnualPrecip;

  let precipMultiplier = 1;
  if (scenario.precipMode === "percent") {
    const pct = Number.isFinite(scenario.precipDeltaPct) ? scenario.precipDeltaPct : 0;
    precipMultiplier = Math.max(0, 1 + pct / 100);
  } else {
    const deltaMm = Number.isFinite(scenario.precipDeltaMm) ? scenario.precipDeltaMm : 0;
    if (baseAnnualPrecip !== null && baseAnnualPrecip > 0) {
      precipMultiplier = Math.max(0, (baseAnnualPrecip + deltaMm) / baseAnnualPrecip);
    } else {
      precipMultiplier = 1;
    }
  }

  const nextAvgTemp =
    baseline.fullRecord.avgAnnualTemp !== null
      ? baseline.fullRecord.avgAnnualTemp + tempDelta
      : null;

  let nextAvgPrecip: number | null = null;
  if (baseAnnualPrecip !== null) {
    if (scenario.precipMode === "absolute_mm" && baseAnnualPrecip === 0) {
      nextAvgPrecip = Math.max(0, scenario.precipDeltaMm);
    } else {
      nextAvgPrecip = Math.max(0, baseAnnualPrecip * precipMultiplier);
    }
  }

  const nextMonthlyTemp = baseline.fullRecord.monthlyTemp.map((t) =>
    t !== null ? t + tempDelta : null
  );

  const nextMonthlyPrecip = baseline.fullRecord.monthlyPrecip.map((p) => {
    if (p === null) return null;
    if (
      scenario.precipMode === "absolute_mm" &&
      (baseAnnualPrecip === null || baseAnnualPrecip === 0)
    ) {
      return Math.max(0, p + scenario.precipDeltaMm / 12);
    }
    return Math.max(0, p * precipMultiplier);
  });

  // Stress metrics scaling with transparent physical heuristics
  const baseDryDays = baseline.stressMetrics.summerDrySpells.avgMaxConsecutiveDryDays;
  let nextDryDays: number | null = null;
  if (baseDryDays !== null) {
    const safeMult = Math.max(0.2, precipMultiplier);
    const rainFactor = Math.pow(1 / safeMult, 0.65);
    const evapWarmingFactor = Math.max(0.7, 1 + 0.04 * tempDelta);
    nextDryDays = Math.min(92, Math.max(0, baseDryDays * rainFactor * evapWarmingFactor));
  }

  const baseHeatDays = baseline.stressMetrics.summerHeatDays.avgDaysAboveThreshold;
  let nextHeatDays: number | null = null;
  if (baseHeatDays !== null) {
    const julTemp = baseline.fullRecord.monthlyTemp[6];
    const augTemp = baseline.fullRecord.monthlyTemp[7];
    const summerMean =
      julTemp !== null && augTemp !== null
        ? (julTemp + augTemp) / 2
        : (baseline.fullRecord.avgAnnualTemp ?? 20);
    // Sensitivity of days >35 °C to ΔT depends on how close summer mean is to the 35 °C tail
    const daysPerDegC = summerMean >= 22 ? 3.5 : summerMean >= 17 ? 2.0 : 0.8;
    nextHeatDays = Math.min(62, Math.max(0, baseHeatDays + tempDelta * daysPerDegC));
  }

  const baseSpringPrecip = baseline.stressMetrics.springPrecip.avgTotalMm;
  const nextSpringPrecip =
    baseSpringPrecip !== null ? Math.max(0, baseSpringPrecip * precipMultiplier) : null;

  const baseGsPrecip = baseline.stressMetrics.growingSeasonPrecip.avgTotalMm;
  const nextGsPrecip =
    baseGsPrecip !== null ? Math.max(0, baseGsPrecip * precipMultiplier) : null;

  const effectiveAnnualPrecipDeltaMm =
    nextAvgPrecip !== null && baseAnnualPrecip !== null
      ? nextAvgPrecip - baseAnnualPrecip
      : 0;

  const assumptions = [
    `Temperature shift (${tempDelta >= 0 ? "+" : ""}${tempDelta.toFixed(1)} °C) is applied uniformly across all 12 monthly means and the annual mean.`,
    scenario.precipMode === "percent"
      ? `Precipitation change (${scenario.precipDeltaPct >= 0 ? "+" : ""}${scenario.precipDeltaPct.toFixed(0)}%, multiplier ${precipMultiplier.toFixed(2)}×) scales monthly, spring (Mar–May), growing-season (May–Aug), and annual precipitation proportionally, preserving seasonal distribution.`
      : `Absolute precipitation change (${scenario.precipDeltaMm >= 0 ? "+" : ""}${scenario.precipDeltaMm.toFixed(0)} mm/yr, effective multiplier ${precipMultiplier.toFixed(2)}×) scales monthly and seasonal totals proportionally to each month's share of baseline rainfall.`,
    `Summer consecutive dry days (<1 mm in Jun–Aug) scale with both rainfall deficit ((1/rainMultiplier)^0.65) and warming-driven evaporative demand (+4% per +1 °C).`,
    `Jul–Aug extreme heat days (>35 °C) adjust by ${
      (baseline.fullRecord.monthlyTemp[6] ?? 22) >= 22 ? "3.5" : "2.0"
    } days per 1 °C change based on summer baseline temperature.`,
    `Solar radiation and soil properties (texture, AWC, OM, pH, drainage, slope) are held constant at baseline values.`,
  ];

  const scenarioSummary = formatScenarioSummary(scenario);

  const scenarioClimate: ClimateData = {
    ...baseline,
    location: { ...baseline.location },
    fullRecord: {
      ...baseline.fullRecord,
      avgAnnualTemp: nextAvgTemp,
      avgAnnualPrecip: nextAvgPrecip,
      monthlyTemp: nextMonthlyTemp,
      monthlyPrecip: nextMonthlyPrecip,
      monthlySolar: [...baseline.fullRecord.monthlySolar],
    },
    stressMetrics: {
      summerDrySpells: {
        ...baseline.stressMetrics.summerDrySpells,
        avgMaxConsecutiveDryDays: nextDryDays,
      },
      summerHeatDays: {
        ...baseline.stressMetrics.summerHeatDays,
        avgDaysAboveThreshold: nextHeatDays,
      },
      springPrecip: {
        ...baseline.stressMetrics.springPrecip,
        avgTotalMm: nextSpringPrecip,
      },
      growingSeasonPrecip: {
        ...baseline.stressMetrics.growingSeasonPrecip,
        avgTotalMm: nextGsPrecip,
      },
    },
    source: `${baseline.source} — Modified with ${scenarioSummary}`,
    limitations: [
      `HYPOTHETICAL SCENARIO: ${scenarioSummary}. Not observed weather.`,
      ...assumptions,
      ...baseline.limitations,
    ],
  };

  return {
    scenarioClimate,
    effectivePrecipMultiplier: precipMultiplier,
    effectiveAnnualPrecipDeltaMm,
    assumptions,
  };
}

export type CropSuitabilityShift =
  | "improved"
  | "stable"
  | "stressed"
  | "newly_viable"
  | "no_longer_viable";

export interface CropScenarioComparison {
  cropId: string;
  commonName: string;
  family: string;
  type: "cash" | "cover";
  waterDemand: string;
  droughtTolerance: string;
  inBaselineCatalog: boolean;
  inScenarioCatalog: boolean;
  baselineSuitabilityScore: number;
  scenarioSuitabilityScore: number;
  scoreDelta: number;
  shift: CropSuitabilityShift;
  explanation: string;
}

function extractPrimarySensitiveStage(crop: Crop): {
  stageName: string;
  monthsLabel: string;
  note: string;
  hasSummerMonths: boolean;
} | null {
  const entries = Object.entries(crop.sensitivePeriods ?? {});
  if (entries.length === 0) return null;
  const [rawKey, detail] = entries[0];
  const stageName = rawKey
    .replace(/([A-Z])/g, " $1")
    .replace(/_/g, " ")
    .trim()
    .toLowerCase();
  const monthsLabel = detail.months
    .map((m) => SHORT_MONTHS[(m - 1 + 12) % 12])
    .join("–");
  const hasSummerMonths = detail.months.some((m) => m === 6 || m === 7 || m === 8);
  return {
    stageName,
    monthsLabel,
    note: detail.note,
    hasSummerMonths,
  };
}

function summarizeCropWindowClause(crop: Crop): string {
  const plant = crop.growingWindow.planting?.split("/")[0]?.trim();
  const end = (crop.growingWindow.harvest ?? crop.growingWindow.termination)
    ?.split("/")[0]
    ?.trim();
  if (plant && end) {
    return `${plant} to ${end}`;
  }
  if (plant) return `planted ${plant}`;
  return crop.type === "cover" ? "seasonal cover window" : "primary cropping window";
}

function summarizeRootAndNitrogenTraits(crop: Crop): string {
  const parts: string[] = [];
  if (crop.rootSystem) {
    const cleanRoot = crop.rootSystem.replace(/\.$/, "").trim();
    parts.push(cleanRoot.charAt(0).toLowerCase() + cleanRoot.slice(1));
  }
  const nCredit = crop.nitrogenBehavior?.residualNcredit?.value;
  if (nCredit) {
    parts.push(`biological N fixation (${nCredit} est. residual credit)`);
  } else if (crop.family === "Fabaceae") {
    parts.push("symbiotic N fixation");
  } else if (crop.nitrogenBehavior?.demand === "high") {
    parts.push("high nitrogen demand");
  }
  return parts.join("; ");
}

/**
 * Compute a deterministic 0–100 climate-suitability index for an individual crop
 * under a given ClimateData + ClassificationResult context so Baseline and Scenario
 * can be compared transparently.
 */
export function evaluateSingleCropClimateFit(
  crop: Crop,
  climate: ClimateData,
  classification: ClassificationResult,
  inCatalog: boolean
): { score: number; notes: string[] } {
  let score = inCatalog ? 78 : 35;
  const notes: string[] = [];

  const gsRain = climate.stressMetrics.growingSeasonPrecip.avgTotalMm ?? 350;
  const springRain = climate.stressMetrics.springPrecip.avgTotalMm ?? 240;
  const annualRain = climate.fullRecord.avgAnnualPrecip ?? 800;
  const dryDays = climate.stressMetrics.summerDrySpells.avgMaxConsecutiveDryDays ?? 7;
  const heatDays = climate.stressMetrics.summerHeatDays.avgDaysAboveThreshold ?? 5;
  const primarySensitive = extractPrimarySensitiveStage(crop);

  // Water demand vs seasonal moisture supply
  if (crop.waterDemand === "high") {
    if (gsRain < 260 || annualRain < 550) {
      score -= 22;
      notes.push("High water demand faces moisture deficit under reduced rainfall");
    } else if (gsRain < 330) {
      score -= 10;
    } else if (gsRain >= 420) {
      score += 8;
      notes.push("Ample growing-season rainfall supports high water demand");
    }
  } else if (crop.waterDemand === "moderate_to_high") {
    if (gsRain < 240 || annualRain < 500) {
      score -= 15;
      notes.push("Moderate-to-high water demand stressed by lower seasonal rainfall");
    } else if (gsRain < 310) {
      score -= 7;
    } else if (gsRain >= 380) {
      score += 6;
    }
  } else if (crop.waterDemand === "moderate") {
    if (gsRain < 210 || annualRain < 450) {
      score -= 10;
    } else if (gsRain >= 340 && gsRain <= 650) {
      score += 4;
    }
  } else if (crop.waterDemand === "low" || crop.waterDemand === "low_to_moderate") {
    if (gsRain < 300 || dryDays > 12) {
      score += crop.waterDemand === "low" ? 11 : 8;
      notes.push("Low water demand provides resilience under drier conditions");
    } else if (annualRain > 1400 || springRain > 420) {
      score -= 8;
      notes.push("Excess rainfall may increase disease pressure for dry-adapted crop");
    }
  }

  // Drought tolerance vs summer dry spells
  if (dryDays > 10) {
    if (crop.droughtTolerance === "very_high") {
      score += 10;
    } else if (crop.droughtTolerance === "high") {
      score += 7;
      notes.push(`High drought tolerance buffers ${dryDays.toFixed(0)}-day dry spells`);
    } else if (crop.droughtTolerance === "low") {
      score -= 16;
      notes.push(`Low drought tolerance vulnerable to ${dryDays.toFixed(0)}-day dry spells`);
    } else {
      score -= 7;
    }
  } else if (dryDays <= 7 && (crop.droughtTolerance === "low" || crop.waterDemand === "high")) {
    score += 4;
  }

  // Heat stress during sensitive periods
  if (heatDays > 10) {
    if (primarySensitive?.hasSummerMonths && crop.droughtTolerance !== "high" && crop.droughtTolerance !== "very_high") {
      score -= Math.min(18, Math.round((heatDays - 8) * 1.1));
      notes.push(
        `Elevated Jul–Aug heat days (${heatDays.toFixed(0)} days >35 °C) overlap ${primarySensitive.stageName}`
      );
    } else if (crop.droughtTolerance === "high" || crop.droughtTolerance === "very_high") {
      score -= Math.min(5, Math.round(Math.max(0, heatDays - 14) * 0.4));
    } else {
      score -= Math.min(9, Math.round((heatDays - 10) * 0.6));
    }
  }

  if (!inCatalog) {
    notes.push(
      `Outside verified catalog for ${formatAgGroupLabel(classification.group)}`
    );
  }

  return {
    score: Math.max(0, Math.min(100, Math.round(score))),
    notes,
  };
}

/**
 * Build a crop-specific, source-grounded agronomic explanation describing how
 * and why a crop's suitability responds to the active scenario.
 */
function buildCropScenarioExplanation(params: {
  crop: Crop;
  scenario: WhatIfScenario;
  baselineClimate: ClimateData;
  scenarioClimate: ClimateData;
  baselineClassification: ClassificationResult;
  scenarioClassification: ClassificationResult;
  inBaseline: boolean;
  inScenario: boolean;
  scoreDelta: number;
}): string {
  const {
    crop,
    scenario,
    baselineClimate,
    scenarioClimate,
    baselineClassification,
    scenarioClassification,
    inBaseline,
    inScenario,
    scoreDelta,
  } = params;

  const waterText = formatEnumLabel(crop.waterDemand).toLowerCase();
  const droughtText = formatEnumLabel(crop.droughtTolerance).toLowerCase();
  const windowClause = summarizeCropWindowClause(crop);
  const rootAndN = summarizeRootAndNitrogenTraits(crop);
  const sensitive = extractPrimarySensitiveStage(crop);

  const baseGsRain = baselineClimate.stressMetrics.growingSeasonPrecip.avgTotalMm ?? 350;
  const scenGsRain = scenarioClimate.stressMetrics.growingSeasonPrecip.avgTotalMm ?? 350;
  const gsRainDelta = Math.round(scenGsRain - baseGsRain);

  const baseDryDays =
    baselineClimate.stressMetrics.summerDrySpells.avgMaxConsecutiveDryDays ?? 7;
  const scenDryDays =
    scenarioClimate.stressMetrics.summerDrySpells.avgMaxConsecutiveDryDays ?? 7;

  const baseHeatDays =
    baselineClimate.stressMetrics.summerHeatDays.avgDaysAboveThreshold ?? 5;
  const scenHeatDays =
    scenarioClimate.stressMetrics.summerHeatDays.avgDaysAboveThreshold ?? 5;

  // 1. Zone catalog boundary change
  if (!inBaseline && inScenario) {
    return `${crop.commonName} (${crop.family}, ${waterText} water demand, ${droughtText} drought tolerance) enters the verified regional catalog as the climate zone shifts from ${formatAgGroupLabel(baselineClassification.group)} to ${formatAgGroupLabel(scenarioClassification.group)}.`;
  }
  if (inBaseline && !inScenario) {
    return `${crop.commonName} (${crop.family}, ${windowClause}) moves outside the verified catalog as the field's climate zone shifts from ${formatAgGroupLabel(baselineClassification.group)} to ${formatAgGroupLabel(scenarioClassification.group)}.`;
  }

  // 2. Baseline (0 °C / 0% change)
  if (isBaselineScenario(scenario)) {
    const stagePart = sensitive
      ? `; sensitive during ${sensitive.stageName} (${sensitive.monthsLabel})`
      : "";
    return `${crop.commonName} (${windowClause}; ${waterText} water demand, ${droughtText} drought tolerance${stagePart}) has ${rootAndN || "documented regional adaptation"} suited to baseline moisture (${Math.round(baseGsRain)} mm growing-season rain).`;
  }

  // 3. Suitability Improved (scoreDelta > 0)
  if (scoreDelta > 0) {
    if (gsRainDelta < 0 || scenDryDays > baseDryDays) {
      return `${crop.commonName} gains a relative advantage (+${scoreDelta} pts) as growing-season rain shifts to ${Math.round(scenGsRain)} mm (${scenDryDays.toFixed(0)}-day dry spells): its ${waterText} water demand, ${droughtText} drought tolerance, and ${rootAndN || windowClause} buffer drier conditions.`;
    }
    if (gsRainDelta > 0) {
      const stageDetail = sensitive
        ? ` during ${sensitive.stageName} (${sensitive.monthsLabel})`
        : ` across its ${windowClause} window`;
      return `${crop.commonName} improves (+${scoreDelta} pts) with ${Math.round(scenGsRain)} mm growing-season rainfall (+${gsRainDelta} mm), reducing moisture stress for its ${waterText} water demand${stageDetail}.`;
    }
    return `${crop.commonName} improves (+${scoreDelta} pts) as cooler temperatures (${scenHeatDays.toFixed(0)} days >35 °C vs. ${baseHeatDays.toFixed(0)} baseline) reduce thermal stress across its ${windowClause} growth cycle.`;
  }

  // 4. Suitability Decreased / Stressed (scoreDelta < 0)
  if (scoreDelta < 0) {
    if (
      sensitive &&
      scenHeatDays > baseHeatDays &&
      (scenHeatDays > 10 || scenario.tempDeltaC >= 1.5)
    ) {
      return `${crop.commonName} declines (${scoreDelta} pts): ${scenHeatDays.toFixed(0)} extreme heat days (>35 °C) and ${scenDryDays.toFixed(0)}-day dry spells overlap ${sensitive.stageName} (${sensitive.monthsLabel}), where ${crop.commonName.toLowerCase()} is sensitive to heat and moisture deficits.`;
    }
    if (gsRainDelta < 0 || scenDryDays > baseDryDays) {
      return `${crop.commonName} declines (${scoreDelta} pts) under ${Math.round(scenGsRain)} mm growing-season rain (${gsRainDelta} mm) and ${scenDryDays.toFixed(0)}-day dry spells due to its ${waterText} water demand, ${droughtText} drought tolerance, and ${rootAndN || windowClause}.`;
    }
    if (gsRainDelta > 0 && (crop.waterDemand === "low" || crop.waterDemand === "low_to_moderate")) {
      return `${crop.commonName} declines slightly (${scoreDelta} pts) under wetter conditions (${Math.round(scenGsRain)} mm seasonal rain); as a dry-adapted ${crop.family} crop (${waterText} water demand), heavier moisture can increase disease or lodging pressure.`;
    }
    return `${crop.commonName} faces added thermal stress (${scoreDelta} pts) under ${formatScenarioSummary(scenario)} during its ${windowClause} window (${waterText} water demand, ${droughtText} drought tolerance).`;
  }

  // 5. Suitability Stable (scoreDelta === 0)
  const stageMention = sensitive
    ? ` and ${sensitive.stageName} window (${sensitive.monthsLabel})`
    : "";
  return `${crop.commonName} remains stable (${waterText} water demand, ${droughtText} drought tolerance; ${windowClause}${stageMention}) because ${Math.round(scenGsRain)} mm seasonal rain and ${scenDryDays.toFixed(0)}-day dry spells stay within its documented tolerance range.`;
}

function buildStrategyScenarioExplanation(params: {
  strategy: RotationStrategy;
  scenario: WhatIfScenario;
  overallDelta: number | null;
  factorDeltas: Record<FactorKey, number | null>;
}): string {
  const { strategy, scenario, overallDelta, factorDeltas } = params;
  const cashCrops = Array.from(
    new Set(
      strategy.years.flatMap((y) =>
        y.seasons
          .filter((s) => cropLibrary[s.crop]?.type === "cash")
          .map((s) => formatCropName(s.crop))
      )
    )
  );
  const coverCrops = Array.from(
    new Set(
      strategy.years.flatMap((y) =>
        y.seasons
          .filter((s) => cropLibrary[s.crop]?.type === "cover")
          .map((s) => formatCropName(s.crop))
      )
    )
  );
  const cropSummary =
    cashCrops.length > 0
      ? `${cashCrops.join(", ")}${coverCrops.length > 0 ? ` with ${coverCrops.join(", ")} cover` : ""}`
      : strategy.name;

  if (isBaselineScenario(scenario) || overallDelta === null) {
    return `Evaluates ${cropSummary} under observed baseline climate and soil conditions.`;
  }

  const waterDelta = factorDeltas.waterSuitability ?? 0;
  const riskDelta = factorDeltas.climateRiskResilience ?? 0;

  if (overallDelta > 0) {
    return `Gains +${overallDelta} pts overall (Water Suitability ${waterDelta >= 0 ? `+${waterDelta}` : waterDelta}, Climate Resilience ${riskDelta >= 0 ? `+${riskDelta}` : riskDelta}) as ${cropSummary} aligns well with the adjusted temperature and moisture regime.`;
  }
  if (overallDelta < 0) {
    return `Changes by ${overallDelta} pts overall (Water Suitability ${waterDelta >= 0 ? `+${waterDelta}` : waterDelta}, Climate Resilience ${riskDelta >= 0 ? `+${riskDelta}` : riskDelta}) reflecting heightened moisture or heat stress across ${cropSummary}.`;
  }
  return `Overall score holds steady across ${cropSummary} (Water Suitability ${waterDelta >= 0 ? `+${waterDelta}` : waterDelta}, Climate Resilience ${riskDelta >= 0 ? `+${riskDelta}` : riskDelta}).`;
}

export interface StrategyScenarioComparison {
  strategyId: string;
  strategyName: string;
  archetype: string;
  baselineResult: StrategyResult;
  scenarioResult: StrategyResult;
  overallDelta: number | null;
  rankDelta: number; // positive means improved rank (e.g. rank 2 -> rank 1 = +1)
  factorDeltas: Record<FactorKey, number | null>;
  explanation: string;
}

export interface WhatIfEvaluationResult {
  scenario: WhatIfScenario;
  isBaseline: boolean;
  scenarioSummary: string;
  assumptions: string[];
  effectivePrecipMultiplier: number;
  effectiveAnnualPrecipDeltaMm: number;
  baselineClimate: ClimateData;
  scenarioClimate: ClimateData;
  baselineClassification: ClassificationResult;
  scenarioClassification: ClassificationResult;
  agGroupChanged: boolean;
  waterRegimeChanged: boolean;
  moistureZoneChanged: boolean;
  lgpDeltaDays: number | null;
  cropComparisons: CropScenarioComparison[];
  strategyComparisons: StrategyScenarioComparison[];
}

/**
 * Evaluate a complete What-If climate scenario against the field's baseline
 * observed climate, soil profile, farmer priorities, and rotation strategies.
 */
export function evaluateWhatIfScenario(params: {
  baselineClimate: ClimateData;
  soil: SoilData | null;
  priorities: FarmerPriorities;
  strategies: RotationStrategy[];
  scenario: WhatIfScenario;
  regionTag?: string | null;
}): WhatIfEvaluationResult {
  const { baselineClimate, soil, priorities, strategies, scenario } = params;
  const effectiveRegionTag =
    params.regionTag !== undefined
      ? params.regionTag
      : detectRegionTag(baselineClimate.location.lat, baselineClimate.location.lon);

  const {
    scenarioClimate,
    effectivePrecipMultiplier,
    effectiveAnnualPrecipDeltaMm,
    assumptions,
  } = applyWhatIfScenarioToClimate(baselineClimate, scenario);

  const baselineClassification = classifyAgGroup(baselineClimate, soil);
  const scenarioClassification = classifyAgGroup(scenarioClimate, soil);

  const baselineCatalogIds = new Set(
    getAvailableCropsForContext(baselineClassification.group, effectiveRegionTag)
  );
  const scenarioCatalogIds = new Set(
    getAvailableCropsForContext(scenarioClassification.group, effectiveRegionTag)
  );

  // Include all crops from baseline catalog, scenario catalog, and active strategies
  const allRelevantCropIds = new Set<string>([
    ...Array.from(baselineCatalogIds),
    ...Array.from(scenarioCatalogIds),
  ]);
  for (const s of strategies) {
    for (const yr of s.years) {
      for (const sea of yr.seasons) {
        if (sea.crop && sea.crop !== "winter_fallow" && cropLibrary[sea.crop]) {
          allRelevantCropIds.add(sea.crop);
        }
      }
    }
  }

  const cropComparisons: CropScenarioComparison[] = Array.from(allRelevantCropIds)
    .map((cropId) => {
      const crop = cropLibrary[cropId];
      if (!crop) return null;
      const inBaseline = baselineCatalogIds.has(cropId);
      const inScenario = scenarioCatalogIds.has(cropId);
      const baseFit = evaluateSingleCropClimateFit(
        crop,
        baselineClimate,
        baselineClassification,
        inBaseline
      );
      const scenFit = evaluateSingleCropClimateFit(
        crop,
        scenarioClimate,
        scenarioClassification,
        inScenario
      );
      const scoreDelta = scenFit.score - baseFit.score;

      let shift: CropSuitabilityShift = "stable";
      if (!inBaseline && inScenario) {
        shift = "newly_viable";
      } else if (inBaseline && !inScenario) {
        shift = "no_longer_viable";
      } else if (scoreDelta >= 4) {
        shift = "improved";
      } else if (scoreDelta <= -4) {
        shift = "stressed";
      }

      const explanation = buildCropScenarioExplanation({
        crop,
        scenario,
        baselineClimate,
        scenarioClimate,
        baselineClassification,
        scenarioClassification,
        inBaseline,
        inScenario,
        scoreDelta,
      });

      return {
        cropId,
        commonName: crop.commonName,
        family: crop.family,
        type: crop.type,
        waterDemand: crop.waterDemand,
        droughtTolerance: crop.droughtTolerance,
        inBaselineCatalog: inBaseline,
        inScenarioCatalog: inScenario,
        baselineSuitabilityScore: baseFit.score,
        scenarioSuitabilityScore: scenFit.score,
        scoreDelta,
        shift,
        explanation,
      };
    })
    .filter((item): item is CropScenarioComparison => item !== null)
    .sort((a, b) => a.scoreDelta - b.scoreDelta);

  // Score strategies under baseline and scenario
  const baselineResults = rankStrategyResults(
    strategies.map((s) =>
      scoreStrategy(s, baselineClimate, soil, priorities, effectiveRegionTag)
    )
  );
  const scenarioResults = rankStrategyResults(
    strategies.map((s) =>
      scoreStrategy(s, scenarioClimate, soil, priorities, effectiveRegionTag)
    )
  );

  const scenarioById = new Map(scenarioResults.map((r) => [r.strategy.id, r]));
  const factorKeys: FactorKey[] = [
    "waterSuitability",
    "nitrogenContribution",
    "soilCoverage",
    "diversityPestBreak",
    "climateRiskResilience",
  ];

  const strategyComparisons: StrategyScenarioComparison[] = baselineResults.map(
    (baseRes) => {
      const scenRes = scenarioById.get(baseRes.strategy.id) ?? baseRes;
      const overallDelta =
        baseRes.overallScore !== null && scenRes.overallScore !== null
          ? scenRes.overallScore - baseRes.overallScore
          : null;
      const rankDelta = baseRes.rank - scenRes.rank;

      const factorDeltas = {} as Record<FactorKey, number | null>;
      for (const k of factorKeys) {
        const bScore = baseRes.factorScores[k]?.score ?? null;
        const sScore = scenRes.factorScores[k]?.score ?? null;
        factorDeltas[k] = bScore !== null && sScore !== null ? sScore - bScore : null;
      }

      return {
        strategyId: baseRes.strategy.id,
        strategyName: baseRes.strategy.name,
        archetype: baseRes.strategy.archetype,
        baselineResult: baseRes,
        scenarioResult: scenRes,
        overallDelta,
        rankDelta,
        factorDeltas,
        explanation: buildStrategyScenarioExplanation({
          strategy: baseRes.strategy,
          scenario,
          overallDelta,
          factorDeltas,
        }),
      };
    }
  );

  const lgpDeltaDays =
    baselineClassification.estimatedLgpDays !== null &&
    baselineClassification.estimatedLgpDays !== undefined &&
    scenarioClassification.estimatedLgpDays !== null &&
    scenarioClassification.estimatedLgpDays !== undefined
      ? scenarioClassification.estimatedLgpDays - baselineClassification.estimatedLgpDays
      : null;

  return {
    scenario,
    isBaseline: isBaselineScenario(scenario),
    scenarioSummary: formatScenarioSummary(scenario),
    assumptions,
    effectivePrecipMultiplier,
    effectiveAnnualPrecipDeltaMm,
    baselineClimate,
    scenarioClimate,
    baselineClassification,
    scenarioClassification,
    agGroupChanged: baselineClassification.group !== scenarioClassification.group,
    waterRegimeChanged:
      formatWaterRegimeLabel(baselineClassification.waterRegime) !==
      formatWaterRegimeLabel(scenarioClassification.waterRegime),
    moistureZoneChanged:
      formatMoistureZoneLabel(baselineClassification.gaezMoistureZone) !==
      formatMoistureZoneLabel(scenarioClassification.gaezMoistureZone),
    lgpDeltaDays,
    cropComparisons,
    strategyComparisons,
  };
}
