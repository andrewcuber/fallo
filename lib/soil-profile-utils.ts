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

import { LRUCache } from "lru-cache";
import { normalizeCoordinates } from "@/lib/coordinates";
import {
  isUnitedStatesCoordinate,
  resolveGeographicContext,
} from "@/lib/region";
import {
  resolveGlobalSoilFallback,
  type SoilPropertyUncertainty,
} from "@/lib/global-data-providers";
import type {
  fetchSoilGridsWcsProfile,
  SoilGridsLayerUncertainty,
} from "@/lib/soilgrids-wcs";

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

// ─── USDA NRCS SSURGO Spatial Query, Parsing & Provider Orchestration ─────────

export const USDA_SDA_REST_ENDPOINT =
  "https://SDMDataAccess.sc.egov.usda.gov/Tabular/post.rest";
export const DEFAULT_SDA_TIMEOUT_MS = 20000;

export interface UsSsurgoFallbackMeta {
  reason: "request_error" | "no_map_unit" | "no_usable_soil_data";
  detail: string;
}

export interface SoilApiResponsePayload {
  location: {
    lat: number;
    lon: number;
    lonWasNormalized?: boolean;
    originalLon?: number;
  };
  dataTier?: SoilDataTier;
  source: string;
  coverage: string;
  wrbSoilGroup?: string;
  mapUnit: {
    mukey: string;
    name: string;
  } | null;
  totalComponentPercent: number;
  components: SoilComponentInput[];
  aggregated: SsurgoAggregatedProperties & {
    depth0_30cm: SsurgoAggregatedProperties["depth0_30cm"] & {
      textureMean0_30cm?: {
        sand: number;
        silt: number;
        clay: number;
      };
      organicCarbonPct?: number | null;
      bulkDensityGcm3?: number | null;
      coarseFragmentsPct?: number | null;
    };
  };
  uncertainty?: {
    depth0_30cm: {
      sand?: SoilPropertyUncertainty;
      silt?: SoilPropertyUncertainty;
      clay?: SoilPropertyUncertainty;
      om?: SoilPropertyUncertainty;
      ph?: SoilPropertyUncertainty;
      awc?: SoilPropertyUncertainty;
    };
  };
  layerUncertainty?: SoilGridsLayerUncertainty;
  pixelResolution?: {
    gridSizeMeters: number;
    usedNeighborPixel: boolean;
    neighborDistanceMeters: number;
    extractedLat: number;
    extractedLon: number;
  };
  propertySources?: Record<string, string>;
  dataCoverage: SsurgoDataCoverage;
  limitations: string[];
  enrichmentStatus?: "complete" | "partial_optional";
  usSsurgoFallback?: UsSsurgoFallbackMeta;
  cached?: boolean;
}

/**
 * Construct a WKT point geometry in strict `POINT(longitude latitude)` order (WGS84 / EPSG:4326)
 * for USDA NRCS `SDA_Get_Mukey_from_intersection_with_WktWgs84`.
 */
export function buildSsurgoPointWkt(latInput: number, lonInput: number): string {
  const norm = normalizeCoordinates(latInput, lonInput);
  if (!norm.valid) {
    throw new RangeError(
      `Invalid coordinates for SSURGO WKT point: (${String(latInput)}, ${String(lonInput)})`
    );
  }
  return `POINT(${norm.lon} ${norm.lat})`;
}

export class SsurgoRequestError extends Error {
  readonly statusCode?: number;

  constructor(message: string, statusCode?: number) {
    super(message);
    this.name = "SsurgoRequestError";
    this.statusCode = statusCode;
  }
}

function sanitizeSdaErrorBody(rawBody: string, statusCode: number): string {
  const trimmed = rawBody.trim();
  if (!trimmed) {
    return `HTTP ${statusCode}`;
  }
  // If SDA or its AWS ALB returns an HTML error page (e.g. 502 Bad Gateway), extract title/h1 cleanly
  if (trimmed.startsWith("<") || /<\/?[a-z][\s\S]*>/i.test(trimmed)) {
    const titleMatch = trimmed.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
    if (titleMatch?.[1]) {
      const cleanTitle = titleMatch[1].replace(/\s+/g, " ").trim();
      return cleanTitle.startsWith(String(statusCode))
        ? `HTTP ${cleanTitle}`
        : `HTTP ${statusCode} (${cleanTitle})`;
    }
    const stripped = trimmed
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    return stripped
      ? `HTTP ${statusCode} (${stripped.slice(0, 120)})`
      : `HTTP ${statusCode}`;
  }
  return `HTTP ${statusCode}: ${trimmed.replace(/\s+/g, " ").slice(0, 160)}`;
}

/**
 * Execute a SQL query against the USDA NRCS Soil Data Access (SDA) REST POST endpoint.
 *
 * Strictly distinguishes:
 * - Genuine empty spatial/tabular results (SDA returns `{}` or `{"Table": []}`) -> returns `[]`
 * - HTTP failures, network timeouts, malformed JSON, or SDA error objects (`{"Error": ...}`, `{"Message": ...}`)
 *   -> throws `SsurgoRequestError` so request failures are never silently converted into empty results.
 */
