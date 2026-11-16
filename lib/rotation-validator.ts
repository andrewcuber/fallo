/**
 * Deterministic rotation proposal validator for fallo.
 *
 * Validates AI-generated (or any) rotation proposals against hard agronomic
 * constraints derived from the verified crop catalog.
 *
 * Design principles:
 * - All rules are explicit, testable, and deterministic.
 * - Hard constraints reject a proposal. Soft concerns become warnings.
 * - The validator never invents crop traits or tolerances.
 * - Unknown/missing data is handled conservatively: if we cannot verify a claim,
 *   we downgrade confidence but do not silently assume safety.
 */

import {
  type Crop,
  type ClimateData,
  type RotationStrategy,
  cropLibrary,
} from "@/lib/rotation-scoring";
import { type AgGroup } from "@/lib/agro-classifier";

const MONTH_SHORT_NAMES = [
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

export interface ProposalValidationResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
  /** Details for UI traceability */
  checks: ValidationCheck[];
}

export interface ValidationCheck {
  name: string;
  passed: boolean;
  severity: "error" | "warning" | "info";
  message: string;
}

export interface ValidationContext {
  /** The classified agricultural group for this field */
  agGroup: AgGroup;
  /** Optional region tag from lib/region.ts */
  regionTag: string | null;
  /** Available crops after group filter (for reference) */
  availableCropIds: string[];
  /** Optional field climate profile for winter cover-crop survival & planting-window checks */
  climate?: ClimateData | null;
  /** Optional hemisphere context (defaults to "northern") */
  hemisphere?: "northern" | "southern" | "tropical";
}

export type CashCoverOverlapClassification =
  | "conditional_transition"
  | "compatible_interseeding"
  | "incompatible_overlap";

export interface CashCoverOverlapFinding {
  year: number;
  cashCropId: string;
  cashCropName: string;
  coverCropId: string;
  coverCropName: string;
  sharedMonths: number[];
  sharedMonthNames: string[];
  coverTerminationMonth: number;
  coverTerminationMonthName: string;
  classification: CashCoverOverlapClassification;
  conflictsWithSensitiveStage: boolean;
  conflictingStageLabels: string[];
  title: string;
  message: string;
  source: string;
}

export interface SeasonalVarietyFinding {
  year: number;
  cropId: string;
  cropName: string;
  months: number[];
  recommendedAlternativeCropId: string;
  recommendedAlternativeName: string;
  message: string;
  source: string;
}

export interface NitrogenBarleyFinding {
  year: number;
  legumeCropId: string;
  legumeCropName: string;
  targetCashCropId: string;
  targetCashCropName: string;
  kind:
    | "concurrent_overlap_n_unavailable"
    | "malting_barley_excess_n_risk"
    | "short_window_reduced_n";
  message: string;
  source: string;
}

export interface CoverWinterSuitabilityFinding {
  year: number;
  cropId: string;
  cropName: string;
  months: number[];
  coldestWinterMonthC: number | null;
  plantingMonthC: number | null;
  severity: "warning" | "info";
  title: string;
  message: string;
  monthlyMeanLimitationNote: string;
  source: string;
}

/**
 * Single source of truth for rotation compatibility rules.
 * Both the AI prompt builder and `validateProposal()` consume this specification
 * so AI instructions and deterministic validation never diverge.
 */
export const ROTATION_COMPATIBILITY_RULES = {
  hardConstraints: {
    rotationYears: 3,
    minCashCropsPerYear: 1,
    maxCashCropSharedMonths: 1,
    maxDoubleCropTransitionMonths: 2,
    maxYearsPerFamily: 2,
    maxSclerotiniaYears: 2,
    maxPrimarySclerotiniaOilseedYears: 1,
    rules: [
      "Use ONLY crop IDs from the verified available crop catalog for the field's agricultural group and region. Do not invent crops, varieties, planting windows, or agronomic traits.",
      "Each strategy must cover exactly 3 years (Year 1, Year 2, Year 3), with 1–4 seasonal entries per year.",
      "Every year must include at least 1 cash crop.",
      "Two same-season cash crops within the same year must not overlap by more than 1 transition month (winter-to-summer double-crop cash transitions may share at most 2 harvest/planting boundary months).",
      "No botanical family (e.g., Poaceae, Fabaceae, Asteraceae, Brassicaceae) may appear in more than 2 years of cash crops across the 3-year rotation.",
      "Primary Sclerotinia oilseed hosts (sunflower, winter_canola, spring_canola) must not appear in more than 1 year of a 3-year upland rotation, and total Sclerotinia-susceptible cash crops (sunflower, winter_canola, spring_canola, soybean) must not appear in all 3 years without at least 1 non-host cereal/grass break year.",
    ],
  },
  softAdvisories: {
    minRecommendedFamilies: 3,
    maxSoybeanYearsBeforeWarning: 1,
    fusariumPredecessors: ["field_corn", "grain_sorghum"] as const,
    fusariumSusceptibleCrop: "soft_red_winter_wheat",
    rules: [
      "Avoid planting soft_red_winter_wheat in the year immediately following field_corn or grain_sorghum due to shared Fusarium head blight inoculum in residue (flagged as a Fusarium warning).",
      "Avoid planting soybean in more than 1 year of the 3-year rotation to limit soybean cyst nematode (SCN) pressure (flagged as an SCN warning).",
      "Avoid combining a primary Sclerotinia oilseed host (sunflower, winter_canola, spring_canola) and soybean in the same 3-year rotation when non-host alternatives are available; a 2-year combination separated by a 1-year non-host cereal break is accepted as a manageable risk with a Sclerotinia warning and diversity score penalty.",
      "Avoid repeating the same botanical family across all 3 years via cover crops (e.g., planting Poaceae or Fabaceae cover crops in the cash-crop break year), which is flagged as a green-bridge advisory warning.",
      "Include at least 3 distinct botanical families across the 3-year rotation when the available crop catalog permits (fewer than 3 families is flagged as a low-diversity warning).",
      "Terminate overwintering cover crops (especially viny hairy_vetch and tall cereal_rye) prior to or at cash-crop planting; do not leave winter covers overlapping spring cash crops across multiple active-growth months or terminating during cash-crop reproductive stages (flagged as a cover-crop overlap/termination warning).",
      "Match seasonal crop varieties to their regional and climatic growing schedule: use spring_barley, spring_wheat, or spring_canola for spring-sown schedules (or documented mild-winter autumn/winter sowing in Mediterranean, MENA, South Asian Rabi, and Australian winter-rainfall systems), and use winter_barley, soft_red_winter_wheat, or winter_canola for cold-winter vernalizing overwinter schedules.",
      "When barley (spring_barley / winter_barley) is grown for malting, avoid pairing immediately after or overlapping high-nitrogen legume covers (hairy_vetch, alfalfa_annual_forage), as excess or late-mineralizing legume N increases the risk of exceeding maltster/buyer grain protein specifications and lodging.",
    ],
  },
} as const;

const COMPATIBLE_RELAY_COVER_CROPS = new Set([
  "crimson_clover",
  "cereal_rye",
  "forage_radish",
  "winter_oat",
  "sunn_hemp",
  "lablab_bean",
  "cowpea",
  "stylo_cover",
  "mucuna_velvet_bean",
]);

const COMPATIBLE_RELAY_CASH_CROPS = new Set([
  "field_corn",
  "soybean",
  "grain_sorghum",
  "sorghum_tropical",
  "pearl_millet_grain",
  "sesame",
  "cassava",
  "maize_tropical",
]);

const SMALL_GRAIN_CASH_CROPS = new Set([
  "spring_barley",
  "winter_barley",
  "spring_wheat",
  "soft_red_winter_wheat",
]);

const MILD_WINTER_AUTUMN_SOWN_SPRING_HABIT_GROUPS = new Set<AgGroup>([
  "temperate_mediterranean",
  "subtropical_humid",
  "arid",
  "tropical_monsoon",
  "tropical_savanna",
  "tropical_subhumid",
  "tropical_humid",
]);

const MILD_WINTER_AUTUMN_SOWN_SPRING_HABIT_REGIONS = new Set<string>([
  "mena_mediterranean_arid",
  "south_asia_indo_gangetic",
  "australia_southern_wheatbelt",
  "us_southwest",
  "east_asia_china_subtropical",
  "sa_pampas_cerrado",
  "ssa_east_southern_humid",
]);

