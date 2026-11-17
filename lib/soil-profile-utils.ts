/**
 * Soil Profile Display & Texture Normalization Utilities (`lib/soil-profile-utils.ts`)
 *
 * Responsibilities:
 * 1. Provider capability matrix distinguishing between:
 *    - properties a soil data provider does not support at all (`provider_unsupported`), and
 *    - properties a provider supports in general, but for which no valid data exist at a
 *      specific coordinate (`missing_at_location`).
 * 2. Proportional fine-earth soil texture normalization (`sand + silt + clay = 100.0%`)
 *    with deterministic largest-remainder rounding to 0.1% (1000 tenth-percent units)
 *    while preserving original raw provider values untouched.
 * 3. Conditional property and table-column availability modeling so the Soil Profile UI
 *    omits unavailable properties completely instead of rendering dashes (`—`) or `N/A`.
 */

export type SoilDataTier =
  | "usda_ssurgo"
  | "soilgrids_wcs_250m"
  | "regional_reference_fallback";

export type SoilPropertyKey =
  | "texture"
  | "om"
  | "ph"
  | "awc"
  | "slope"
  | "drainage"
  | "bulkDensity"
  | "coarseFragments"
  | "wrbSoilGroup";

export type SoilPropertyAvailabilityStatus =
  | "available"
  | "provider_unsupported"
  | "missing_at_location";

export interface SoilProviderCapabilitySpec {
  tier: SoilDataTier;
  label: string;
  coverageSummary: string;
  supportedProperties: readonly SoilPropertyKey[];
  unsupportedProperties: readonly SoilPropertyKey[];
}

/**
 * Authoritative capability matrix across fallo's three soil data tiers:
 * - Tier 1 (`usda_ssurgo`): U.S. polygon survey map units with component-level
 *   drainage class (`co.drainagecl`), representative slope (`co.slope_r`), and
 *   0–30 cm horizon texture, OM, pH, and AWC.
 * - Tier 2 (`soilgrids_wcs_250m`): International ISRIC SoilGrids v2.0 ~250 m
 *   OGC WCS predictions across 0–5 cm, 5–15 cm, and 15–30 cm. Publishes sand,
 *   silt, clay, SOC (converted to OM), pH, bulk density, coarse fragments,
 *   volumetric water retention (33 kPa / 1500 kPa -> AWC), and WRB soil group.
 *   Does NOT publish terrain slope (%) or categorical soil drainage class.
 * - Tier 3 (`regional_reference_fallback`): Static macro-regional 0–30 cm
 *   reference estimates compiled from FAO HWSD v2.2 & ISRIC SoilGrids v2.0
 *   regional summaries when coordinate-specific soil services are unavailable.
 *   Does NOT provide field-specific terrain slope or drainage class.
 */
export const SOIL_PROVIDER_CAPABILITIES: Record<
  SoilDataTier,
  SoilProviderCapabilitySpec
> = {
  usda_ssurgo: {
    tier: "usda_ssurgo",
    label: "USDA NRCS SSURGO",
    coverageSummary:
      "U.S. polygon soil survey (1:12,000–1:24,000) providing 0–30 cm horizon texture, organic matter, pH, available water capacity (AWC), component drainage class, and representative terrain slope.",
    supportedProperties: [
      "texture",
      "om",
      "ph",
      "awc",
      "slope",
      "drainage",
    ],
    unsupportedProperties: ["bulkDensity", "coarseFragments", "wrbSoilGroup"],
  },
  soilgrids_wcs_250m: {
    tier: "soilgrids_wcs_250m",
    label: "ISRIC SoilGrids v2.0 OGC WCS (~250 m)",
    coverageSummary:
      "International ~250 m gridded machine-learning predictions across 0–5 cm, 5–15 cm, and 15–30 cm for fine-earth texture, organic carbon (SOC → OM), pH, bulk density, coarse fragments, water retention (AWC), and WRB soil group. Does not publish terrain slope or categorical drainage class.",
    supportedProperties: [
      "texture",
      "om",
      "ph",
      "awc",
      "bulkDensity",
      "coarseFragments",
      "wrbSoilGroup",
    ],
    unsupportedProperties: ["slope", "drainage"],
  },
  regional_reference_fallback: {
    tier: "regional_reference_fallback",
    label: "Macro-Regional Reference Summary (FAO HWSD v2.2 / SoilGrids v2.0)",
    coverageSummary:
      "Macro-regional 0–30 cm topsoil reference summary for texture, organic matter, pH, and available water capacity when coordinate-specific survey or WCS rasters are unavailable. Does not provide coordinate-specific slope, drainage class, or horizon breakdowns.",
    supportedProperties: [
      "texture",
      "om",
      "ph",
      "awc",
      "bulkDensity",
      "coarseFragments",
      "wrbSoilGroup",
    ],
    unsupportedProperties: ["slope", "drainage"],
  },
};

