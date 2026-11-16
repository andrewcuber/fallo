/**
 * Live International ISRIC SoilGrids v2.0 OGC Web Coverage Service (WCS) Adapter.
 *
 * Official service: https://maps.isric.org/
 * Documentation:    https://docs.isric.org/globaldata/soilgrids/wcs.html
 * License:          CC BY 4.0 (ISRIC — World Soil Information; Poggio et al., 2021)
 *
 * Scientific & Architectural Safeguards:
 * 1. Uses the operational OGC WCS service (`https://maps.isric.org/mapserv?map=/map/<prop>.map`),
 *    never the paused SoilGrids REST API.
 * 2. Retrieves 0–5 cm, 5–15 cm, and 15–30 cm depth layers and computes thickness-weighted
 *    0–30 cm topsoil properties using source-documented unit conversions.
 * 3. Preserves actual SoilGrids 90% prediction intervals (Q0.05, Q0.50, Q0.95) labeled strictly
 *    for the specific depth layer retrieved (0–5 cm), never misrepresenting a single-layer
 *    interval as the uncertainty of the aggregated 0–30 cm composite profile.
 * 4. Never fabricates missing attributes: categorical drainage class and terrain slope % are
 *    not published by SoilGrids v2.0 and remain `null`. Available Water Capacity (AWC) is
 *    computed only when valid 33 kPa (`wv0033`) and 1500 kPa (`wv1500`) water-retention
 *    predictions exist. Organic Matter (`om`) is explicitly labeled as a derived estimate from
 *    Soil Organic Carbon (`soc` × 1.724) while retaining `organicCarbonPct`.
 * 5. Handles NoData values (including `-32768` and masked pixels) accurately. When the exact
 *    requested coordinate lands on a masked pixel (e.g., road, building, or small water body),
 *    selects the nearest unmasked pixel only if its center is within ≤ 250 m (`MAX_NEIGHBOR_DISTANCE_METERS`),
 *    extracts all properties and depth layers strictly from that single geographic pixel,
 *    and discloses the exact Haversine distance in meters.
 */

import zlib from "node:zlib";
import { LRUCache } from "lru-cache";
import { unstable_cache } from "next/cache";
import { normalizeCoordinates } from "@/lib/coordinates";
import type { SoilPropertyUncertainty } from "@/lib/global-data-providers";

export const SOILGRIDS_WCS_BASE_URL = "https://maps.isric.org/mapserv";

/**
 * Official 30 World Reference Base (WRB) Reference Soil Groups in ISRIC SoilGrids v2.0
 * `wrb.map` (`MostProbable` coverage integer codes 0..29, `NoData = 255`).
 *
 * Authoritative sources:
 * - ISRIC SoilGrids v2.0 `MostProbable.vrt` GDAL Raster Attribute Table (`<GDALRasterAttributeTable>`):
 *   https://files.isric.org/soilgrids/latest/data/wrb/MostProbable.vrt
 * - ISRIC SoilGrids v2.0 FAQ ("What happened to the map of soil types?" — notes that Anthrosols,
 *   Technosols, and Retisols are not included in the 30 aggregated RSG predictions):
 *   https://docs.isric.org/globaldata/soilgrids/SoilGrids_faqs_03.html#sec-faq16
 * - ISRIC GeoNetwork ISO 19115 metadata record (DOI: 10.17027/isric-soilgrids.c4dc161c-d62d-11ea-a1a3-292680b15169):
 *   https://data.isric.org/geonetwork/srv/resources/records/c4dc161c-d62d-11ea-a1a3-292680b15169/formatters/xml
 */
export const WRB_SOIL_GROUPS: readonly string[] = [
  "Acrisols",
  "Albeluvisols",
  "Alisols",
  "Andosols",
  "Arenosols",
  "Calcisols",
  "Cambisols",
  "Chernozems",
  "Cryosols",
  "Durisols",
  "Ferralsols",
  "Fluvisols",
  "Gleysols",
  "Gypsisols",
  "Histosols",
  "Kastanozems",
  "Leptosols",
  "Lixisols",
  "Luvisols",
  "Nitisols",
  "Phaeozems",
  "Planosols",
  "Plinthosols",
  "Podzols",
  "Regosols",
  "Solonchaks",
  "Solonetz",
  "Stagnosols",
  "Umbrisols",
  "Vertisols",
] as const;

export type SoilGridsDepthId = "0-5cm" | "5-15cm" | "15-30cm";

export interface SoilGridsDepthLayerSpec {
  id: SoilGridsDepthId;
  label: string;
  depthTop: number;
  depthBottom: number;
  thicknessCm: number;
}

export const SOILGRIDS_DEPTH_LAYERS: readonly SoilGridsDepthLayerSpec[] = [
  { id: "0-5cm", label: "0–5 cm", depthTop: 0, depthBottom: 5, thicknessCm: 5 },
  { id: "5-15cm", label: "5–15 cm", depthTop: 5, depthBottom: 15, thicknessCm: 10 },
  { id: "15-30cm", label: "15–30 cm", depthTop: 15, depthBottom: 30, thicknessCm: 15 },
] as const;

export type SoilGridsPropertyId =
  | "sand"
  | "silt"
  | "clay"
  | "soc"
  | "phh2o"
  | "bdod"
  | "cfvo"
  | "wv0033"
  | "wv1500";

export interface SoilGridsPropertySpec {
  id: SoilGridsPropertyId;
  mapFile: string;
  description: string;
  mappedUnit: string;
  targetUnit: string;
  /** Divisor to convert SoilGrids integer mapped units to conventional target units */
  divisor: number;
  minValidRaw: number;
  maxValidRaw: number;
  /**
   * Whether `0` is a valid terrestrial value once a soil pixel is confirmed (`NoData = -32768`).
   * True for `sand`, `silt`, `clay`, `soc`, and `cfvo` (including `Q0.05` lower prediction bounds),
   * whereas `phh2o`, `bdod`, `wv0033`, and `wv1500` are strictly positive (`> 0`).
   */
  allowZeroWhenSoilValid?: boolean;
}

/**
 * Source-backed ISRIC SoilGrids v2.0 property specifications and unit conversions.
 * Reference: https://docs.isric.org/globaldata/soilgrids/SoilGrids_faqs_01.html
 */
