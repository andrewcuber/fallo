/**
 * Deterministic global agroecological group classifier for fallo.
 *
 * Principles:
 * - Uses actual climate, elevation, and soil data, grounded in FAO/IIASA GAEZ v5
 *   thermal regimes, moisture regimes, and Length of Growing Period (LGP) indicators.
 * - Returns explicit confidence and evidence levels; unknown/insufficient-data is a valid outcome.
 * - Separates agroecological classification, water regime (rainfed vs. irrigated),
 *   dominant seasonality, and soil data quality.
 * - Rules are transparent, deterministic, and never invent field characteristics.
 */

import type { ClimateData, SoilData } from "@/lib/rotation-scoring";
import {
  evaluateGaezV5Indicators,
  type EvidenceLevel,
} from "@/lib/global-data-providers";

export type AgGroup =
  | "temperate_humid"
  | "semi_arid_temperate"
  | "subtropical_humid"
  | "temperate_mediterranean"
  | "tropical_humid"
  | "tropical_subhumid"
  | "tropical_savanna"
  | "tropical_monsoon"
  | "tropical_semi_arid"
  | "arid"
  | "continental"
  | "boreal"
  | "highland_montane"
  | "unknown";

export interface DisplayTermInfo {
  label: string;
  description: string;
}

export const AG_GROUP_DISPLAY: Record<AgGroup, DisplayTermInfo> = {
  temperate_humid: {
    label: "Temperate Humid",
    description:
      "Moderate seasonal temperatures with reliable rainfall across the growing season.",
  },
  semi_arid_temperate: {
    label: "Semi-Arid Temperate",
    description:
      "Temperate four-season climate with limited annual rainfall and periodic summer dry spells.",
  },
  subtropical_humid: {
    label: "Subtropical Humid",
    description:
      "Long, warm growing seasons, mild winters, and abundant year-round precipitation.",
  },
  temperate_mediterranean: {
    label: "Mediterranean (Winter-Wet, Summer-Dry)",
    description:
      "Mild, rainy cool seasons followed by warm, dry summers suited to winter grains and pulses.",
  },
  tropical_humid: {
    label: "Humid Tropical",
    description:
      "Warm temperatures year-round with abundant rainfall and a short or absent dry season.",
  },
  tropical_subhumid: {
    label: "Subhumid Tropical",
    description:
      "Warm year-round temperatures with a long rainy growing season and a moderate dry season.",
  },
  tropical_savanna: {
    label: "Tropical Savanna (Wet–Dry Season)",
    description:
      "Warm tropical climate where rainfall is concentrated in a single rainy season followed by a pronounced dry season.",
  },
  tropical_monsoon: {
    label: "Tropical Monsoon",
    description:
      "Warm tropical climate with heavy monsoon rains and a distinct dry season.",
  },
  tropical_semi_arid: {
    label: "Semi-Arid Tropical (Dry Savanna)",
    description:
      "Hot tropical conditions with a short rainy season and elevated drought risk.",
  },
  arid: {
    label: "Arid (Irrigation-Dependent)",
    description:
      "Very low annual rainfall where dependable crop production relies on irrigation.",
  },
  continental: {
    label: "Continental (Cold Winter, Warm Summer)",
    description:
      "Wide seasonal temperature swings with cold winters and a defined spring-to-autumn growing window.",
  },
  boreal: {
    label: "Boreal / Cold Short-Season",
    description:
      "Cold high-latitude climate with a brief frost-free growing period.",
  },
  highland_montane: {
    label: "Highland / Montane",
    description:
      "High-elevation agricultural zone where altitude moderates tropical or subtropical temperatures.",
  },
  unknown: {
    label: "Unclassified Climate Zone",
    description:
      "Climate observations are incomplete or outside supported agricultural zones.",
  },
};

export const AG_GROUP_LABELS: Record<AgGroup, string> = {
  temperate_humid: AG_GROUP_DISPLAY.temperate_humid.label,
  semi_arid_temperate: AG_GROUP_DISPLAY.semi_arid_temperate.label,
  subtropical_humid: AG_GROUP_DISPLAY.subtropical_humid.label,
  temperate_mediterranean: AG_GROUP_DISPLAY.temperate_mediterranean.label,
  tropical_humid: AG_GROUP_DISPLAY.tropical_humid.label,
  tropical_subhumid: AG_GROUP_DISPLAY.tropical_subhumid.label,
  tropical_savanna: AG_GROUP_DISPLAY.tropical_savanna.label,
  tropical_monsoon: AG_GROUP_DISPLAY.tropical_monsoon.label,
  tropical_semi_arid: AG_GROUP_DISPLAY.tropical_semi_arid.label,
  arid: AG_GROUP_DISPLAY.arid.label,
  continental: AG_GROUP_DISPLAY.continental.label,
  boreal: AG_GROUP_DISPLAY.boreal.label,
  highland_montane: AG_GROUP_DISPLAY.highland_montane.label,
  unknown: AG_GROUP_DISPLAY.unknown.label,
};