/**
 * Determine the active `SoilDataTier` from a soil response object.
 */
export function resolveSoilDataTier(data: {
  dataTier?: SoilDataTier;
  source?: string;
}): SoilDataTier {
  if (
    data.dataTier === "usda_ssurgo" ||
    data.dataTier === "soilgrids_wcs_250m" ||
    data.dataTier === "regional_reference_fallback"
  ) {
    return data.dataTier;
  }
  const src = data.source ?? "";
  if (src.toUpperCase().includes("SSURGO")) {
    return "usda_ssurgo";
  }
  if (
    src.includes("maps.isric.org") ||
    (src.includes("SoilGrids") && !src.includes("HWSD"))
  ) {
    return "soilgrids_wcs_250m";
  }
  return "regional_reference_fallback";
}

/**
 * Distinguish between:
 * - `"available"`: valid data exist at the selected location
 * - `"provider_unsupported"`: the active soil data provider does not publish this property at all
 * - `"missing_at_location"`: the active soil data provider supports this property in general,
 *   but no valid value exists at the selected coordinate
 */
export function classifySoilPropertyStatus(
  tier: SoilDataTier,
  property: SoilPropertyKey,
  hasValidValue: boolean
): SoilPropertyAvailabilityStatus {
  if (hasValidValue) {
    return "available";
  }
  const spec = SOIL_PROVIDER_CAPABILITIES[tier];
  if (spec.unsupportedProperties.includes(property)) {
    return "provider_unsupported";
  }
  return "missing_at_location";
}

// ─── Soil Texture Normalization (sand + silt + clay = 100.0%) ─────────

export interface NormalizedSoilTexture {
  /** True only when all 3 fractions (sand, silt, clay) are valid non-negative numbers with positive sum */
  valid: boolean;
  /** Displayed sand percentage rounded to 1 decimal place (or null if invalid) */
  sand: number | null;
  /** Displayed silt percentage rounded to 1 decimal place (or null if invalid) */
  silt: number | null;
  /** Displayed clay percentage rounded to 1 decimal place (or null if invalid) */
  clay: number | null;
  /** Sum of displayed rounded percentages — guaranteed to be 100.0 when valid === true */
  total: number | null;
  /** Unrounded proportional percentages totaling 100% (or null if invalid) */
  exact: {
    sand: number;
    silt: number;
    clay: number;
  } | null;
  /** Original raw provider values preserved without modification */
  raw: {
    sand: number | null;
    silt: number | null;
    clay: number | null;
    total: number | null;
  };
  /**
   * True when proportional normalization or rounding adjustment changed the displayed
   * percentages relative to the raw 1-decimal source values (e.g., when raw values did
   * not already sum to 100.0%).
   */
  wasNormalized: boolean;
}

function isValidFraction(value: number | null | undefined): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

/**
 * Proportionally normalize fine-earth soil texture fractions (`sand`, `silt`, `clay`)
 * so that the displayed percentages rounded to 1 decimal place always sum to **100.0%**,
 * while preserving the original raw source values in `.raw`.
 *
 * Rules:
 * - Requires all three fractions (`rawSand`, `rawSilt`, `rawClay`) to be finite numbers `>= 0`
 *   with `rawTotal = rawSand + rawSilt + rawClay > 0`.
 * - Never normalizes partial or invalid compositions (if any fraction is `null`, `undefined`,
 *   `NaN`, `Infinity`, or `< 0`, or if `rawTotal <= 0`, returns `valid: false` with `null`
 *   normalized values).
 * - Uses deterministic largest-remainder allocation in tenth-percent integer units
 *   (`1000` units = `100.0%`) so rounding never produces `99.9%` or `100.1%`.
 */
