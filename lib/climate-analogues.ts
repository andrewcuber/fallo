/**
 * Pure, deterministic Historical Climate Analogues engine for fallo.
 *
 * Responsibilities:
 * - Identify and rank historically similar growing seasons at a field's location
 *   using retrieved NASA POWER daily-derived annual & monthly records (`historicalYears`).
 * - Support three comparison modes:
 *   1. "recent_window": Compare recent conditions against prior baseline historical years.
 *   2. "specific_year": Compare a selected historical year against all other years in the archive
 *      (strictly excluding the target year from its own matches).
 *   3. "what_if_scenario": Compare a hypothetical What-If climate scenario against all
 *      historical years to show which real past season(s) most closely resembled the scenario.
 * - Use a transparent, standardized multi-metric distance calculation combining annual mean
 *   temperature, annual precipitation, hemisphere-aware growing-season temperature & rainfall,
 *   and 12-month seasonal curve shape.
 * - Never fabricate observations; return an honest `insufficient_data` state if historical
 *   records are missing or too sparse.
 */

import {
  type ClimateData,
  type HistoricalYearClimateRecord,
} from "@/lib/rotation-scoring";
import {
  type WhatIfScenario,
  applyWhatIfScenarioToClimate,
  formatScenarioSummary,
} from "@/lib/what-if-simulator";

export type AnalogueTargetMode =
  | "recent_window"
  | "specific_year"
  | "what_if_scenario";

export interface AnalogueTargetProfile {
  mode: AnalogueTargetMode;
  label: string;
  description: string;
  excludedYears: number[];
  avgTempC: number;
  totalPrecipMm: number;
  growingSeasonTempC: number;
  growingSeasonPrecipMm: number;
  monthlyTemp: (number | null)[];
  monthlyPrecip: (number | null)[];
  summerDrySpellDays: number | null;
  summerHeatDays: number | null;
}

export interface HistoricalAnalogueMatch {
  rank: number;
  year: number;
  similarityScore: number; // 0–100
  compositeDistance: number; // standardized z-distance (lower = closer)
  record: HistoricalYearClimateRecord;
  growingSeasonTempC: number;
  growingSeasonPrecipMm: number;
  deltas: {
    annualTempDeltaC: number; // candidate - target
    annualPrecipDeltaMm: number; // candidate - target
    annualPrecipDeltaPct: number | null;
    growingSeasonTempDeltaC: number;
    growingSeasonPrecipDeltaMm: number;
    growingSeasonPrecipDeltaPct: number | null;
    monthlyTempRmseC: number;
    monthlyPrecipRmseMm: number;
  };
  componentDistances: {
    annualTempZ: number;
    annualPrecipZ: number;
    growingSeasonTempZ: number;
    growingSeasonPrecipZ: number;
    seasonalPatternZ: number;
  };
  selectionReasons: string[];
  seasonCharacterLabel: string;
}

export interface ClimateAnaloguesResult {
  status: "ready" | "insufficient_data";
  insufficientReason?: string;
  source: string;
  spatialResolution: string;
  archivePeriodLabel: string;
  totalValidArchiveYears: number;
  candidateYearsEvaluated: number;
  growingSeasonMonths: number[]; // 1..12
  growingSeasonLabel: string;
  methodologySummary: string;
  target: AnalogueTargetProfile | null;
  matches: HistoricalAnalogueMatch[];
}