export const SOILGRIDS_PROPERTIES: Record<SoilGridsPropertyId, SoilGridsPropertySpec> = {
  sand: {
    id: "sand",
    mapFile: "sand",
    description: "Proportion of sand particles (> 0.05 mm) in the fine earth fraction",
    mappedUnit: "g/kg",
    targetUnit: "%",
    divisor: 10,
    minValidRaw: 1,
    maxValidRaw: 1000,
    allowZeroWhenSoilValid: true,
  },
  silt: {
    id: "silt",
    mapFile: "silt",
    description: "Proportion of silt particles (0.002–0.05 mm) in the fine earth fraction",
    mappedUnit: "g/kg",
    targetUnit: "%",
    divisor: 10,
    minValidRaw: 1,
    maxValidRaw: 1000,
    allowZeroWhenSoilValid: true,
  },
  clay: {
    id: "clay",
    mapFile: "clay",
    description: "Proportion of clay particles (< 0.002 mm) in the fine earth fraction",
    mappedUnit: "g/kg",
    targetUnit: "%",
    divisor: 10,
    minValidRaw: 1,
    maxValidRaw: 1000,
    allowZeroWhenSoilValid: true,
  },
  soc: {
    id: "soc",
    mapFile: "soc",
    description: "Soil organic carbon content in the fine earth fraction",
    mappedUnit: "dg/kg",
    targetUnit: "%",
    divisor: 100, // 1 dg/kg = 0.1 g/kg = 0.01% weight
    minValidRaw: 1,
    maxValidRaw: 10000,
    allowZeroWhenSoilValid: true,
  },
  phh2o: {
    id: "phh2o",
    mapFile: "phh2o",
    description: "Soil pH in water suspension (1:1 / H2O)",
    mappedUnit: "pH × 10",
    targetUnit: "pH (H2O)",
    divisor: 10,
    minValidRaw: 20,
    maxValidRaw: 115,
  },
  bdod: {
    id: "bdod",
    mapFile: "bdod",
    description: "Bulk density of the fine earth fraction",
    mappedUnit: "cg/cm³",
    targetUnit: "g/cm³",
    divisor: 100,
    minValidRaw: 10,
    maxValidRaw: 265,
  },
  cfvo: {
    id: "cfvo",
    mapFile: "cfvo",
    description: "Volumetric fraction of coarse fragments (> 2 mm)",
    mappedUnit: "cm³/dm³",
    targetUnit: "%",
    divisor: 10,
    minValidRaw: 0,
    maxValidRaw: 1000,
    allowZeroWhenSoilValid: true,
  },
  wv0033: {
    id: "wv0033",
    mapFile: "wv0033",
    description: "Volumetric water content at 33 kPa (field capacity)",
    mappedUnit: "0.1 vol% (mm/m)",
    targetUnit: "cm/cm",
    divisor: 1000,
    minValidRaw: 10,
    maxValidRaw: 950,
  },
  wv1500: {
    id: "wv1500",
    mapFile: "wv1500",
    description: "Volumetric water content at 1500 kPa (permanent wilting point)",
    mappedUnit: "0.1 vol% (mm/m)",
    targetUnit: "cm/cm",
    divisor: 1000,
    minValidRaw: 5,
    maxValidRaw: 850,
  },
};

export const VAN_BEMMELEN_OM_FACTOR = 1.724;
export const SOILGRIDS_DEFAULT_NODATA = -32768;
export const MAX_NEIGHBOR_DISTANCE_METERS = 250;

const WCS_GRID_WIDTH = 5;
const WCS_GRID_HEIGHT = 5;
/**
 * 5 pixels × 0.00225° = 0.01125° total span (half-span = 0.005625° ≈ 625 m),
 * matching SoilGrids native ~250 m (0.00225°) resolution with pixel (2, 2) centered at (lat, lon).
 */
const WCS_HALF_SPAN_DEG = 0.005625;
const CANARY_TIMEOUT_MS = 5000;
const LAYER_TIMEOUT_MS = 5000;
const TOTAL_BUDGET_MS = 12000;
const MAX_CONCURRENCY = 4;
const CACHE_TTL_SECONDS = 24 * 60 * 60; // 24 hours

// ─── GeoTIFF Decoder Types & Implementation ──────────────────────────

export interface DecodedSoilGridsGeoTiff {
  width: number;
  height: number;
  bitsPerSample: number;
  sampleFormat: number;
  compression: number;
  predictor: number;
  noDataValue: number | null;
  pixelScale: [number, number] | null; // [scaleX, scaleY] in degrees
  tiepoint: [number, number, number, number] | null; // [i, j, originLon, originLat]
  /** 2D array [row][col] of decoded raw integer values */
  grid: number[][];
}

export interface SelectedPixelResult {
  row: number;
  col: number;
  rawValue: number;
  usedNeighborPixel: boolean;
  distanceMeters: number;
  pixelLat: number;
  pixelLon: number;
}

/**
 * Compute great-circle Haversine distance in meters between two WGS84 coordinates.
 */
export function haversineDistanceMeters(
  lat1: number,
  lon1: number,
  lat2: number,
  lon2: number
): number {
  const R = 6371000; // Earth mean radius in meters
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(Math.max(0, 1 - a)));
  return R * c;
}

/**
 * Decode an 8-bit (`GEOTIFF_BYTE`) or 16-bit (`GEOTIFF_INT16`) GeoTIFF buffer returned
 * by ISRIC SoilGrids MapServer WCS.
 *
 * Supports:
 * - Little-endian (`II`) and big-endian (`MM`) byte orders
 * - Tiled (`TileWidth` / `TileOffsets`) and strip-based (`StripOffsets`) layouts
 * - Uncompressed (`Compression = 1`) and Adobe Deflate (`Compression = 8` or `32946`)
 * - Horizontal differencing predictor (`Predictor = 2`) and no predictor (`Predictor = 1`)
 * - `GDAL_NODATA` tag (`42113`)
 * - GeoTIFF `ModelPixelScaleTag` (`33550`) and `ModelTiepointTag` (`33922`)
 */