export function normalizeSoilTexture(
  rawSand: number | null | undefined,
  rawSilt: number | null | undefined,
  rawClay: number | null | undefined
): NormalizedSoilTexture {
  const cleanRawSand = isValidFraction(rawSand) ? rawSand : null;
  const cleanRawSilt = isValidFraction(rawSilt) ? rawSilt : null;
  const cleanRawClay = isValidFraction(rawClay) ? rawClay : null;

  if (
    cleanRawSand === null ||
    cleanRawSilt === null ||
    cleanRawClay === null
  ) {
    return {
      valid: false,
      sand: null,
      silt: null,
      clay: null,
      total: null,
      exact: null,
      raw: {
        sand: cleanRawSand,
        silt: cleanRawSilt,
        clay: cleanRawClay,
        total: null,
      },
      wasNormalized: false,
    };
  }

  const rawTotal = cleanRawSand + cleanRawSilt + cleanRawClay;
  if (!Number.isFinite(rawTotal) || rawTotal <= 0) {
    return {
      valid: false,
      sand: null,
      silt: null,
      clay: null,
      total: null,
      exact: null,
      raw: {
        sand: cleanRawSand,
        silt: cleanRawSilt,
        clay: cleanRawClay,
        total: Number.isFinite(rawTotal) ? Number(rawTotal.toFixed(1)) : null,
      },
      wasNormalized: false,
    };
  }

  const exactSand = (cleanRawSand / rawTotal) * 100;
  const exactSilt = (cleanRawSilt / rawTotal) * 100;
  const exactClay = (cleanRawClay / rawTotal) * 100;

  // Largest-remainder allocation in integer tenth-percent units (1000 = 100.0%)
  const TARGET_TENTH_UNITS = 1000;
  const items = [
    { key: "sand" as const, order: 0, exact: exactSand, raw: cleanRawSand },
    { key: "silt" as const, order: 1, exact: exactSilt, raw: cleanRawSilt },
    { key: "clay" as const, order: 2, exact: exactClay, raw: cleanRawClay },
  ].map((item) => {
    const scaled = item.exact * 10;
    const floorUnits = Math.floor(scaled + 1e-9);
    const remainder = Math.max(0, scaled - floorUnits);
    return {
      ...item,
      units: floorUnits,
      remainder,
    };
  });

  const currentSumUnits =
    items[0].units + items[1].units + items[2].units;
  let deficitUnits = TARGET_TENTH_UNITS - currentSumUnits;

  if (deficitUnits > 0) {
    const byRemainderDesc = [...items].sort((a, b) => {
      if (Math.abs(b.remainder - a.remainder) > 1e-9) {
        return b.remainder - a.remainder;
      }
      if (Math.abs(b.raw - a.raw) > 1e-9) {
        return b.raw - a.raw;
      }
      return a.order - b.order;
    });
    for (let i = 0; i < deficitUnits && i < byRemainderDesc.length; i++) {
      byRemainderDesc[i].units += 1;
    }
  } else if (deficitUnits < 0) {
    const byRemainderAsc = [...items].sort((a, b) => {
      if (Math.abs(a.remainder - b.remainder) > 1e-9) {
        return a.remainder - b.remainder;
      }
      return b.order - a.order;
    });
    for (let i = 0; i < -deficitUnits && i < byRemainderAsc.length; i++) {
      if (byRemainderAsc[i].units > 0) {
        byRemainderAsc[i].units -= 1;
      }
    }
  }

  const sandUnits = items.find((i) => i.key === "sand")!.units;
  const siltUnits = items.find((i) => i.key === "silt")!.units;
  const clayUnits = items.find((i) => i.key === "clay")!.units;

  const displaySand = Number((sandUnits / 10).toFixed(1));
  const displaySilt = Number((siltUnits / 10).toFixed(1));
  const displayClay = Number((clayUnits / 10).toFixed(1));
  const displayTotal = Number(
    ((sandUnits + siltUnits + clayUnits) / 10).toFixed(1)
  );

  const rawSand1 = Number(cleanRawSand.toFixed(1));
  const rawSilt1 = Number(cleanRawSilt.toFixed(1));
  const rawClay1 = Number(cleanRawClay.toFixed(1));
  const rawTotal1 = Number(rawTotal.toFixed(1));

  // Normalization was needed and applied if the raw total differed from 100.0%
  // or if any displayed 1-decimal value differs from its raw 1-decimal value.
  const wasNormalized =
    Math.abs(rawTotal - 100) >= 0.05 ||
    displaySand !== rawSand1 ||
    displaySilt !== rawSilt1 ||
    displayClay !== rawClay1;

  return {
    valid: true,
    sand: displaySand,
    silt: displaySilt,
    clay: displayClay,
    total: displayTotal,
    exact: {
      sand: exactSand,
      silt: exactSilt,
      clay: exactClay,
    },
    raw: {
      sand: cleanRawSand,
      silt: cleanRawSilt,
      clay: cleanRawClay,
      total: rawTotal1,
    },
    wasNormalized,
  };
}