export async function queryUsdaSda<T = string | null>(
  query: string,
  options?: {
    fetchFn?: typeof fetch;
    timeoutMs?: number;
  }
): Promise<T[][]> {
  const fetchImpl = options?.fetchFn ?? fetch;
  const timeoutMs = options?.timeoutMs ?? DEFAULT_SDA_TIMEOUT_MS;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    let res: Response;
    try {
      res = await fetchImpl(USDA_SDA_REST_ENDPOINT, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify({ query, format: "JSON" }),
        signal: controller.signal,
      });
    } catch (err: unknown) {
      if (
        err instanceof Error &&
        (err.name === "AbortError" ||
          err.message.toLowerCase().includes("aborted"))
      ) {
        throw new SsurgoRequestError(
          `USDA Soil Data Access request timed out after ${timeoutMs} ms`
        );
      }
      const msg = err instanceof Error ? err.message : String(err);
      throw new SsurgoRequestError(
        `USDA Soil Data Access network request failed: ${msg}`
      );
    }

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new SsurgoRequestError(
        `USDA Soil Data Access API returned ${sanitizeSdaErrorBody(text, res.status)}`,
        res.status
      );
    }

    const rawText = await res.text();
    const trimmed = rawText.trim();
    if (!trimmed) {
      throw new SsurgoRequestError(
        "USDA Soil Data Access API returned an empty response body"
      );
    }

    let json: unknown;
    try {
      json = JSON.parse(trimmed);
    } catch {
      throw new SsurgoRequestError(
        "USDA Soil Data Access API returned non-JSON response"
      );
    }

    if (json && typeof json === "object" && !Array.isArray(json)) {
      const record = json as Record<string, unknown>;
      if ("Table" in record) {
        if (Array.isArray(record.Table)) {
          return record.Table as T[][];
        }
        if (record.Table === null || record.Table === undefined) {
          return [];
        }
        throw new SsurgoRequestError(
          "Unexpected USDA Soil Data Access Table format"
        );
      }

      const keys = Object.keys(record);
      if (keys.length === 0) {
        // USDA SDA returns `{}` when a spatial or tabular query matches zero rows
        return [];
      }

      // Non-empty object without `Table` indicates an SDA SQL/service error payload
      const errDetail =
        record.Error ??
        record.error ??
        record.Message ??
        record.message ??
        record.ExceptionMessage ??
        JSON.stringify(record).slice(0, 200);
      throw new SsurgoRequestError(
        `USDA Soil Data Access query error: ${String(errDetail)}`
      );
    }

    throw new SsurgoRequestError(
      "Unexpected USDA Soil Data Access response format"
    );
  } finally {
    clearTimeout(timeout);
  }
}

function parseSdaNumber(val: unknown): number | null {
  if (val === null || val === undefined) return null;
  const n = typeof val === "string" ? parseFloat(val) : Number(val);
  return Number.isFinite(n) ? n : null;
}

function parseSdaString(val: unknown): string | null {
  if (val === null || val === undefined) return null;
  const s = String(val).trim();
  return s.length > 0 ? s : null;
}

/**
 * Check whether an aggregated SSURGO profile contains at least one usable soil property
 * (complete texture triplet, OM, pH, AWC, drainage class, or slope).
 */
export function hasUsableSsurgoProperties(
  aggregated: SsurgoAggregatedProperties
): boolean {
  const d = aggregated.depth0_30cm;
  const hasCompleteTexture =
    isValidFraction(d.sand) &&
    isValidFraction(d.silt) &&
    isValidFraction(d.clay) &&
    d.sand + d.silt + d.clay > 0;
  return (
    hasCompleteTexture ||
    isValidNumber(d.om, 0) ||
    isValidNumber(d.ph, 0.1) ||
    isValidNumber(d.awc, 0) ||
    isValidDrainage(aggregated.drainage) ||
    isValidNumber(aggregated.slope, 0)
  );
}

export type UsdaSsurgoFetchResult =
  | {
      status: "ok";
      wkt: string;
      mukey: string;
      mapUnitName: string | null;
      response: SoilApiResponsePayload;
    }
  | {
      status: "no_map_unit";
      wkt: string;
      message: string;
    }
  | {
      status: "no_usable_soil_data";
      wkt: string;
      mukey: string;
      mapUnitName: string | null;
      message: string;
    }
  | {
      status: "request_error";
      wkt: string;
      errorMessage: string;
      message: string;
    };

/**
 * Query USDA NRCS SSURGO for a coordinate pair, returning a typed result that
 * distinguishes:
 * - `"ok"`: Valid SSURGO soil profile with aggregated 0–30 cm properties
 * - `"no_map_unit"`: SDA responded normally, but no surveyed map unit intersects `POINT(lon lat)`
 * - `"no_usable_soil_data"`: Map unit exists, but components contain no usable 0–30 cm soil properties
 * - `"request_error"`: SDA service outage (e.g. HTTP 502), network failure, timeout, or SQL/JSON error
 */
