/**
 * Pure, hemisphere-aware 3-year Field Calendar builder for fallo.
 *
 * Responsibilities:
 * - Transform a 3-year RotationStrategy, field coordinates, and ClimateData
 *   into a structured 3-year × 12-month agronomic calendar.
 * - Distinguish planting months, active vegetative/reproductive growth months,
 *   documented sensitive growth stages, and harvest/termination months using
 *   only the strategy's month arrays and `cropLibrary` metadata.
 * - NEVER invent exact calendar dates (e.g. "April 14"); always express timing
 *   as month ranges or clearly labeled month-level estimates grounded in the
 *   rotation schedule and published extension/FAO crop windows.
 * - Summarize growing-period temperature (°C), cumulative precipitation (mm),
 *   and solar radiation (MJ/m²/day) for every crop season across all 3 years.
 */

import {
  type RotationStrategy,
  type ClimateData,
  type Crop,
  cropLibrary,
} from "@/lib/rotation-scoring";
import {
  evaluateCropOverlapAndTermination,
  evaluateSeasonalVarietyAlignment,
  evaluateNitrogenAndBarleyCompatibility,
  evaluateCoverCropWinterSuitability,
} from "@/lib/rotation-validator";
import { classifyAgGroup } from "@/lib/agro-classifier";
import { resolveGeographicContext } from "@/lib/region";
import { formatEnumLabel, formatCropName } from "@/lib/what-if-simulator";

export const CALENDAR_MONTH_NAMES = [
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

export const CALENDAR_MONTH_FULL_NAMES = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
] as const;

export type MonthStageRole =
  | "planting"
  | "active_growth"
  | "sensitive_stage"
  | "harvest"
  | "termination"
  | "fallow";

export interface CalendarSeasonEntry {
  year: number;
  seasonIndex: number;
  seasonLabel: string;
  cropId: string;
  cropName: string;
  scientificName: string;
  family: string;
  cropType: "cash" | "cover" | "fallow";
  activity: string;
  /** Ordered month numbers (1..12) in chronological order of the season */
  months: number[];
  /** Human-readable month range, e.g. "Apr–Aug (5 months)" or "Oct–Mar (6 months, overwinter)" */
  monthRangeLabel: string;
  /** First scheduled month of the season (estimated planting/establishment month) */
  estimatedPlantingMonth: number;
  estimatedPlantingMonthName: string;
  /** Final scheduled month of the season (estimated harvest or cover termination month) */
  estimatedEndMonth: number;
  estimatedEndMonthName: string;
  endActionLabel: "Harvest window" | "Termination window" | "Fallow end";
  /** Documented catalog planting window (hemisphere-filtered when applicable), or month-based estimate */
  documentedPlantingWindow: string;
  /** Documented catalog harvest/termination window, or month-based estimate */
  documentedHarvestOrTerminationWindow: string;
  growingWindowDescription: string;
  /** Role of each month (1..12) within this season */
  monthRoles: Record<number, MonthStageRole>;
  /** Sensitive period notes that overlap this crop's scheduled months */
  sensitiveStages: {
    stageKey: string;
    stageLabel: string;
    months: number[];
    monthNames: string[];
    note: string;
    source: string;
  }[];
  /** Growing-season climate conditions calculated from the field's monthly climate profile */
  seasonClimate: {
    avgTempC: number | null;
    minMonthlyTempC: number | null;
    maxMonthlyTempC: number | null;
    totalPrecipMm: number | null;
    avgSolarMj: number | null;
    conditionSummary: string;
  };
  /** Agronomic traits relevant to field management during this window */
  waterDemand: string;
  droughtTolerance: string;
  nitrogenSummary: string;
  residueSummary: string;
  /** Agronomic advisories covering overlap/interseeding, termination timing, seasonal variety, N availability, and winter survival */
  agronomicAdvisories: CalendarAgronomicAdvisory[];
}

export interface CalendarAgronomicAdvisory {
  severity: "warning" | "info";
  category:
    | "overlap"
    | "termination"
    | "variety_season"
    | "nitrogen"
    | "winter_survival";
  title: string;
  detail: string;
  source: string;
}

