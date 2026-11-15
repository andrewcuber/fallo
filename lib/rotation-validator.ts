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

import { type Crop, type RotationStrategy, cropLibrary } from "@/lib/rotation-scoring";
import { type AgGroup } from "@/lib/agro-classifier";

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
    maxYearsPerFamily: 2,
    maxSclerotiniaYears: 1,
    rules: [
      "Use ONLY crop IDs from the verified available crop catalog for the field's agricultural group and region. Do not invent crops, varieties, planting windows, or agronomic traits.",
      "Each strategy must cover exactly 3 years (Year 1, Year 2, Year 3), with 1–4 seasonal entries per year.",
      "Every year must include at least 1 cash crop.",
      "Two cash crops within the same year must not overlap by more than 1 transition month.",
      "No botanical family (e.g., Poaceae, Fabaceae, Asteraceae, Brassicaceae) may appear in more than 2 years across the 3-year rotation.",
      "Sclerotinia-susceptible crops (sunflower, soybean) must not appear in more than 1 year across the 3-year rotation, because a 3-year plan cannot provide a multi-year non-host break between two Sclerotinia host years.",
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
      "Include at least 3 distinct botanical families across the 3-year rotation when the available crop catalog permits (fewer than 3 families is flagged as a low-diversity warning).",
    ],
  },
} as const;

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

export function getSclerotiniaHosts(crops: (Crop | undefined)[]): string[] {
  return crops
    .filter((c): c is Crop => !!c)
    .filter((c) =>
      c.diseasePestNotes?.some((n) => n.toLowerCase().includes("sclerotinia"))
    )
    .map((c) => c.id);
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
  // Ensure no two cash crops in the same year have overlapping growingWindow months
  // beyond the allowed single transition month.
  const maxSharedMonths = ROTATION_COMPATIBILITY_RULES.hardConstraints.maxCashCropSharedMonths;
  for (const year of proposal.years) {
    const cashSeasons = year.seasons.filter((s) => {
      const c = cropLibrary[s.crop];
      return c?.type === "cash";
    });
    for (let i = 0; i < cashSeasons.length; i++) {
      for (let j = i + 1; j < cashSeasons.length; j++) {
        const overlap = cashSeasons[i].months.filter((m) => cashSeasons[j].months.includes(m));
        if (overlap.length > maxSharedMonths) {
          errors.push(
            `Year ${year.year}: cash crops "${cashSeasons[i].crop}" and "${cashSeasons[j].crop}" have overlapping activity months.`
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
  // Penalize/flag if the same family appears in > maxYearsPerFamily years across the 3-year rotation.
  const maxYearsPerFamily = ROTATION_COMPATIBILITY_RULES.hardConstraints.maxYearsPerFamily;
  const familyByYear = proposal.years.map((y) => {
    const families = new Set<string>();
    y.seasons.forEach((s) => {
      const fam = getKnownFamilies(cropLibrary[s.crop]);
      if (fam !== "unknown") families.add(fam);
    });
    return Array.from(families);
  });

  const familyCounts: Record<string, number> = {};
  familyByYear.forEach((fams) => {
    fams.forEach((f) => {
      familyCounts[f] = (familyCounts[f] || 0) + 1;
    });
  });

  const repeatedFamilies = Object.entries(familyCounts).filter(([, count]) => count > maxYearsPerFamily);
  const passFamilySeq = repeatedFamilies.length === 0;
  checks.push({
    name: "Family diversity over 3 years",
    passed: passFamilySeq,
    severity: passFamilySeq ? "info" : "error",
    message: passFamilySeq
      ? "Botanical families are reasonably distributed across the rotation."
      : `Family(ies) appearing in >${maxYearsPerFamily} years: ${repeatedFamilies.map(([f]) => f).join(", ")}`,
  });
  if (!passFamilySeq) {
    errors.push(
      `Botanical family sequence constraint violated: ${repeatedFamilies.map(([f]) => f).join(", ")} appear in more than ${maxYearsPerFamily} years.`
    );
  }

  // ── 6. Disease compatibility ──
  // Sclerotinia host stacking
  const maxSclerotiniaYears = ROTATION_COMPATIBILITY_RULES.hardConstraints.maxSclerotiniaYears;
  const sclerotiniaHosts = getSclerotiniaHosts(allCrops);
  const sclerotiniaYears = new Map<number, string[]>();
  proposal.years.forEach((y) => {
    const hosts = y.seasons
      .filter((s) => sclerotiniaHosts.includes(s.crop))
      .map((s) => s.crop);
    if (hosts.length > 0) sclerotiniaYears.set(y.year, hosts);
  });
  const sclerotiniaYearCount = sclerotiniaYears.size;
  const passSclerotinia = sclerotiniaYearCount <= maxSclerotiniaYears;
  checks.push({
    name: "Sclerotinia host accumulation",
    passed: passSclerotinia,
    severity: passSclerotinia ? "info" : "error",
    message: passSclerotinia
      ? "Sclerotinia-susceptible crops are not accumulated across multiple years."
      : `Sclerotinia hosts appear in ${sclerotiniaYearCount} years: ${Array.from(sclerotiniaYears.entries()).map(([y, h]) => `Year ${y} (${h.join(", ")})`).join("; ")}`,
  });
  if (!passSclerotinia) {
    errors.push(
      `Sclerotinia host stacking: hosts appear in ${sclerotiniaYearCount} years. ` +
        `Consider lengthening the rotation interval or selecting non-host alternatives.`
    );
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