export async function fetchUsdaSsurgoProfile(
  latInput: number,
  lonInput: number,
  options?: {
    fetchFn?: typeof fetch;
    timeoutMs?: number;
  }
): Promise<UsdaSsurgoFetchResult> {
  const norm = normalizeCoordinates(latInput, lonInput);
  if (!norm.ok) {
    return {
      status: "request_error",
      wkt: "",
      errorMessage: norm.error,
      message: norm.error,
    };
  }

  const lat = norm.lat;
  const lon = norm.lon;
  const wkt = buildSsurgoPointWkt(lat, lon);
  const locationMeta = {
    lat,
    lon,
    ...(norm.lonWasNormalized
      ? { lonWasNormalized: true, originalLon: norm.originalLon }
      : {}),
  };

  try {
    // Step 1: Spatial intersection query in WGS84 (`POINT(lon lat)`)
    const mukeyRows = await queryUsdaSda<string>(
      `SELECT mukey FROM SDA_Get_Mukey_from_intersection_with_WktWgs84('${wkt}')`,
      options
    );

    const dataMukeyRows = mukeyRows.filter(
      (r) =>
        Array.isArray(r) &&
        r.length > 0 &&
        String(r[0]).trim().toLowerCase() !== "mukey"
    );

    if (dataMukeyRows.length === 0) {
      return {
        status: "no_map_unit",
        wkt,
        message:
          "No USDA NRCS SSURGO map unit polygon was found at this coordinate.",
      };
    }

    const mukey = parseSdaString(dataMukeyRows[0][0]);
    if (!mukey || !/^[A-Za-z0-9_-]+$/.test(mukey)) {
      return {
        status: "no_map_unit",
        wkt,
        message:
          "USDA NRCS SSURGO spatial query returned an empty map unit key at this coordinate.",
      };
    }

    // Step 2: Fetch mapunit name
    const muRows = await queryUsdaSda<string>(
      `SELECT muname FROM mapunit WHERE mukey = '${mukey}'`,
      options
    );
    const dataMuRows = muRows.filter(
      (r) =>
        Array.isArray(r) &&
        r.length > 0 &&
        String(r[0]).trim().toLowerCase() !== "muname"
    );
    const mapUnitName =
      dataMuRows.length > 0 ? parseSdaString(dataMuRows[0][0]) : null;

    // Step 3: Fetch components and horizons (0–30 cm)
    // Columns (in order):
    // 0:co.cokey 1:co.comppct_r 2:co.compname 3:co.drainagecl 4:co.slope_r 5:co.compkind 6:co.majcompflag
    // 7:hz.hzdept_r 8:hz.hzdepb_r 9:hz.sandtotal_r 10:hz.silttotal_r 11:hz.claytotal_r 12:hz.om_r 13:hz.ph1to1h2o_r 14:hz.awc_r
    const rows = await queryUsdaSda<string | null>(
      `SELECT co.cokey, co.comppct_r, co.compname, co.drainagecl, co.slope_r, co.compkind, co.majcompflag,
        hz.hzdept_r, hz.hzdepb_r, hz.sandtotal_r, hz.silttotal_r, hz.claytotal_r, hz.om_r, hz.ph1to1h2o_r, hz.awc_r
       FROM component co
       LEFT JOIN chorizon hz ON co.cokey = hz.cokey AND hz.hzdept_r < 30
       WHERE co.mukey = '${mukey}'
       ORDER BY co.comppct_r DESC, co.cokey, hz.hzdept_r`,
      options
    );

    const compMap = new Map<string, SoilComponentInput>();
    for (const row of rows) {
      if (!Array.isArray(row)) continue;
      const cokey = parseSdaString(row[0]);
      if (!cokey || cokey.toLowerCase() === "cokey") continue;

      if (!compMap.has(cokey)) {
        compMap.set(cokey, {
          cokey,
          name: parseSdaString(row[2]) ?? "Unknown",
          percent: parseSdaNumber(row[1]) ?? 0,
          kind: parseSdaString(row[5]) ?? "Unknown",
          majcompflag: parseSdaString(row[6]),
          drainage: parseSdaString(row[3]),
          slope: parseSdaNumber(row[4]),
          horizons: [],
        });
      }

      const comp = compMap.get(cokey)!;
      const hzdept = parseSdaNumber(row[7]);
      const hzdepb = parseSdaNumber(row[8]);
      if (hzdept === null || hzdepb === null) continue;

      comp.horizons.push({
        depthTop: hzdept,
        depthBottom: hzdepb,
        sand: parseSdaNumber(row[9]),
        silt: parseSdaNumber(row[10]),
        clay: parseSdaNumber(row[11]),
        om: parseSdaNumber(row[12]),
        ph: parseSdaNumber(row[13]),
        awc: parseSdaNumber(row[14]),
      });
    }

    const components = Array.from(compMap.values());
    if (components.length === 0) {
      return {
        status: "no_usable_soil_data",
        wkt,
        mukey,
        mapUnitName,
        message: `USDA NRCS SSURGO map unit "${mapUnitName ?? mukey}" (mukey ${mukey}) contains no component records at this coordinate.`,
      };
    }

    const { aggregated, dataCoverage } = aggregateComponents(components);
    if (!hasUsableSsurgoProperties(aggregated)) {
      return {
        status: "no_usable_soil_data",
        wkt,
        mukey,
        mapUnitName,
        message: `USDA NRCS SSURGO map unit "${mapUnitName ?? mukey}" (mukey ${mukey}) contains no usable 0–30 cm soil measurements (e.g., water or unpopulated miscellaneous area).`,
      };
    }

    const limitations: string[] = [];
    const totalComponentPercent = components.reduce((s, c) => s + c.percent, 0);
    const unaccountedPercent = Math.max(0, 100 - totalComponentPercent);
    if (unaccountedPercent > 0) {
      limitations.push(
        `Components account for ${totalComponentPercent}% of the map unit. The remaining ${unaccountedPercent}% is unaccounted for in the component records. SSURGO map units may include areas not represented as named components.`
      );
    } else {
      limitations.push(
        `Components account for ${totalComponentPercent}% of the map unit.`
      );
    }

    const compsWithoutHorizons = components.filter(
      (c) => c.horizons.length === 0
    );
    if (compsWithoutHorizons.length > 0) {
      limitations.push(
        `Components without usable horizon data: ${compsWithoutHorizons.map((c) => `${c.name} (${c.percent}%)`).join(", ")}. Depth-weighted averages exclude these.`
      );
    }

    const depthCoverage = dataCoverage.depth0_30cm;
    for (const prop of ["sand", "silt", "clay", "om", "ph", "awc"] as const) {
      const cov = depthCoverage[prop];
      if (cov !== null && cov < totalComponentPercent) {
        limitations.push(
          `0-30 cm ${prop.toUpperCase()} is averaged from components covering ${cov}% of the map unit (missing values excluded, not treated as zero).`
        );
      }
    }

    if (
      dataCoverage.drainage !== null &&
      dataCoverage.drainage < totalComponentPercent
    ) {
      limitations.push(
        `Drainage class is drawn from components covering ${dataCoverage.drainage}% of the map unit.`
      );
    }

    if (
      dataCoverage.slope !== null &&
      dataCoverage.slope < totalComponentPercent
    ) {
      limitations.push(
        `Slope is averaged from components covering ${dataCoverage.slope}% of the map unit.`
      );
    }

    const { sand, silt, clay } = aggregated.depth0_30cm;
    if (sand !== null && silt !== null && clay !== null) {
      const textureSum = sand + silt + clay;
      if (Math.abs(textureSum - 100) > 5) {
        limitations.push(
          `Depth-weighted texture fractions sum to ${textureSum.toFixed(1)}%. This may indicate incomplete horizon data or rounding differences.`
        );
      }
    }

    limitations.push(
      "SSURGO data represent the best-available survey mapping. Properties vary within a map unit. On-site testing is recommended for field-level decisions."
    );
    limitations.push(
      "Aggregated 0-30 cm values are depth-weighted averages of named soil components, weighted by component percentage. Missing values are excluded, not treated as zero."
    );

    const ssurgoPropertySources: Record<string, string> = {};
    if (
      aggregated.depth0_30cm.sand !== null &&
      aggregated.depth0_30cm.silt !== null &&
      aggregated.depth0_30cm.clay !== null
    ) {
      ssurgoPropertySources.sand = "USDA NRCS SSURGO (depth-weighted 0–30 cm)";
      ssurgoPropertySources.silt = "USDA NRCS SSURGO (depth-weighted 0–30 cm)";
      ssurgoPropertySources.clay = "USDA NRCS SSURGO (depth-weighted 0–30 cm)";
    }
    if (aggregated.depth0_30cm.om !== null) {
      ssurgoPropertySources.om = "USDA NRCS SSURGO (depth-weighted 0–30 cm)";
    }
    if (aggregated.depth0_30cm.ph !== null) {
      ssurgoPropertySources.ph =
        "USDA NRCS SSURGO (1:1 H2O, depth-weighted 0–30 cm)";
    }
    if (aggregated.depth0_30cm.awc !== null) {
      ssurgoPropertySources.awc = "USDA NRCS SSURGO (depth-weighted 0–30 cm)";
    }
    if (aggregated.drainage) {
      ssurgoPropertySources.drainage =
        "USDA NRCS SSURGO (dominant component drainage class)";
    }
    if (aggregated.slope !== null) {
      ssurgoPropertySources.slope =
        "USDA NRCS SSURGO (component-weighted slope %)";
    }

    const response: SoilApiResponsePayload = {
      location: locationMeta,
      dataTier: "usda_ssurgo",
      source:
        "USDA NRCS Soil Survey Geographic Database (SSURGO). https://sdmdataaccess.sc.egov.usda.gov",
      coverage: "United States (USDA SSURGO primary survey).",
      mapUnit: {
        mukey,
        name: mapUnitName ?? "Unknown map unit",
      },
      totalComponentPercent,
      components,
      aggregated,
      propertySources: ssurgoPropertySources,
      dataCoverage,
      limitations,
    };

    return {
      status: "ok",
      wkt,
      mukey,
      mapUnitName,
      response,
    };
  } catch (err: unknown) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    return {
      status: "request_error",
      wkt,
      errorMessage,
      message: `USDA NRCS Soil Data Access (SSURGO) request failed (${errorMessage}).`,
    };
  }
}