// ─── Conditional Soil Profile Display Model ───────────────────────────

export interface SoilHorizonInput {
  depthTop: number;
  depthBottom: number;
  sand: number | null;
  silt: number | null;
  clay: number | null;
  sandMean?: number | null;
  siltMean?: number | null;
  clayMean?: number | null;
  om: number | null;
  ph: number | null;
  awc: number | null;
}

export interface SoilComponentInput {
  cokey: string;
  name: string;
  percent: number;
  kind: string;
  majcompflag: string | null;
  drainage: string | null;
  slope: number | null;
  horizons: SoilHorizonInput[];
}

export interface SsurgoAggregatedProperties {
  depth0_30cm: {
    sand: number | null; // %
    silt: number | null; // %
    clay: number | null; // %
    om: number | null; // %
    ph: number | null; // 1:1 H2O
    awc: number | null; // cm/cm
  };
  drainage: string | null;
  slope: number | null; // %
}

export interface SsurgoDataCoverage {
  depth0_30cm: {
    sand: number | null;
    silt: number | null;
    clay: number | null;
    om: number | null;
    ph: number | null;
    awc: number | null;
  };
  drainage: number | null;
  slope: number | null;
}

/**
 * Depth-weighted 0–30 cm average for a single numeric horizon property (`om`, `ph`, `awc`, etc.).
 * Horizons starting at or below 30 cm or missing a valid value for `property` are excluded.
 */
export function depthWeightedAverage(
  horizons: SoilHorizonInput[],
  property: "sand" | "silt" | "clay" | "om" | "ph" | "awc"
): number | null {
  let weightedSum = 0;
  let totalDepth = 0;
  let hasValue = false;

  for (const h of horizons) {
    const top = h.depthTop;
    const bottom = Math.min(h.depthBottom, 30);
    if (top >= 30 || bottom <= top) continue;

    const val = h[property];
    if (val === null || val === undefined || Number.isNaN(val)) continue;

    const depth = bottom - top;
    weightedSum += val * depth;
    totalDepth += depth;
    hasValue = true;
  }

  if (!hasValue || totalDepth === 0) return null;
  return weightedSum / totalDepth;
}

/**
 * Depth-weighted 0–30 cm texture average requiring all three fine-earth fractions
 * (`sand`, `silt`, `clay`) to be valid and present on the same horizon interval,
 * preventing partial-horizon records from skewing the composite texture sum.
 */
export function depthWeightedTextureAverage(
  horizons: SoilHorizonInput[]
): { sand: number; silt: number; clay: number } | null {
  let sandSum = 0;
  let siltSum = 0;
  let claySum = 0;
  let totalDepth = 0;

  for (const h of horizons) {
    const top = h.depthTop;
    const bottom = Math.min(h.depthBottom, 30);
    if (top >= 30 || bottom <= top) continue;

    if (
      h.sand === null ||
      h.silt === null ||
      h.clay === null ||
      !Number.isFinite(h.sand) ||
      !Number.isFinite(h.silt) ||
      !Number.isFinite(h.clay) ||
      h.sand < 0 ||
      h.silt < 0 ||
      h.clay < 0 ||
      h.sand + h.silt + h.clay <= 0
    ) {
      continue;
    }

    const depth = bottom - top;
    sandSum += h.sand * depth;
    siltSum += h.silt * depth;
    claySum += h.clay * depth;
    totalDepth += depth;
  }

  if (totalDepth === 0) return null;
  return {
    sand: sandSum / totalDepth,
    silt: siltSum / totalDepth,
    clay: claySum / totalDepth,
  };
}