export function decodeSoilGridsGeoTiff(buf: Buffer): DecodedSoilGridsGeoTiff {
  if (!Buffer.isBuffer(buf) || buf.length < 16) {
    throw new Error("Invalid GeoTIFF buffer: buffer is too short.");
  }

  const byteOrder = buf.toString("ascii", 0, 2);
  if (byteOrder !== "II" && byteOrder !== "MM") {
    throw new Error(`Invalid GeoTIFF header byte order: "${byteOrder}".`);
  }
  const isLE = byteOrder === "II";

  const rU16 = (off: number) => (isLE ? buf.readUInt16LE(off) : buf.readUInt16BE(off));
  const rU32 = (off: number) => (isLE ? buf.readUInt32LE(off) : buf.readUInt32BE(off));
  const rI16 = (off: number) => (isLE ? buf.readInt16LE(off) : buf.readInt16BE(off));
  const rF64 = (off: number) => (isLE ? buf.readDoubleLE(off) : buf.readDoubleBE(off));

  const magic = rU16(2);
  if (magic !== 42) {
    throw new Error(`Invalid TIFF magic number: expected 42, got ${magic}.`);
  }

  const ifdOffset = rU32(4);
  if (ifdOffset + 2 > buf.length) {
    throw new Error("Invalid TIFF IFD offset: exceeds buffer length.");
  }

  const numEntries = rU16(ifdOffset);
  if (ifdOffset + 2 + numEntries * 12 > buf.length) {
    throw new Error("Invalid TIFF IFD entry count: exceeds buffer length.");
  }

  const scalarTags = new Map<number, number>();
  let noDataStr: string | null = null;
  let pixelScale: [number, number] | null = null;
  let tiepoint: [number, number, number, number] | null = null;

  for (let i = 0; i < numEntries; i++) {
    const entryOff = ifdOffset + 2 + i * 12;
    const tag = rU16(entryOff);
    const type = rU16(entryOff + 2);
    const count = rU32(entryOff + 4);
    const valOrOff = rU32(entryOff + 8);

    if (type === 1 && count === 1) {
      // BYTE
      scalarTags.set(tag, buf.readUInt8(entryOff + 8));
    } else if (type === 3 && count === 1) {
      // SHORT
      scalarTags.set(tag, rU16(entryOff + 8));
    } else if (type === 4 && count === 1) {
      // LONG
      scalarTags.set(tag, valOrOff);
    } else if (type === 3 && count > 1) {
      // First SHORT of array
      const arrOff = count === 2 ? entryOff + 8 : valOrOff;
      if (arrOff + 2 <= buf.length) {
        scalarTags.set(tag, rU16(arrOff));
      }
    } else if (type === 4 && count > 1) {
      // First LONG of array
      if (valOrOff + 4 <= buf.length) {
        scalarTags.set(tag, rU32(valOrOff));
      }
    } else if (type === 2 && tag === 42113) {
      // GDAL_NODATA ASCII string
      const strOff = count <= 4 ? entryOff + 8 : valOrOff;
      if (strOff + count <= buf.length) {
        noDataStr = buf
          .toString("ascii", strOff, strOff + count)
          .replace(/\0+$/, "")
          .trim();
      }
    } else if (type === 12 && tag === 33550 && count >= 2) {
      // ModelPixelScaleTag (DOUBLE[3])
      if (valOrOff + 16 <= buf.length) {
        const sx = rF64(valOrOff);
        const sy = rF64(valOrOff + 8);
        if (Number.isFinite(sx) && Number.isFinite(sy) && sx > 0 && sy > 0) {
          pixelScale = [sx, sy];
        }
      }
    } else if (type === 12 && tag === 33922 && count >= 6) {
      // ModelTiepointTag (DOUBLE[6]: i, j, k, x, y, z)
      if (valOrOff + 48 <= buf.length) {
        const ti = rF64(valOrOff);
        const tj = rF64(valOrOff + 8);
        const tx = rF64(valOrOff + 24);
        const ty = rF64(valOrOff + 32);
        if (
          Number.isFinite(ti) &&
          Number.isFinite(tj) &&
          Number.isFinite(tx) &&
          Number.isFinite(ty)
        ) {
          tiepoint = [ti, tj, tx, ty];
        }
      }
    }
  }

  const width = scalarTags.get(256) ?? 0;
  const height = scalarTags.get(257) ?? 0;
  const bitsPerSample = scalarTags.get(258) ?? 16;
  const compression = scalarTags.get(259) ?? 1;
  const samplesPerPixel = scalarTags.get(277) ?? 1;
  const predictor = scalarTags.get(317) ?? 1;
  const sampleFormat = scalarTags.get(339) ?? (bitsPerSample === 8 ? 1 : 2);

  if (width <= 0 || height <= 0 || width > 1024 || height > 1024) {
    throw new Error(`Invalid GeoTIFF dimensions: ${width}×${height}.`);
  }
  if (bitsPerSample !== 8 && bitsPerSample !== 16) {
    throw new Error(`Unsupported BitsPerSample: ${bitsPerSample}.`);
  }
  if (samplesPerPixel !== 1) {
    throw new Error(`Unsupported SamplesPerPixel: expected 1, got ${samplesPerPixel}.`);
  }
  if (compression !== 1 && compression !== 8 && compression !== 32946) {
    throw new Error(`Unsupported TIFF compression code: ${compression}.`);
  }
  if (predictor !== 1 && predictor !== 2) {
    throw new Error(`Unsupported TIFF Predictor: ${predictor}.`);
  }
  if (sampleFormat !== 1 && sampleFormat !== 2) {
    throw new Error(`Unsupported TIFF SampleFormat: ${sampleFormat}.`);
  }

  const isTiled = scalarTags.has(324);
  const strideWidth = isTiled ? (scalarTags.get(322) ?? width) : width;
  const strideHeight = isTiled ? (scalarTags.get(323) ?? height) : (scalarTags.get(278) ?? height);
  if (isTiled && (width > strideWidth || height > strideHeight)) {
    throw new Error(
      `Unsupported multi-tile GeoTIFF layout: image ${width}×${height} exceeds single tile ${strideWidth}×${strideHeight}.`
    );
  }
  if (!isTiled && height > strideHeight) {
    throw new Error(
      `Unsupported multi-strip GeoTIFF layout: image height ${height} exceeds RowsPerStrip ${strideHeight}.`
    );
  }

  const dataOffset = scalarTags.get(324) ?? scalarTags.get(273);
  const dataByteCount = scalarTags.get(325) ?? scalarTags.get(279);

  if (
    dataOffset === undefined ||
    dataByteCount === undefined ||
    dataOffset + dataByteCount > buf.length
  ) {
    throw new Error("Invalid TIFF tile/strip offset or byte count.");
  }

  const compressedSlice = buf.subarray(dataOffset, dataOffset + dataByteCount);
  const rawBytes =
    compression === 8 || compression === 32946
      ? zlib.inflateSync(compressedSlice)
      : compressedSlice;

  const bytesPerSample = bitsPerSample / 8;
  const expectedMinBytes = ((height - 1) * strideWidth + width) * bytesPerSample;
  if (rawBytes.length < expectedMinBytes || strideHeight < height) {
    throw new Error(
      `Decompressed TIFF payload (${rawBytes.length} bytes) is smaller than expected (${expectedMinBytes} bytes).`
    );
  }

  const grid: number[][] = [];

  for (let y = 0; y < height; y++) {
    const row: number[] = [];
    let acc = 0;
    for (let x = 0; x < width; x++) {
      const sampleByteOffset = (y * strideWidth + x) * bytesPerSample;
      if (bitsPerSample === 16) {
        const rawSample = isLE
          ? rawBytes.readInt16LE(sampleByteOffset)
          : rawBytes.readInt16BE(sampleByteOffset);
        if (predictor === 2) {
          // 16-bit two's-complement horizontal differencing
          acc = ((acc + rawSample) << 16) >> 16;
        } else {
          acc = rawSample;
        }
        row.push(sampleFormat === 1 ? acc & 0xffff : acc);
      } else {
        const rawSample = rawBytes.readUInt8(sampleByteOffset);
        if (predictor === 2) {
          acc = (acc + rawSample) & 0xff;
        } else {
          acc = rawSample;
        }
        row.push(acc);
      }
    }
    grid.push(row);
  }

  let noDataValue: number | null = null;
  if (noDataStr !== null && noDataStr.length > 0) {
    const parsed = Number(noDataStr);
    if (Number.isFinite(parsed)) {
      noDataValue = parsed;
    }
  } else if (bitsPerSample === 16 && sampleFormat === 2) {
    noDataValue = SOILGRIDS_DEFAULT_NODATA;
  }

  return {
    width,
    height,
    bitsPerSample,
    sampleFormat,
    compression,
    predictor,
    noDataValue,
    pixelScale,
    tiepoint,
    grid,
  };
}

/**
 * Compute the WGS84 center coordinate `(lat, lon)` for pixel `(row, col)` of a decoded GeoTIFF.
 * Uses embedded GeoTIFF `ModelTiepointTag` and `ModelPixelScaleTag` when present, or falls back
 * to the requested BBOX bounds.
 */
export function getPixelCenterCoordinates(
  decoded: DecodedSoilGridsGeoTiff,
  row: number,
  col: number,
  fallbackBbox: { lonMin: number; latMin: number; lonMax: number; latMax: number }
): { lat: number; lon: number } {
  if (decoded.pixelScale && decoded.tiepoint) {
    const [scaleX, scaleY] = decoded.pixelScale;
    const [tieI, tieJ, originLon, originLat] = decoded.tiepoint;
    const lon = originLon + (col - tieI + 0.5) * scaleX;
    const lat = originLat - (row - tieJ + 0.5) * scaleY;
    return { lat, lon };
  }

  const cellWidth = (fallbackBbox.lonMax - fallbackBbox.lonMin) / decoded.width;
  const cellHeight = (fallbackBbox.latMax - fallbackBbox.latMin) / decoded.height;
  return {
    lon: fallbackBbox.lonMin + (col + 0.5) * cellWidth,
    lat: fallbackBbox.latMax - (row + 0.5) * cellHeight,
  };
}

/**
 * Check whether a raw pixel value from a SoilGrids property layer is a valid terrestrial prediction.
 */