/**
 * Determine whether a cached soil response is valid to serve for a coordinate pair.
 *
 * Specifically prevents any cached `regional_reference_fallback` profile from ever being
 * reused for a U.S. coordinate.
 */
export function isUsableCachedSoilResponse(
  latInput: number,
  lonInput: number,
  response: { dataTier?: SoilDataTier; source?: string } | null | undefined
): boolean {
  if (!response) return false;
  const tier = resolveSoilDataTier(response);
  if (isUnitedStatesCoordinate(latInput, lonInput)) {
    if (tier === "regional_reference_fallback") {
      return false;
    }
  }
  return true;
}

export type SoilCachePolicy =
  | "ssurgo_primary"
  | "soilgrids_primary"
  | "us_outage_soilgrids_fallback"
  | "us_unmapped_soilgrids_fallback"
  | "international_regional_fallback";

export type ResolvedSoilRouteResult =
  | {
      ok: true;
      httpStatus: 200;
      response: SoilApiResponsePayload;
      cachePolicy: SoilCachePolicy;
      usSsurgoStatus?: UsdaSsurgoFetchResult["status"];
    }
  | {
      ok: false;
      httpStatus: 503 | 404;
      error: string;
      detail: string;
      usSsurgoStatus: Exclude<UsdaSsurgoFetchResult["status"], "ok">;
    };