function humanizeStageKey(key: string): string {
  return key
    .replace(/([A-Z])/g, " $1")
    .replace(/_/g, " ")
    .replace(/^\w/, (c) => c.toUpperCase())
    .trim();
}

function getSensitiveStageOverlap(
  crop: Crop | undefined,
  scheduledCashMonths: number[],
  testMonths: number[],
  hemisphere: "northern" | "southern" | "tropical" = "northern"
): string[] {
  if (!crop?.sensitivePeriods || testMonths.length === 0) return [];
  const labels: string[] = [];
  for (const [stageKey, sp] of Object.entries(crop.sensitivePeriods)) {
    const docMonths =
      hemisphere === "southern" &&
      !sp.months.some((m) => scheduledCashMonths.includes(m))
        ? sp.months.map((m) => ((m + 5) % 12) + 1)
        : sp.months;
    const activeStageMonths = docMonths.filter((m) =>
      scheduledCashMonths.includes(m)
    );
    const conflicting = activeStageMonths.filter((m) => testMonths.includes(m));
    if (conflicting.length > 0) {
      const mNames = conflicting.map((m) => MONTH_SHORT_NAMES[m - 1]).join("–");
      labels.push(`${humanizeStageKey(stageKey)} (${mNames})`);
    }
  }
  return labels;
}

/**
 * Evaluate cash-crop and cover-crop overlaps and cover-crop termination timing
 * across a 3-year rotation strategy.
 *
 * Distinguishes:
 * - "conditional_transition": 1-month planting/termination or harvest/seeding boundary transition
 *   where month-level resolution cannot verify intra-month event order, so compatibility is
 *   conditional on actual termination-before-planting sequence and management.
 * - "compatible_interseeding": Intentional late-season overseeding/relay cropping into maturing
 *   cash crops or spring frost-seeding clover into small grains where cover termination does not
 *   occur inside active cash-crop growth or sensitive reproductive stages.
 * - "incompatible_overlap": Multi-month competitive overlap during cash-crop establishment/growth
 *   (e.g., hairy_vetch Sep–May overlapping spring_barley Mar–Jul across March–May) or cover-crop
 *   termination occurring inside cash-crop active growth / sensitive stages.
 */
export function evaluateCropOverlapAndTermination(
  proposal: RotationStrategy,
  hemisphere: "northern" | "southern" | "tropical" = "northern"
): CashCoverOverlapFinding[] {
  const findings: CashCoverOverlapFinding[] = [];

  for (const yr of proposal.years) {
    const cashSeasons = yr.seasons.filter(
      (s) => cropLibrary[s.crop]?.type === "cash"
    );
    const coverSeasons = yr.seasons.filter(
      (s) =>
        cropLibrary[s.crop]?.type === "cover" && s.crop !== "winter_fallow"
    );

    for (const cashSea of cashSeasons) {
      const cashCrop = cropLibrary[cashSea.crop];
      const cashMonths = cashSea.months.filter((m) => m >= 1 && m <= 12);
      if (!cashCrop || cashMonths.length === 0) continue;

      const cashPlantMonth = cashMonths[0];
      const cashHarvestMonth = cashMonths[cashMonths.length - 1];
      const cashInteriorMonths =
        cashMonths.length > 2 ? cashMonths.slice(1, -1) : [];

      for (const coverSea of coverSeasons) {
        const coverCrop = cropLibrary[coverSea.crop];
        const coverMonths = coverSea.months.filter((m) => m >= 1 && m <= 12);
        if (!coverCrop || coverMonths.length === 0) continue;

        const sharedMonths = cashMonths.filter((m) => coverMonths.includes(m));
        if (sharedMonths.length === 0) continue;

        const sharedMonthNames = sharedMonths.map(
          (m) => MONTH_SHORT_NAMES[m - 1]
        );
        const coverPlantMonth = coverMonths[0];
        const coverTerminationMonth = coverMonths[coverMonths.length - 1];
        const coverTerminationMonthName =
          MONTH_SHORT_NAMES[coverTerminationMonth - 1];

        const conflictingStageLabels = getSensitiveStageOverlap(
          cashCrop,
          cashMonths,
          sharedMonths,
          hemisphere
        );
        const terminationHitsSensitiveStage =
          getSensitiveStageOverlap(
            cashCrop,
            cashMonths,
            [coverTerminationMonth],
            hemisphere
          ).length > 0;
        const terminationInsideCashGrowth =
          cashInteriorMonths.includes(coverTerminationMonth) ||
          (sharedMonths.length >= 2 &&
            cashMonths.includes(coverTerminationMonth) &&
            coverTerminationMonth !== cashPlantMonth);

        const conflictsWithSensitiveStage =
          conflictingStageLabels.length > 0 || terminationHitsSensitiveStage;

        // 1. Check 1-month boundary transition (termination-to-planting or harvest-to-seeding)
        // Because the calendar only has monthly resolution, compatibility is conditional on actual
        // intra-month event order and management rather than automatically guaranteed.
        const isSingleMonthTerminateThenPlant =
          sharedMonths.length === 1 &&
          sharedMonths[0] === coverTerminationMonth &&
          sharedMonths[0] === cashPlantMonth &&
          !terminationHitsSensitiveStage;

        const isSingleMonthHarvestThenSeed =
          sharedMonths.length === 1 &&
          sharedMonths[0] === cashHarvestMonth &&
          sharedMonths[0] === coverPlantMonth;

        if (isSingleMonthTerminateThenPlant || isSingleMonthHarvestThenSeed) {
          const isHairyVetchToSummerCash =
            isSingleMonthTerminateThenPlant && coverCrop.id === "hairy_vetch";
          const transitionMessage = isSingleMonthTerminateThenPlant
            ? isHairyVetchToSummerCash
              ? `Because the schedule has monthly resolution, compatibility in ${sharedMonthNames[0]} depends on actual intra-month event order and management: ${coverCrop.commonName} termination must precede ${cashCrop.commonName} planting (for example, USDA NRCS guidance recommends approximately 10–14 days between hairy vetch termination and summer cash-crop planting to reduce soil moisture depletion, pest carryover, and seedling interference, unless using specialized planting-green practices). If ${cashCrop.commonName} is planted before ${coverCrop.commonName} is terminated within ${sharedMonthNames[0]}, competitive overlap still occurs.`
              : `Because the schedule has monthly resolution, compatibility in ${sharedMonthNames[0]} depends on actual intra-month event order and management: ${coverCrop.commonName} termination must precede ${cashCrop.commonName} planting (or use appropriate planting-green residue and moisture management). If ${cashCrop.commonName} is planted before ${coverCrop.commonName} is terminated within ${sharedMonthNames[0]}, competitive overlap still occurs.`
            : `Because the schedule has monthly resolution, compatibility in ${sharedMonthNames[0]} depends on actual intra-month event order and management: ${coverCrop.commonName} should be seeded after ${cashCrop.commonName} harvest or via intentional late-season overseeding at crop senescence.`;

          findings.push({
            year: yr.year,
            cashCropId: cashCrop.id,
            cashCropName: cashCrop.commonName,
            coverCropId: coverCrop.id,
            coverCropName: coverCrop.commonName,
            sharedMonths,
            sharedMonthNames,
            coverTerminationMonth,
            coverTerminationMonthName,
            classification: "conditional_transition",
            conflictsWithSensitiveStage: false,
            conflictingStageLabels: [],
            title: isSingleMonthTerminateThenPlant
              ? `Conditional ${sharedMonthNames[0]} cover-termination to cash-planting transition (month-level resolution)`
              : `Conditional ${sharedMonthNames[0]} harvest-to-cover seeding transition (month-level resolution)`,
            message: transitionMessage,
            source: "USDA NRCS / SARE Managing Cover Crops Profitably",
          });
          continue;
        }

        // 2. Check intentional, agronomically compatible interseeding / relay cropping
        const cashTailTwoMonths = cashMonths.slice(-2);
        const isLateSeasonRelayOverseed =
          sharedMonths.length <= 2 &&
          sharedMonths.every((m) => cashTailTwoMonths.includes(m)) &&
          cashTailTwoMonths.includes(coverPlantMonth) &&
          !cashMonths.includes(coverTerminationMonth) &&
          COMPATIBLE_RELAY_COVER_CROPS.has(coverCrop.id) &&
          COMPATIBLE_RELAY_CASH_CROPS.has(cashCrop.id);

        const isFrostSeededCloverIntoSmallGrain =
          coverCrop.id === "crimson_clover" &&
          SMALL_GRAIN_CASH_CROPS.has(cashCrop.id) &&
          !cashInteriorMonths.includes(coverTerminationMonth) &&
          !terminationHitsSensitiveStage &&
          coverTerminationMonth !== cashHarvestMonth;

        if (isLateSeasonRelayOverseed || isFrostSeededCloverIntoSmallGrain) {
          findings.push({
            year: yr.year,
            cashCropId: cashCrop.id,
            cashCropName: cashCrop.commonName,
            coverCropId: coverCrop.id,
            coverCropName: coverCrop.commonName,
            sharedMonths,
            sharedMonthNames,
            coverTerminationMonth,
            coverTerminationMonthName,
            classification: "compatible_interseeding",
            conflictsWithSensitiveStage: false,
            conflictingStageLabels,
            title: isFrostSeededCloverIntoSmallGrain
              ? `Compatible underseeding / frost-seeding (${sharedMonthNames.join("–")})`
              : `Compatible late-season relay / overseeding (${sharedMonthNames.join("–")})`,
            message: isFrostSeededCloverIntoSmallGrain
              ? `${coverCrop.commonName} can be frost-seeded or underseeded into ${cashCrop.commonName} (${sharedMonthNames.join("–")}) as a low-stature understory legume that continues growing after grain harvest.`
              : `${coverCrop.commonName} overlaps ${cashCrop.commonName} during ${sharedMonthNames.join("–")} via late-season overseeding/relay intercropping at canopy senescence and continues growing after cash-crop harvest.`,
            source: "SARE Managing Cover Crops Profitably / State Extension Relay Interseeding Guidelines",
          });
          continue;
        }

        // 3. Otherwise, flag as incompatible scheduling overlap & termination conflict
        const isVinyVetchInSmallGrain =
          coverCrop.id === "hairy_vetch" &&
          SMALL_GRAIN_CASH_CROPS.has(cashCrop.id);
        const isRyeInSmallGrain =
          coverCrop.id === "cereal_rye" &&
          SMALL_GRAIN_CASH_CROPS.has(cashCrop.id);

        const conflictReasons: string[] = [];
        if (isVinyVetchInSmallGrain) {
          conflictReasons.push(
            `${coverCrop.commonName} is a vigorous climbing/vining legume whose tendrils twine around ${cashCrop.commonName} stems during ${sharedMonthNames.join("–")}, causing severe lodging, light competition, and grain harvest contamination rather than a compatible interseeding`
          );
        } else if (isRyeInSmallGrain) {
          conflictReasons.push(
            `${coverCrop.commonName} competes directly with ${cashCrop.commonName} in the same Poaceae cereal canopy during ${sharedMonthNames.join("–")} and can contaminate harvested grain`
          );
        } else {
          conflictReasons.push(
            `${coverCrop.commonName} and ${cashCrop.commonName} overlap for ${sharedMonths.length} month(s) (${sharedMonthNames.join("–")}) during active cash-crop establishment and vegetative growth without a compatible relay/interseeding window`
          );
        }

        if (terminationInsideCashGrowth || conflictsWithSensitiveStage) {
          const stageDetail =
            conflictingStageLabels.length > 0
              ? ` (overlapping critical ${conflictingStageLabels.join(", ")})`
              : "";
          conflictReasons.push(
            `${coverCrop.commonName} termination is scheduled in ${coverTerminationMonthName} inside ${cashCrop.commonName}'s active growing season${stageDetail}, where mechanical or herbicide termination would damage the standing cash crop`
          );
        }

        findings.push({
          year: yr.year,
          cashCropId: cashCrop.id,
          cashCropName: cashCrop.commonName,
          coverCropId: coverCrop.id,
          coverCropName: coverCrop.commonName,
          sharedMonths,
          sharedMonthNames,
          coverTerminationMonth,
          coverTerminationMonthName,
          classification: "incompatible_overlap",
          conflictsWithSensitiveStage,
          conflictingStageLabels,
          title: `Year ${yr.year} scheduling & termination conflict: ${coverCrop.commonName} overlaps ${cashCrop.commonName} (${sharedMonthNames.join("–")})`,
          message: `Year ${yr.year}: ${conflictReasons.join("; ")}. Terminate ${coverCrop.commonName} before planting ${cashCrop.commonName}, or pair overwintered ${coverCrop.commonName} with a warm-season crop planted after ${coverTerminationMonthName} cover termination.`,
          source: "USDA NRCS Cover Crop Termination Guidelines; SARE Managing Cover Crops Profitably",
        });
      }
    }
  }

  return findings;
}