/**
 * Aggregate USDA SSURGO map-unit components across 0–30 cm horizons,
 * weighting each component by its map-unit percentage (`percent`) and requiring
 * complete (`sand`, `silt`, `clay`) triplets for texture aggregation.
 */
export function aggregateComponents(
  components: SoilComponentInput[]
): { aggregated: SsurgoAggregatedProperties; dataCoverage: SsurgoDataCoverage } {
  const nonTextureProps: ("om" | "ph" | "awc")[] = ["om", "ph", "awc"];

  const depth0_30cm = {
    sand: null as number | null,
    silt: null as number | null,
    clay: null as number | null,
    om: null as number | null,
    ph: null as number | null,
    awc: null as number | null,
  };

  const coverage0_30cm = {
    sand: null as number | null,
    silt: null as number | null,
    clay: null as number | null,
    om: null as number | null,
    ph: null as number | null,
    awc: null as number | null,
  };

  // Texture (sand, silt, clay): require complete 3-fraction coverage per component
  let sandWeightedSum = 0;
  let siltWeightedSum = 0;
  let clayWeightedSum = 0;
  let textureTotalPercent = 0;

  for (const comp of components) {
    const compTex = depthWeightedTextureAverage(comp.horizons);
    if (!compTex || comp.percent <= 0) continue;

    sandWeightedSum += compTex.sand * comp.percent;
    siltWeightedSum += compTex.silt * comp.percent;
    clayWeightedSum += compTex.clay * comp.percent;
    textureTotalPercent += comp.percent;
  }

  if (textureTotalPercent > 0) {
    depth0_30cm.sand = sandWeightedSum / textureTotalPercent;
    depth0_30cm.silt = siltWeightedSum / textureTotalPercent;
    depth0_30cm.clay = clayWeightedSum / textureTotalPercent;
    coverage0_30cm.sand = textureTotalPercent;
    coverage0_30cm.silt = textureTotalPercent;
    coverage0_30cm.clay = textureTotalPercent;
  }

  for (const prop of nonTextureProps) {
    let weightedSum = 0;
    let totalPercent = 0;
    let hasValue = false;

    for (const comp of components) {
      const compVal = depthWeightedAverage(comp.horizons, prop);
      if (compVal === null || Number.isNaN(compVal)) continue;

      weightedSum += compVal * comp.percent;
      totalPercent += comp.percent;
      hasValue = true;
    }

    if (hasValue && totalPercent > 0) {
      depth0_30cm[prop] = weightedSum / totalPercent;
      coverage0_30cm[prop] = totalPercent;
    }
  }

  // Drainage: weighted dominant class among components with valid drainage
  const drainageCounts = new Map<string, number>();
  let drainageTotalPercent = 0;
  for (const comp of components) {
    if (comp.drainage) {
      drainageCounts.set(
        comp.drainage,
        (drainageCounts.get(comp.drainage) ?? 0) + comp.percent
      );
      drainageTotalPercent += comp.percent;
    }
  }
  let drainage: string | null = null;
  let maxDrainagePercent = 0;
  for (const [d, p] of drainageCounts) {
    if (p > maxDrainagePercent) {
      maxDrainagePercent = p;
      drainage = d;
    }
  }

  // Slope: weighted average among components with valid slope
  let slopeSum = 0;
  let slopePercent = 0;
  let hasSlope = false;
  for (const comp of components) {
    if (comp.slope !== null && !Number.isNaN(comp.slope)) {
      slopeSum += comp.slope * comp.percent;
      slopePercent += comp.percent;
      hasSlope = true;
    }
  }
  const slope = hasSlope && slopePercent > 0 ? slopeSum / slopePercent : null;

  return {
    aggregated: { depth0_30cm, drainage, slope },
    dataCoverage: {
      depth0_30cm: coverage0_30cm,
      drainage: drainageTotalPercent > 0 ? drainageTotalPercent : null,
      slope: hasSlope && slopePercent > 0 ? slopePercent : null,
    },
  };
}