export async function fetchNearbySsurgoMapUnit(lat: number, lon: number, options?: { sdaFetchFn?: typeof fetch; sdaTimeoutMs?: number }) {
  const distanceMeters = 150;
  const latOffset = distanceMeters / 111320;
  const lonOffset = distanceMeters / (111320 * Math.cos(lat * Math.PI / 180));
  const minLon = (lon - lonOffset).toFixed(6);
  const maxLon = (lon + lonOffset).toFixed(6);
  const minLat = (lat - latOffset).toFixed(6);
  const maxLat = (lat + latOffset).toFixed(6);
  const wkt = `POLYGON((${minLon} ${minLat}, ${maxLon} ${minLat}, ${maxLon} ${maxLat}, ${minLon} ${maxLat}, ${minLon} ${minLat}))`;

  try {
    const mukeyRows = await queryUsdaSda<string>(
      `SELECT mukey FROM SDA_Get_Mukey_from_intersection_with_WktWgs84('${wkt}')`,
      { fetchFn: options?.sdaFetchFn, timeoutMs: options?.sdaTimeoutMs }
    );
    const dataMukeyRows = mukeyRows.filter(r => Array.isArray(r) && r.length > 0 && String(r[0]).trim().toLowerCase() !== "mukey");
    if (dataMukeyRows.length === 0) return null;

    const mukeys = dataMukeyRows.map(r => parseSdaString(r[0])).filter((m): m is string => m !== null && /^[A-Za-z0-9_-]+$/.test(m));
    if (mukeys.length === 0) return null;

    for (const mukey of mukeys) {
      const muRows = await queryUsdaSda<string>(`SELECT muname FROM mapunit WHERE mukey = '${mukey}'`, { fetchFn: options?.sdaFetchFn, timeoutMs: options?.sdaTimeoutMs });
      const mapUnitName = muRows.length > 1 ? parseSdaString(muRows[1][0]) : null;

      const rows = await queryUsdaSda<string | null>(
        `SELECT co.cokey, co.comppct_r, co.compname, co.drainagecl, co.slope_r, co.compkind, co.majcompflag,
          hz.hzdept_r, hz.hzdepb_r, hz.sandtotal_r, hz.silttotal_r, hz.claytotal_r, hz.om_r, hz.ph1to1h2o_r, hz.awc_r
         FROM component co
         LEFT JOIN chorizon hz ON co.cokey = hz.cokey AND hz.hzdept_r < 30
         WHERE co.mukey = '${mukey}'
         ORDER BY co.comppct_r DESC, co.cokey, hz.hzdept_r`,
        { fetchFn: options?.sdaFetchFn, timeoutMs: options?.sdaTimeoutMs }
      );

      const compMap = new Map<string, SoilComponentInput>();
      for (const row of rows) {
        if (!Array.isArray(row)) continue;
        const cokey = parseSdaString(row[0]);
        if (!cokey || cokey.toLowerCase() === "cokey") continue;
        if (!compMap.has(cokey)) {
          compMap.set(cokey, { cokey, name: parseSdaString(row[2]) ?? "Unknown", percent: parseSdaNumber(row[1]) ?? 0, kind: parseSdaString(row[5]) ?? "Unknown", majcompflag: parseSdaString(row[6]), drainage: parseSdaString(row[3]), slope: parseSdaNumber(row[4]), horizons: [] });
        }
        const hzdept = parseSdaNumber(row[7]);
        const hzdepb = parseSdaNumber(row[8]);
        if (hzdept !== null && hzdepb !== null) {
          compMap.get(cokey)!.horizons.push({ depthTop: hzdept, depthBottom: hzdepb, sand: parseSdaNumber(row[9]), silt: parseSdaNumber(row[10]), clay: parseSdaNumber(row[11]), om: parseSdaNumber(row[12]), ph: parseSdaNumber(row[13]), awc: parseSdaNumber(row[14]) });
        }
      }

      const components = Array.from(compMap.values());
      if (components.length === 0) continue;
      const { aggregated, dataCoverage } = aggregateComponents(components);
      if (hasUsableSsurgoProperties(aggregated) && aggregated.depth0_30cm.sand !== null) {
        const totalComponentPercent = components.reduce((s, c) => s + c.percent, 0);
        const limitations: string[] = [`Components account for ${totalComponentPercent}% of the map unit.`];
        const ssurgoPropertySources: Record<string, string> = {};
        if (aggregated.depth0_30cm.sand !== null) ssurgoPropertySources.sand = "USDA NRCS SSURGO (depth-weighted 0-30 cm)";
        if (aggregated.depth0_30cm.om !== null) ssurgoPropertySources.om = "USDA NRCS SSURGO (depth-weighted 0-30 cm)";

        const response: SoilApiResponsePayload = {
          location: { lat, lon },
          dataTier: "usda_ssurgo",
          source: "USDA NRCS Soil Survey Geographic Database (SSURGO). https://sdmdataaccess.sc.egov.usda.gov",
          coverage: "United States (USDA SSURGO primary survey).",
          mapUnit: { mukey, name: mapUnitName ?? "Unknown map unit" },
          totalComponentPercent, components, aggregated, propertySources: ssurgoPropertySources, dataCoverage, limitations
        };
        return response;
      }
    }
  } catch (e) { }
  return null;
}

/**
 * Resolve the authoritative soil profile for any coordinate (`(lat, lon)`):
 *
 * - **U.S. coordinates (`isUnitedStatesCoordinate(lat, lon) === true`):**
 *   1. Attempts live USDA NRCS SSURGO first.
 *   2. If SSURGO succeeds, returns the `usda_ssurgo` profile.
 *   3. Distinguishes a USDA service/request failure (`request_error`) from a genuine
 *      absence of a surveyed map unit (`no_map_unit`) or unusable map unit (`no_usable_soil_data`).
 *   4. If SSURGO is unavailable, attempts the live ISRIC SoilGrids v2.0 OGC WCS provider
 *      as a coordinate-specific modeled fallback, clearly labeled as `soilgrids_wcs_250m`
 *      (`ISRIC SoilGrids v2.0`) with explicit `usSsurgoFallback` provenance and limitations.
 *   5. **Never** silently falls back to the generic `HWSD_SOILGRIDS_REFERENCE_UNITS` /
 *      `Global Reference Cambisols & Luvisols` macroregional profile for a U.S. field.
 *   6. If neither live provider returns usable data for a U.S. coordinate, returns an
 *      honest unavailable/error result (`ok: false`, HTTP 503/404).
 *
 * - **International coordinates (`isUnitedStatesCoordinate(lat, lon) === false`):**
 *   1. Attempts live ISRIC SoilGrids v2.0 OGC WCS first (`soilgrids_wcs_250m`).
 *   2. If WCS is unavailable or masked > 250 m, falls back to the macro-regional
 *      `regional_reference_fallback` profile (`resolveGlobalSoilFallback`).
 */
export type SoilGridsWcsFetcherFn = typeof fetchSoilGridsWcsProfile;

