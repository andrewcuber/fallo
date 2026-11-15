/**
 * Deterministic agricultural group classifier for fallo.
 *
 * Principles:
 * - Uses actual climate and soil data, never lat/lon alone.
 * - Returns explicit confidence levels; unknown/insufficient-data is a valid outcome.
 * - Rules are transparent and extensible.
 * - Does not invent field characteristics.
 */

import type { ClimateData, SoilData } from "@/lib/rotation-scoring";

export type AgGroup =
  | "temperate_humid"
  | "semi_arid_temperate"
  | "subtropical_humid"
  | "temperate_mediterranean"
  | "unknown";

export interface ClassificationResult {
  group: AgGroup;
  confidence: "high" | "moderate" | "low";
  reasons: string[];
  inputsUsed: string[];
  limitations: string[];
}

function sum(arr: (number | null)[]): number | null {
  const valid = arr.filter((n): n is number => n !== null);
  if (valid.length === 0) return null;
  return valid.reduce((a, b) => a + b, 0);
}

function summerMonthsPrecip(monthlyPrecip: (number | null)[]): number | null {
  // Jun, Jul, Aug
  return sum([monthlyPrecip[5], monthlyPrecip[6], monthlyPrecip[7]]);
}

function winterMonthsPrecip(monthlyPrecip: (number | null)[]): number | null {
  // Dec, Jan, Feb
  return sum([monthlyPrecip[11], monthlyPrecip[0], monthlyPrecip[1]]);
}

/**
 * Classify a field into an agricultural group based on climate and optional soil data.
 *
 * Hard requirements for any classification:
 *   - Annual average temperature must be available.
 *   - Annual precipitation must be available.
 *
 * Note on soil integration:
 *   The current crop catalog and agronomic reference sources do not define
 *   validated quantitative soil thresholds for macro-group assignment. Therefore,
 *   classification is provisionally driven by climate regimes, while soil
 *   availability is explicitly recorded in inputs/limitations and factored into
 *   classification confidence.
 */
export function classifyAgGroup(
  climate: ClimateData,
  soil: SoilData | null
): ClassificationResult {
  const reasons: string[] = [];
  const inputsUsed: string[] = [];
  const limitations: string[] = [];

  const avgAnnualTemp = climate.fullRecord.avgAnnualTemp;
  const avgAnnualPrecip = climate.fullRecord.avgAnnualPrecip;
  const dryDays = climate.stressMetrics.summerDrySpells.avgMaxConsecutiveDryDays;
  const heatDays = climate.stressMetrics.summerHeatDays.avgDaysAboveThreshold;
  const gsPrecip = climate.stressMetrics.growingSeasonPrecip.avgTotalMm;

  const summerPrecip = summerMonthsPrecip(climate.fullRecord.monthlyPrecip);
  const winterPrecip = winterMonthsPrecip(climate.fullRecord.monthlyPrecip);

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
  } else {
    limitations.push("No soil data available.");
  }

  limitations.push(
    "Provisional climate-based classification: soil properties are recorded for field context and scoring, but source-backed soil-group thresholds are not yet integrated into group classification."
  );

  // Core data gating: without temperature and precipitation, we cannot classify.
  if (avgAnnualTemp === null || avgAnnualPrecip === null) {
    return {
      group: "unknown",
      confidence: "low",
      reasons: ["Insufficient core climate data to assign an agricultural group."],
      inputsUsed,
      limitations,
    };
  }

  let group: AgGroup = "unknown";
  let confidence: "high" | "moderate" | "low" = "moderate";

  // ── Temperate Mediterranean ──
  // Winter-wet, summer-dry pattern
  if (summerPrecip !== null && winterPrecip !== null) {
    if (
      avgAnnualTemp >= 10 &&
      avgAnnualTemp <= 20 &&
      summerPrecip < 80 &&
      winterPrecip > summerPrecip * 2 &&
      avgAnnualPrecip < 900
    ) {
      group = "temperate_mediterranean";
      reasons.push(
        `Winter precipitation (${winterPrecip.toFixed(0)} mm) substantially exceeds summer precipitation (${summerPrecip.toFixed(0)} mm) with mild annual temperatures (${avgAnnualTemp.toFixed(1)} °C).`
      );
      confidence = "high";
    }
  }

  // ── Subtropical Humid ──
  // Warm year-round, relatively high precipitation
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

  // ── Semi-Arid Temperate ──
  // Low precipitation, high dry spells or heat days
  if (group === "unknown") {
    const aridSignal =
      avgAnnualPrecip <= 550 ||
      (dryDays !== null && dryDays >= 14) ||
      (heatDays !== null && heatDays >= 18) ||
      (gsPrecip !== null && gsPrecip <= 300);

    if (avgAnnualTemp >= 8 && avgAnnualTemp <= 24 && aridSignal) {
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

  // ── Temperate Humid ──
  // Moderate temperatures, moderate-to-high precipitation, not arid
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

  // If nothing matched, but we have core data, mark as unknown with low confidence
  // that we genuinely cannot assign a known group.
  if (group === "unknown") {
    if (avgAnnualTemp > 25) {
      reasons.push(
        `Tropical thermal regime (annual average ${avgAnnualTemp.toFixed(1)} °C, annual precip ${avgAnnualPrecip.toFixed(0)} mm) exceeds temperate/subtropical thresholds (≤ 25 °C). Tropical savanna/monsoon agroecological groups and verified local rainy/dry-season crop calendars are not yet defined in the current catalog.`
      );
      limitations.push(
        "Global tropical coverage requires integrating FAO/IIASA GAEZ v5 agro-ecological zones, ISRIC SoilGrids global soil profiles, and regional research-backed crop calendars (e.g., sorghum, pearl millet, cowpea, groundnut, sesame)."
      );
    } else {
      reasons.push(
        `Climate profile (temp ${avgAnnualTemp.toFixed(1)} °C, precip ${avgAnnualPrecip.toFixed(0)} mm) does not match any currently defined agricultural group.`
      );
    }
    confidence = "low";
  }

  // Degrade confidence if too many key stress metrics are missing or if soil context is absent
  const missingStressMetrics = [dryDays, heatDays, gsPrecip].filter((v) => v === null).length;
  if ((missingStressMetrics >= 2 || !hasSoilAwc) && confidence === "high") {
    confidence = "moderate";
  }

  return { group, confidence, reasons, inputsUsed, limitations };
}

/**
 * Return true if the group is one we have a verified crop catalog for.
 */
export function isGroupSupported(group: AgGroup): boolean {
  return group === "temperate_humid" || group === "semi_arid_temperate";
}