/**
 * Determine whether a crop's documented regional planting windows and the field's
 * geographic/agroecological context support autumn/winter sowing of a spring-habit variety
 * (e.g., Mediterranean, MENA, South Asian Rabi, Australian winter-rainfall, or low-elevation US Southwest).
 */
function supportsMildWinterAutumnSowingOfSpringHabit(
  crop: Crop,
  options?: {
    agGroup?: AgGroup;
    regionTag?: string | null;
  }
): boolean {
  const plantingText = `${crop.growingWindow.planting ?? ""} ${crop.growingWindow.description ?? ""}`;
  const cropDocumentsMildWinterWindow =
    /mena|south asia|rabi|australia|mediterranean|mild-winter|winter-rainfall|november|december|may \(australia\)/i.test(
      plantingText
    );
  if (!cropDocumentsMildWinterWindow) return false;

  const agGroup = options?.agGroup;
  const regionTag = options?.regionTag;

  if (regionTag && MILD_WINTER_AUTUMN_SOWN_SPRING_HABIT_REGIONS.has(regionTag)) {
    return true;
  }
  if (agGroup && MILD_WINTER_AUTUMN_SOWN_SPRING_HABIT_GROUPS.has(agGroup)) {
    return true;
  }
  return false;
}

/**
 * Check whether spring-habit vs. winter-vernalizing crop varieties match their scheduled
 * seasonal months, accounting for documented regional planting windows and mild-winter
 * agroecological contexts (Mediterranean, MENA, South Asian Rabi, Australian winter-rainfall, etc.).
 */