export async function resolveSoilProfileForCoordinate(
  latInput: number,
  lonInput: number,
  options?: {
    sdaFetchFn?: typeof fetch;
    wcsFetchFn?: typeof fetch;
    soilGridsWcsFetcher?: SoilGridsWcsFetcherFn;
    bypassCache?: boolean;
    sdaTimeoutMs?: number;
  }
): Promise<ResolvedSoilRouteResult> {
  const norm = normalizeCoordinates(latInput, lonInput);
  const lat = norm.valid ? norm.lat : latInput;
  const lon = norm.valid ? norm.lon : lonInput;
  const locationMeta = {
    lat,
    lon,
    ...(norm.valid && norm.lonWasNormalized
      ? { lonWasNormalized: true, originalLon: norm.originalLon }
      : {}),
  };

  const isInsideUS = isUnitedStatesCoordinate(lat, lon);

  if (isInsideUS) {
    const ssurgoResult = await fetchUsdaSsurgoProfile(lat, lon, {
      fetchFn: options?.sdaFetchFn,
      timeoutMs: options?.sdaTimeoutMs,
    });

    const lacksTexture = ssurgoResult.status === "ok" && ssurgoResult.response.aggregated.depth0_30cm.sand === null;

    if (ssurgoResult.status === "no_map_unit" || ssurgoResult.status === "no_usable_soil_data" || lacksTexture) {
      const nearbyProfile = await fetchNearbySsurgoMapUnit(lat, lon, { sdaFetchFn: options?.sdaFetchFn, sdaTimeoutMs: options?.sdaTimeoutMs });
      if (nearbyProfile) {
        nearbyProfile.limitations = [
          `Estimated from available mapped soil data located approximately within 150 meters. The exact requested coordinate lacked mapped soil properties (${ssurgoResult.status === "ok" ? "No component horizon data" : ssurgoResult.message}).`,
          ...nearbyProfile.limitations
        ];
        return {
          ok: true,
          httpStatus: 200,
          response: nearbyProfile,
          cachePolicy: "ssurgo_primary",
          usSsurgoStatus: "ok"
        };
      }
    }

    if (ssurgoResult.status === "ok") {
      return {
        ok: true,
        httpStatus: 200,
        response: ssurgoResult.response,
        cachePolicy: "ssurgo_primary",
        usSsurgoStatus: "ok",
      };
    }

    // SSURGO was unavailable (`request_error`, `no_map_unit`, or `no_usable_soil_data`).
    // Attempt live coordinate-specific ISRIC SoilGrids v2.0 WCS (~250 m) fallback.
    const sgProfile = options?.soilGridsWcsFetcher
      ? await options.soilGridsWcsFetcher(lat, lon, {
          fetchFn: options?.wcsFetchFn,
          bypassCache: options?.bypassCache,
        })
      : null;

    if (sgProfile) {
      const fallbackExplanation =
        ssurgoResult.status === "request_error"
          ? `Live USDA NRCS SSURGO service was unreachable or returned an error (${ssurgoResult.errorMessage}). Displaying coordinate-specific ISRIC SoilGrids v2.0 (~250 m OGC WCS) modeled 0-30 cm topsoil estimate instead; terrain slope and categorical drainage class are omitted because SoilGrids does not publish them.`
          : ssurgoResult.status === "no_map_unit"
          ? "USDA NRCS SSURGO returned no surveyed soil map unit polygon at this coordinate. Displaying coordinate-specific ISRIC SoilGrids v2.0 (~250 m OGC WCS) modeled 0-30 cm topsoil estimate instead; terrain slope and categorical drainage class are omitted because SoilGrids does not publish them."
          : `${ssurgoResult.message} Displaying coordinate-specific ISRIC SoilGrids v2.0 (~250 m OGC WCS) modeled 0-30 cm topsoil estimate instead; terrain slope and categorical drainage class are omitted because SoilGrids does not publish them.`;

      const response: SoilApiResponsePayload = {
        location: locationMeta,
        dataTier: "soilgrids_wcs_250m",
        source: sgProfile.source,
        coverage:
          ssurgoResult.status === "request_error"
            ? "United States coordinate — live ISRIC SoilGrids v2.0 (~250 m OGC WCS) modeled 0-30 cm topsoil estimate (used while USDA NRCS SSURGO service was unreachable)."
            : "United States coordinate — live ISRIC SoilGrids v2.0 (~250 m OGC WCS) modeled 0-30 cm topsoil estimate (used where USDA NRCS SSURGO lacked field-level data).",
        wrbSoilGroup: sgProfile.wrbSoilGroup,
        mapUnit: sgProfile.mapUnit,
        totalComponentPercent: sgProfile.totalComponentPercent,
        components: sgProfile.components,
        aggregated: sgProfile.aggregated,
        uncertainty: undefined,
        layerUncertainty: sgProfile.layerUncertainty,
        pixelResolution: sgProfile.pixelResolution,
        propertySources: sgProfile.propertySources,
        dataCoverage: sgProfile.dataCoverage,
        limitations: [fallbackExplanation, ...sgProfile.limitations],
        ...(sgProfile.enrichmentStatus
          ? { enrichmentStatus: sgProfile.enrichmentStatus }
          : {}),
        usSsurgoFallback: {
          reason: ssurgoResult.status,
          detail: ssurgoResult.message,
        },
      };

      return {
        ok: true,
        httpStatus: 200,
        response,
        cachePolicy:
          ssurgoResult.status === "request_error"
            ? "us_outage_soilgrids_fallback"
            : "us_unmapped_soilgrids_fallback",
        usSsurgoStatus: ssurgoResult.status,
      };
    }

    // Neither live USDA SSURGO nor live ISRIC SoilGrids WCS returned usable data.
    // Never fall back to the generic macro-regional Cambisols/Luvisols reference profile for a U.S. coordinate.
    const httpStatus = ssurgoResult.status === "request_error" ? 503 : 404;
    const error =
      ssurgoResult.status === "request_error"
        ? "Live USDA NRCS SSURGO soil service is temporarily unavailable, and the live ISRIC SoilGrids v2.0 WCS fallback could not retrieve coordinate-specific data for this U.S. location. Please retry shortly."
        : "No coordinate-specific soil profile data available at this U.S. location from either USDA NRCS SSURGO or live ISRIC SoilGrids v2.0 WCS.";

    return {
      ok: false,
      httpStatus,
      error,
      detail: ssurgoResult.message,
      usSsurgoStatus: ssurgoResult.status,
    };
  }

  // International (non-U.S.) coordinate path
  const geo = resolveGeographicContext(lat, lon);
  const sgProfile = options?.soilGridsWcsFetcher
    ? await options.soilGridsWcsFetcher(lat, lon, {
        fetchFn: options?.wcsFetchFn,
        bypassCache: options?.bypassCache,
      })
    : null;

  if (sgProfile) {
    const response: SoilApiResponsePayload = {
      location: locationMeta,
      dataTier: "soilgrids_wcs_250m",
      source: sgProfile.source,
      coverage: sgProfile.coverage,
      wrbSoilGroup: sgProfile.wrbSoilGroup,
      mapUnit: sgProfile.mapUnit,
      totalComponentPercent: sgProfile.totalComponentPercent,
      components: sgProfile.components,
      aggregated: sgProfile.aggregated,
      uncertainty: undefined,
      layerUncertainty: sgProfile.layerUncertainty,
      pixelResolution: sgProfile.pixelResolution,
      propertySources: sgProfile.propertySources,
      dataCoverage: sgProfile.dataCoverage,
      limitations: sgProfile.limitations,
      ...(sgProfile.enrichmentStatus
        ? { enrichmentStatus: sgProfile.enrichmentStatus }
        : {}),
    };

    return {
      ok: true,
      httpStatus: 200,
      response,
      cachePolicy: "soilgrids_primary",
    };
  }

  const fb = resolveGlobalSoilFallback(lat, lon);
  const reasonNote = `Location (${geo.countryName} — ${geo.admin1Name}) is outside USDA SSURGO (US-only) survey coverage and live ISRIC SoilGrids v2.0 WCS extraction was unavailable or masked at this coordinate (no valid 250 m soil pixel within ≤ 250 m). Displaying a macro-regional 0–30 cm topsoil reference estimate compiled from published FAO HWSD v2.2 & ISRIC SoilGrids v2.0 regional summaries (not a coordinate-specific spatial extraction).`;

  const response: SoilApiResponsePayload = {
    location: locationMeta,
    dataTier: "regional_reference_fallback",
    source: fb.source,
    coverage: fb.coverage,
    wrbSoilGroup: fb.wrbSoilGroup,
    mapUnit: fb.mapUnit,
    totalComponentPercent: fb.totalComponentPercent,
    components: [],
    aggregated: fb.aggregated,
    uncertainty: fb.uncertainty,
    propertySources: fb.propertySources,
    dataCoverage: fb.dataCoverage,
    limitations: [reasonNote, ...fb.limitations],
  };

  return {
    ok: true,
    httpStatus: 200,
    response,
    cachePolicy: "international_regional_fallback",
  };
}