export function isRawSoilGridsValueValid(
  raw: number,
  spec: SoilGridsPropertySpec,
  noDataValue: number | null,
  soilPixelConfirmed = false
): boolean {
  if (!Number.isFinite(raw)) return false;
  if (noDataValue !== null && raw === noDataValue) return false;
  if (raw === SOILGRIDS_DEFAULT_NODATA) return false;
  if (raw === 0 && spec.allowZeroWhenSoilValid && soilPixelConfirmed) {
    return true;
  }
  return raw >= spec.minValidRaw && raw <= spec.maxValidRaw;
}

/**
 * Select the center pixel (or nearest valid neighbor pixel within `MAX_NEIGHBOR_DISTANCE_METERS`)
 * from a decoded SoilGrids GeoTIFF grid.
 */
export function selectBestPixelFromGrid(
  decoded: DecodedSoilGridsGeoTiff,
  targetLat: number,
  targetLon: number,
  fallbackBbox: { lonMin: number; latMin: number; lonMax: number; latMax: number },
  isValidValue: (rawValue: number) => boolean
): SelectedPixelResult | null {
  const candidates: SelectedPixelResult[] = [];
  const centerRow = Math.floor(decoded.height / 2);
  const centerCol = Math.floor(decoded.width / 2);

  for (let r = 0; r < decoded.height; r++) {
    for (let c = 0; c < decoded.width; c++) {
      const val = decoded.grid[r]?.[c];
      if (val === undefined || !isValidValue(val)) continue;

      const { lat: pixelLat, lon: pixelLon } = getPixelCenterCoordinates(
        decoded,
        r,
        c,
        fallbackBbox
      );
      const isCenter = r === centerRow && c === centerCol;
      const dist = isCenter
        ? 0
        : Math.max(1, Math.round(haversineDistanceMeters(targetLat, targetLon, pixelLat, pixelLon)));

      if (dist <= MAX_NEIGHBOR_DISTANCE_METERS) {
        candidates.push({
          row: r,
          col: c,
          rawValue: val,
          usedNeighborPixel: !isCenter,
          distanceMeters: dist,
          pixelLat: Number(pixelLat.toFixed(5)),
          pixelLon: Number(pixelLon.toFixed(5)),
        });
      }
    }
  }

  if (candidates.length === 0) return null;

  candidates.sort((a, b) => {
    if (a.distanceMeters !== b.distanceMeters) {
      return a.distanceMeters - b.distanceMeters;
    }
    const aCenterDist = Math.abs(a.row - centerRow) + Math.abs(a.col - centerCol);
    const bCenterDist = Math.abs(b.row - centerRow) + Math.abs(b.col - centerCol);
    return aCenterDist - bCenterDist;
  });

  return candidates[0];
}

// ─── Depth-Weighting & Unit Conversion Helpers ───────────────────────

export interface LayerValueEntry {
  depthId: SoilGridsDepthId;
  thicknessCm: number;
  value: number | null;
}

/**
 * Compute thickness-weighted 0–30 cm average from 0–5 cm (5 cm), 5–15 cm (10 cm),
 * and 15–30 cm (15 cm) layer values. Excludes missing (`null`) layers rather than
 * treating them as zero.
 */
export function computeDepthWeighted0_30cm(
  layers: LayerValueEntry[],
  decimals = 2
): { value: number | null; coveragePct: number | null; coveredDepthCm: number } {
  let weightedSum = 0;
  let coveredDepthCm = 0;

  for (const l of layers) {
    if (l.value === null || !Number.isFinite(l.value)) continue;
    weightedSum += l.value * l.thicknessCm;
    coveredDepthCm += l.thicknessCm;
  }

  if (coveredDepthCm === 0) {
    return { value: null, coveragePct: null, coveredDepthCm: 0 };
  }

  const weightedMean = weightedSum / coveredDepthCm;
  const coveragePct = Math.round((coveredDepthCm / 30) * 100);
  return {
    value: Number(weightedMean.toFixed(decimals)),
    coveragePct,
    coveredDepthCm,
  };
}

/**
 * Convert a raw SoilGrids integer pixel value to its conventional unit.
 */
export function convertRawSoilGridsValue(
  raw: number,
  propId: SoilGridsPropertyId,
  decimals = 2
): number {
  const spec = SOILGRIDS_PROPERTIES[propId];
  return Number((raw / spec.divisor).toFixed(decimals));
}

// ─── Normalized SoilGrids WCS Output Structure ───────────────────────

export interface SoilGridsLayerHorizon {
  depthId: SoilGridsDepthId;
  depthLabel: string;
  depthTop: number;
  depthBottom: number;
  sand: number | null;
  silt: number | null;
  clay: number | null;
  socPct: number | null;
  om: number | null;
  ph: number | null;
  awc: number | null;
  bulkDensityGcm3: number | null;
  coarseFragmentsPct: number | null;
}

export interface SoilGridsLayerUncertainty {
  depthInterval: SoilGridsDepthId;
  depthLabel: string;
  note: string;
  properties: Partial<
    Record<"sand" | "silt" | "clay" | "soc" | "om" | "ph", SoilPropertyUncertainty>
  >;
}

export interface SoilGridsWcsProfileResult {
  location: {
    lat: number;
    lon: number;
  };
  dataTier: "soilgrids_wcs_250m";
  source: string;
  coverage: string;
  wrbSoilGroup?: string;
  mapUnit: {
    mukey: string;
    name: string;
  };
  totalComponentPercent: number;
  components: {
    cokey: string;
    name: string;
    percent: number;
    kind: string;
    majcompflag: string | null;
    drainage: string | null;
    slope: number | null;
    horizons: {
      depthTop: number;
      depthBottom: number;
      sand: number | null;
      silt: number | null;
      clay: number | null;
      om: number | null;
      ph: number | null;
      awc: number | null;
    }[];
  }[];
  horizonsDetailed: SoilGridsLayerHorizon[];
  aggregated: {
    depth0_30cm: {
      sand: number | null;
      silt: number | null;
      clay: number | null;
      om: number | null;
      ph: number | null;
      awc: number | null;
      organicCarbonPct: number | null;
      bulkDensityGcm3: number | null;
      coarseFragmentsPct: number | null;
    };
    drainage: null;
    slope: null;
  };
  /**
   * Deliberately `undefined` on aggregated 0–30 cm SoilGrids profiles so a single-layer
   * (e.g. 0–5 cm or 5–15 cm) prediction interval is NEVER misrepresented as the composite
   * 0–30 cm uncertainty. Layer-specific prediction intervals are provided in `layerUncertainty`.
   */
  uncertainty?: undefined;
  layerUncertainty?: SoilGridsLayerUncertainty;
  pixelResolution: {
    gridSizeMeters: number;
    usedNeighborPixel: boolean;
    neighborDistanceMeters: number;
    extractedLat: number;
    extractedLon: number;
  };
  propertySources: Record<string, string>;
  dataCoverage: {
    depth0_30cm: {
      sand: number | null;
      silt: number | null;
      clay: number | null;
      om: number | null;
      ph: number | null;
      awc: number | null;
    };
    drainage: null;
    slope: null;
  };
  limitations: string[];
}

export interface SoilGridsFetchOptions {
  fetchFn?: typeof fetch;
  canaryTimeoutMs?: number;
  layerTimeoutMs?: number;
  totalBudgetMs?: number;
  bypassCache?: boolean;
}

const memoryCache = new LRUCache<string, SoilGridsWcsProfileResult>({
  max: 500,
  ttl: CACHE_TTL_SECONDS * 1000,
});

export function clearSoilGridsCacheForTests(): void {
  memoryCache.clear();
}

