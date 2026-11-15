/**
 * Simple region detector for the United States.
 * Uses lat/lon bounding boxes to assign a coarse region tag.
 * This is intentionally conservative: only well-known regions are returned;
 * everything else is "unsupported" so the UI can show an honest fallback.
 */

export const REGIONS = [
  { tag: "us_southeast", label: "US Southeast", box: { latMin: 24, latMax: 39.5, lonMin: -92, lonMax: -75 } },
  { tag: "us_midwest", label: "US Midwest", box: { latMin: 36, latMax: 49, lonMin: -97, lonMax: -82 } },
  { tag: "us_northeast", label: "US Northeast", box: { latMin: 37, latMax: 47.5, lonMin: -80, lonMax: -66 } },
  { tag: "us_great_plains", label: "US Great Plains", box: { latMin: 32, latMax: 49, lonMin: -105, lonMax: -95 } },
  { tag: "us_southwest", label: "US Southwest", box: { latMin: 31, latMax: 42, lonMin: -120, lonMax: -103 } },
] as const;

export type RegionTag = (typeof REGIONS)[number]["tag"];
export type RegionLabel = (typeof REGIONS)[number]["label"];

export interface DetectedRegion {
  tag: RegionTag;
  label: RegionLabel;
}

export function detectRegion(lat: number, lon: number): DetectedRegion | null {
  for (const r of REGIONS) {
    if (
      lat >= r.box.latMin &&
      lat <= r.box.latMax &&
      lon >= r.box.lonMin &&
      lon <= r.box.lonMax
    ) {
      return { tag: r.tag, label: r.label };
    }
  }
  return null;
}

export function isSupportedRegion(lat: number, lon: number): boolean {
  return detectRegion(lat, lon) !== null;
}

export function regionLabelFor(tag: RegionTag | string): string {
  const found = REGIONS.find((r) => r.tag === tag);
  return found?.label ?? tag;
}