// ─── Server & Browser Soil Profile Cache Policy & Automatic SSURGO Recovery ───

/**
 * Server-side route cache TTL (`24 hours`) for authoritative primary provider responses:
 * - U.S. USDA NRCS SSURGO (`ssurgo_primary`)
 * - Complete international ISRIC SoilGrids v2.0 WCS (`soilgrids_primary`, `enrichmentStatus !== "partial_optional"`)
 */
export const SOIL_PRIMARY_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * Server-side route cache TTL (`5 minutes`) for fallback responses:
 * - U.S. SoilGrids fallback during a transient USDA SSURGO outage (`us_outage_soilgrids_fallback`)
 * - U.S. SoilGrids fallback when SSURGO returned no map unit or no usable data (`us_unmapped_soilgrids_fallback`)
 * - International macro-regional reference fallback (`international_regional_fallback`)
 */
export const SOIL_FALLBACK_CACHE_TTL_MS = 5 * 60 * 1000;

/**
 * Server-side route cache TTL (`1 minute`) when SoilGrids optional enrichment (`mean` texture,
 * `wv0033`/`wv1500` AWC, `wrb`, `bdod`, `cfvo`, or `Q0.05`/`Q0.95` uncertainty) is only partially
 * complete (`enrichmentStatus === "partial_optional"`), so missing optional layers can be
 * completed on a subsequent request while reusing the 24-hour per-coverage `coverageCache`.
 */
export const SOIL_PARTIAL_ENRICHMENT_CACHE_TTL_MS = 60 * 1000;

/**
 * Browser in-memory environmental cache (`envMemoryCache`) TTL (`15 minutes`) for authoritative
 * primary soil responses (`usda_ssurgo` and complete international `soilgrids_wcs_250m`).
 */
export const ENV_PRIMARY_CACHE_TTL_MS = 15 * 60 * 1000;

/**
 * Browser in-memory environmental cache (`envMemoryCache`) TTL (`5 minutes`, matching
 * `SOIL_FALLBACK_CACHE_TTL_MS`) for U.S. SoilGrids fallbacks and international regional fallbacks,
 * ensuring browser cache entries expire so subsequent requests automatically re-attempt USDA SSURGO.
 */
export const ENV_FALLBACK_CACHE_TTL_MS = SOIL_FALLBACK_CACHE_TTL_MS;

/**
 * Browser in-memory environmental cache (`envMemoryCache`) TTL (`1 minute`) for partially enriched
 * SoilGrids responses (`enrichmentStatus === "partial_optional"`).
 */
export const ENV_PARTIAL_ENRICHMENT_CACHE_TTL_MS =
  SOIL_PARTIAL_ENRICHMENT_CACHE_TTL_MS;

export function buildSoilCacheKey(lat: number, lon: number): string {
  return `v3_${lat.toFixed(4)}_${lon.toFixed(4)}`;
}

/**
 * Determine the server-side `/api/soil` route cache TTL (in milliseconds) for a resolved soil profile.
 */
export function resolveSoilRouteCacheTtlMs(
  cachePolicy: SoilCachePolicy,
  enrichmentStatus?: "complete" | "partial_optional"
): number {
  if (enrichmentStatus === "partial_optional") {
    return SOIL_PARTIAL_ENRICHMENT_CACHE_TTL_MS;
  }
  if (
    cachePolicy === "ssurgo_primary" ||
    cachePolicy === "soilgrids_primary"
  ) {
    return SOIL_PRIMARY_CACHE_TTL_MS;
  }
  return SOIL_FALLBACK_CACHE_TTL_MS;
}

/**
 * Determine the browser-side `envMemoryCache` TTL (in milliseconds) for a soil API response.
 *
 * - Partially enriched SoilGrids responses (`enrichmentStatus === "partial_optional"`): `1 minute`
 * - U.S. SoilGrids fallback responses (`usSsurgoFallback !== undefined`) or international
 *   macro-regional reference fallbacks (`dataTier === "regional_reference_fallback"`): `5 minutes`
 * - Authoritative `usda_ssurgo` or complete international `soilgrids_wcs_250m` primary profiles: `15 minutes`
 */