/**
 * Build a WCS 1.0.0 `GetCoverage` URL for a 5×5 pixel window centered at `(lat, lon)`.
 */
export function buildSoilGridsWcsUrl(params: {
  mapFile: string;
  coverageId: string;
  lat: number;
  lon: number;
  format?: "GEOTIFF_INT16" | "GEOTIFF_BYTE";
}): string {
  const { mapFile, coverageId, lat, lon, format = "GEOTIFF_INT16" } = params;
  const lonMin = Number((lon - WCS_HALF_SPAN_DEG).toFixed(6));
  const latMin = Number((lat - WCS_HALF_SPAN_DEG).toFixed(6));
  const lonMax = Number((lon + WCS_HALF_SPAN_DEG).toFixed(6));
  const latMax = Number((lat + WCS_HALF_SPAN_DEG).toFixed(6));

  const url = new URL(SOILGRIDS_WCS_BASE_URL);
  url.searchParams.set("map", `/map/${mapFile}.map`);
  url.searchParams.set("SERVICE", "WCS");
  url.searchParams.set("VERSION", "1.0.0");
  url.searchParams.set("REQUEST", "GetCoverage");
  url.searchParams.set("COVERAGE", coverageId);
  url.searchParams.set("CRS", "EPSG:4326");
  url.searchParams.set("BBOX", `${lonMin},${latMin},${lonMax},${latMax}`);
  url.searchParams.set("WIDTH", String(WCS_GRID_WIDTH));
  url.searchParams.set("HEIGHT", String(WCS_GRID_HEIGHT));
  url.searchParams.set("FORMAT", format);
  return url.toString();
}

/**
 * Execute an array of async tasks with bounded concurrency (`maxConcurrency`).
 */
async function runWithBoundedConcurrency<T, R>(
  items: readonly T[],
  maxConcurrency: number,
  worker: (item: T) => Promise<R>
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let nextIdx = 0;

  async function runWorker(): Promise<void> {
    while (nextIdx < items.length) {
      const currentIdx = nextIdx++;
      results[currentIdx] = await worker(items[currentIdx]);
    }
  }

  const workerCount = Math.min(Math.max(1, maxConcurrency), items.length);
  await Promise.all(Array.from({ length: workerCount }, () => runWorker()));
  return results;
}

/**
 * Core implementation that queries ISRIC SoilGrids v2.0 WCS at `(lat, lon)`.
 */