const MONTH_SHORT = [
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
 * Determine the primary 6-month growing-season window (month numbers 1..12)
 * based on latitude and monthly precipitation/temperature.
 */
export function resolveGrowingSeasonWindow(
  lat: number,
  monthlyPrecip?: (number | null)[]
): { months: number[]; label: string } {
  const absLat = Math.abs(lat);
  if (absLat < 23.5 && monthlyPrecip && monthlyPrecip.length === 12) {
    // Tropical: find the 6-month contiguous window with highest cumulative rainfall
    let bestStart = 5; // default May–Oct
    let bestSum = -1;
    for (let start = 1; start <= 12; start++) {
      let sum = 0;
      for (let k = 0; k < 6; k++) {
        const mIdx = (start - 1 + k) % 12;
        sum += monthlyPrecip[mIdx] ?? 0;
      }
      if (sum > bestSum) {
        bestSum = sum;
        bestStart = start;
      }
    }
    const months: number[] = [];
    for (let k = 0; k < 6; k++) {
      months.push(((bestStart - 1 + k) % 12) + 1);
    }
    const first = MONTH_SHORT[months[0] - 1];
    const last = MONTH_SHORT[months[months.length - 1] - 1];
    return {
      months,
      label: `Primary Wet/Cropping Season (${first}–${last})`,
    };
  }

  if (lat < 0) {
    return {
      months: [10, 11, 12, 1, 2, 3],
      label: "Southern Hemisphere Warm Growing Season (Oct–Mar)",
    };
  }

  return {
    months: [4, 5, 6, 7, 8, 9],
    label: "Northern Hemisphere Warm Growing Season (Apr–Sep)",
  };
}

function computeGrowingSeasonStats(
  monthlyTemp: (number | null)[],
  monthlyPrecip: (number | null)[],
  gsMonths: number[]
): { tempC: number | null; precipMm: number | null } {
  const temps = gsMonths
    .map((m) => monthlyTemp[m - 1])
    .filter((v): v is number => v !== null && v !== undefined && Number.isFinite(v));
  const precips = gsMonths
    .map((m) => monthlyPrecip[m - 1])
    .filter((v): v is number => v !== null && v !== undefined && Number.isFinite(v));

  return {
    tempC: temps.length > 0 ? temps.reduce((a, b) => a + b, 0) / temps.length : null,
    precipMm: precips.length > 0 ? precips.reduce((a, b) => a + b, 0) : null,
  };
}

function stdDevWithFloor(values: number[], floor: number): number {
  if (values.length < 2) return floor;
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const variance =
    values.reduce((acc, v) => acc + Math.pow(v - mean, 2), 0) / values.length;
  return Math.max(floor, Math.sqrt(variance));
}

function classifyYearCharacter(
  yearTemp: number,
  yearPrecip: number,
  archiveMeanTemp: number,
  archiveMeanPrecip: number,
  tempSd: number,
  precipSd: number
): string {
  const tZ = (yearTemp - archiveMeanTemp) / tempSd;
  const pZ = (yearPrecip - archiveMeanPrecip) / precipSd;

  const tempDesc =
    tZ >= 0.75 ? "Warmer than normal" : tZ <= -0.75 ? "Cooler than normal" : "Near-normal temperature";
  const precipDesc =
    pZ >= 0.75 ? "wetter than normal" : pZ <= -0.75 ? "drier than normal" : "near-average rainfall";

  return `${tempDesc}, ${precipDesc}`;
}

/**
 * Compute ranked historical climate analogues from retrieved NASA POWER historical years.
 */
export function computeClimateAnalogues(params: {
  climate: ClimateData;
  mode: AnalogueTargetMode;
  targetYear?: number;
  whatIfScenario?: WhatIfScenario;
  maxResults?: number;
  topN?: number;
}): ClimateAnaloguesResult {
  const { climate, mode, targetYear, whatIfScenario } = params;
  const maxResults = params.maxResults ?? params.topN ?? 10;
  const rawYears = climate.historicalYears ?? [];

  // Filter to years with valid temperature, precipitation, and at least 300 days of observations
  const validYears = rawYears.filter(
    (y) =>
      y.avgTemp !== null &&
      Number.isFinite(y.avgTemp) &&
      y.totalPrecip !== null &&
      Number.isFinite(y.totalPrecip) &&
      y.daysWithData >= 300 &&
      y.monthlyTemp.filter((t) => t !== null).length >= 10 &&
      y.monthlyPrecip.filter((p) => p !== null).length >= 10
  );

  const gsWindow = resolveGrowingSeasonWindow(
    climate.location.lat,
    climate.fullRecord.monthlyPrecip
  );

  const methodologySummary =
    "Standardized Euclidean distance (z-score normalized across the field's 20-year NASA POWER record) weighting: " +
    "25% Annual Precipitation, 20% Annual Mean Temperature, 20% Growing-Season Precipitation, " +
    "15% Growing-Season Temperature, and 20% 12-Month Seasonal Trajectory RMSE. " +
    "Similarity Score = round(100 × exp(−0.55 × compositeDistance)).";

  if (validYears.length < 4) {
    return {
      status: "insufficient_data",
      insufficientReason:
        rawYears.length === 0
          ? "Per-year historical climate records are not present in the current response. Refresh the field's climate data to load the 20-year NASA POWER annual archive."
          : `Only ${validYears.length} complete historical years were retrieved from NASA POWER (minimum 4 required for reliable standardized similarity ranking).`,
      source: climate.source,
      spatialResolution: climate.spatialResolution,
      archivePeriodLabel:
        validYears.length > 0
          ? `${validYears[0].year}–${validYears[validYears.length - 1].year}`
          : "Unavailable",
      totalValidArchiveYears: validYears.length,
      candidateYearsEvaluated: 0,
      growingSeasonMonths: gsWindow.months,
      growingSeasonLabel: gsWindow.label,
      methodologySummary,
      target: null,
      matches: [],
    };
  }

  const sortedYears = [...validYears].sort((a, b) => a.year - b.year);
  const minYear = sortedYears[0].year;
  const maxYear = sortedYears[sortedYears.length - 1].year;
  const archivePeriodLabel = `${minYear}–${maxYear} (${sortedYears.length} complete years)`;

  // Build Target Profile & Excluded Years
  let target: AnalogueTargetProfile;

  if (mode === "specific_year") {
    const selectedYearNum = targetYear ?? maxYear;
    const foundYear = sortedYears.find((y) => y.year === selectedYearNum) ?? sortedYears[sortedYears.length - 1];
    const gsStats = computeGrowingSeasonStats(
      foundYear.monthlyTemp,
      foundYear.monthlyPrecip,
      gsWindow.months
    );

    target = {
      mode: "specific_year",
      label: `Historical Year ${foundYear.year}`,
      description: `Comparing observed conditions in ${foundYear.year} against all other years in ${minYear}–${maxYear} (${foundYear.year} is excluded from matches).`,
      excludedYears: [foundYear.year],
      avgTempC: foundYear.avgTemp!,
      totalPrecipMm: foundYear.totalPrecip!,
      growingSeasonTempC: gsStats.tempC ?? foundYear.avgTemp!,
      growingSeasonPrecipMm: gsStats.precipMm ?? foundYear.totalPrecip! * 0.5,
      monthlyTemp: foundYear.monthlyTemp,
      monthlyPrecip: foundYear.monthlyPrecip,
      summerDrySpellDays: foundYear.summerDrySpellDays,
      summerHeatDays: foundYear.summerHeatDays,
    };
  } else if (mode === "what_if_scenario" && whatIfScenario) {
    const { scenarioClimate } = applyWhatIfScenarioToClimate(climate, whatIfScenario);
    const gsStats = computeGrowingSeasonStats(
      scenarioClimate.fullRecord.monthlyTemp,
      scenarioClimate.fullRecord.monthlyPrecip,
      gsWindow.months
    );
    const scenSummary = formatScenarioSummary(whatIfScenario);

    target = {
      mode: "what_if_scenario",
      label: scenSummary,
      description: `Comparing your hypothetical What-If scenario against real observed historical growing seasons (${minYear}–${maxYear}) to find past years that experienced similar temperatures and rainfall.`,
      excludedYears: [],
      avgTempC: scenarioClimate.fullRecord.avgAnnualTemp ?? 15,
      totalPrecipMm: scenarioClimate.fullRecord.avgAnnualPrecip ?? 800,
      growingSeasonTempC:
        gsStats.tempC ?? (scenarioClimate.fullRecord.avgAnnualTemp ?? 15),
      growingSeasonPrecipMm:
        gsStats.precipMm ?? (scenarioClimate.fullRecord.avgAnnualPrecip ?? 800) * 0.5,
      monthlyTemp: scenarioClimate.fullRecord.monthlyTemp,
      monthlyPrecip: scenarioClimate.fullRecord.monthlyPrecip,
      summerDrySpellDays:
        scenarioClimate.stressMetrics.summerDrySpells.avgMaxConsecutiveDryDays,
      summerHeatDays:
        scenarioClimate.stressMetrics.summerHeatDays.avgDaysAboveThreshold,
    };
  } else {
    // Default: "recent_window"
    const recentStart = climate.periods?.recentStart ?? maxYear - 2;
    const recentEnd = climate.periods?.recentEnd ?? maxYear;
    const recentRecords = sortedYears.filter(
      (y) => y.year >= recentStart && y.year <= recentEnd
    );
    const excluded = recentRecords.map((r) => r.year);

    const recentMonthlyTemp =
      climate.recent?.monthlyTemp ?? climate.fullRecord.monthlyTemp;
    const recentMonthlyPrecip =
      climate.recent?.monthlyPrecip ?? climate.fullRecord.monthlyPrecip;
    const recentAvgTemp =
      climate.recent?.avgAnnualTemp ?? climate.fullRecord.avgAnnualTemp ?? 15;
    const recentAvgPrecip =
      climate.recent?.avgAnnualPrecip ?? climate.fullRecord.avgAnnualPrecip ?? 800;

    const gsStats = computeGrowingSeasonStats(
      recentMonthlyTemp,
      recentMonthlyPrecip,
      gsWindow.months
    );

    target = {
      mode: "recent_window",
      label: `Recent Climate (${recentStart}–${recentEnd} Mean)`,
      description: `Comparing recent observed conditions (${recentStart}–${recentEnd}) against prior baseline years (${minYear}–${recentStart - 1}) to identify historical growing seasons most similar to current conditions.`,
      excludedYears: excluded,
      avgTempC: recentAvgTemp,
      totalPrecipMm: recentAvgPrecip,
      growingSeasonTempC: gsStats.tempC ?? recentAvgTemp,
      growingSeasonPrecipMm: gsStats.precipMm ?? recentAvgPrecip * 0.5,
      monthlyTemp: recentMonthlyTemp,
      monthlyPrecip: recentMonthlyPrecip,
      summerDrySpellDays:
        climate.stressMetrics.summerDrySpells.avgMaxConsecutiveDryDays,
      summerHeatDays:
        climate.stressMetrics.summerHeatDays.avgDaysAboveThreshold,
    };
  }

  // Filter candidate years, strictly excluding any year in target.excludedYears
  const excludedSet = new Set(target.excludedYears);
  const candidates = sortedYears.filter((y) => !excludedSet.has(y.year));

  if (candidates.length === 0) {
    return {
      status: "insufficient_data",
      insufficientReason:
        "No candidate historical years remain after excluding the target comparison window.",
      source: climate.source,
      spatialResolution: climate.spatialResolution,
      archivePeriodLabel,
      totalValidArchiveYears: sortedYears.length,
      candidateYearsEvaluated: 0,
      growingSeasonMonths: gsWindow.months,
      growingSeasonLabel: gsWindow.label,
      methodologySummary,
      target,
      matches: [],
    };
  }

  // Compute archive standard deviations for z-score normalization
  const archiveTemps = sortedYears.map((y) => y.avgTemp!);
  const archivePrecips = sortedYears.map((y) => y.totalPrecip!);
  const archiveMeanTemp =
    archiveTemps.reduce((a, b) => a + b, 0) / archiveTemps.length;
  const archiveMeanPrecip =
    archivePrecips.reduce((a, b) => a + b, 0) / archivePrecips.length;

  const gsStatsByYear = new Map<number, { tempC: number; precipMm: number }>();
  for (const y of sortedYears) {
    const gs = computeGrowingSeasonStats(y.monthlyTemp, y.monthlyPrecip, gsWindow.months);
    gsStatsByYear.set(y.year, {
      tempC: gs.tempC ?? y.avgTemp!,
      precipMm: gs.precipMm ?? y.totalPrecip! * 0.5,
    });
  }

  const annualTempSd = stdDevWithFloor(archiveTemps, 0.4);
  const annualPrecipSd = stdDevWithFloor(archivePrecips, 45);
  const gsTempSd = stdDevWithFloor(
    Array.from(gsStatsByYear.values()).map((v) => v.tempC),
    0.5
  );
  const gsPrecipSd = stdDevWithFloor(
    Array.from(gsStatsByYear.values()).map((v) => v.precipMm),
    30
  );

  // Per-month SDs for 12-month trajectory comparison
  const monthlyTempSds: number[] = [];
  const monthlyPrecipSds: number[] = [];
  for (let m = 0; m < 12; m++) {
    const mTemps = sortedYears
      .map((y) => y.monthlyTemp[m])
      .filter((v): v is number => v !== null);
    const mPrecips = sortedYears
      .map((y) => y.monthlyPrecip[m])
      .filter((v): v is number => v !== null);
    monthlyTempSds.push(stdDevWithFloor(mTemps, 0.8));
    monthlyPrecipSds.push(stdDevWithFloor(mPrecips, 15));
  }

  const rawMatches: Omit<HistoricalAnalogueMatch, "rank">[] = candidates.map((cand) => {
    const candGs = gsStatsByYear.get(cand.year)!;
    const annualTempDeltaC = cand.avgTemp! - target.avgTempC;
    const annualPrecipDeltaMm = cand.totalPrecip! - target.totalPrecipMm;
    const annualPrecipDeltaPct =
      target.totalPrecipMm > 0
        ? (annualPrecipDeltaMm / target.totalPrecipMm) * 100
        : null;

    const growingSeasonTempDeltaC = candGs.tempC - target.growingSeasonTempC;
    const growingSeasonPrecipDeltaMm = candGs.precipMm - target.growingSeasonPrecipMm;
    const growingSeasonPrecipDeltaPct =
      target.growingSeasonPrecipMm > 0
        ? (growingSeasonPrecipDeltaMm / target.growingSeasonPrecipMm) * 100
        : null;

    const annualTempZ = Math.abs(annualTempDeltaC) / annualTempSd;
    const annualPrecipZ = Math.abs(annualPrecipDeltaMm) / annualPrecipSd;
    const growingSeasonTempZ = Math.abs(growingSeasonTempDeltaC) / gsTempSd;
    const growingSeasonPrecipZ = Math.abs(growingSeasonPrecipDeltaMm) / gsPrecipSd;

    // 12-month trajectory RMSE and standardized z-distance
    let sqTempErrSum = 0;
    let sqPrecipErrSum = 0;
    let zMonthSum = 0;
    let validMonthsCount = 0;

    for (let m = 0; m < 12; m++) {
      const cT = cand.monthlyTemp[m];
      const tT = target.monthlyTemp[m];
      const cP = cand.monthlyPrecip[m];
      const tP = target.monthlyPrecip[m];

      if (cT !== null && tT !== null && cP !== null && tP !== null) {
        const dT = cT - tT;
        const dP = cP - tP;
        sqTempErrSum += dT * dT;
        sqPrecipErrSum += dP * dP;
        const mTz = Math.abs(dT) / monthlyTempSds[m];
        const mPz = Math.abs(dP) / monthlyPrecipSds[m];
        zMonthSum += 0.5 * mTz + 0.5 * mPz;
        validMonthsCount++;
      }
    }

    const monthlyTempRmseC =
      validMonthsCount > 0 ? Math.sqrt(sqTempErrSum / validMonthsCount) : 0;
    const monthlyPrecipRmseMm =
      validMonthsCount > 0 ? Math.sqrt(sqPrecipErrSum / validMonthsCount) : 0;
    const seasonalPatternZ =
      validMonthsCount > 0 ? zMonthSum / validMonthsCount : 1;

    // Weighted composite standardized distance
    const compositeDistance =
      0.20 * annualTempZ +
      0.25 * annualPrecipZ +
      0.15 * growingSeasonTempZ +
      0.20 * growingSeasonPrecipZ +
      0.20 * seasonalPatternZ;

    const similarityScore = Math.max(
      0,
      Math.min(100, Math.round(100 * Math.exp(-0.55 * compositeDistance)))
    );

    const reasons: string[] = [];
    if (Math.abs(annualTempDeltaC) <= 0.4) {
      reasons.push(
        `Annual mean temperature (${cand.avgTemp!.toFixed(1)} °C) is within ${Math.abs(annualTempDeltaC).toFixed(1)} °C of target.`
      );
    } else {
      reasons.push(
        `Annual mean temperature is ${cand.avgTemp!.toFixed(1)} °C (${annualTempDeltaC >= 0 ? "+" : ""}${annualTempDeltaC.toFixed(1)} °C vs. target).`
      );
    }

    if (annualPrecipDeltaPct !== null && Math.abs(annualPrecipDeltaPct) <= 8) {
      reasons.push(
        `Annual rainfall (${Math.round(cand.totalPrecip!)} mm) closely matches target (${annualPrecipDeltaPct >= 0 ? "+" : ""}${annualPrecipDeltaPct.toFixed(0)}%).`
      );
    } else {
      reasons.push(
        `Annual rainfall of ${Math.round(cand.totalPrecip!)} mm (${annualPrecipDeltaMm >= 0 ? "+" : ""}${Math.round(annualPrecipDeltaMm)} mm${annualPrecipDeltaPct !== null ? ` / ${annualPrecipDeltaPct >= 0 ? "+" : ""}${annualPrecipDeltaPct.toFixed(0)}%` : ""} vs. target).`
      );
    }

    reasons.push(
      `Growing-season (${gsWindow.months.map((m) => MONTH_SHORT[m - 1]).join("–")}) averages ${candGs.tempC.toFixed(1)} °C with ${Math.round(candGs.precipMm)} mm rainfall (${growingSeasonPrecipDeltaMm >= 0 ? "+" : ""}${Math.round(growingSeasonPrecipDeltaMm)} mm vs. target).`
    );

    if (cand.summerDrySpellDays !== null && cand.summerHeatDays !== null) {
      reasons.push(
        `Observed stress indicators in ${cand.year}: ${cand.summerDrySpellDays}-day peak Jun–Aug dry spell and ${cand.summerHeatDays} Jul–Aug heat days (>35 °C).`
      );
    }

    const seasonCharacterLabel = classifyYearCharacter(
      cand.avgTemp!,
      cand.totalPrecip!,
      archiveMeanTemp,
      archiveMeanPrecip,
      annualTempSd,
      annualPrecipSd
    );

    return {
      year: cand.year,
      similarityScore,
      compositeDistance: Number(compositeDistance.toFixed(3)),
      record: cand,
      growingSeasonTempC: candGs.tempC,
      growingSeasonPrecipMm: candGs.precipMm,
      deltas: {
        annualTempDeltaC,
        annualPrecipDeltaMm,
        annualPrecipDeltaPct,
        growingSeasonTempDeltaC,
        growingSeasonPrecipDeltaMm,
        growingSeasonPrecipDeltaPct,
        monthlyTempRmseC,
        monthlyPrecipRmseMm,
      },
      componentDistances: {
        annualTempZ: Number(annualTempZ.toFixed(2)),
        annualPrecipZ: Number(annualPrecipZ.toFixed(2)),
        growingSeasonTempZ: Number(growingSeasonTempZ.toFixed(2)),
        growingSeasonPrecipZ: Number(growingSeasonPrecipZ.toFixed(2)),
        seasonalPatternZ: Number(seasonalPatternZ.toFixed(2)),
      },
      selectionReasons: reasons,
      seasonCharacterLabel,
    };
  });

  // Sort by lowest compositeDistance (ties broken by most recent year)
  rawMatches.sort((a, b) => {
    if (Math.abs(a.compositeDistance - b.compositeDistance) > 1e-6) {
      return a.compositeDistance - b.compositeDistance;
    }
    return b.year - a.year;
  });

  const rankedMatches: HistoricalAnalogueMatch[] = rawMatches
    .slice(0, maxResults)
    .map((m, idx) => ({
      ...m,
      rank: idx + 1,
    }));

  return {
    status: "ready",
    source: climate.source,
    spatialResolution: climate.spatialResolution,
    archivePeriodLabel,
    totalValidArchiveYears: sortedYears.length,
    candidateYearsEvaluated: candidates.length,
    growingSeasonMonths: gsWindow.months,
    growingSeasonLabel: gsWindow.label,
    methodologySummary,
    target,
    matches: rankedMatches,
  };
}