export function resolveBrowserSoilCacheTtlMs(response: {
  dataTier?: SoilDataTier;
  source?: string;
  enrichmentStatus?: "complete" | "partial_optional";
  usSsurgoFallback?: UsSsurgoFallbackMeta;
}): number {
  if (response.enrichmentStatus === "partial_optional") {
    return ENV_PARTIAL_ENRICHMENT_CACHE_TTL_MS;
  }
  if (
    response.usSsurgoFallback !== undefined ||
    resolveSoilDataTier(response) === "regional_reference_fallback"
  ) {
    return ENV_FALLBACK_CACHE_TTL_MS;
  }
  return ENV_PRIMARY_CACHE_TTL_MS;
}

export interface CachedSoilRouteEntry {
  response: SoilApiResponsePayload;
  cachePolicy: SoilCachePolicy;
  cachedAt: number;
  ttlMs: number;
  expiresAt: number;
}

const soilRouteCache = new LRUCache<string, CachedSoilRouteEntry>({
  max: 500,
  ttl: SOIL_PRIMARY_CACHE_TTL_MS,
});

export function clearSoilRouteCacheForTests(): void {
  soilRouteCache.clear();
}

export function getSoilRouteCacheEntryForTests(
  latInput: number,
  lonInput: number
): CachedSoilRouteEntry | undefined {
  const norm = normalizeCoordinates(latInput, lonInput);
  const lat = norm.valid ? norm.lat : latInput;
  const lon = norm.valid ? norm.lon : lonInput;
  return soilRouteCache.get(buildSoilCacheKey(lat, lon));
}

export type CachedSoilRouteResult =
  | {
      ok: true;
      httpStatus: 200;
      response: SoilApiResponsePayload;
      cachePolicy: SoilCachePolicy;
      fromCache: boolean;
      ttlMs: number;
      cacheControl: string;
      usSsurgoStatus?: UsdaSsurgoFetchResult["status"];
    }
  | {
      ok: false;
      httpStatus: 503 | 404;
      error: string;
      detail: string;
      usSsurgoStatus: Exclude<UsdaSsurgoFetchResult["status"], "ok">;
      cacheControl: "no-store";
    };

/**
 * Server-side soil profile resolver with TTL-aware route caching and automatic USDA SSURGO recovery:
 *
 * - Reuses fresh cached responses without re-querying USDA SSURGO or ISRIC SoilGrids WCS.
 * - Expires U.S. SoilGrids outage fallbacks after `SOIL_FALLBACK_CACHE_TTL_MS` (5 minutes)
 *   and partially enriched SoilGrids profiles after `SOIL_PARTIAL_ENRICHMENT_CACHE_TTL_MS` (1 minute).
 * - Once a fallback entry expires (or when `forceRefresh: true`), the next request for a U.S.
 *   coordinate attempts live USDA NRCS SSURGO first and immediately replaces the fallback cache
 *   entry with the authoritative `usda_ssurgo` profile (`SOIL_PRIMARY_CACHE_TTL_MS` = 24 hours)
 *   when USDA succeeds.
 */
export async function resolveCachedSoilProfileForCoordinate(
  latInput: number,
  lonInput: number,
  options?: {
    forceRefresh?: boolean;
    sdaFetchFn?: typeof fetch;
    wcsFetchFn?: typeof fetch;
    soilGridsWcsFetcher?: SoilGridsWcsFetcherFn;
    sdaTimeoutMs?: number;
    nowFn?: () => number;
  }
): Promise<CachedSoilRouteResult> {
  const norm = normalizeCoordinates(latInput, lonInput);
  const lat = norm.valid ? norm.lat : latInput;
  const lon = norm.valid ? norm.lon : lonInput;
  const locationMeta = {
    lat,
    lon,
    ...(norm.valid && norm.lonWasNormalized
      ? { lonWasNormalized: true, originalLon: norm.originalLon }
      : {}),
  };

  const nowFn = options?.nowFn ?? Date.now;
  const forceRefresh = Boolean(options?.forceRefresh);
  const cacheKey = buildSoilCacheKey(lat, lon);

  if (!forceRefresh) {
    const cached = soilRouteCache.get(cacheKey);
    if (cached) {
      const now = nowFn();
      if (
        now < cached.expiresAt &&
        isUsableCachedSoilResponse(lat, lon, cached.response)
      ) {
        return {
          ok: true,
          httpStatus: 200,
          response: {
            ...cached.response,
            location: locationMeta,
            cached: true,
          },
          cachePolicy: cached.cachePolicy,
          fromCache: true,
          ttlMs: cached.ttlMs,
          cacheControl: "no-store",
        };
      }
      // Evict expired or disallowed fallback entry so the next resolution queries the primary provider
      soilRouteCache.delete(cacheKey);
    }
  } else {
    soilRouteCache.delete(cacheKey);
  }

  const result = await resolveSoilProfileForCoordinate(lat, lon, {
    sdaFetchFn: options?.sdaFetchFn,
    wcsFetchFn: options?.wcsFetchFn,
    soilGridsWcsFetcher: options?.soilGridsWcsFetcher,
    bypassCache: forceRefresh,
    sdaTimeoutMs: options?.sdaTimeoutMs,
  });

  if (!result.ok) {
    return {
      ...result,
      cacheControl: "no-store",
    };
  }

  const response: SoilApiResponsePayload = {
    ...result.response,
    location: locationMeta,
  };

  const ttlMs = resolveSoilRouteCacheTtlMs(
    result.cachePolicy,
    response.enrichmentStatus
  );
  const cachedAt = nowFn();

  soilRouteCache.set(
    cacheKey,
    {
      response,
      cachePolicy: result.cachePolicy,
      cachedAt,
      ttlMs,
      expiresAt: cachedAt + ttlMs,
    },
    { ttl: ttlMs }
  );

  const isPrimaryComplete =
    (result.cachePolicy === "ssurgo_primary" ||
      result.cachePolicy === "soilgrids_primary") &&
    response.enrichmentStatus !== "partial_optional";

  return {
    ok: true,
    httpStatus: 200,
    response,
    cachePolicy: result.cachePolicy,
    fromCache: false,
    ttlMs,
    cacheControl: isPrimaryComplete
      ? "private, max-age=300, stale-while-revalidate=3600"
      : "no-store",
    ...(result.usSsurgoStatus ? { usSsurgoStatus: result.usSsurgoStatus } : {}),
  };
}