async function fetchSoilGridsWcsProfileUncached(
  lat: number,
  lon: number,
  options?: SoilGridsFetchOptions
): Promise<SoilGridsWcsProfileResult | null> {
  // SoilGrids v2.0 covers global land between -56°S and +84°N
  if (lat < -56 || lat > 84) {
    return null;
  }

  const fetchImpl = options?.fetchFn ?? fetch;
  const canaryTimeout = options?.canaryTimeoutMs ?? CANARY_TIMEOUT_MS;
  const layerTimeout = options?.layerTimeoutMs ?? LAYER_TIMEOUT_MS;
  const totalBudget = options?.totalBudgetMs ?? TOTAL_BUDGET_MS;
  const deadline = Date.now() + totalBudget;

  const bbox = {
    lonMin: Number((lon - WCS_HALF_SPAN_DEG).toFixed(6)),
    latMin: Number((lat - WCS_HALF_SPAN_DEG).toFixed(6)),
    lonMax: Number((lon + WCS_HALF_SPAN_DEG).toFixed(6)),
    latMax: Number((lat + WCS_HALF_SPAN_DEG).toFixed(6)),
  };

  async function fetchAndDecodeCoverage(
    mapFile: string,
    coverageId: string,
    format: "GEOTIFF_INT16" | "GEOTIFF_BYTE",
    timeoutMs: number
  ): Promise<DecodedSoilGridsGeoTiff | null> {
    const remainingBudget = deadline - Date.now();
    if (remainingBudget <= 150) return null;

    const effectiveTimeout = Math.min(timeoutMs, remainingBudget);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), effectiveTimeout);

    try {
      const url = buildSoilGridsWcsUrl({ mapFile, coverageId, lat, lon, format });
      const reqInit: RequestInit = {
        signal: controller.signal,
        cache: "no-store",
        headers: {
          Accept: "image/tiff,application/octet-stream,*/*",
          "User-Agent": "fallo-agricultural-decision-support/1.0",
        },
      };

      const res = await fetchImpl(url, reqInit);
      clearTimeout(timer);
      if (!res.ok) return null;

      const ct = (res.headers.get("content-type") ?? "").toLowerCase();
      if (ct.includes("xml") || ct.includes("html")) {
        return null;
      }

      const buf = Buffer.from(await res.arrayBuffer());
      return decodeSoilGridsGeoTiff(buf);
    } catch {
      clearTimeout(timer);
      return null;
    }
  }

  // ── Step 1: Canary request (`clay_0-5cm_Q0.5`) to verify WCS reachability,
  // warm up the TLS keep-alive socket, and select the target terrestrial pixel. ──
  const canarySpec = SOILGRIDS_PROPERTIES.clay;
  const canaryDecoded = await fetchAndDecodeCoverage(
    canarySpec.mapFile,
    "clay_0-5cm_Q0.5",
    "GEOTIFF_INT16",
    canaryTimeout
  );
  if (!canaryDecoded) {
    return null;
  }

  const targetPixel = selectBestPixelFromGrid(
    canaryDecoded,
    lat,
    lon,
    bbox,
    (raw) => isRawSoilGridsValueValid(raw, canarySpec, canaryDecoded.noDataValue, false)
  );
  if (!targetPixel) {
    // All pixels in the 5×5 (~500 m) window are NoData (ocean, lake, glacier, or dense urban mask)
    return null;
  }

  const selectedRow = targetPixel.row;
  const selectedCol = targetPixel.col;

  // Extract values strictly at `(selectedRow, selectedCol)` — never combine properties or depths
  // from different neighboring pixels into a synthetic chimeric profile.
  function extractPropertyAtSelectedPixel(
    decoded: DecodedSoilGridsGeoTiff | null,
    propId: SoilGridsPropertyId
  ): number | null {
    if (!decoded) return null;
    const spec = SOILGRIDS_PROPERTIES[propId];
    const directRaw = decoded.grid[selectedRow]?.[selectedCol];
    if (
      directRaw !== undefined &&
      isRawSoilGridsValueValid(directRaw, spec, decoded.noDataValue, true)
    ) {
      return directRaw;
    }
    return null;
  }

  // ── Step 2: Build bounded request batch for 0–5, 5–15, 15–30 cm layers + 0–5 cm Q0.05/Q0.95 + WRB ──
  interface CoverageTask {
    key: string;
    mapFile: string;
    coverageId: string;
    format: "GEOTIFF_INT16" | "GEOTIFF_BYTE";
  }

  const tasks: CoverageTask[] = [];
  const allProps: SoilGridsPropertyId[] = [
    "sand",
    "silt",
    "clay",
    "soc",
    "phh2o",
    "bdod",
    "cfvo",
    "wv0033",
    "wv1500",
  ];

  for (const propId of allProps) {
    const spec = SOILGRIDS_PROPERTIES[propId];
    for (const depth of SOILGRIDS_DEPTH_LAYERS) {
      if (propId === "clay" && depth.id === "0-5cm") {
        // Already fetched in canary Step 1
        continue;
      }
      tasks.push({
        key: `${propId}_${depth.id}_Q0.5`,
        mapFile: spec.mapFile,
        coverageId: `${propId}_${depth.id}_Q0.5`,
        format: "GEOTIFF_INT16",
      });
    }
  }

  // Fetch 0–5 cm Q0.05 and Q0.95 prediction quantiles for the 5 primary properties
  const uncertaintyProps: SoilGridsPropertyId[] = ["sand", "silt", "clay", "soc", "phh2o"];
  for (const propId of uncertaintyProps) {
    const spec = SOILGRIDS_PROPERTIES[propId];
    tasks.push({
      key: `${propId}_0-5cm_Q0.05`,
      mapFile: spec.mapFile,
      coverageId: `${propId}_0-5cm_Q0.05`,
      format: "GEOTIFF_INT16",
    });
    tasks.push({
      key: `${propId}_0-5cm_Q0.95`,
      mapFile: spec.mapFile,
      coverageId: `${propId}_0-5cm_Q0.95`,
      format: "GEOTIFF_INT16",
    });
  }

  // Fetch WRB MostProbable reference soil group
  tasks.push({
    key: "wrb_MostProbable",
    mapFile: "wrb",
    coverageId: "MostProbable",
    format: "GEOTIFF_BYTE",
  });

  const decodedMap = new Map<string, DecodedSoilGridsGeoTiff | null>();
  decodedMap.set("clay_0-5cm_Q0.5", canaryDecoded);

  const taskResults = await runWithBoundedConcurrency(tasks, MAX_CONCURRENCY, async (task) => {
    const decoded = await fetchAndDecodeCoverage(
      task.mapFile,
      task.coverageId,
      task.format,
      layerTimeout
    );
    return { key: task.key, decoded };
  });

  for (const { key, decoded } of taskResults) {
    decodedMap.set(key, decoded);
  }

  // ── Step 3: Assemble per-layer (0–5, 5–15, 15–30 cm) values with proper unit conversions ──
  const horizonsDetailed: SoilGridsLayerHorizon[] = [];

  for (const depth of SOILGRIDS_DEPTH_LAYERS) {
    const sandRaw = extractPropertyAtSelectedPixel(
      decodedMap.get(`sand_${depth.id}_Q0.5`) ?? null,
      "sand"
    );
    const siltRaw = extractPropertyAtSelectedPixel(
      decodedMap.get(`silt_${depth.id}_Q0.5`) ?? null,
      "silt"
    );
    const clayRaw = extractPropertyAtSelectedPixel(
      decodedMap.get(`clay_${depth.id}_Q0.5`) ?? null,
      "clay"
    );
    const socRaw = extractPropertyAtSelectedPixel(
      decodedMap.get(`soc_${depth.id}_Q0.5`) ?? null,
      "soc"
    );
    const phRaw = extractPropertyAtSelectedPixel(
      decodedMap.get(`phh2o_${depth.id}_Q0.5`) ?? null,
      "phh2o"
    );
    const bdodRaw = extractPropertyAtSelectedPixel(
      decodedMap.get(`bdod_${depth.id}_Q0.5`) ?? null,
      "bdod"
    );
    const cfvoRaw = extractPropertyAtSelectedPixel(
      decodedMap.get(`cfvo_${depth.id}_Q0.5`) ?? null,
      "cfvo"
    );
    const wv0033Raw = extractPropertyAtSelectedPixel(
      decodedMap.get(`wv0033_${depth.id}_Q0.5`) ?? null,
      "wv0033"
    );
    const wv1500Raw = extractPropertyAtSelectedPixel(
      decodedMap.get(`wv1500_${depth.id}_Q0.5`) ?? null,
      "wv1500"
    );

    const sand = sandRaw !== null ? convertRawSoilGridsValue(sandRaw, "sand", 1) : null;
    const silt = siltRaw !== null ? convertRawSoilGridsValue(siltRaw, "silt", 1) : null;
    const clay = clayRaw !== null ? convertRawSoilGridsValue(clayRaw, "clay", 1) : null;
    const socPct = socRaw !== null ? convertRawSoilGridsValue(socRaw, "soc", 2) : null;
    const om =
      socPct !== null ? Number((socPct * VAN_BEMMELEN_OM_FACTOR).toFixed(2)) : null;
    const ph = phRaw !== null ? convertRawSoilGridsValue(phRaw, "phh2o", 1) : null;
    const bulkDensityGcm3 =
      bdodRaw !== null ? convertRawSoilGridsValue(bdodRaw, "bdod", 2) : null;
    const coarseFragmentsPct =
      cfvoRaw !== null ? convertRawSoilGridsValue(cfvoRaw, "cfvo", 1) : null;

    // Available Water Capacity (AWC): computed ONLY when both 33 kPa and 1500 kPa
    // water-retention predictions are valid and wv0033 > wv1500.
    const awc =
      wv0033Raw !== null && wv1500Raw !== null && wv0033Raw > wv1500Raw
        ? Number(((wv0033Raw - wv1500Raw) / 1000).toFixed(3))
        : null;

    horizonsDetailed.push({
      depthId: depth.id,
      depthLabel: depth.label,
      depthTop: depth.depthTop,
      depthBottom: depth.depthBottom,
      sand,
      silt,
      clay,
      socPct,
      om,
      ph,
      awc,
      bulkDensityGcm3,
      coarseFragmentsPct,
    });
  }

  // ── Step 4: Compute thickness-weighted 0–30 cm topsoil profile ──
  function weightProp(
    getter: (h: SoilGridsLayerHorizon) => number | null,
    decimals: number
  ) {
    return computeDepthWeighted0_30cm(
      horizonsDetailed.map((h) => ({
        depthId: h.depthId,
        thicknessCm: h.depthBottom - h.depthTop,
        value: getter(h),
      })),
      decimals
    );
  }

  const sandW = weightProp((h) => h.sand, 1);
  const siltW = weightProp((h) => h.silt, 1);
  const clayW = weightProp((h) => h.clay, 1);
  const socW = weightProp((h) => h.socPct, 2);
  const omW = weightProp(
    (h) => (h.socPct !== null ? h.socPct * VAN_BEMMELEN_OM_FACTOR : null),
    2
  );
  const phW = weightProp((h) => h.ph, 1);
  const awcW = weightProp((h) => h.awc, 3);
  const bdodW = weightProp((h) => h.bulkDensityGcm3, 2);
  const cfvoW = weightProp((h) => h.coarseFragmentsPct, 1);

  // Require full 3-layer (0–5 cm, 5–15 cm, 15–30 cm = 30 cm) coverage at `(selectedRow, selectedCol)`
  // for all 5 core topsoil properties (sand, silt, clay, soc, phh2o) so partial mid-batch timeouts
  // are never accepted or cached as complete 0–30 cm profiles.
  const hasFullCoreDepthCoverage =
    sandW.value !== null &&
    sandW.coveredDepthCm === 30 &&
    siltW.value !== null &&
    siltW.coveredDepthCm === 30 &&
    clayW.value !== null &&
    clayW.coveredDepthCm === 30 &&
    socW.value !== null &&
    socW.coveredDepthCm === 30 &&
    phW.value !== null &&
    phW.coveredDepthCm === 30 &&
    sandW.value + siltW.value + clayW.value > 0;
  if (!hasFullCoreDepthCoverage) {
    return null;
  }

  // ── Step 5: Decode WRB MostProbable soil group strictly at `(selectedRow, selectedCol)` ──
  let wrbSoilGroup: string | undefined;
  const wrbDecoded = decodedMap.get("wrb_MostProbable") ?? null;
  if (wrbDecoded) {
    const directWrb = wrbDecoded.grid[selectedRow]?.[selectedCol];
    if (
      directWrb !== undefined &&
      directWrb >= 0 &&
      directWrb < WRB_SOIL_GROUPS.length &&
      (wrbDecoded.noDataValue === null || directWrb !== wrbDecoded.noDataValue)
    ) {
      wrbSoilGroup = WRB_SOIL_GROUPS[directWrb];
    }
  }

  // ── Step 6: Extract layer-specific 0–5 cm 90% prediction intervals (Q0.05, Q0.50, Q0.95) ──
  const surfaceHorizon = horizonsDetailed[0];
  const layerUncertaintyProps: SoilGridsLayerUncertainty["properties"] = {};

  function buildSurfaceQuantile(
    propId: SoilGridsPropertyId,
    q50Value: number | null,
    unit: string,
    decimals: number,
    scaleMultiplier = 1
  ): SoilPropertyUncertainty | undefined {
    if (q50Value === null) return undefined;
    const q05Raw = extractPropertyAtSelectedPixel(
      decodedMap.get(`${propId}_0-5cm_Q0.05`) ?? null,
      propId
    );
    const q95Raw = extractPropertyAtSelectedPixel(
      decodedMap.get(`${propId}_0-5cm_Q0.95`) ?? null,
      propId
    );
    if (q05Raw === null || q95Raw === null) return undefined;
    const q05 = Number(
      (convertRawSoilGridsValue(q05Raw, propId, decimals + 1) * scaleMultiplier).toFixed(decimals)
    );
    const q95 = Number(
      (convertRawSoilGridsValue(q95Raw, propId, decimals + 1) * scaleMultiplier).toFixed(decimals)
    );
    if (q95 < q05) return undefined;
    return {
      q05,
      q50: Number(q50Value.toFixed(decimals)),
      q95,
      unit,
    };
  }

  const sandUnc = buildSurfaceQuantile("sand", surfaceHorizon.sand, "%", 1);
  if (sandUnc) layerUncertaintyProps.sand = sandUnc;

  const siltUnc = buildSurfaceQuantile("silt", surfaceHorizon.silt, "%", 1);
  if (siltUnc) layerUncertaintyProps.silt = siltUnc;

  const clayUnc = buildSurfaceQuantile("clay", surfaceHorizon.clay, "%", 1);
  if (clayUnc) layerUncertaintyProps.clay = clayUnc;

  const socUnc = buildSurfaceQuantile("soc", surfaceHorizon.socPct, "% SOC", 2);
  if (socUnc) layerUncertaintyProps.soc = socUnc;

  const omUnc = buildSurfaceQuantile(
    "soc",
    surfaceHorizon.om,
    "% OM (derived from SOC × 1.724)",
    2,
    VAN_BEMMELEN_OM_FACTOR
  );
  if (omUnc) layerUncertaintyProps.om = omUnc;

  const phUnc = buildSurfaceQuantile("phh2o", surfaceHorizon.ph, "pH (H2O)", 1);
  if (phUnc) layerUncertaintyProps.ph = phUnc;

  const layerUncertainty: SoilGridsLayerUncertainty | undefined =
    Object.keys(layerUncertaintyProps).length > 0
      ? {
          depthInterval: "0-5cm",
          depthLabel: "0–5 cm surface layer (90% prediction interval: Q0.05–Q0.95)",
          note: "SoilGrids v2.0 publishes 90% prediction intervals (5th–95th percentiles, Q0.05–Q0.95) for individual depth layers rather than for a depth-weighted 0–30 cm composite profile. Values shown here represent the retrieved 0–5 cm surface horizon prediction interval.",
          properties: layerUncertaintyProps,
        }
      : undefined;

  // ── Step 7: Build transparent property provenance & scientific limitations ──
  const propertySources: Record<string, string> = {
    sand:
      sandW.value !== null
        ? `ISRIC SoilGrids v2.0 WCS (sand_Q0.5, g/kg ÷ 10 -> %, depth-weighted 0–30 cm across ${sandW.coveredDepthCm} cm)`
        : "Unavailable in SoilGrids WCS at this coordinate",
    silt:
      siltW.value !== null
        ? `ISRIC SoilGrids v2.0 WCS (silt_Q0.5, g/kg ÷ 10 -> %, depth-weighted 0–30 cm across ${siltW.coveredDepthCm} cm)`
        : "Unavailable in SoilGrids WCS at this coordinate",
    clay:
      clayW.value !== null
        ? `ISRIC SoilGrids v2.0 WCS (clay_Q0.5, g/kg ÷ 10 -> %, depth-weighted 0–30 cm across ${clayW.coveredDepthCm} cm)`
        : "Unavailable in SoilGrids WCS at this coordinate",
    organicCarbon:
      socW.value !== null
        ? `ISRIC SoilGrids v2.0 WCS (soc_Q0.5, dg/kg ÷ 100 -> % SOC, depth-weighted 0–30 cm = ${socW.value.toFixed(2)}% SOC)`
        : "Unavailable in SoilGrids WCS at this coordinate",
    om:
      omW.value !== null && socW.value !== null
        ? `Derived estimate from SoilGrids v2.0 Soil Organic Carbon (SOC = ${socW.value.toFixed(2)}%) via Van Bemmelen factor (OM = SOC × 1.724)`
        : "Unavailable (requires SoilGrids SOC prediction)",
    ph:
      phW.value !== null
        ? `ISRIC SoilGrids v2.0 WCS (phh2o_Q0.5, pH×10 ÷ 10 -> pH H2O, depth-weighted 0–30 cm across ${phW.coveredDepthCm} cm)`
        : "Unavailable in SoilGrids WCS at this coordinate",
    bulkDensity:
      bdodW.value !== null
        ? `ISRIC SoilGrids v2.0 WCS (bdod_Q0.5, cg/cm³ ÷ 100 -> g/cm³, depth-weighted 0–30 cm = ${bdodW.value.toFixed(2)} g/cm³)`
        : "Unavailable in SoilGrids WCS at this coordinate",
    coarseFragments:
      cfvoW.value !== null
        ? `ISRIC SoilGrids v2.0 WCS (cfvo_Q0.5, cm³/dm³ ÷ 10 -> % vol, depth-weighted 0–30 cm = ${cfvoW.value.toFixed(1)}%)`
        : "Unavailable in SoilGrids WCS at this coordinate",
    awc:
      awcW.value !== null
        ? `Derived from ISRIC SoilGrids v2.0 water-retention predictions ((wv0033 − wv1500) ÷ 1000 -> cm/cm, depth-weighted 0–30 cm across ${awcW.coveredDepthCm} cm)`
        : "Unavailable (valid wv0033 / wv1500 water-retention predictions not present; not fabricated)",
    wrbSoilGroup: wrbSoilGroup
      ? `ISRIC SoilGrids v2.0 WCS (wrb MostProbable = ${wrbSoilGroup})`
      : "Unavailable in SoilGrids WCS at this coordinate",
    drainage: "Not provided by ISRIC SoilGrids v2.0 (categorical drainage class is not fabricated)",
    slope: "Not provided by ISRIC SoilGrids v2.0 (terrain slope % is not fabricated)",
  };

  const limitations: string[] = [
    "ISRIC SoilGrids v2.0 values are coordinate-specific machine-learning predictions at ~250 m grid resolution—NOT field soil measurements or laboratory tests. Local soil properties vary substantially within a 250 m cell; on-site soil testing is recommended before making fertilizer, lime, or management decisions.",
  ];

  if (targetPixel.usedNeighborPixel) {
    limitations.push(
      `The exact requested coordinate (${lat.toFixed(4)}, ${lon.toFixed(4)}) fell on a masked SoilGrids pixel (NoData = -32768, typically built-up infrastructure, road, or surface water). Values were extracted from the nearest unmasked 250 m soil pixel located ~${targetPixel.distanceMeters} m away (${targetPixel.pixelLat.toFixed(4)}, ${targetPixel.pixelLon.toFixed(4)}).`
    );
  }

  if (socW.value !== null && omW.value !== null) {
    limitations.push(
      `Organic Matter (${omW.value.toFixed(2)}%) is a derived estimate calculated from SoilGrids Soil Organic Carbon (SOC = ${socW.value.toFixed(2)}%, or ${(socW.value * 10).toFixed(1)} g/kg) using the conventional Van Bemmelen conversion factor (OM = SOC × 1.724).`
    );
  }

  if (awcW.value !== null) {
    limitations.push(
      `Available Water Capacity (AWC = ${awcW.value.toFixed(3)} cm/cm) is calculated from SoilGrids volumetric water-retention predictions at 33 kPa (wv0033) and 1500 kPa (wv1500) across 0–30 cm.`
    );
  } else {
    limitations.push(
      "Available Water Capacity (AWC) could not be computed because valid 33 kPa / 1500 kPa water-retention predictions were unavailable at this pixel."
    );
  }

  if (sandW.value !== null && siltW.value !== null && clayW.value !== null) {
    const textureSum = sandW.value + siltW.value + clayW.value;
    if (Math.abs(textureSum - 100) > 3) {
      limitations.push(
        `SoilGrids models sand, silt, and clay independently via quantile random forests; depth-weighted 0–30 cm fractions at this pixel sum to ${textureSum.toFixed(1)}%.`
      );
    }
  }

  limitations.push(
    "Categorical soil drainage class and terrain slope (%) are not published by ISRIC SoilGrids v2.0 and are intentionally left blank (not fabricated)."
  );

  if (layerUncertainty) {
    limitations.push(
      "Prediction uncertainty (Q0.05–Q0.95, 90% prediction interval) is reported by SoilGrids per individual depth layer (shown for the 0–5 cm surface layer) and is not applied as a composite 0–30 cm interval."
    );
  }

  const profileName = wrbSoilGroup
    ? `ISRIC SoilGrids v2.0 (250 m) — ${wrbSoilGroup}`
    : "ISRIC SoilGrids v2.0 (250 m Coordinate Prediction)";

  const result: SoilGridsWcsProfileResult = {
    location: { lat, lon },
    dataTier: "soilgrids_wcs_250m",
    source:
      "ISRIC SoilGrids v2.0 (250 m global digital soil mapping via OGC WCS). https://maps.isric.org/",
    coverage:
      "Global (~250 m grid, ISRIC SoilGrids v2.0 OGC WCS). Depth-weighted 0–30 cm topsoil predictions from 0–5 cm, 5–15 cm, and 15–30 cm layers (CC BY 4.0).",
    ...(wrbSoilGroup ? { wrbSoilGroup } : {}),
    mapUnit: {
      mukey: `SG250M_${targetPixel.pixelLat.toFixed(4)}_${targetPixel.pixelLon.toFixed(4)}`,
      name: profileName,
    },
    totalComponentPercent: 100,
    components: [
      {
        cokey: `SG250M_PIXEL_${targetPixel.pixelLat.toFixed(4)}_${targetPixel.pixelLon.toFixed(4)}`,
        name: profileName,
        percent: 100,
        kind: "Modeled 250 m grid cell (Q0.5 median)",
        majcompflag: "Yes",
        drainage: null,
        slope: null,
        horizons: horizonsDetailed.map((h) => ({
          depthTop: h.depthTop,
          depthBottom: h.depthBottom,
          sand: h.sand,
          silt: h.silt,
          clay: h.clay,
          om: h.om,
          ph: h.ph,
          awc: h.awc,
        })),
      },
    ],
    horizonsDetailed,
    aggregated: {
      depth0_30cm: {
        sand: sandW.value,
        silt: siltW.value,
        clay: clayW.value,
        om: omW.value,
        ph: phW.value,
        awc: awcW.value,
        organicCarbonPct: socW.value,
        bulkDensityGcm3: bdodW.value,
        coarseFragmentsPct: cfvoW.value,
      },
      drainage: null,
      slope: null,
    },
    uncertainty: undefined,
    layerUncertainty,
    pixelResolution: {
      gridSizeMeters: 250,
      usedNeighborPixel: targetPixel.usedNeighborPixel,
      neighborDistanceMeters: targetPixel.distanceMeters,
      extractedLat: targetPixel.pixelLat,
      extractedLon: targetPixel.pixelLon,
    },
    propertySources,
    dataCoverage: {
      depth0_30cm: {
        sand: sandW.coveragePct,
        silt: siltW.coveragePct,
        clay: clayW.coveragePct,
        om: omW.coveragePct,
        ph: phW.coveragePct,
        awc: awcW.coveragePct,
      },
      drainage: null,
      slope: null,
    },
    limitations,
  };

  return result;
}