export interface SoilProfileInput {
  dataTier?: SoilDataTier;
  source: string;
  totalComponentPercent: number;
  components?: SoilComponentInput[];
  aggregated: {
    depth0_30cm: {
      sand: number | null;
      silt: number | null;
      clay: number | null;
      textureMean0_30cm?: {
        sand: number;
        silt: number;
        clay: number;
      };
      om: number | null;
      ph: number | null;
      awc: number | null;
      organicCarbonPct?: number | null;
      bulkDensityGcm3?: number | null;
      coarseFragmentsPct?: number | null;
    };
    drainage: string | null;
    slope: number | null;
  };
}

export type DisplayedTextureStatistic =
  | "soilgrids_mean"
  | "soilgrids_q50"
  | "ssurgo_survey"
  | "regional_reference";

export interface AvailableSoilMetric {
  key: "om" | "ph" | "awc" | "slope" | "drainage";
  label: string;
  value: number | string;
  formattedValue: string;
  unit: string;
}

export interface NormalizedHorizonRow {
  depthTop: number;
  depthBottom: number;
  texture: NormalizedSoilTexture;
  textureStatistic: DisplayedTextureStatistic;
  om: number | null;
  ph: number | null;
  awc: number | null;
}

export interface ComponentHorizonTableModel {
  cokey: string;
  name: string;
  percent: number;
  rows: NormalizedHorizonRow[];
  showTextureColumns: boolean;
  showOmColumn: boolean;
  showPhColumn: boolean;
  showAwcColumn: boolean;
}

export interface SoilProfileDisplayModel {
  dataTier: SoilDataTier;
  providerCapability: SoilProviderCapabilitySpec;
  texture: NormalizedSoilTexture;
  textureStatistic: DisplayedTextureStatistic;
  /**
   * When `textureStatistic === "soilgrids_mean"`, preserves the 0–30 cm Q0.50
   * marginal median predictions (`aggregated.depth0_30cm.{sand, silt, clay}`)
   * retained for downstream suitability and rotation scoring.
   */
  q50TextureRaw: {
    sand: number | null;
    silt: number | null;
    clay: number | null;
    total: number | null;
  } | null;
  availableMetrics: AvailableSoilMetric[];
  propertyStatuses: Record<
    "texture" | "om" | "ph" | "awc" | "slope" | "drainage",
    SoilPropertyAvailabilityStatus
  >;
  subtitlePropertiesLabel: string;
  componentTable: {
    visible: boolean;
    components: SoilComponentInput[];
    showMajorColumn: boolean;
    showDrainageColumn: boolean;
    showSlopeColumn: boolean;
    showKnownTotalRow: boolean;
    visibleColumnCount: number;
  };
  horizonTables: ComponentHorizonTableModel[];
}

function isValidNumber(val: number | null | undefined, min = 0): val is number {
  return typeof val === "number" && Number.isFinite(val) && val >= min;
}

function isValidDrainage(val: string | null | undefined): val is string {
  if (typeof val !== "string") return false;
  const trimmed = val.trim();
  return (
    trimmed.length > 0 &&
    trimmed !== "—" &&
    trimmed.toLowerCase() !== "n/a" &&
    trimmed.toLowerCase() !== "unknown" &&
    trimmed.toLowerCase() !== "null"
  );
}

/**
 * Build a conditional display model for the Soil Profile page that:
 * 1. Normalizes 0–30 cm and horizon-level texture percentages to 100.0% while preserving raw values.
 * 2. Includes ONLY soil properties and table columns that have genuine, valid values at the location.
 * 3. Classifies unavailable properties as either `provider_unsupported` or `missing_at_location`.
 */