export function evaluateSeasonalVarietyAlignment(
  proposal: RotationStrategy,
  hemisphere: "northern" | "southern" | "tropical" = "northern",
  options?: {
    agGroup?: AgGroup;
    regionTag?: string | null;
  }
): SeasonalVarietyFinding[] {
  const findings: SeasonalVarietyFinding[] = [];
  if (hemisphere === "tropical") return findings;

  const winterMonths = hemisphere === "southern" ? [6, 7, 8] : [12, 1, 2];
  const autumnMonths = hemisphere === "southern" ? [3, 4, 5] : [9, 10, 11];
  const springMonths = hemisphere === "southern" ? [9, 10, 11] : [3, 4, 5];
  const lateSummerMonths = hemisphere === "southern" ? [1, 2, 3] : [7, 8, 9];

  const springToWinterMap: Record<string, { id: string; name: string }> = {
    spring_barley: {
      id: "winter_barley",
      name: cropLibrary.winter_barley?.commonName ?? "Winter Barley (Feed & Malt)",
    },
    spring_wheat: {
      id: "soft_red_winter_wheat",
      name:
        cropLibrary.soft_red_winter_wheat?.commonName ?? "Soft Red Winter Wheat",
    },
    spring_canola: {
      id: "winter_canola",
      name:
        cropLibrary.winter_canola?.commonName ?? "Winter Rapeseed / Canola",
    },
  };

  const winterToSpringMap: Record<string, { id: string; name: string }> = {
    winter_barley: {
      id: "spring_barley",
      name: cropLibrary.spring_barley?.commonName ?? "Spring Barley (Feed & Malt)",
    },
    winter_canola: {
      id: "spring_canola",
      name:
        cropLibrary.spring_canola?.commonName ?? "Spring Canola / Rapeseed",
    },
    soft_red_winter_wheat: {
      id: "spring_wheat",
      name: cropLibrary.spring_wheat?.commonName ?? "Hard Red Spring Wheat",
    },
  };

  for (const yr of proposal.years) {
    for (const sea of yr.seasons) {
      const crop = cropLibrary[sea.crop];
      const months = sea.months.filter((m) => m >= 1 && m <= 12);
      if (!crop || months.length === 0) continue;

      const firstMonth = months[0];
      const lastMonth = months[months.length - 1];
      const spansWinter = months.some((m) => winterMonths.includes(m));
      const plantedInAutumn = autumnMonths.includes(firstMonth);
      const plantedInSpring = springMonths.includes(firstMonth);
      const harvestedInLateSummer = lateSummerMonths.includes(lastMonth);

      // Case 1: Spring variety scheduled as autumn-sown overwintering crop
      // Only flag when the field's regional/agroecological context and documented crop windows
      // do not support mild-winter autumn/winter sowing of spring-habit cultivars.
      if (
        springToWinterMap[crop.id] &&
        (plantedInAutumn || (spansWinter && months.length >= 6)) &&
        !supportsMildWinterAutumnSowingOfSpringHabit(crop, options)
      ) {
        const alt = springToWinterMap[crop.id];
        const mRange = `${MONTH_SHORT_NAMES[firstMonth - 1]}–${MONTH_SHORT_NAMES[lastMonth - 1]}`;
        findings.push({
          year: yr.year,
          cropId: crop.id,
          cropName: crop.commonName,
          months,
          recommendedAlternativeCropId: alt.id,
          recommendedAlternativeName: alt.name,
          message: `Year ${yr.year}: ${crop.commonName} (${crop.id}) is a spring-habit non-vernalizing variety scheduled across an overwintering window (${mRange}) in a cold-winter context. Where winter freezes require cold-hardy overwintering cultivars, use ${alt.name} (${alt.id}) for autumn-planted schedules.`,
          source: "University of Minnesota / NDSU Extension Small Grain & Canola Variety Guides",
        });
      }

      // Case 2: Winter vernalizing variety scheduled strictly as a spring-planted summer crop
      if (winterToSpringMap[crop.id]) {
        const isStrictSpringSummerSchedule =
          crop.id === "soft_red_winter_wheat"
            ? plantedInSpring && harvestedInLateSummer && !spansWinter
            : plantedInSpring && !spansWinter;
        if (isStrictSpringSummerSchedule) {
          const alt = winterToSpringMap[crop.id];
          const mRange = `${MONTH_SHORT_NAMES[firstMonth - 1]}–${MONTH_SHORT_NAMES[lastMonth - 1]}`;
          findings.push({
            year: yr.year,
            cropId: crop.id,
            cropName: crop.commonName,
            months,
            recommendedAlternativeCropId: alt.id,
            recommendedAlternativeName: alt.name,
            message: `Year ${yr.year}: ${crop.commonName} (${crop.id}) is an autumn-sown cultivar requiring cold winter vernalization, but is scheduled strictly in spring–summer (${mRange}) without overwintering months. Use ${alt.name} (${alt.id}) for spring-sown schedules.`,
            source: "USDA ARS / State Extension Winter vs. Spring Small Grain & Canola Guidelines",
          });
        }
      }
    }
  }

  return findings;
}

/**
 * Evaluate legume nitrogen credit qualifications, distinguishing post-termination N
 * mineralized for a subsequent crop from concurrent overlap with an active cash crop,
 * and checking conditional malting barley excess-nitrogen / grain protein risk.
 */
export function evaluateNitrogenAndBarleyCompatibility(
  proposal: RotationStrategy,
  hemisphere: "northern" | "southern" | "tropical" = "northern"
): NitrogenBarleyFinding[] {
  const findings: NitrogenBarleyFinding[] = [];
  const overlapFindings = evaluateCropOverlapAndTermination(proposal, hemisphere);

  for (let yIdx = 0; yIdx < proposal.years.length; yIdx++) {
    const yr = proposal.years[yIdx];
    const prevYr = yIdx > 0 ? proposal.years[yIdx - 1] : null;

    // 1. Check concurrent incompatible overlap between legume cover crop and cash crop
    for (const ov of overlapFindings.filter((f) => f.year === yr.year)) {
      const coverCrop = cropLibrary[ov.coverCropId];
      const credit = coverCrop?.nitrogenBehavior.residualNcredit?.value;
      if (
        ov.classification === "incompatible_overlap" &&
        coverCrop?.family === "Fabaceae" &&
        credit
      ) {
        findings.push({
          year: yr.year,
          legumeCropId: coverCrop.id,
          legumeCropName: coverCrop.commonName,
          targetCashCropId: ov.cashCropId,
          targetCashCropName: ov.cashCropName,
          kind: "concurrent_overlap_n_unavailable",
          message: `Year ${yr.year}: ${coverCrop.commonName}'s estimated residual nitrogen credit (${credit}) is a post-termination credit mineralized for a subsequent crop—it is NOT available to concurrently growing ${ov.cashCropName} during their ${ov.sharedMonthNames.join("–")} overlap, when living ${coverCrop.commonName} competes for water, light, and nutrients.`,
          source: "SARE Managing Cover Crops Profitably; Penn State Extension Cover Crop Nitrogen Mineralization",
        });
      }
    }

    // 2. Check short-duration legume cover (< 4 months) reducing potential N fixation
    for (const sea of yr.seasons) {
      const crop = cropLibrary[sea.crop];
      const credit = crop?.nitrogenBehavior.residualNcredit?.value;
      if (
        crop?.type === "cover" &&
        crop.family === "Fabaceae" &&
        credit &&
        sea.months.length > 0 &&
        sea.months.length <= 3
      ) {
        const cashInYear = yr.seasons.find(
          (s) => cropLibrary[s.crop]?.type === "cash"
        );
        findings.push({
          year: yr.year,
          legumeCropId: crop.id,
          legumeCropName: crop.commonName,
          targetCashCropId: cashInYear?.crop ?? crop.id,
          targetCashCropName:
            cropLibrary[cashInYear?.crop ?? ""]?.commonName ?? "subsequent cash crop",
          kind: "short_window_reduced_n",
          message: `Year ${yr.year}: ${crop.commonName} is scheduled for only ${sea.months.length} month(s); upper-range nitrogen estimates (${credit}) depend on establishment, stand vigor, biomass accumulation, termination timing, and subsequent mineralization, so actual available N from a short window will be substantially lower.`,
          source: "SARE Managing Cover Crops Profitably",
        });
      }
    }

    // 3. Conditional malting barley advisory when spring_barley / winter_barley is paired with or follows high-N legume (hairy_vetch / alfalfa_annual_forage)
    const barleySeasons = yr.seasons.filter(
      (s) => s.crop === "spring_barley" || s.crop === "winter_barley"
    );
    if (barleySeasons.length > 0) {
      const sameYearHighNLegume = yr.seasons.find(
        (s) => s.crop === "hairy_vetch" || s.crop === "alfalfa_annual_forage"
      );
      const prevYearHighNLegume = prevYr?.seasons.find(
        (s) => s.crop === "hairy_vetch" || s.crop === "alfalfa_annual_forage"
      );
      const highNLegumeSeason = sameYearHighNLegume ?? prevYearHighNLegume;
      if (highNLegumeSeason) {
        const legumeCrop = cropLibrary[highNLegumeSeason.crop];
        const barleyCrop = cropLibrary[barleySeasons[0].crop];
        const credit =
          legumeCrop?.nitrogenBehavior.residualNcredit?.value ??
          "80–100 lb N/acre (conditional upper-range potential)";
        if (legumeCrop && barleyCrop) {
          findings.push({
            year: yr.year,
            legumeCropId: legumeCrop.id,
            legumeCropName: legumeCrop.commonName,
            targetCashCropId: barleyCrop.id,
            targetCashCropName: barleyCrop.commonName,
            kind: "malting_barley_excess_n_risk",
            message: `Year ${yr.year}: ${barleyCrop.commonName} is paired with or follows ${legumeCrop.commonName} (${credit}). If this barley is grown for malting, acceptable grain protein specifications depend on the maltster, buyer, barley class, and contract, and excess or late-mineralizing legume nitrogen increases the risk of exceeding buyer protein specifications and lodging.`,
            source: "University of Nevada Extension; NDSU Malting Barley Production Guide",
          });
        }
      }
    }
  }

  return findings;
}

/**
 * Evaluate winter survival and autumn planting temperature suitability for overwintering
 * cover crops against the field's climate profile.
 *
 * Explicitly notes that monthly mean temperatures cannot establish daily freeze extremes
 * or guarantee winter survival.
 */