/**
 * Next.js persistent Data Cache wrapper (persists across serverless invocations on Vercel).
 * Automatically falls back to direct execution when called outside a Next.js request/build
 * context (such as CLI test suites via `npx tsx`).
 */
const fetchSoilGridsWithNextCache = unstable_cache(
  async (latRounded: number, lonRounded: number) => {
    const res = await fetchSoilGridsWcsProfileUncached(latRounded, lonRounded);
    if (!res) {
      // Throw inside unstable_cache so transient upstream WCS failures are not cached for 24h
      throw new Error("SOILGRIDS_WCS_UNAVAILABLE");
    }
    return res;
  },
  ["soilgrids-wcs-v2-profile"],
  { revalidate: CACHE_TTL_SECONDS, tags: ["soilgrids-wcs"] }
);

/**
 * Retrieve a normalized 0–30 cm SoilGrids v2.0 profile for `(latInput, lonInput)` via OGC WCS.
 * Returns `null` if SoilGrids WCS is unreachable, times out, or has NoData at the coordinate,
 * allowing the caller to fall back cleanly to the macro-regional reference profile.
 */
export async function fetchSoilGridsWcsProfile(
  latInput: number,
  lonInput: number,
  options?: SoilGridsFetchOptions
): Promise<SoilGridsWcsProfileResult | null> {
  const norm = normalizeCoordinates(latInput, lonInput);
  if (!norm.ok) return null;

  const lat = norm.lat;
  const lon = norm.lon;
  // Cache key at 4 decimal places (~11 m, aligned with client coordinate precision)
  const cacheKey = `${lat.toFixed(4)}_${lon.toFixed(4)}`;

  const useCache = !options?.bypassCache && !options?.fetchFn;
  if (useCache) {
    const memHit = memoryCache.get(cacheKey);
    if (memHit) {
      return {
        ...memHit,
        location: { lat, lon },
      };
    }

    try {
      const nextCached = await fetchSoilGridsWithNextCache(
        Number(lat.toFixed(4)),
        Number(lon.toFixed(4))
      );
      if (nextCached) {
        memoryCache.set(cacheKey, nextCached);
        return {
          ...nextCached,
          location: { lat, lon },
        };
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg === "SOILGRIDS_WCS_UNAVAILABLE") {
        return null;
      }
      // If unstable_cache threw because we are outside Next.js incrementalCache runtime (e.g., npx tsx),
      // proceed to direct execution below.
    }
  }

  const fresh = await fetchSoilGridsWcsProfileUncached(lat, lon, options);
  if (fresh && useCache) {
    memoryCache.set(cacheKey, fresh);
  }
  return fresh;
}
