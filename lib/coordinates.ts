/**
 * Canonical geographic coordinate validation and longitude normalization utilities.
 *
 * World maps (such as Leaflet) allow horizontal panning across repeated copies of the
 * globe, producing wrapped longitudes outside [-180, 180] (for example, -250° when
 * panning west across the Pacific to 110°E in China, or 190° for -170°W).
 *
 * This module normalizes any finite longitude into the canonical interval [-180, 180)
 * using the mathematical formula:
 *   ((longitude + 180) % 360 + 360) % 360 - 180
 * while strictly validating latitude in [-90, 90] without wrapping.
 */

export interface NormalizedCoordinatesResult {
  valid: true;
  ok: true;
  lat: number;
  lon: number;
  /** True when the input longitude was outside [-180, 180) and was wrapped to its canonical value */
  lonWasNormalized: boolean;
  originalLon: number;
}

export interface InvalidCoordinatesResult {
  valid: false;
  ok: false;
  error: string;
  field: "lat" | "lon";
}

export type CoordinateNormalizationOutcome =
  | NormalizedCoordinatesResult
  | InvalidCoordinatesResult;

function toFiniteNumber(value: unknown): number | null {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : null;
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed.length === 0) return null;
    // Reject strings with trailing non-numeric characters that parseFloat would silently ignore
    if (!/^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/.test(trimmed)) {
      return null;
    }
    const parsed = Number(trimmed);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

/**
 * Normalize any finite longitude into the canonical interval [-180, 180).
 *
 * Examples:
 *   -250 -> 110
 *    250 -> -110
 *    190 -> -170
 *   -190 -> 170
 *    180 -> -180
 *    540 -> -180
 *   -540 -> -180
 *      0 -> 0
 *
 * Throws a RangeError if `longitude` is not a finite number.
 */
export function normalizeLongitude(longitude: unknown): number {
  const num = toFiniteNumber(longitude);
  if (num === null) {
    throw new RangeError("Longitude must be a finite number.");
  }
  const normalized = ((((num + 180) % 360) + 360) % 360) - 180;
  // Avoid -0
  const clean = Object.is(normalized, -0) ? 0 : normalized;
  // Round floating-point inaccuracy (e.g. -250.123456 -> 109.876544) to 8 decimal places (~1.1 mm precision)
  return Number(clean.toFixed(8));
}

/**
 * Validate latitude in the closed interval [-90, 90].
 * Never wraps latitude. Throws a RangeError if invalid.
 */
export function validateLatitude(latitude: unknown): number {
  const num = toFiniteNumber(latitude);
  if (num === null) {
    throw new RangeError("Latitude must be a valid finite number.");
  }
  if (num < -90 || num > 90) {
    throw new RangeError("Latitude must be between -90 and 90.");
  }
  const clean = Object.is(num, -0) ? 0 : num;
  return Number(clean.toFixed(8));
}

/**
 * Validate latitude in [-90, 90] and normalize any finite longitude into [-180, 180).
 * Idempotent: normalizing already-canonical coordinates returns the exact same values
 * with `lonWasNormalized: false`.
 */
export function normalizeCoordinates(
  latInput: unknown,
  lonInput: unknown
): CoordinateNormalizationOutcome {
  const rawLat = toFiniteNumber(latInput);
  if (rawLat === null) {
    return {
      valid: false,
      ok: false,
      field: "lat",
      error: "Latitude must be a valid number.",
    };
  }
  if (rawLat < -90 || rawLat > 90) {
    return {
      valid: false,
      ok: false,
      field: "lat",
      error: "Latitude must be between -90 and 90.",
    };
  }

  const rawLon = toFiniteNumber(lonInput);
  if (rawLon === null) {
    return {
      valid: false,
      ok: false,
      field: "lon",
      error: "Longitude must be a valid number.",
    };
  }

  const lat = validateLatitude(rawLat);
  const lon = normalizeLongitude(rawLon);
  const lonWasNormalized = Math.abs(lon - rawLon) > 1e-9;

  return {
    valid: true,
    ok: true,
    lat,
    lon,
    lonWasNormalized,
    originalLon: rawLon,
  };
}