export function buildSoilProfileDisplayModel(
  data: SoilProfileInput
): SoilProfileDisplayModel {
  const dataTier = resolveSoilDataTier(data);
  const providerCapability = SOIL_PROVIDER_CAPABILITIES[dataTier];
  const d = data.aggregated.depth0_30cm;

  const hasMeanTexture0_30 =
    dataTier === "soilgrids_wcs_250m" &&
    d.textureMean0_30cm !== undefined &&
    isValidFraction(d.textureMean0_30cm.sand) &&
    isValidFraction(d.textureMean0_30cm.silt) &&
    isValidFraction(d.textureMean0_30cm.clay) &&
    d.textureMean0_30cm.sand +
      d.textureMean0_30cm.silt +
      d.textureMean0_30cm.clay >
      0;

  const texture = hasMeanTexture0_30
    ? normalizeSoilTexture(
        d.textureMean0_30cm!.sand,
        d.textureMean0_30cm!.silt,
        d.textureMean0_30cm!.clay
      )
    : normalizeSoilTexture(d.sand, d.silt, d.clay);

  const textureStatistic: DisplayedTextureStatistic = hasMeanTexture0_30
    ? "soilgrids_mean"
    : dataTier === "soilgrids_wcs_250m"
    ? "soilgrids_q50"
    : dataTier === "usda_ssurgo"
    ? "ssurgo_survey"
    : "regional_reference";

  const q50TextureRaw =
    dataTier === "soilgrids_wcs_250m"
      ? {
          sand: isValidFraction(d.sand) ? d.sand : null,
          silt: isValidFraction(d.silt) ? d.silt : null,
          clay: isValidFraction(d.clay) ? d.clay : null,
          total:
            isValidFraction(d.sand) &&
            isValidFraction(d.silt) &&
            isValidFraction(d.clay)
              ? Number((d.sand + d.silt + d.clay).toFixed(1))
              : null,
        }
      : null;

  const hasOm = isValidNumber(d.om, 0);
  const hasPh = isValidNumber(d.ph, 0.1);
  const hasAwc = isValidNumber(d.awc, 0);
  const hasSlope = isValidNumber(data.aggregated.slope, 0);
  const hasDrainage = isValidDrainage(data.aggregated.drainage);

  const availableMetrics: AvailableSoilMetric[] = [];
  if (hasOm && d.om !== null) {
    availableMetrics.push({
      key: "om",
      label: "Organic Matter",
      value: d.om,
      formattedValue: d.om.toFixed(2),
      unit: "%",
    });
  }
  if (hasPh && d.ph !== null) {
    availableMetrics.push({
      key: "ph",
      label: "pH (1:1 H₂O)",
      value: d.ph,
      formattedValue: d.ph.toFixed(1),
      unit: "",
    });
  }
  if (hasAwc && d.awc !== null) {
    availableMetrics.push({
      key: "awc",
      label: "AWC",
      value: d.awc,
      formattedValue: d.awc.toFixed(3),
      unit: "cm/cm",
    });
  }
  if (hasSlope && data.aggregated.slope !== null) {
    availableMetrics.push({
      key: "slope",
      label: "Slope",
      value: data.aggregated.slope,
      formattedValue: data.aggregated.slope.toFixed(1),
      unit: "%",
    });
  }
  if (hasDrainage && data.aggregated.drainage !== null) {
    availableMetrics.push({
      key: "drainage",
      label: "Drainage",
      value: data.aggregated.drainage.trim(),
      formattedValue: data.aggregated.drainage.trim(),
      unit: "",
    });
  }

  const propertyStatuses: SoilProfileDisplayModel["propertyStatuses"] = {
    texture: classifySoilPropertyStatus(dataTier, "texture", texture.valid),
    om: classifySoilPropertyStatus(dataTier, "om", hasOm),
    ph: classifySoilPropertyStatus(dataTier, "ph", hasPh),
    awc: classifySoilPropertyStatus(dataTier, "awc", hasAwc),
    slope: classifySoilPropertyStatus(dataTier, "slope", hasSlope),
    drainage: classifySoilPropertyStatus(dataTier, "drainage", hasDrainage),
  };

  // Build concise subtitle listing only available properties
  const subtitleParts: string[] = [];
  if (texture.valid) subtitleParts.push("texture");
  if (hasOm) subtitleParts.push("organic matter");
  if (hasPh) subtitleParts.push("pH");
  if (hasAwc) subtitleParts.push("water-holding capacity");
  if (hasDrainage) subtitleParts.push("drainage");
  if (hasSlope) subtitleParts.push("slope");

  let subtitlePropertiesLabel = "";
  if (subtitleParts.length === 1) {
    subtitlePropertiesLabel = subtitleParts[0];
  } else if (subtitleParts.length === 2) {
    subtitlePropertiesLabel = `${subtitleParts[0]} and ${subtitleParts[1]}`;
  } else if (subtitleParts.length > 2) {
    subtitlePropertiesLabel = `${subtitleParts.slice(0, -1).join(", ")}, and ${
      subtitleParts[subtitleParts.length - 1]
    }`;
  }

  // Component breakdown table visibility & columns
  const rawComponents = data.components ?? [];
  const showMajorColumn =
    dataTier === "usda_ssurgo" &&
    rawComponents.some(
      (c) => c.majcompflag === "Yes" || c.majcompflag === "No"
    );
  const showDrainageColumn = rawComponents.some((c) =>
    isValidDrainage(c.drainage)
  );
  const showSlopeColumn = rawComponents.some((c) => isValidNumber(c.slope, 0));
  const showKnownTotalRow =
    dataTier === "usda_ssurgo" && rawComponents.length > 0;

  // Base columns: Name, %, Kind, Horizons (4 columns) + optional Major, Drainage, Slope
  const visibleColumnCount =
    4 +
    (showMajorColumn ? 1 : 0) +
    (showDrainageColumn ? 1 : 0) +
    (showSlopeColumn ? 1 : 0);

  // Horizon tables per component
  const horizonTables: ComponentHorizonTableModel[] = [];
  for (const comp of rawComponents) {
    const normalizedRows: NormalizedHorizonRow[] = [];
    for (const hz of comp.horizons) {
      const hasHzMeanTexture =
        dataTier === "soilgrids_wcs_250m" &&
        isValidFraction(hz.sandMean) &&
        isValidFraction(hz.siltMean) &&
        isValidFraction(hz.clayMean) &&
        hz.sandMean + hz.siltMean + hz.clayMean > 0;

      const hzTexture = hasHzMeanTexture
        ? normalizeSoilTexture(hz.sandMean, hz.siltMean, hz.clayMean)
        : normalizeSoilTexture(hz.sand, hz.silt, hz.clay);

      const hzTextureStatistic: DisplayedTextureStatistic = hasHzMeanTexture
        ? "soilgrids_mean"
        : dataTier === "soilgrids_wcs_250m"
        ? "soilgrids_q50"
        : dataTier === "usda_ssurgo"
        ? "ssurgo_survey"
        : "regional_reference";

      const hzOm = isValidNumber(hz.om, 0) ? hz.om : null;
      const hzPh = isValidNumber(hz.ph, 0.1) ? hz.ph : null;
      const hzAwc = isValidNumber(hz.awc, 0) ? hz.awc : null;

      // Omit completely empty horizon rows (e.g. unpopulated bedrock layers)
      if (!hzTexture.valid && hzOm === null && hzPh === null && hzAwc === null) {
        continue;
      }

      normalizedRows.push({
        depthTop: hz.depthTop,
        depthBottom: hz.depthBottom,
        texture: hzTexture,
        textureStatistic: hzTextureStatistic,
        om: hzOm,
        ph: hzPh,
        awc: hzAwc,
      });
    }

    if (normalizedRows.length === 0) continue;

    const showTextureColumns = normalizedRows.some((r) => r.texture.valid);
    const showOmColumn = normalizedRows.some((r) => r.om !== null);
    const showPhColumn = normalizedRows.some((r) => r.ph !== null);
    const showAwcColumn = normalizedRows.some((r) => r.awc !== null);

    horizonTables.push({
      cokey: comp.cokey,
      name: comp.name,
      percent: comp.percent,
      rows: normalizedRows,
      showTextureColumns,
      showOmColumn,
      showPhColumn,
      showAwcColumn,
    });
  }

  return {
    dataTier,
    providerCapability,
    texture,
    textureStatistic,
    q50TextureRaw,
    availableMetrics,
    propertyStatuses,
    subtitlePropertiesLabel,
    componentTable: {
      visible: rawComponents.length > 0,
      components: rawComponents,
      showMajorColumn,
      showDrainageColumn,
      showSlopeColumn,
      showKnownTotalRow,
      visibleColumnCount,
    },
    horizonTables,
  };
}