export const MOISTURE_ZONE_DISPLAY: Record<string, DisplayTermInfo> = {
  humid: {
    label: "Humid (abundant year-round moisture)",
    description:
      "Precipitation supports crop growth for most of the year (270+ moist growing days).",
  },
  subhumid: {
    label: "Subhumid (reliable seasonal moisture)",
    description:
      "Extended rainy season supporting 180–269 growing-period days, followed by a moderate dry season.",
  },
  moist_semi_arid: {
    label: "Semi-arid with seasonal moisture",
    description:
      "Moderate seasonal rainfall (120–179 growing-period days) with a pronounced dry season; timely planting and drought-adapted crops reduce moisture stress.",
  },
  dry_semi_arid: {
    label: "Dry semi-arid (short rainy season)",
    description:
      "Limited seasonal rainfall (60–119 growing-period days) with frequent dry spells; favors short-duration drought-tolerant crops or supplemental water.",
  },
  arid: {
    label: "Arid (very low natural rainfall)",
    description:
      "Minimal natural precipitation (fewer than 60 moist days per year); reliable harvests require irrigation.",
  },
  hyper_arid: {
    label: "Hyper-arid (extreme moisture deficit)",
    description:
      "Year-round desert moisture deficit where cropping is only possible under full irrigation.",
  },
  unknown: {
    label: "Moisture regime unavailable",
    description:
      "Insufficient precipitation data to characterize seasonal moisture conditions.",
  },
};

export const WATER_REGIME_DISPLAY: Record<string, DisplayTermInfo> = {
  rainfed_viable: {
    label: "Rainfed cropping viable",
    description:
      "Natural precipitation is generally sufficient for regionally adapted crops during the primary growing season.",
  },
  supplementary_irrigation_recommended: {
    label: "Rainfed in wet season; supplemental irrigation helpful",
    description:
      "Rainfed crops are viable during the main rainy season, while dry-season crops or mid-season dry spells benefit from supplemental irrigation.",
  },
  irrigation_required: {
    label: "Irrigation required for reliable production",
    description:
      "Natural rainfall is too low to sustain dependable commercial crop yields without irrigation.",
  },
};

export function formatAgGroupLabel(group: AgGroup | string | null | undefined): string {
  if (!group) return AG_GROUP_DISPLAY.unknown.label;
  return (
    AG_GROUP_DISPLAY[group as AgGroup]?.label ??
    group.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase())
  );
}

export function formatAgGroupDescription(group: AgGroup | string | null | undefined): string {
  if (!group) return AG_GROUP_DISPLAY.unknown.description;
  return AG_GROUP_DISPLAY[group as AgGroup]?.description ?? "";
}

export function formatMoistureZoneLabel(zone: string | null | undefined): string {
  if (!zone) return MOISTURE_ZONE_DISPLAY.unknown.label;
  return (
    MOISTURE_ZONE_DISPLAY[zone]?.label ??
    zone.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase())
  );
}

export function formatMoistureZoneDescription(zone: string | null | undefined): string {
  if (!zone) return MOISTURE_ZONE_DISPLAY.unknown.description;
  return MOISTURE_ZONE_DISPLAY[zone]?.description ?? "";
}

export function formatWaterRegimeLabel(regime: string | null | undefined): string {
  if (!regime) return "Rainfed or irrigated depending on season";
  return (
    WATER_REGIME_DISPLAY[regime]?.label ??
    regime.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase())
  );
}

export function formatWaterRegimeDescription(regime: string | null | undefined): string {
  if (!regime) return "";
  return WATER_REGIME_DISPLAY[regime]?.description ?? "";
}

