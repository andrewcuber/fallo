import { fromUrl } from "geotiff";
import { normalizeCoordinates } from "@/lib/coordinates";

const OLM_COGS = {
  sand: "https://s3.opengeohub.org/global-soil/global_soil_props_v20250523/sand.tot_iso.11277.2020.wpct_m_120m_b0cm..30cm_20200101_20221231_g_epsg.4326_v20250523.tif",
  silt: "https://s3.opengeohub.org/global-soil/global_soil_props_v20250523/silt.tot_iso.11277.2020.wpct_m_120m_b0cm..30cm_20200101_20221231_g_epsg.4326_v20250523.tif",
  clay: "https://s3.opengeohub.org/global-soil/global_soil_props_v20250523/clay.tot_iso.11277.2020.wpct_m_120m_b0cm..30cm_20200101_20221231_g_epsg.4326_v20250523.tif",
  ph: "https://s3.opengeohub.org/global-soil/global_soil_props_v20250204_mosaics/ph.h2o_iso.10390.2021.index_m_120m_b0cm..30cm_20000101_20051231_g_epsg.4326_v20250204.tif",
  oc: "https://s3.opengeohub.org/global-soil/global_soil_props_v20250204_mosaics/oc_iso.10694.1995.wpml_m_120m_b0cm..30cm_20000101_20051231_g_epsg.4326_v20250204.tif",
};

export interface OpenLandMapResult {
  sand: number | null;
  silt: number | null;
  clay: number | null;
  om: number | null;
  ph: number | null;
}

/**
 * Extracts a specific pixel value from a Cloud-Optimized GeoTIFF (COG) via HTTP Range requests.
 */
async function queryCogPixel(url: string, lat: number, lon: number): Promise<number | null> {
  try {
    const tiff = await fromUrl(url);
    const image = await tiff.getImage();
    const bbox = image.getBoundingBox(); // [minX, minY, maxX, maxY]
    const [resX, resY] = image.getResolution();
    
    // EPSG:4326 coordinates
    if (lon < bbox[0] || lon > bbox[2] || lat < bbox[1] || lat > bbox[3]) {
      return null;
    }

    const px = Math.floor((lon - bbox[0]) / resX);
    const py = Math.floor((lat - bbox[3]) / resY);
    
    const window = [px, py, px + 1, py + 1];
    const data = await image.readRasters({ window });
    
    // Check for NoData/null
    const value = data[0][0];
    if (value === 255 || value === 65535 || value === -32768) {
        return null;
    }
    
    return typeof value === "number" ? value : null;
  } catch (err) {
    console.error(`Error querying COG ${url} at ${lat},${lon}:`, err);
    return null;
  }
}

/**
 * Fetches OpenLandMap 0-30cm soil properties directly from OpenGeoHub COGs.
 * Fallback for urban and unmapped areas masked by SoilGrids and SSURGO.
 */
export async function fetchOpenLandMapProfile(
  latInput: number,
  lonInput: number
): Promise<OpenLandMapResult | null> {
  const norm = normalizeCoordinates(latInput, lonInput);
  if (!norm.valid) return null;

  const [sand, silt, clay, phRaw, ocRaw] = await Promise.all([
    queryCogPixel(OLM_COGS.sand, norm.lat, norm.lon),
    queryCogPixel(OLM_COGS.silt, norm.lat, norm.lon),
    queryCogPixel(OLM_COGS.clay, norm.lat, norm.lon),
    queryCogPixel(OLM_COGS.ph, norm.lat, norm.lon),
    queryCogPixel(OLM_COGS.oc, norm.lat, norm.lon),
  ]);

  if (sand === null && clay === null && ocRaw === null) {
      return null;
  }

  // Conversions based on OpenLandMap unit multipliers
  // ph.h2o_iso.10390.2021.index_m: index value -> divide by 10 to get pH
  const ph = phRaw !== null ? phRaw / 10 : null; 
  // oc_iso.10694.1995.wpml_m: wpml is g/kg, BUT the raster value is often scaled by 10 (like SoilGrids dg/kg).
  // Thus, raw value / 100 yields % OC. 
  // e.g. raw 216 -> 2.16% OC -> 3.72% OM.
  const ocPct = ocRaw !== null ? ocRaw / 100 : null; 
  const om = ocPct !== null ? Number((ocPct * 1.724).toFixed(2)) : null;

  return {
    sand,
    silt,
    clay,
    om,
    ph,
  };
}