export function evaluateCoverCropWinterSuitability(params: {
  proposal: RotationStrategy;
  climate: ClimateData | null | undefined;
  hemisphere?: "northern" | "southern" | "tropical";
}): CoverWinterSuitabilityFinding[] {
  const { proposal, climate, hemisphere = "northern" } = params;
  const findings: CoverWinterSuitabilityFinding[] = [];
  if (hemisphere === "tropical") return findings;

  const winterMonths = hemisphere === "southern" ? [6, 7, 8] : [12, 1, 2];
  const lateSpringMonths = hemisphere === "southern" ? [10, 11] : [4, 5];
  const lateAutumnMonths = hemisphere === "southern" ? [5, 6] : [11, 12];

  const monthlyMeanLimitationNote =
    "Field climate profiles provide monthly mean temperatures, which cannot establish daily minimum freeze extremes, freeze duration, or snow-cover insulation needed to confirm winter survival (USDA NRCS / SARE).";

  const winterKillCoverIds = new Set([
    "forage_radish",
    "winter_oat",
    "yellow_mustard_cover",
  ]);

  for (const yr of proposal.years) {
    for (const sea of yr.seasons) {
      const crop = cropLibrary[sea.crop];
      const months = sea.months.filter((m) => m >= 1 && m <= 12);
      if (!crop || crop.type !== "cover" || crop.id === "winter_fallow" || months.length === 0) {
        continue;
      }

      const spansWinter = months.some((m) => winterMonths.includes(m));
      if (!spansWinter) continue;

      const firstMonth = months[0];
      const continuesIntoLateSpring = months.some((m) =>
        lateSpringMonths.includes(m)
      );

      const scheduledWinterMonths = months.filter((m) =>
        winterMonths.includes(m)
      );
      const winterTemps =
        climate?.fullRecord.monthlyTemp
          ? scheduledWinterMonths
              .map((m) => climate.fullRecord.monthlyTemp[m - 1])
              .filter((t): t is number => t !== null && t !== undefined)
          : [];
      const coldestWinterMonthC =
        winterTemps.length > 0 ? Math.min(...winterTemps) : null;
      const plantingMonthC =
        climate?.fullRecord.monthlyTemp?.[firstMonth - 1] ?? null;

      // 1. Winter-kill cover crops (radish, winter oat, mustard) scheduled across cold winter into late spring
      if (
        winterKillCoverIds.has(crop.id) &&
        continuesIntoLateSpring &&
        (coldestWinterMonthC === null || coldestWinterMonthC < 3)
      ) {
        const tempDesc =
          coldestWinterMonthC !== null
            ? ` (coldest winter month mean ${coldestWinterMonthC.toFixed(1)} °C)`
            : "";
        findings.push({
          year: yr.year,
          cropId: crop.id,
          cropName: crop.commonName,
          months,
          coldestWinterMonthC,
          plantingMonthC,
          severity: "warning",
          title: `Year ${yr.year} winterkill risk: ${crop.commonName} scheduled through spring`,
          message: `Year ${yr.year}: ${crop.commonName} is cold-sensitive and commonly winter-kills in freezing winters${tempDesc}, so it may not survive as living cover into ${lateSpringMonths.map((m) => MONTH_SHORT_NAMES[m - 1]).join("–")}. ${monthlyMeanLimitationNote}`,
          monthlyMeanLimitationNote,
          source: "SARE Managing Cover Crops Profitably; Midwest Cover Crops Council",
        });
        continue;
      }

      // 2. Crimson clover cold-winter or late-planting vulnerability
      if (
        crop.id === "crimson_clover" &&
        ((coldestWinterMonthC !== null && coldestWinterMonthC < -1) ||
          lateAutumnMonths.includes(firstMonth))
      ) {
        findings.push({
          year: yr.year,
          cropId: crop.id,
          cropName: crop.commonName,
          months,
          coldestWinterMonthC,
          plantingMonthC,
          severity: "warning",
          title: `Year ${yr.year} winter survival & establishment risk: ${crop.commonName}`,
          message: `Year ${yr.year}: ${crop.commonName} is moderately winter-hardy (USDA Zones 6–9)${coldestWinterMonthC !== null ? ` and faces elevated winterkill risk where coldest winter month mean is ${coldestWinterMonthC.toFixed(1)} °C` : ""}${lateAutumnMonths.includes(firstMonth) ? ` when seeded late in ${MONTH_SHORT_NAMES[firstMonth - 1]}` : ""}. ${monthlyMeanLimitationNote}`,
          monthlyMeanLimitationNote,
          source: "USDA NRCS Plant Guide — Crimson Clover; SARE Managing Cover Crops Profitably",
        });
        continue;
      }

      // 3. Hairy vetch severe winter cold or late autumn establishment warning
      if (
        crop.id === "hairy_vetch" &&
        ((coldestWinterMonthC !== null && coldestWinterMonthC < -4) ||
          lateAutumnMonths.includes(firstMonth) ||
          (plantingMonthC !== null && plantingMonthC < 7))
      ) {
        findings.push({
          year: yr.year,
          cropId: crop.id,
          cropName: crop.commonName,
          months,
          coldestWinterMonthC,
          plantingMonthC,
          severity: "warning",
          title: `Year ${yr.year} winter hardiness & autumn establishment check: ${crop.commonName}`,
          message: `Year ${yr.year}: ${crop.commonName} requires timely autumn establishment before freeze to survive winter and build biomass toward its conditional 80–100 lb N/acre upper-range potential${lateAutumnMonths.includes(firstMonth) ? ` (scheduled ${MONTH_SHORT_NAMES[firstMonth - 1]} planting is late for autumn rosette growth)` : ""}${coldestWinterMonthC !== null ? ` with coldest winter month mean ${coldestWinterMonthC.toFixed(1)} °C` : ""}. ${monthlyMeanLimitationNote}`,
          monthlyMeanLimitationNote,
          source: "USDA ARS / SARE Managing Cover Crops Profitably — Hairy Vetch",
        });
        continue;
      }

      // 4. General informational note on overwintering cover crops regarding monthly mean temperature limits
      findings.push({
        year: yr.year,
        cropId: crop.id,
        cropName: crop.commonName,
        months,
        coldestWinterMonthC,
        plantingMonthC,
        severity: "info",
        title: `Year ${yr.year} overwintering climate note: ${crop.commonName}`,
        message: `${crop.commonName} overwinters${coldestWinterMonthC !== null ? ` (coldest monthly mean ${coldestWinterMonthC.toFixed(1)} °C)` : ""}. ${monthlyMeanLimitationNote}`,
        monthlyMeanLimitationNote,
        source: "USDA NRCS / SARE Managing Cover Crops Profitably",
      });
    }
  }

  return findings;
}

/**
 * Render the authoritative compatibility rules for inclusion in an AI system prompt.
 */
export function formatCompatibilityRulesForPrompt(): string {
  const hardLines = ROTATION_COMPATIBILITY_RULES.hardConstraints.rules
    .map((r) => `- [HARD CONSTRAINT — violation rejects proposal] ${r}`)
    .join("\n");
  const softLines = ROTATION_COMPATIBILITY_RULES.softAdvisories.rules
    .map((r) => `- [AGRONOMIC ADVISORY — violation attaches warning] ${r}`)
    .join("\n");
  return `### Hard Agronomic Constraints (Enforced Deterministically)\n${hardLines}\n\n### Soft Agronomic Advisories (Flagged as Warnings)\n${softLines}`;
}

function getKnownFamilies(crop: Crop | undefined): string {
  return crop?.family ?? "unknown";
}

/**
 * Primary highly susceptible Sclerotinia oilseed hosts that build heavy
 * sclerotial loads in soil (must not appear in >1 year of a 3-year upland rotation).
 */
export const PRIMARY_SCLEROTINIA_HOSTS = new Set<string>([
  "sunflower",
  "winter_canola",
  "spring_canola",
]);

/**
 * Moderate / climate-conditional Sclerotinia hosts (primarily in cool, wet,
 * dense-canopy conditions; manageable with cultivar tolerance, row spacing,
 * and a non-host cereal break year).
 */
export const MODERATE_SCLEROTINIA_HOSTS = new Set<string>([
  "soybean",
]);

export const ALL_SCLEROTINIA_HOSTS = new Set<string>([
  ...PRIMARY_SCLEROTINIA_HOSTS,
  ...MODERATE_SCLEROTINIA_HOSTS,
]);

/**
 * Cool-season / overwintering cash crops that harvest in spring or early summer,
 * allowing double-cropping with a warm-season summer cash crop in the same year.
 */