export interface ClassificationResult {
  group: AgGroup;
  confidence: "high" | "moderate" | "low";
  reasons: string[];
  inputsUsed: string[];
  limitations: string[];
  evidenceLevel?: EvidenceLevel;
  waterRegime?:
    | "rainfed_viable"
    | "supplementary_irrigation_recommended"
    | "irrigation_required";
  dominantSeasonality?:
    | "northern_warm_cool"
    | "southern_warm_cool"
    | "tropical_rainy_dry"
    | "mediterranean_winter_wet"
    | "arid_irrigated";
  gaezThermalZone?: string;
  gaezMoistureZone?: string;
  estimatedLgpDays?: number | null;
}

function sum(arr: (number | null)[]): number | null {
  const valid = arr.filter((n): n is number => n !== null);
  if (valid.length === 0) return null;
  return valid.reduce((a, b) => a + b, 0);
}

function summerMonthsPrecip(
  monthlyPrecip: (number | null)[],
  lat = 35
): number | null {
  // Northern hemisphere warm season: Jun, Jul, Aug; Southern hemisphere warm season: Dec, Jan, Feb
  if (lat < 0) {
    return sum([monthlyPrecip[11], monthlyPrecip[0], monthlyPrecip[1]]);
  }
  return sum([monthlyPrecip[5], monthlyPrecip[6], monthlyPrecip[7]]);
}

function winterMonthsPrecip(
  monthlyPrecip: (number | null)[],
  lat = 35
): number | null {
  // Northern hemisphere cool season: Dec, Jan, Feb; Southern hemisphere cool season: Jun, Jul, Aug
  if (lat < 0) {
    return sum([monthlyPrecip[5], monthlyPrecip[6], monthlyPrecip[7]]);
  }
  return sum([monthlyPrecip[11], monthlyPrecip[0], monthlyPrecip[1]]);
}

/**
 * Classify a field into a global agroecological group based on climate, elevation, and soil data.
 *
 * Hard requirements for any classification:
 *   - Annual average temperature must be available.
 *   - Annual precipitation must be available.
 */