export interface CalendarMonthCell {
  month: number; // 1..12
  monthShort: string;
  monthFull: string;
  avgTempC: number | null;
  totalPrecipMm: number | null;
  avgSolarMj: number | null;
  /** Active season entries occupying this month in this rotation year */
  occupants: {
    seasonIndex: number;
    cropId: string;
    cropName: string;
    cropType: "cash" | "cover" | "fallow";
    role: MonthStageRole;
    roleLabel: string;
    isSensitiveMonth: boolean;
  }[];
}

export interface CalendarYearSchedule {
  year: number;
  seasons: CalendarSeasonEntry[];
  months: CalendarMonthCell[];
  coveredMonthsCount: number;
  cashCropNames: string[];
  coverCropNames: string[];
  yearSummary: string;
  yearAdvisories: CalendarAgronomicAdvisory[];
}

export interface FieldCalendarModel {
  strategyId: string;
  strategyName: string;
  archetype: string;
  hemisphere: "northern" | "southern" | "tropical";
  hemisphereSeasonNote: string;
  years: CalendarYearSchedule[];
  totalUniqueFamilies: string[];
  averageCoveredMonthsPerYear: number;
}

function formatMonthRange(months: number[]): string {
  if (months.length === 0) return "No months specified";
  const first = CALENDAR_MONTH_NAMES[(months[0] - 1 + 12) % 12];
  const last = CALENDAR_MONTH_NAMES[(months[months.length - 1] - 1 + 12) % 12];
  if (months.length === 1) {
    return `${first} (1 month)`;
  }
  const wrapsYear = months[months.length - 1] < months[0];
  return `${first}–${last} (${months.length} mos${wrapsYear ? ", overwinter" : ""})`;
}

function humanizeStageKey(key: string): string {
  return key
    .replace(/([A-Z])/g, " $1")
    .replace(/_/g, " ")
    .replace(/^\w/, (c) => c.toUpperCase())
    .trim();
}

/**
 * Filter hemisphere-tagged catalog window text (e.g. "April–May (NH) / October–November (SH)")
 * so farmers see the clause most relevant to their hemisphere alongside the full note.
 */