const WINTER_COOL_CASH_CROPS = new Set<string>([
  "soft_red_winter_wheat",
  "winter_barley",
  "winter_canola",
  "chickpea",
  "lentil",
]);

export function getSclerotiniaHosts(crops: (Crop | undefined)[]): string[] {
  return Array.from(
    new Set(
      crops
        .filter((c): c is Crop => !!c)
        .filter((c) => ALL_SCLEROTINIA_HOSTS.has(c.id))
        .map((c) => c.id)
    )
  );
}

/**
 * Validate a rotation proposal strategy against hard agronomic rules.
 *
 * This function is pure: no side effects, no network calls, no AI calls.
 */
export function validateProposal(
  proposal: RotationStrategy,
  ctx: ValidationContext
): ProposalValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  const checks: ValidationCheck[] = [];

  const allSeasons = proposal.years.flatMap((y) => y.seasons);
  const allCrops = allSeasons.map((s) => cropLibrary[s.crop]);
  const allCropIds = allSeasons.map((s) => s.crop);

  // ── 1. All crop IDs exist in catalog ──
  const unknownCrops = allCropIds.filter((id) => !cropLibrary[id]);
  const passKnownCrops = unknownCrops.length === 0;
  checks.push({
    name: "Crop IDs in catalog",
    passed: passKnownCrops,
    severity: passKnownCrops ? "info" : "error",
    message: passKnownCrops
      ? "All crops are present in the verified catalog."
      : `Unknown crop IDs: ${unknownCrops.join(", ")}`,
  });
  if (!passKnownCrops) {
    errors.push(`Proposal contains crops not in the verified catalog: ${unknownCrops.join(", ")}`);
  }

  // ── 2. Group applicability ──
  const wrongGroupCrops = allCrops
    .filter((c): c is Crop => !!c)
    .filter((c) => {
      if (ctx.agGroup === "unknown") return false; // cannot reject when group unknown
      if (!c.applicableGroups || c.applicableGroups.length === 0) return false;
      return !c.applicableGroups.includes(ctx.agGroup);
    })
    .map((c) => c.id);

  const passGroup = wrongGroupCrops.length === 0 || ctx.agGroup === "unknown";
  checks.push({
    name: "Group applicability",
    passed: passGroup,
    severity: wrongGroupCrops.length > 0 ? "error" : "info",
    message:
      wrongGroupCrops.length > 0
        ? `Crops not documented for group "${ctx.agGroup}": ${wrongGroupCrops.join(", ")}`
        : `All crops are documented for group "${ctx.agGroup}".`,
  });
  if (wrongGroupCrops.length > 0 && ctx.agGroup !== "unknown") {
    errors.push(
      `Crops not documented for agricultural group "${ctx.agGroup}": ${wrongGroupCrops.join(", ")}`
    );
  }

  // ── 2b. Regional applicability ──
  if (ctx.regionTag) {
    const wrongRegionCrops = Array.from(
      new Set(
        allCrops
          .filter((c): c is Crop => !!c)
          .filter((c) => {
            if (!c.supportedRegions || c.supportedRegions.length === 0) return false;
            return !c.supportedRegions.includes(ctx.regionTag!);
          })
          .map((c) => c.id)
      )
    );
    const passRegion = wrongRegionCrops.length === 0;
    checks.push({
      name: "Regional applicability",
      passed: passRegion,
      severity: passRegion ? "info" : "error",
      message: passRegion
        ? `All crops are documented for region "${ctx.regionTag}".`
        : `Crops not documented for region "${ctx.regionTag}": ${wrongRegionCrops.join(", ")}`,
    });
    if (!passRegion) {
      errors.push(
        `Crops not documented for region "${ctx.regionTag}": ${wrongRegionCrops.join(", ")}`
      );
    }
  }

  // ── 3. Required properties present ──
  const missingPropsCrops = allCrops
    .filter((c): c is Crop => !!c)
    .filter((c) => !c.waterDemand || !c.droughtTolerance || !c.growingWindow)
    .map((c) => c.id);
  const passProps = missingPropsCrops.length === 0;
  checks.push({
    name: "Required crop properties",
    passed: passProps,
    severity: passProps ? "info" : "warning",
    message: passProps
      ? "All crops have water demand, drought tolerance, and growing window."
      : `Crops missing required properties: ${missingPropsCrops.join(", ")}`,
  });
  if (!passProps) {
    warnings.push(
      `Crops missing required properties (waterDemand, droughtTolerance, growingWindow): ${missingPropsCrops.join(", ")}`
    );
  }

  // ── 4. Planting window plausibility ──
  // Ensure no two same-season cash crops in the same year have overlapping growingWindow months
  // beyond the allowed single transition month, while allowing up to 2 harvest/planting boundary
  // months (with a transition warning) for cool-to-warm cash double-cropping or autumn seeding
  // of an overwintering cash crop after summer harvest.
  const maxSharedMonths = ROTATION_COMPATIBILITY_RULES.hardConstraints.maxCashCropSharedMonths;
  const maxDoubleCropMonths =
    ROTATION_COMPATIBILITY_RULES.hardConstraints.maxDoubleCropTransitionMonths;
  const boundaryTransitionMonths = new Set([4, 5, 6, 9, 10, 11, 12]);
  const autumnEstablishmentMonths = new Set([8, 9, 10, 11, 12]);

  // Helper: detect when a season in Year N is purely the autumn establishment phase of an
  // overwintering crop whose main winter/spring growth and harvest/termination continues in Year N+1.
  const isAutumnEstablishmentContinuingNextYear = (
    yearIdx: number,
    season: RotationStrategy["years"][number]["seasons"][number]
  ): boolean => {
    if (yearIdx < 0 || yearIdx >= proposal.years.length - 1) return false;
    const months = Array.from(new Set(season.months));
    if (months.length === 0 || months.length > 4) return false;
    if (!months.every((m) => autumnEstablishmentMonths.has(m))) return false;
    const nextYear = proposal.years[yearIdx + 1];
    return nextYear.seasons.some(
      (ns) =>
        ns.crop === season.crop &&
        ns.months.some((m) => m >= 1 && m <= 6)
    );
  };

  for (let yIdx = 0; yIdx < proposal.years.length; yIdx++) {
    const year = proposal.years[yIdx];
    const cashSeasons = year.seasons.filter((s) => {
      const c = cropLibrary[s.crop];
      return c?.type === "cash";
    });
    for (let i = 0; i < cashSeasons.length; i++) {
      for (let j = i + 1; j < cashSeasons.length; j++) {
        const cropA = cashSeasons[i].crop;
        const cropB = cashSeasons[j].crop;
        const monthsA = Array.from(new Set(cashSeasons[i].months));
        const monthsB = Array.from(new Set(cashSeasons[j].months));
        const overlap = monthsA.filter((m) => monthsB.includes(m));

        if (overlap.length > maxSharedMonths) {
          const isCoolWarmPair =
            cropA !== cropB &&
            ((WINTER_COOL_CASH_CROPS.has(cropA) && !WINTER_COOL_CASH_CROPS.has(cropB)) ||
              (!WINTER_COOL_CASH_CROPS.has(cropA) && WINTER_COOL_CASH_CROPS.has(cropB)));
          const unsharedA = monthsA.filter((m) => !overlap.includes(m)).length;
          const unsharedB = monthsB.filter((m) => !overlap.includes(m)).length;
          const aIsAutumnRelay = isAutumnEstablishmentContinuingNextYear(yIdx, cashSeasons[i]);
          const bIsAutumnRelay = isAutumnEstablishmentContinuingNextYear(yIdx, cashSeasons[j]);
          const allBoundaryMonths = overlap.every((m) => boundaryTransitionMonths.has(m));
          const isDoubleCropTransition =
            isCoolWarmPair &&
            allBoundaryMonths &&
            overlap.length <= maxDoubleCropMonths &&
            ((unsharedA >= 2 && unsharedB >= 2) ||
              (aIsAutumnRelay && unsharedB >= 2) ||
              (bIsAutumnRelay && unsharedA >= 2));

          if (isDoubleCropTransition) {
            const overlapNames = overlap.map((m) => MONTH_SHORT_NAMES[m - 1] ?? String(m)).join(", ");
            const warnMsg = `Year ${year.year} double-crop transition: cash crops "${cropA}" and "${cropB}" share boundary months (${overlapNames}); harvest of the preceding crop must complete before planting the following crop.`;
            warnings.push(warnMsg);
            checks.push({
              name: `Year ${year.year} double-crop window transition`,
              passed: false,
              severity: "warning",
              message: warnMsg,
            });
          } else {
            errors.push(
              `Year ${year.year}: cash crops "${cropA}" and "${cropB}" have overlapping activity months.`
            );
            checks.push({
              name: `Year ${year.year} window overlap`,
              passed: false,
              severity: "error",
              message: `Cash crops overlap in months: ${overlap.map((m) => m).join(", ")}`,
            });
          }
        }
      }
    }
  }
  const hasOverlapError = checks.some(
    (c) => c.name.startsWith("Year") && c.name.includes("overlap") && !c.passed
  );
  if (!hasOverlapError) {
    checks.push({
      name: "Planting window overlap",
      passed: true,
      severity: "info",
      message: "No cash-crop seasonal overlaps detected.",
    });
  }

  // ── 5. Family sequence constraints ──
  // Hard-reject when the same botanical family appears in > maxYearsPerFamily years of CASH crops.
  // When cash crops satisfy <= maxYearsPerFamily years per family, but a cover crop causes a
  // family to appear across all 3 years, attach a soft green-bridge advisory warning.
  // Note: An autumn-only establishment season in Year N that continues into Year N+1 as the
  // same overwintering crop is counted in its harvest/completion year (Year N+1), not twice.
  const maxYearsPerFamily = ROTATION_COMPATIBILITY_RULES.hardConstraints.maxYearsPerFamily;
  const cashFamilyByYear = proposal.years.map((y, yIdx) => {
    const families = new Set<string>();
    const cashSeasonsInYear = y.seasons.filter((s) => cropLibrary[s.crop]?.type === "cash");
    cashSeasonsInYear.forEach((s) => {
      if (
        cashSeasonsInYear.length > 1 &&
        isAutumnEstablishmentContinuingNextYear(yIdx, s)
      ) {
        return;
      }
      const c = cropLibrary[s.crop];
      if (c?.type === "cash") {
        const fam = getKnownFamilies(c);
        if (fam !== "unknown") families.add(fam);
      }
    });
    return Array.from(families);
  });

  const allFamilyByYear = proposal.years.map((y, yIdx) => {
    const families = new Set<string>();
    y.seasons.forEach((s) => {
      if (
        y.seasons.length > 1 &&
        isAutumnEstablishmentContinuingNextYear(yIdx, s)
      ) {
        return;
      }
      const fam = getKnownFamilies(cropLibrary[s.crop]);
      if (fam !== "unknown") families.add(fam);
    });
    return Array.from(families);
  });

  const cashFamilyCounts: Record<string, number> = {};
  cashFamilyByYear.forEach((fams) => {
    fams.forEach((f) => {
      cashFamilyCounts[f] = (cashFamilyCounts[f] || 0) + 1;
    });
  });

  const allFamilyCounts: Record<string, number> = {};
  allFamilyByYear.forEach((fams) => {
    fams.forEach((f) => {
      allFamilyCounts[f] = (allFamilyCounts[f] || 0) + 1;
    });
  });

  const repeatedCashFamilies = Object.entries(cashFamilyCounts).filter(
    ([, count]) => count > maxYearsPerFamily
  );
  const repeatedCoverBridgeFamilies = Object.entries(allFamilyCounts).filter(
    ([f, count]) => count > maxYearsPerFamily && (cashFamilyCounts[f] || 0) <= maxYearsPerFamily
  );

  const passFamilySeq = repeatedCashFamilies.length === 0;
  if (!passFamilySeq) {
    checks.push({
      name: "Family diversity over 3 years",
      passed: false,
      severity: "error",
      message: `Cash-crop family(ies) appearing in >${maxYearsPerFamily} years: ${repeatedCashFamilies.map(([f]) => f).join(", ")}`,
    });
    errors.push(
      `Botanical family sequence constraint violated: ${repeatedCashFamilies.map(([f]) => f).join(", ")} appear in more than ${maxYearsPerFamily} years.`
    );
  } else if (repeatedCoverBridgeFamilies.length > 0) {
    const bridgeMsg = `Botanical family bridge advisory: ${repeatedCoverBridgeFamilies
      .map(([f]) => `${f} (cash crops in ${cashFamilyCounts[f] || 0} of 3 years, plus cover crops)`)
      .join(", ")} appear across all 3 years. Terminate same-family cover crops on time to prevent green-bridge pest or disease carryover.`;
    warnings.push(bridgeMsg);
    checks.push({
      name: "Family diversity over 3 years",
      passed: false,
      severity: "warning",
      message: bridgeMsg,
    });
  } else {
    checks.push({
      name: "Family diversity over 3 years",
      passed: true,
      severity: "info",
      message: "Botanical families are reasonably distributed across the rotation.",
    });
  }

  // ── 6. Disease compatibility ──
  // Sclerotinia host accumulation:
  // - Hard error when Sclerotinia hosts appear in all 3 years (no non-host break year) OR
  //   primary oilseed hosts (sunflower, winter_canola, spring_canola) appear in >= 2 years
  //   without an intervening flooded paddy_rice phase.
  // - Manageable risk warning when Sclerotinia hosts appear in 2 of 3 years with at most 1
  //   primary oilseed host year (e.g. sunflower + soybean or canola + soybean with a cereal break).
  const maxSclerotiniaYears = ROTATION_COMPATIBILITY_RULES.hardConstraints.maxSclerotiniaYears;
  const maxPrimaryOilseedYears =
    ROTATION_COMPATIBILITY_RULES.hardConstraints.maxPrimarySclerotiniaOilseedYears;
  const sclerotiniaHosts = getSclerotiniaHosts(allCrops);
  const sclerotiniaYears = new Map<number, string[]>();
  const primarySclerotiniaYears = new Map<number, string[]>();

  proposal.years.forEach((y, yIdx) => {
    const hosts = Array.from(
      new Set(
        y.seasons
          .filter((s) => !isAutumnEstablishmentContinuingNextYear(yIdx, s))
          .filter((s) => sclerotiniaHosts.includes(s.crop))
          .map((s) => s.crop)
      )
    );
    if (hosts.length > 0) sclerotiniaYears.set(y.year, hosts);

    const primaryHosts = hosts.filter((id) => PRIMARY_SCLEROTINIA_HOSTS.has(id));
    if (primaryHosts.length > 0) primarySclerotiniaYears.set(y.year, primaryHosts);
  });

  const sclerotiniaYearCount = sclerotiniaYears.size;
  const primaryOilseedYearCount = primarySclerotiniaYears.size;
  const hasPaddyRiceFloodBreak = allCropIds.includes("paddy_rice");

  const isHardSclerotiniaStacking =
    sclerotiniaYearCount > maxSclerotiniaYears ||
    (primaryOilseedYearCount > maxPrimaryOilseedYears && !hasPaddyRiceFloodBreak);

  const sclerotiniaYearDetails = Array.from(sclerotiniaYears.entries())
    .map(([y, h]) => `Year ${y} (${h.join(", ")})`)
    .join("; ");

  if (isHardSclerotiniaStacking) {
    checks.push({
      name: "Sclerotinia host accumulation",
      passed: false,
      severity: "error",
      message: `High-risk Sclerotinia host stacking across ${sclerotiniaYearCount} years: ${sclerotiniaYearDetails}`,
    });
    errors.push(
      `Sclerotinia host stacking: hosts appear in ${sclerotiniaYearCount} years (${sclerotiniaYearDetails}). ` +
        `Consider lengthening the rotation interval or selecting non-host alternatives.`
    );
  } else if (sclerotiniaYearCount === 2) {
    const sclerotiniaWarn =
      `Sclerotinia risk: Sclerotinia-susceptible crops appear in 2 of 3 years (${sclerotiniaYearDetails}). ` +
      (hasPaddyRiceFloodBreak
        ? `The flooded paddy_rice phase helps degrade soil sclerotia, but canopy moisture and disease history should still be monitored.`
        : `A single non-host break year may not fully deplete sclerotia in cool, wet conditions; use Sclerotinia-tolerant varieties, wider row spacing, or substitute a non-host crop where white mold history is present.`);
    warnings.push(sclerotiniaWarn);
    checks.push({
      name: "Sclerotinia host accumulation",
      passed: false,
      severity: "warning",
      message: sclerotiniaWarn,
    });
  } else {
    checks.push({
      name: "Sclerotinia host accumulation",
      passed: true,
      severity: "info",
      message: "Sclerotinia-susceptible crops are not accumulated across multiple years.",
    });
  }

  // Wheat following sorghum / corn Fusarium check
  // Find any wheat (Poaceae cash) that immediately follows sorghum or corn in Year order
  const fusariumPredecessors: readonly string[] = ROTATION_COMPATIBILITY_RULES.softAdvisories.fusariumPredecessors;
  const fusariumCrop = ROTATION_COMPATIBILITY_RULES.softAdvisories.fusariumSusceptibleCrop;
  for (let i = 1; i < proposal.years.length; i++) {
    const prevCash = proposal.years[i - 1].seasons.find((s) => cropLibrary[s.crop]?.type === "cash");
    const currentWheat = proposal.years[i].seasons.find(
      (s) => s.crop === fusariumCrop
    );
    if (
      currentWheat &&
      prevCash &&
      fusariumPredecessors.includes(prevCash.crop)
    ) {
      warnings.push(
        `Fusarium risk: soft red winter wheat follows ${prevCash.crop} (Year ${proposal.years[i - 1].year} → ${proposal.years[i].year}). Shared Fusarium inoculum may elevate head blight risk.`
      );
      checks.push({
        name: `Fusarium sequence Year ${proposal.years[i - 1].year}→${proposal.years[i].year}`,
        passed: false,
        severity: "warning",
        message: `Wheat follows ${prevCash.crop}; Fusarium head blight risk may be elevated.`,
      });
    }
  }

  // ── 7. Cash / cover sequence plausibility ──
  // Every year should have at least 1 cash crop.
  const yearsWithoutCash = proposal.years
    .filter((y) => !y.seasons.some((s) => cropLibrary[s.crop]?.type === "cash"))
    .map((y) => y.year);
  const passCashCover = yearsWithoutCash.length === 0;
  checks.push({
    name: "Cash crop presence per year",
    passed: passCashCover,
    severity: passCashCover ? "info" : "error",
    message: passCashCover
      ? "Each year contains at least one cash crop."
      : `Years without cash crops: ${yearsWithoutCash.join(", ")}`,
  });
  if (!passCashCover) {
    errors.push(`Years ${yearsWithoutCash.join(", ")} contain no cash crop.`);
  }

  // ── 8. High-level rotation quality heuristic ──
  const minFamilies = ROTATION_COMPATIBILITY_RULES.softAdvisories.minRecommendedFamilies;
  const uniqueFamilies = new Set(allCrops.map((c) => c?.family).filter(Boolean));
  if (uniqueFamilies.size < minFamilies) {
    warnings.push(
      `Low botanical diversity: only ${uniqueFamilies.size} unique family(ies) across rotation. Consider adding a Fabaceae or Asteraceae crop for pest-break benefit.`
    );
    checks.push({
      name: "Botanical diversity",
      passed: false,
      severity: "warning",
      message: `Only ${uniqueFamilies.size} unique families detected.`,
    });
  } else {
    checks.push({
      name: "Botanical diversity",
      passed: true,
      severity: "info",
      message: `${uniqueFamilies.size} unique families present.`,
    });
  }

  // ── 9. SCN frequency ──
  // If soybean appears more than maxSoybeanYearsBeforeWarning in 3 years, flag as warning
  const maxSoybeanYears = ROTATION_COMPATIBILITY_RULES.softAdvisories.maxSoybeanYearsBeforeWarning;
  const soybeanYears = proposal.years.filter((y) =>
    y.seasons.some((s) => s.crop === "soybean")
  ).length;
  if (soybeanYears > maxSoybeanYears) {
    warnings.push(
      `Soybean appears in ${soybeanYears} years. Frequent soybean can increase soybean cyst nematode (SCN) pressure over time.`
    );
    checks.push({
      name: "SCN rotation frequency",
      passed: false,
      severity: "warning",
      message: `Soybean appears in ${soybeanYears} years.`,
    });
  } else {
    checks.push({
      name: "SCN rotation frequency",
      passed: true,
      severity: "info",
      message: "Soybean appears at most once in the rotation.",
    });
  }

  // ── 10. Cash-crop / cover-crop overlap & cover termination timing ──
  const hemisphere = ctx.hemisphere ?? "northern";
  const overlapFindings = evaluateCropOverlapAndTermination(proposal, hemisphere);
  const incompatibleOverlaps = overlapFindings.filter(
    (f) => f.classification === "incompatible_overlap"
  );
  if (incompatibleOverlaps.length > 0) {
    for (const conflict of incompatibleOverlaps) {
      warnings.push(conflict.message);
      checks.push({
        name: `Year ${conflict.year} cover-crop overlap & termination (${conflict.coverCropId} / ${conflict.cashCropId})`,
        passed: false,
        severity: "warning",
        message: conflict.message,
      });
    }
  } else {
    const compatibleNotes = overlapFindings.map(
      (f) =>
        `Year ${f.year}: ${f.coverCropName} + ${f.cashCropName} (${f.sharedMonthNames.join("–")} — ${f.classification.replace("_", " ")})`
    );
    checks.push({
      name: "Cover-crop overlap & termination timing",
      passed: true,
      severity: "info",
      message:
        compatibleNotes.length > 0
          ? `Compatible cash/cover transitions or interseeding: ${compatibleNotes.join("; ")}.`
          : "No conflicting cash-crop / cover-crop overlaps or late terminations detected.",
    });
  }

  // ── 11. Spring vs. winter seasonal variety alignment ──
  const seasonalVarietyFindings = evaluateSeasonalVarietyAlignment(
    proposal,
    hemisphere,
    { agGroup: ctx.agGroup, regionTag: ctx.regionTag }
  );
  if (seasonalVarietyFindings.length > 0) {
    for (const vf of seasonalVarietyFindings) {
      warnings.push(vf.message);
      checks.push({
        name: `Year ${vf.year} seasonal variety mismatch (${vf.cropId})`,
        passed: false,
        severity: "warning",
        message: vf.message,
      });
    }
  } else {
    checks.push({
      name: "Seasonal variety schedule alignment",
      passed: true,
      severity: "info",
      message: "Spring and winter crop varieties match their scheduled seasonal windows.",
    });
  }

  // ── 12. Legume nitrogen availability & malting barley quality compatibility ──
  const nitrogenBarleyFindings = evaluateNitrogenAndBarleyCompatibility(
    proposal,
    hemisphere
  );
  for (const nf of nitrogenBarleyFindings) {
    if (
      nf.kind === "concurrent_overlap_n_unavailable" ||
      nf.kind === "malting_barley_excess_n_risk"
    ) {
      warnings.push(nf.message);
      checks.push({
        name: `Year ${nf.year} nitrogen management (${nf.legumeCropId} / ${nf.targetCashCropId})`,
        passed: false,
        severity: "warning",
        message: nf.message,
      });
    }
  }

  // ── 13. Overwintering cover-crop climate suitability & monthly-mean caveat ──
  if (ctx.climate) {
    const winterSuitabilityFindings = evaluateCoverCropWinterSuitability({
      proposal,
      climate: ctx.climate,
      hemisphere,
    });
    for (const wf of winterSuitabilityFindings) {
      if (wf.severity === "warning") {
        warnings.push(wf.message);
        checks.push({
          name: `Year ${wf.year} cover-crop winter suitability (${wf.cropId})`,
          passed: false,
          severity: "warning",
          message: wf.message,
        });
      } else {
        checks.push({
          name: `Year ${wf.year} overwintering climate note (${wf.cropId})`,
          passed: true,
          severity: "info",
          message: wf.message,
        });
      }
    }
  }

  const valid = errors.length === 0;

  return {
    valid,
    errors,
    warnings: [...new Set(warnings)], // dedupe
    checks,
  };
}

/**
 * Quick check: is a strategy structurally valid (can be scored, rendered, etc.)?
 */
export function isStrategyStructurallyValid(strategy: RotationStrategy): boolean {
  if (!strategy.id || !strategy.name) return false;
  if (!Array.isArray(strategy.years) || strategy.years.length === 0) return false;
  for (const year of strategy.years) {
    if (!Array.isArray(year.seasons)) return false;
    for (const season of year.seasons) {
      if (!season.crop || !season.season) return false;
    }
  }
  return true;
}