export function classifyAgGroup(
  climate: ClimateData,
  soil: SoilData | null
): ClassificationResult {
  const reasons: string[] = [];
  const inputsUsed: string[] = [];
  const limitations: string[] = [];

  const lat = climate.location?.lat ?? 35;
  const elevation = climate.location?.elevation ?? null;
  const avgAnnualTemp = climate.fullRecord.avgAnnualTemp;
  const avgAnnualPrecip = climate.fullRecord.avgAnnualPrecip;
  const dryDays = climate.stressMetrics.summerDrySpells.avgMaxConsecutiveDryDays;
  const heatDays = climate.stressMetrics.summerHeatDays.avgDaysAboveThreshold;
  const gsPrecip = climate.stressMetrics.growingSeasonPrecip.avgTotalMm;

  const summerPrecip = summerMonthsPrecip(climate.fullRecord.monthlyPrecip, lat);
  const winterPrecip = winterMonthsPrecip(climate.fullRecord.monthlyPrecip, lat);

  const validMonthlyTemps = (climate.fullRecord.monthlyTemp ?? []).filter(
    (t): t is number => t !== null
  );
  const minMonthlyTemp =
    validMonthlyTemps.length === 12 ? Math.min(...validMonthlyTemps) : null;
  const maxMonthlyTemp =
    validMonthlyTemps.length === 12 ? Math.max(...validMonthlyTemps) : null;
  const annualTempRange =
    minMonthlyTemp !== null && maxMonthlyTemp !== null
      ? maxMonthlyTemp - minMonthlyTemp
      : null;

  const validMonthlyPrecips = (climate.fullRecord.monthlyPrecip ?? []).filter(
    (p): p is number => p !== null
  );
  const dryMonthCount = validMonthlyPrecips.filter((p) => p < 30).length;

  const gaez = evaluateGaezV5Indicators(climate);

  if (avgAnnualTemp !== null) {
    inputsUsed.push(`Average annual temperature: ${avgAnnualTemp.toFixed(1)} °C`);
  } else {
    limitations.push("Average annual temperature is unavailable.");
  }

  if (avgAnnualPrecip !== null) {
    inputsUsed.push(`Average annual precipitation: ${avgAnnualPrecip.toFixed(0)} mm`);
  } else {
    limitations.push("Average annual precipitation is unavailable.");
  }

  if (elevation !== null) {
    inputsUsed.push(`Surface elevation (DEM / NASA POWER): ${elevation.toFixed(0)} m`);
  }

  if (gaez.estimatedLgpDays !== null) {
    inputsUsed.push(
      `Estimated growing period (GAEZ v5 LGP): ${gaez.estimatedLgpDays} days (${formatMoistureZoneLabel(gaez.moistureZone)})`
    );
  }

  if (dryDays !== null) {
    inputsUsed.push(`Average max consecutive dry days (Jun–Aug): ${dryDays.toFixed(1)} days`);
  } else {
    limitations.push("Summer dry-spell data unavailable.");
  }

  if (heatDays !== null) {
    inputsUsed.push(`Average heat-stress days (Jul–Aug, >35 °C): ${heatDays.toFixed(1)} days`);
  } else {
    limitations.push("Heat-stress day count unavailable.");
  }

  if (gsPrecip !== null) {
    inputsUsed.push(`Growing-season precipitation (May–Aug): ${gsPrecip.toFixed(0)} mm`);
  } else {
    limitations.push("Growing-season precipitation unavailable.");
  }

  const hasSoilAwc = soil !== null && soil.aggregated.depth0_30cm.awc !== null;
  if (soil) {
    const awc = soil.aggregated.depth0_30cm.awc;
    if (awc !== null) inputsUsed.push(`Soil AWC (0–30 cm): ${awc.toFixed(3)} cm/cm`);
    else limitations.push("Soil AWC unavailable.");
    if (soil.aggregated.drainage) {
      inputsUsed.push(`Soil drainage class: ${soil.aggregated.drainage}`);
    }
    if (soil.aggregated.slope !== null) {
      inputsUsed.push(`Soil slope: ${soil.aggregated.slope.toFixed(1)}%`);
    }
    if (soil.source) {
      inputsUsed.push(`Soil data source: ${soil.source}`);
    }
  } else {
    limitations.push("No soil data available.");
  }

  limitations.push(
    "Provisional climate-based classification: soil properties are recorded for field context and scoring, while macro-group assignment is driven by FAO GAEZ v5 thermal, moisture, and LGP regimes."
  );

  // Core data gating: without temperature and precipitation, we cannot classify.
  if (avgAnnualTemp === null || avgAnnualPrecip === null) {
    return {
      group: "unknown",
      confidence: "low",
      reasons: ["Insufficient core climate data to assign an agricultural group."],
      inputsUsed,
      limitations,
      evidenceLevel: "level_3_insufficient",
      waterRegime: gaez.waterRegimeRecommendation,
      dominantSeasonality: gaez.dominantSeasonality,
      gaezThermalZone: gaez.thermalZone,
      gaezMoistureZone: gaez.moistureZone,
      estimatedLgpDays: gaez.estimatedLgpDays,
    };
  }

  let group: AgGroup = "unknown";
  let confidence: "high" | "moderate" | "low" = "moderate";

  // ── 1. Highland / Montane (low-latitude high-elevation agroecosystems) ──
  if (
    elevation !== null &&
    elevation >= 1500 &&
    Math.abs(lat) <= 38 &&
    avgAnnualTemp >= 8 &&
    avgAnnualTemp <= 23 &&
    avgAnnualPrecip >= 450
  ) {
    group = "highland_montane";
    reasons.push(
      `Highland/montane regime at ${elevation.toFixed(0)} m elevation (lat ${lat.toFixed(2)}°) with moderated annual temperature (${avgAnnualTemp.toFixed(1)} °C) and ${avgAnnualPrecip.toFixed(0)} mm annual precipitation.`
    );
    confidence = "high";
  }

  // ── 2. Tropical Agroecological Regimes (GAEZ Warm Tropics: T_ann > 24 °C or low-lat T_ann >= 22.5 °C) ──
  const isTropicalThermal =
    avgAnnualTemp > 24.0 ||
    (Math.abs(lat) <= 23.5 &&
      avgAnnualTemp >= 22.5 &&
      (minMonthlyTemp === null || minMonthlyTemp >= 16));

  if (group === "unknown" && isTropicalThermal) {
    if (avgAnnualPrecip >= 1500 && dryMonthCount <= 3) {
      group = "tropical_humid";
      reasons.push(
        `Humid tropical regime: warm year-round (${avgAnnualTemp.toFixed(1)} °C) with abundant precipitation (${avgAnnualPrecip.toFixed(0)} mm) and short dry season (${dryMonthCount} dry months).`
      );
      confidence = "high";
    } else if (avgAnnualPrecip >= 1200 && dryMonthCount > 3) {
      group = "tropical_monsoon";
      reasons.push(
        `Tropical monsoon regime: warm thermal baseline (${avgAnnualTemp.toFixed(1)} °C) with high annual rainfall (${avgAnnualPrecip.toFixed(0)} mm) concentrated in a pronounced wet season (${dryMonthCount} dry months <30 mm).`
      );
      confidence = "high";
    } else if (avgAnnualPrecip >= 950) {
      group = "tropical_subhumid";
      reasons.push(
        `Subhumid tropical regime: annual temperature ${avgAnnualTemp.toFixed(1)} °C with ${avgAnnualPrecip.toFixed(0)} mm rainfall and ${gaez.estimatedLgpDays ?? 190}-day GAEZ growing period.`
      );
      confidence = "high";
    } else if (avgAnnualPrecip >= 500) {
      group = "tropical_savanna";
      reasons.push(
        `Tropical savanna (Sudano-Sahelian / wet-dry tropical) regime: warm annual temperature (${avgAnnualTemp.toFixed(1)} °C) with seasonal rainfall (${avgAnnualPrecip.toFixed(0)} mm, ~${gaez.estimatedLgpDays ?? 135} LGP days) and distinct rainy/dry seasons.`
      );
      confidence = "high";
    } else if (avgAnnualPrecip >= 250) {
      group = "tropical_semi_arid";
      reasons.push(
        `Semi-arid tropical (Sahelian / dry savanna) regime: high annual temperature (${avgAnnualTemp.toFixed(1)} °C) with limited seasonal rainfall (${avgAnnualPrecip.toFixed(0)} mm, ~${gaez.estimatedLgpDays ?? 80} LGP days).`
      );
      confidence = "high";
    } else {
      group = "arid";
      reasons.push(
        `Arid tropical/subtropical regime: annual precipitation ${avgAnnualPrecip.toFixed(0)} mm (<250 mm threshold) at ${avgAnnualTemp.toFixed(1)} °C; crop production requires irrigation.`
      );
      confidence = "high";
    }
  }

  // ── 3. Temperate / Subtropical Arid (< 250 mm annual precipitation) ──
  if (group === "unknown" && avgAnnualTemp >= 6 && avgAnnualPrecip < 250) {
    group = "arid";
    reasons.push(
      `Arid moisture regime: annual precipitation ${avgAnnualPrecip.toFixed(0)} mm (<250 mm) with ${avgAnnualTemp.toFixed(1)} °C mean annual temperature; agricultural production depends on irrigation.`
    );
    confidence = "high";
  }

  // ── 4. Temperate Mediterranean (winter-wet, summer-dry pattern) ──
  if (group === "unknown" && summerPrecip !== null && winterPrecip !== null) {
    if (
      avgAnnualTemp >= 10 &&
      avgAnnualTemp <= 21 &&
      summerPrecip < 80 &&
      winterPrecip > summerPrecip * 2 &&
      avgAnnualPrecip >= 250 &&
      avgAnnualPrecip < 900
    ) {
      group = "temperate_mediterranean";
      reasons.push(
        `Winter precipitation (${winterPrecip.toFixed(0)} mm) substantially exceeds summer precipitation (${summerPrecip.toFixed(0)} mm) with mild annual temperatures (${avgAnnualTemp.toFixed(1)} °C).`
      );
      confidence = "high";
    }
  }

  // ── 5. Subtropical Humid (warm year-round, high precipitation) ──
  if (group === "unknown") {
    if (
      avgAnnualTemp >= 16 &&
      avgAnnualTemp <= 25 &&
      avgAnnualPrecip >= 900 &&
      (dryDays === null || dryDays <= 18)
    ) {
      group = "subtropical_humid";
      reasons.push(
        `Warm annual temperature (${avgAnnualTemp.toFixed(1)} °C) with abundant precipitation (${avgAnnualPrecip.toFixed(0)} mm).`
      );
      confidence = dryDays !== null && heatDays !== null ? "high" : "moderate";
    }
  }

  // ── 6. Semi-Arid Temperate (low precipitation, high dry spells or heat days) ──
  if (group === "unknown") {
    const aridSignal =
      avgAnnualPrecip <= 550 ||
      (dryDays !== null && dryDays >= 14) ||
      (heatDays !== null && heatDays >= 18) ||
      (gsPrecip !== null && gsPrecip <= 300);

    if (avgAnnualTemp >= 6 && avgAnnualTemp <= 24 && aridSignal) {
      group = "semi_arid_temperate";
      reasons.push(
        `Limited moisture signal: annual precip ${avgAnnualPrecip.toFixed(0)} mm${
          dryDays !== null ? `, summer dry spells ~${dryDays.toFixed(0)} days` : ""
        }${heatDays !== null ? `, heat days ~${heatDays.toFixed(0)}` : ""}.`
      );
      confidence =
        dryDays !== null && heatDays !== null && gsPrecip !== null ? "high" : "moderate";
    }
  }

  // ── 7. Continental (cold winters <= -4 °C and wide seasonal amplitude >= 26 °C) ──
  if (group === "unknown") {
    if (
      avgAnnualTemp >= 2 &&
      avgAnnualTemp <= 12 &&
      avgAnnualPrecip >= 350 &&
      minMonthlyTemp !== null &&
      minMonthlyTemp <= -4 &&
      annualTempRange !== null &&
      annualTempRange >= 26
    ) {
      group = "continental";
      reasons.push(
        `Continental thermal regime: cold winters (min monthly mean ${minMonthlyTemp.toFixed(1)} °C), large annual temperature amplitude (${annualTempRange.toFixed(1)} °C), and ${avgAnnualPrecip.toFixed(0)} mm annual precipitation.`
      );
      confidence = "high";
    }
  }

  // ── 8. Temperate Humid (moderate temperatures, adequate precipitation) ──
  if (group === "unknown") {
    const humidSignal =
      avgAnnualPrecip >= 500 || (gsPrecip !== null && gsPrecip >= 350);

    if (avgAnnualTemp >= 4 && avgAnnualTemp <= 20 && humidSignal) {
      group = "temperate_humid";
      reasons.push(
        `Moderate annual temperature (${avgAnnualTemp.toFixed(1)} °C) with adequate precipitation (${avgAnnualPrecip.toFixed(0)} mm).`
      );
      confidence =
        dryDays !== null && heatDays !== null && gsPrecip !== null ? "high" : "moderate";
    }
  }

  // ── 9. Boreal (cold high-latitude short growing season: 0 to <4 °C, >= 350 mm) ──
  if (group === "unknown") {
    if (avgAnnualTemp >= 0 && avgAnnualTemp < 4 && avgAnnualPrecip >= 350) {
      group = "boreal";
      reasons.push(
        `Boreal cold-temperate regime: low mean annual temperature (${avgAnnualTemp.toFixed(1)} °C) with short frost-free growing period and ${avgAnnualPrecip.toFixed(0)} mm precipitation.`
      );
      confidence = "moderate";
    }
  }

  // ── 10. Unmatched / Extreme Climate ──
  if (group === "unknown") {
    reasons.push(
      `Climate profile (temp ${avgAnnualTemp.toFixed(1)} °C, precip ${avgAnnualPrecip.toFixed(0)} mm) does not match any supported agricultural group.`
    );
    confidence = "low";
  }

  // Degrade confidence if too many key stress metrics are missing or if soil context is absent
  const missingStressMetrics = [dryDays, heatDays, gsPrecip].filter((v) => v === null).length;
  if ((missingStressMetrics >= 2 || !hasSoilAwc) && confidence === "high") {
    confidence = "moderate";
  }

  const evidenceLevel: EvidenceLevel =
    group === "unknown" || group === "boreal"
      ? "level_3_insufficient"
      : hasSoilAwc && soil?.source?.includes("SSURGO")
      ? "level_1_strong_local"
      : "level_2_global_modeled";

  return {
    group,
    confidence,
    reasons,
    inputsUsed,
    limitations,
    evidenceLevel,
    waterRegime: gaez.waterRegimeRecommendation,
    dominantSeasonality: gaez.dominantSeasonality,
    gaezThermalZone: gaez.thermalZone,
    gaezMoistureZone: gaez.moistureZone,
    estimatedLgpDays: gaez.estimatedLgpDays,
  };
}

/**
 * Supported agroecological groups that have verified multi-family 3-year crop
 * catalog coverage in `data/crops.json`.
 */
const SUPPORTED_AG_GROUPS: ReadonlySet<AgGroup> = new Set<AgGroup>([
  "temperate_humid",
  "semi_arid_temperate",
  "subtropical_humid",
  "temperate_mediterranean",
  "tropical_humid",
  "tropical_subhumid",
  "tropical_savanna",
  "tropical_monsoon",
  "tropical_semi_arid",
  "arid",
  "continental",
  "highland_montane",
]);

/**
 * Return true if the group is one we have a verified crop catalog for.
 */
export function isGroupSupported(group: AgGroup): boolean {
  return SUPPORTED_AG_GROUPS.has(group);
}