export function selectHemisphereWindowText(
  rawWindow: string | null | undefined,
  hemisphere: "northern" | "southern" | "tropical",
  fallbackMonthName: string,
  fallbackKind: "planting" | "harvest" | "termination"
): string {
  if (!rawWindow || !rawWindow.trim()) {
    return `Estimated ${fallbackKind} month: ${fallbackMonthName} (derived from rotation schedule)`;
  }
  const clauses = rawWindow.split("/").map((c) => c.trim());
  if (clauses.length > 1) {
    if (hemisphere === "southern") {
      const shClause = clauses.find(
        (c) => /\(SH\b/i.test(c) || /southern|australia/i.test(c)
      );
      if (shClause) return `${shClause} (schedule: ${fallbackMonthName})`;
    } else if (hemisphere === "northern") {
      const nhClause = clauses.find(
        (c) => /\(NH\b/i.test(c) || /northern/i.test(c)
      );
      if (nhClause) return `${nhClause} (schedule: ${fallbackMonthName})`;
    } else if (hemisphere === "tropical") {
      const tropClause = clauses.find((c) => /tropic|rainy|monsoon/i.test(c));
      if (tropClause) return `${tropClause} (schedule: ${fallbackMonthName})`;
    }
  }
  return `${rawWindow.trim()} (schedule: ${fallbackMonthName})`;
}

/**
 * Adjust documented sensitive-period months for Southern Hemisphere fields when
 * the crop's scheduled growing window is in the opposite half of the year.
 */
function resolveSensitiveMonthsForSchedule(
  documentedMonths: number[],
  scheduledMonths: number[],
  hemisphere: "northern" | "southern" | "tropical"
): number[] {
  const directOverlap = documentedMonths.filter((m) => scheduledMonths.includes(m));
  if (directOverlap.length > 0) {
    return directOverlap;
  }
  if (hemisphere === "southern") {
    const shifted = documentedMonths
      .map((m) => ((m + 5) % 12) + 1)
      .filter((m) => scheduledMonths.includes(m));
    if (shifted.length > 0) return shifted;
  }
  return [];
}

function summarizeSeasonClimate(
  months: number[],
  climate: ClimateData | null,
  crop: Crop | undefined
): CalendarSeasonEntry["seasonClimate"] {
  if (!climate || months.length === 0) {
    return {
      avgTempC: null,
      minMonthlyTempC: null,
      maxMonthlyTempC: null,
      totalPrecipMm: null,
      avgSolarMj: null,
      conditionSummary: "Climate observations not loaded.",
    };
  }

  const temps = months
    .map((m) => climate.fullRecord.monthlyTemp[m - 1])
    .filter((v): v is number => v !== null && v !== undefined);
  const precips = months
    .map((m) => climate.fullRecord.monthlyPrecip[m - 1])
    .filter((v): v is number => v !== null && v !== undefined);
  const solars = months
    .map((m) => climate.fullRecord.monthlySolar[m - 1])
    .filter((v): v is number => v !== null && v !== undefined);

  const avgTempC =
    temps.length > 0 ? temps.reduce((a, b) => a + b, 0) / temps.length : null;
  const minMonthlyTempC = temps.length > 0 ? Math.min(...temps) : null;
  const maxMonthlyTempC = temps.length > 0 ? Math.max(...temps) : null;
  const totalPrecipMm =
    precips.length > 0 ? precips.reduce((a, b) => a + b, 0) : null;
  const avgSolarMj =
    solars.length > 0 ? solars.reduce((a, b) => a + b, 0) / solars.length : null;

  const parts: string[] = [];
  if (avgTempC !== null && minMonthlyTempC !== null && maxMonthlyTempC !== null) {
    parts.push(
      `Mean ${avgTempC.toFixed(1)} °C (monthly range ${minMonthlyTempC.toFixed(0)}–${maxMonthlyTempC.toFixed(0)} °C)`
    );
  }
  if (totalPrecipMm !== null) {
    parts.push(`${Math.round(totalPrecipMm)} mm cumulative rain across ${months.length} mos`);
  }
  if (crop && totalPrecipMm !== null) {
    if (crop.waterDemand === "high" && totalPrecipMm < 250) {
      parts.push("supplementary moisture conservation or irrigation advisable for high water-demand crop");
    } else if (
      (crop.droughtTolerance === "high" || crop.droughtTolerance === "very_high") &&
      totalPrecipMm < 250
    ) {
      parts.push("well matched to crop's high drought tolerance");
    }
  }

  return {
    avgTempC,
    minMonthlyTempC,
    maxMonthlyTempC,
    totalPrecipMm,
    avgSolarMj,
    conditionSummary: parts.join(" · ") || "Seasonal climate summary unavailable.",
  };
}

export function formatMonthRoleLabel(role: MonthStageRole): string {
  switch (role) {
    case "planting":
      return "Planting / Establishment";
    case "active_growth":
      return "Active Growth";
    case "sensitive_stage":
      return "Sensitive Growth Stage";
    case "harvest":
      return "Harvest Window";
    case "termination":
      return "Cover Termination";
    case "fallow":
      return "Fallow / Rest";
  }
}

/**
 * Build a complete 3-year FieldCalendarModel for a selected RotationStrategy.
 */
export function buildFieldCalendar(params: {
  strategy: RotationStrategy;
  climate: ClimateData | null;
  lat: number;
  lon: number;
}): FieldCalendarModel {
  const { strategy, climate, lat, lon } = params;
  const geo = resolveGeographicContext(lat, lon);
  const absLat = Math.abs(lat);
  const hemisphere: "northern" | "southern" | "tropical" =
    absLat < 23.5 || geo.hemisphere === "equatorial" ? "tropical" : geo.hemisphere;

  const hemisphereSeasonNote =
    hemisphere === "southern"
      ? `Southern Hemisphere calendar (${geo.countryName}): warm growing season peaks Oct–Mar; cool season spans Apr–Sep.`
      : hemisphere === "tropical"
        ? `Tropical calendar (${geo.countryName}): cropping windows follow wet/dry monsoon and rainfall onset rather than thermal winter/summer.`
        : `Northern Hemisphere calendar (${geo.countryName}): warm season spans Apr–Sep; overwinter cover/small-grain season spans Oct–May.`;

  const familiesSet = new Set<string>();
  let totalCoveredMonths = 0;

  const overlapFindings = evaluateCropOverlapAndTermination(strategy, hemisphere);
  const agGroup = climate ? classifyAgGroup(climate, null).group : undefined;
  const seasonalVarietyFindings = evaluateSeasonalVarietyAlignment(
    strategy,
    hemisphere,
    { agGroup, regionTag: geo.regionTag }
  );
  const nitrogenBarleyFindings = evaluateNitrogenAndBarleyCompatibility(
    strategy,
    hemisphere
  );
  const winterSuitabilityFindings = evaluateCoverCropWinterSuitability({
    proposal: strategy,
    climate,
    hemisphere,
  });

  const years: CalendarYearSchedule[] = strategy.years.map((yr) => {
    const yrOverlaps = overlapFindings.filter((f) => f.year === yr.year);
    const yrVarieties = seasonalVarietyFindings.filter((f) => f.year === yr.year);
    const yrNitrogen = nitrogenBarleyFindings.filter((f) => f.year === yr.year);
    const yrWinter = winterSuitabilityFindings.filter((f) => f.year === yr.year);

    const seasons: CalendarSeasonEntry[] = yr.seasons.map((s, idx) => {
      const crop = cropLibrary[s.crop];
      const isFallow = s.crop === "winter_fallow" || !crop;
      const cropType: "cash" | "cover" | "fallow" = isFallow
        ? "fallow"
        : crop.type;

      if (crop?.family) {
        familiesSet.add(crop.family);
      }

      const scheduledMonths = s.months.filter((m) => m >= 1 && m <= 12);
      const firstMonth = scheduledMonths[0] ?? 1;
      const lastMonth = scheduledMonths[scheduledMonths.length - 1] ?? firstMonth;
      const firstMonthName = CALENDAR_MONTH_FULL_NAMES[firstMonth - 1];
      const lastMonthName = CALENDAR_MONTH_FULL_NAMES[lastMonth - 1];

      // Determine sensitive stages overlapping scheduled months
      const sensitiveStages: CalendarSeasonEntry["sensitiveStages"] = [];
      const sensitiveMonthSet = new Set<number>();

      if (crop?.sensitivePeriods) {
        for (const [stageKey, sp] of Object.entries(crop.sensitivePeriods)) {
          const matchedMonths = resolveSensitiveMonthsForSchedule(
            sp.months,
            scheduledMonths,
            hemisphere
          );
          if (matchedMonths.length > 0) {
            matchedMonths.forEach((m) => sensitiveMonthSet.add(m));
            sensitiveStages.push({
              stageKey,
              stageLabel: humanizeStageKey(stageKey),
              months: matchedMonths,
              monthNames: matchedMonths.map((m) => CALENDAR_MONTH_NAMES[m - 1]),
              note: sp.note,
              source: sp.source,
            });
          }
        }
      }

      const monthRoles: Record<number, MonthStageRole> = {};
      for (let i = 0; i < scheduledMonths.length; i++) {
        const m = scheduledMonths[i];
        if (isFallow) {
          monthRoles[m] = "fallow";
        } else if (i === 0) {
          monthRoles[m] = "planting";
        } else if (i === scheduledMonths.length - 1 && scheduledMonths.length > 1) {
          monthRoles[m] = cropType === "cover" ? "termination" : "harvest";
        } else if (sensitiveMonthSet.has(m)) {
          monthRoles[m] = "sensitive_stage";
        } else {
          monthRoles[m] = "active_growth";
        }
      }

      const documentedPlantingWindow = isFallow
        ? `Fallow start (${firstMonthName})`
        : selectHemisphereWindowText(
            crop?.growingWindow.planting,
            hemisphere,
            firstMonthName,
            "planting"
          );

      const documentedHarvestOrTerminationWindow = isFallow
        ? `Fallow end (${lastMonthName})`
        : cropType === "cover"
          ? selectHemisphereWindowText(
              crop?.growingWindow.termination ?? crop?.growingWindow.harvest,
              hemisphere,
              lastMonthName,
              "termination"
            )
          : selectHemisphereWindowText(
              crop?.growingWindow.harvest,
              hemisphere,
              lastMonthName,
              "harvest"
            );

      const seasonClimate = summarizeSeasonClimate(scheduledMonths, climate, crop);

      const agronomicAdvisories: CalendarAgronomicAdvisory[] = [];

      // Attach overlap and termination advisories relevant to this crop season
      for (const ov of yrOverlaps) {
        if (ov.cashCropId === s.crop || ov.coverCropId === s.crop) {
          agronomicAdvisories.push({
            severity:
              ov.classification === "incompatible_overlap" ? "warning" : "info",
            category:
              ov.classification === "incompatible_overlap" &&
              ov.conflictsWithSensitiveStage
                ? "termination"
                : "overlap",
            title: ov.title,
            detail: ov.message,
            source: ov.source,
          });
        }
      }

      // Attach seasonal variety advisories
      for (const vf of yrVarieties) {
        if (vf.cropId === s.crop) {
          agronomicAdvisories.push({
            severity: "warning",
            category: "variety_season",
            title: `Seasonal variety mismatch: ${vf.cropName}`,
            detail: vf.message,
            source: vf.source,
          });
        }
      }

      // Attach nitrogen & malting barley advisories
      for (const nf of yrNitrogen) {
        if (nf.legumeCropId === s.crop || nf.targetCashCropId === s.crop) {
          agronomicAdvisories.push({
            severity: "warning",
            category: "nitrogen",
            title:
              nf.kind === "malting_barley_excess_n_risk"
                ? `Conditional malting barley protein & lodging advisory (${nf.legumeCropName} → ${nf.targetCashCropName})`
                : nf.kind === "concurrent_overlap_n_unavailable"
                  ? `Post-termination N credit not available during concurrent ${nf.legumeCropName} overlap`
                  : `Reduced N accumulation window (${nf.legumeCropName})`,
            detail: nf.message,
            source: nf.source,
          });
        }
      }

      // Attach winter cover-crop climate suitability & monthly-mean caveat advisories
      for (const wf of yrWinter) {
        if (wf.cropId === s.crop) {
          agronomicAdvisories.push({
            severity: wf.severity,
            category: "winter_survival",
            title: wf.title,
            detail: wf.message,
            source: wf.source,
          });
        }
      }

      const nCredit = crop?.nitrogenBehavior.residualNcredit?.value;
      const hasConcurrentOverlapConflict = yrNitrogen.some(
        (nf) =>
          nf.kind === "concurrent_overlap_n_unavailable" &&
          nf.legumeCropId === s.crop
      );
      const nitrogenSummary = isFallow
        ? "No living root nitrogen uptake during fallow"
        : nCredit
          ? cropType === "cover"
            ? `Fixes N (est. ${nCredit} for subsequent crop after termination; depends on establishment, stand vigor, biomass, termination & mineralization${hasConcurrentOverlapConflict ? " — not available to concurrently overlapping spring crop" : ""})`
            : `Fixes N (est. residual credit: ${nCredit})`
          : `N demand: ${formatEnumLabel(crop?.nitrogenBehavior.demand ?? "moderate")}`;

      const residueSummary = isFallow
        ? "No new biomass residue added"
        : `${formatEnumLabel(crop?.residue.quantity ?? "moderate")} biomass (${formatEnumLabel(crop?.residue.persistence ?? "moderate").toLowerCase()} persistence)`;

      return {
        year: yr.year,
        seasonIndex: idx,
        seasonLabel: s.season,
        cropId: s.crop,
        cropName: formatCropName(s.crop),
        scientificName: crop?.scientificName ?? "",
        family: crop?.family ?? "Fallow",
        cropType,
        activity: s.activity,
        months: scheduledMonths,
        monthRangeLabel: formatMonthRange(scheduledMonths),
        estimatedPlantingMonth: firstMonth,
        estimatedPlantingMonthName: firstMonthName,
        estimatedEndMonth: lastMonth,
        estimatedEndMonthName: lastMonthName,
        endActionLabel: isFallow
          ? "Fallow end"
          : cropType === "cover"
            ? "Termination window"
            : "Harvest window",
        documentedPlantingWindow,
        documentedHarvestOrTerminationWindow,
        growingWindowDescription:
          crop?.growingWindow.description ??
          "Month-level schedule derived from validated rotation plan.",
        monthRoles,
        sensitiveStages,
        seasonClimate,
        waterDemand: formatEnumLabel(crop?.waterDemand ?? "low"),
        droughtTolerance: formatEnumLabel(crop?.droughtTolerance ?? "moderate"),
        nitrogenSummary,
        residueSummary,
        agronomicAdvisories,
      };
    });

    const yearAdvisories: CalendarAgronomicAdvisory[] = [];
    const seenYearAdvisoryTitles = new Set<string>();
    for (const sea of seasons) {
      for (const adv of sea.agronomicAdvisories) {
        if (!seenYearAdvisoryTitles.has(adv.title)) {
          seenYearAdvisoryTitles.add(adv.title);
          yearAdvisories.push(adv);
        }
      }
    }

    // Build 12 monthly cells for this rotation year
    const months: CalendarMonthCell[] = CALENDAR_MONTH_NAMES.map((mShort, idx) => {
      const mNum = idx + 1;
      const occupants: CalendarMonthCell["occupants"] = [];

      for (const sea of seasons) {
        if (sea.months.includes(mNum)) {
          const role = sea.monthRoles[mNum] ?? "active_growth";
          occupants.push({
            seasonIndex: sea.seasonIndex,
            cropId: sea.cropId,
            cropName: sea.cropName,
            cropType: sea.cropType,
            role,
            roleLabel: formatMonthRoleLabel(role),
            isSensitiveMonth: sea.sensitiveStages.some((st) => st.months.includes(mNum)),
          });
        }
      }

      return {
        month: mNum,
        monthShort: mShort,
        monthFull: CALENDAR_MONTH_FULL_NAMES[idx],
        avgTempC: climate?.fullRecord.monthlyTemp[idx] ?? null,
        totalPrecipMm: climate?.fullRecord.monthlyPrecip[idx] ?? null,
        avgSolarMj: climate?.fullRecord.monthlySolar[idx] ?? null,
        occupants,
      };
    });

    const coveredMonthsCount = months.filter((m) =>
      m.occupants.some((o) => o.cropType !== "fallow")
    ).length;
    totalCoveredMonths += coveredMonthsCount;

    const cashCropNames = seasons
      .filter((s) => s.cropType === "cash")
      .map((s) => s.cropName);
    const coverCropNames = seasons
      .filter((s) => s.cropType === "cover")
      .map((s) => s.cropName);

    const yearSummary = [
      cashCropNames.length > 0 ? `Cash: ${cashCropNames.join(" + ")}` : null,
      coverCropNames.length > 0 ? `Cover: ${coverCropNames.join(" + ")}` : null,
      `${coveredMonthsCount}/12 months with living cover`,
    ]
      .filter(Boolean)
      .join(" · ");

    return {
      year: yr.year,
      seasons,
      months,
      coveredMonthsCount,
      cashCropNames,
      coverCropNames,
      yearSummary,
      yearAdvisories,
    };
  });

  return {
    strategyId: strategy.id,
    strategyName: strategy.name,
    archetype: strategy.archetype,
    hemisphere,
    hemisphereSeasonNote,
    years,
    totalUniqueFamilies: Array.from(familiesSet),
    averageCoveredMonthsPerYear:
      years.length > 0 ? Number((totalCoveredMonths / years.length).toFixed(1)) : 0,
  };
}
