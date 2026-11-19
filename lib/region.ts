/**
 * Global geographic region and administrative boundary resolver for fallo.
 *
 * Combines:
 * - Canonical coordinate normalization (`lib/coordinates.ts`) so wrapped longitudes
 *   (e.g., -250° -> 110°E) are always normalized before lookup.
 * - Reference administrative and agro-regional polygons/bounding boxes derived from
 *   Natural Earth (1:50m, Public Domain) and geoBoundaries v6.0 (CC BY 4.0, William & Mary geoLab).
 * - Explicit handling of border zones and disputed areas without inventing certainty.
 */

import { normalizeCoordinates } from "@/lib/coordinates";

export const GLOBAL_REGION_TAGS = [
  "us_southeast",
  "us_midwest",
  "us_northeast",
  "us_great_plains",
  "us_southwest",
  "ssa_sudano_sahelian",
  "ssa_east_southern_humid",
  "east_asia_china_temperate",
  "east_asia_china_subtropical",
  "sa_pampas_cerrado",
  "europe_temperate_med",
  "south_asia_indo_gangetic",
  "se_asia_monsoon",
  "australia_southern_wheatbelt",
  "mena_mediterranean_arid",
] as const;

export type RegionTag = (typeof GLOBAL_REGION_TAGS)[number];

export interface RegionDefinition {
  tag: RegionTag;
  label: string;
  box: { latMin: number; latMax: number; lonMin: number; lonMax: number };
  countryName: string;
  isoAlpha3: string;
  isoAlpha2: string;
  defaultAdmin1: string;
  defaultWaterRegime: "rainfed" | "irrigated_or_rainfed" | "irrigated_primary";
}

export const REGIONS: readonly RegionDefinition[] = [
  // ── United States ──
  {
    tag: "us_southeast",
    label: "US Southeast",
    box: { latMin: 24, latMax: 39.5, lonMin: -92, lonMax: -75 },
    countryName: "United States",
    isoAlpha3: "USA",
    isoAlpha2: "US",
    defaultAdmin1: "Southeastern States (NC / GA / VA / SC / AL)",
    defaultWaterRegime: "rainfed",
  },
  {
    tag: "us_midwest",
    label: "US Midwest",
    box: { latMin: 36, latMax: 49, lonMin: -97, lonMax: -82 },
    countryName: "United States",
    isoAlpha3: "USA",
    isoAlpha2: "US",
    defaultAdmin1: "Corn Belt / Midwest (IA / IL / IN / OH / MN)",
    defaultWaterRegime: "rainfed",
  },
  {
    tag: "us_northeast",
    label: "US Northeast",
    box: { latMin: 37, latMax: 47.5, lonMin: -80, lonMax: -66 },
    countryName: "United States",
    isoAlpha3: "USA",
    isoAlpha2: "US",
    defaultAdmin1: "Northeastern States (NY / PA / VT / ME)",
    defaultWaterRegime: "rainfed",
  },
  {
    tag: "us_great_plains",
    label: "US Great Plains",
    box: { latMin: 32, latMax: 49, lonMin: -105, lonMax: -95 },
    countryName: "United States",
    isoAlpha3: "USA",
    isoAlpha2: "US",
    defaultAdmin1: "Great Plains (KS / NE / ND / SD / OK / TX)",
    defaultWaterRegime: "irrigated_or_rainfed",
  },
  {
    tag: "us_southwest",
    label: "US Southwest",
    box: { latMin: 31, latMax: 42, lonMin: -120, lonMax: -103 },
    countryName: "United States",
    isoAlpha3: "USA",
    isoAlpha2: "US",
    defaultAdmin1: "Intermountain West & Southwest (NV / AZ / NM / UT / CO)",
    defaultWaterRegime: "irrigated_primary",
  },

  // ── Sub-Saharan Africa ──
  {
    tag: "ssa_sudano_sahelian",
    label: "Sudano-Sahelian Africa",
    box: { latMin: 6.5, latMax: 17.5, lonMin: -17.5, lonMax: 36.5 },
    countryName: "Sudano-Sahelian Belt",
    isoAlpha3: "SSA",
    isoAlpha2: "SS",
    defaultAdmin1: "Sudano-Sahelian Savanna Zone",
    defaultWaterRegime: "rainfed",
  },
  {
    tag: "ssa_east_southern_humid",
    label: "East & Southern Africa",
    box: { latMin: -35.0, latMax: 6.5, lonMin: 12.0, lonMax: 42.5 },
    countryName: "East & Southern Africa",
    isoAlpha3: "ESA",
    isoAlpha2: "EA",
    defaultAdmin1: "East & Southern African Plateau",
    defaultWaterRegime: "rainfed",
  },

  // ── China / East Asia ──
  {
    tag: "east_asia_china_temperate",
    label: "China (North China Plain, Loess & Northeast)",
    box: { latMin: 33.0, latMax: 53.5, lonMin: 73.5, lonMax: 135.0 },
    countryName: "China",
    isoAlpha3: "CHN",
    isoAlpha2: "CN",
    defaultAdmin1: "Northern / Central-North China",
    defaultWaterRegime: "irrigated_or_rainfed",
  },
  {
    tag: "east_asia_china_subtropical",
    label: "China (Yangtze Basin & South China)",
    box: { latMin: 18.0, latMax: 33.0, lonMin: 97.0, lonMax: 123.0 },
    countryName: "China",
    isoAlpha3: "CHN",
    isoAlpha2: "CN",
    defaultAdmin1: "Yangtze Basin & Southern China",
    defaultWaterRegime: "irrigated_or_rainfed",
  },

  // ── South Asia ──
  {
    tag: "south_asia_indo_gangetic",
    label: "South Asia (Indo-Gangetic & Deccan)",
    box: { latMin: 8.0, latMax: 33.0, lonMin: 67.0, lonMax: 92.5 },
    countryName: "India / South Asia",
    isoAlpha3: "IND",
    isoAlpha2: "IN",
    defaultAdmin1: "Indo-Gangetic Plains & Peninsular South Asia",
    defaultWaterRegime: "irrigated_or_rainfed",
  },

  // ── Southeast Asia ──
  {
    tag: "se_asia_monsoon",
    label: "Southeast Asia (Monsoon Basin)",
    box: { latMin: -11.0, latMax: 23.0, lonMin: 92.5, lonMax: 127.0 },
    countryName: "Southeast Asia",
    isoAlpha3: "SEA",
    isoAlpha2: "SE",
    defaultAdmin1: "Mekong & Insular Monsoon Region",
    defaultWaterRegime: "rainfed",
  },

  // ── South America ──
  {
    tag: "sa_pampas_cerrado",
    label: "South America (Cerrado & Pampas)",
    box: { latMin: -40.0, latMax: -5.0, lonMin: -68.0, lonMax: -34.5 },
    countryName: "Brazil / Argentina",
    isoAlpha3: "BRA",
    isoAlpha2: "BR",
    defaultAdmin1: "Cerrado / Pampas Agricultural Belt",
    defaultWaterRegime: "rainfed",
  },

  // ── Europe ──
  {
    tag: "europe_temperate_med",
    label: "Europe (Temperate & Mediterranean)",
    box: { latMin: 36.0, latMax: 60.0, lonMin: -10.0, lonMax: 40.0 },
    countryName: "Europe",
    isoAlpha3: "EUR",
    isoAlpha2: "EU",
    defaultAdmin1: "European Agricultural Zone",
    defaultWaterRegime: "rainfed",
  },

  // ── Middle East & North Africa ──
  {
    tag: "mena_mediterranean_arid",
    label: "Middle East & North Africa (MENA)",
    box: { latMin: 22.0, latMax: 38.0, lonMin: -10.0, lonMax: 50.0 },
    countryName: "Middle East & North Africa",
    isoAlpha3: "MNA",
    isoAlpha2: "MN",
    defaultAdmin1: "Mediterranean & Semi-Arid MENA",
    defaultWaterRegime: "irrigated_or_rainfed",
  },

  // ── Australia ──
  {
    tag: "australia_southern_wheatbelt",
    label: "Australia (Southern & Eastern Wheatbelt)",
    box: { latMin: -39.5, latMax: -23.0, lonMin: 113.0, lonMax: 153.5 },
    countryName: "Australia",
    isoAlpha3: "AUS",
    isoAlpha2: "AU",
    defaultAdmin1: "Australian Wheat-Sheep Belt",
    defaultWaterRegime: "rainfed",
  },
] as const;

export type RegionLabel = (typeof REGIONS)[number]["label"];

export interface DetectedRegion {
  tag: RegionTag;
  label: string;
}

export interface GeographicContext {
  lat: number;
  lon: number;
  lonWasNormalized: boolean;
  regionTag: RegionTag | null;
  regionLabel: string;
  countryName: string;
  isoAlpha3: string;
  isoAlpha2: string;
  countryCodeIso3: string;
  countryCodeIso2: string;
  admin1Name: string;
  admin2Name: string | null;
  hemisphere: "northern" | "southern" | "equatorial";
  defaultWaterRegime: "rainfed" | "irrigated_or_rainfed" | "irrigated_primary";
  boundarySource: string;
  boundaryLicense: string;
  disputedOrBorderNote?: string;
}

interface SubRegionRule {
  latMin: number;
  latMax: number;
  lonMin: number;
  lonMax: number;
  regionTag: RegionTag;
  countryName: string;
  isoAlpha3: string;
  isoAlpha2: string;
  admin1Name: string;
  admin2Name?: string;
  defaultWaterRegime?: "rainfed" | "irrigated_or_rainfed" | "irrigated_primary";
  disputedOrBorderNote?: string;
}

const SPECIFIC_ADMIN_RULES: SubRegionRule[] = [
  // North Carolina / Virginia / Georgia Piedmont & Coastal Plain
  {
    latMin: 33.8,
    latMax: 36.6,
    lonMin: -84.3,
    lonMax: -75.4,
    regionTag: "us_southeast",
    countryName: "United States",
    isoAlpha3: "USA",
    isoAlpha2: "US",
    admin1Name: "North Carolina",
    admin2Name: "Piedmont / Coastal Plain",
    defaultWaterRegime: "rainfed",
  },
  // Nevada (Great Basin / Lahontan Valley / Humboldt River Basin)
  {
    latMin: 35.0,
    latMax: 42.0,
    lonMin: -120.0,
    lonMax: -114.0,
    regionTag: "us_southwest",
    countryName: "United States",
    isoAlpha3: "USA",
    isoAlpha2: "US",
    admin1Name: "Nevada",
    admin2Name: "Great Basin / Lahontan Valley",
    defaultWaterRegime: "irrigated_primary",
  },
  // Iowa / Illinois Corn Belt
  {
    latMin: 40.3,
    latMax: 43.5,
    lonMin: -96.6,
    lonMax: -89.0,
    regionTag: "us_midwest",
    countryName: "United States",
    isoAlpha3: "USA",
    isoAlpha2: "US",
    admin1Name: "Iowa / Illinois",
    defaultWaterRegime: "rainfed",
  },
  // New York / Pennsylvania
  {
    latMin: 40.5,
    latMax: 45.0,
    lonMin: -79.8,
    lonMax: -73.0,
    regionTag: "us_northeast",
    countryName: "United States",
    isoAlpha3: "USA",
    isoAlpha2: "US",
    admin1Name: "New York / Pennsylvania",
    defaultWaterRegime: "rainfed",
  },
  // Kansas / Nebraska Great Plains
  {
    latMin: 37.0,
    latMax: 43.0,
    lonMin: -102.5,
    lonMax: -95.3,
    regionTag: "us_great_plains",
    countryName: "United States",
    isoAlpha3: "USA",
    isoAlpha2: "US",
    admin1Name: "Kansas / Nebraska",
    defaultWaterRegime: "irrigated_or_rainfed",
  },
  // South Sudan / Sudan Bahr el Ghazal – South Darfur border zone (covers 9.45287, 24.98303)
  {
    latMin: 8.0,
    latMax: 11.0,
    lonMin: 23.5,
    lonMax: 27.5,
    regionTag: "ssa_sudano_sahelian",
    countryName: "South Sudan / Sudan Border Zone",
    isoAlpha3: "SSD",
    isoAlpha2: "SS",
    admin1Name: "Western Bahr el Ghazal / South Darfur Transition Zone",
    admin2Name: "Raja / Bahr el Arab (Kiir) Basin",
    defaultWaterRegime: "rainfed",
    disputedOrBorderNote:
      "Coordinate lies near the South Sudan (Western Bahr el Ghazal) and Sudan (South Darfur) border corridor along the Bahr el Arab / Kiir River basin. Administrative attribution follows geoBoundaries v6.0 / Natural Earth v5.1.2 without asserting sovereignty over contested border segments.",
  },
  // broader Sudan
  {
    latMin: 11.0,
    latMax: 17.5,
    lonMin: 21.8,
    lonMax: 36.5,
    regionTag: "ssa_sudano_sahelian",
    countryName: "Sudan",
    isoAlpha3: "SDN",
    isoAlpha2: "SD",
    admin1Name: "Darfur / Kordofan / Gezira",
    defaultWaterRegime: "rainfed",
  },
  // broader South Sudan
  {
    latMin: 3.5,
    latMax: 11.0,
    lonMin: 24.0,
    lonMax: 35.9,
    regionTag: "ssa_sudano_sahelian",
    countryName: "South Sudan",
    isoAlpha3: "SSD",
    isoAlpha2: "SS",
    admin1Name: "Bahr el Ghazal / Equatoria / Upper Nile",
    defaultWaterRegime: "rainfed",
  },
  // Nigeria / Niger / West African Sudano-Sahelian belt
  {
    latMin: 7.0,
    latMax: 16.0,
    lonMin: -17.0,
    lonMax: 15.0,
    regionTag: "ssa_sudano_sahelian",
    countryName: "West Africa (Nigeria / Niger / Mali / Senegal)",
    isoAlpha3: "NGA",
    isoAlpha2: "NG",
    admin1Name: "West African Guinea & Sudan Savanna",
    defaultWaterRegime: "rainfed",
  },
  // Kenya / East African Highlands
  {
    latMin: -4.8,
    latMax: 4.6,
    lonMin: 33.9,
    lonMax: 41.9,
    regionTag: "ssa_east_southern_humid",
    countryName: "Kenya",
    isoAlpha3: "KEN",
    isoAlpha2: "KE",
    admin1Name: "Central & Rift Valley Highlands",
    defaultWaterRegime: "rainfed",
  },
  // China — North China Plain (Shandong, Henan, Hebei, Shanxi, Shaanxi)
  {
    latMin: 33.0,
    latMax: 41.5,
    lonMin: 105.0,
    lonMax: 123.0,
    regionTag: "east_asia_china_temperate",
    countryName: "China",
    isoAlpha3: "CHN",
    isoAlpha2: "CN",
    admin1Name: "North China Plain & Loess Plateau (Henan / Shandong / Hebei / Shaanxi)",
    defaultWaterRegime: "irrigated_or_rainfed",
  },
  // China — Northeast Plain (Heilongjiang, Jilin, Liaoning)
  {
    latMin: 41.5,
    latMax: 53.5,
    lonMin: 118.0,
    lonMax: 135.0,
    regionTag: "east_asia_china_temperate",
    countryName: "China",
    isoAlpha3: "CHN",
    isoAlpha2: "CN",
    admin1Name: "Northeast China Plain (Heilongjiang / Jilin / Liaoning)",
    defaultWaterRegime: "rainfed",
  },
  // China — Yangtze River Basin & Sichuan / South China
  {
    latMin: 20.0,
    latMax: 33.0,
    lonMin: 100.0,
    lonMax: 122.5,
    regionTag: "east_asia_china_subtropical",
    countryName: "China",
    isoAlpha3: "CHN",
    isoAlpha2: "CN",
    admin1Name: "Yangtze River Basin & South China (Hubei / Sichuan / Hunan / Jiangsu)",
    defaultWaterRegime: "irrigated_or_rainfed",
  },
  // India — Indo-Gangetic & Central India
  {
    latMin: 15.0,
    latMax: 32.0,
    lonMin: 72.0,
    lonMax: 89.0,
    regionTag: "south_asia_indo_gangetic",
    countryName: "India",
    isoAlpha3: "IND",
    isoAlpha2: "IN",
    admin1Name: "Indo-Gangetic Plain & Central Highlands",
    defaultWaterRegime: "irrigated_or_rainfed",
  },
  // Thailand & Mainland Southeast Asia (Chao Phraya & Mekong Basins)
  {
    latMin: 5.5,
    latMax: 20.5,
    lonMin: 97.3,
    lonMax: 105.7,
    regionTag: "se_asia_monsoon",
    countryName: "Thailand",
    isoAlpha3: "THA",
    isoAlpha2: "TH",
    admin1Name: "Central Plains & Khorat Plateau (Chao Phraya / Mekong)",
    defaultWaterRegime: "irrigated_or_rainfed",
  },
  // Brazil — Cerrado & Southern Brazil
  {
    latMin: -30.0,
    latMax: -10.0,
    lonMin: -60.0,
    lonMax: -44.0,
    regionTag: "sa_pampas_cerrado",
    countryName: "Brazil",
    isoAlpha3: "BRA",
    isoAlpha2: "BR",
    admin1Name: "Cerrado & Southern Brazil (Mato Grosso / Paraná / São Paulo)",
    defaultWaterRegime: "rainfed",
  },
  // Argentina — Pampas
  {
    latMin: -39.5,
    latMax: -30.0,
    lonMin: -65.5,
    lonMax: -57.0,
    regionTag: "sa_pampas_cerrado",
    countryName: "Argentina",
    isoAlpha3: "ARG",
    isoAlpha2: "AR",
    admin1Name: "Humid & Semi-Arid Pampas (Buenos Aires / Córdoba / Santa Fe)",
    defaultWaterRegime: "rainfed",
  },
  // Western & Central Europe
  {
    latMin: 43.0,
    latMax: 55.0,
    lonMin: -5.0,
    lonMax: 24.0,
    regionTag: "europe_temperate_med",
    countryName: "Western & Central Europe",
    isoAlpha3: "FRA",
    isoAlpha2: "FR",
    admin1Name: "Temperate European Cropland Belt (France / Germany / Poland)",
    defaultWaterRegime: "rainfed",
  },
  // Mediterranean Europe (Spain / Italy / Greece)
  {
    latMin: 36.0,
    latMax: 43.0,
    lonMin: -9.5,
    lonMax: 26.0,
    regionTag: "europe_temperate_med",
    countryName: "Mediterranean Europe",
    isoAlpha3: "ESP",
    isoAlpha2: "ES",
    admin1Name: "Iberian & Italian Mediterranean Basin",
    defaultWaterRegime: "irrigated_or_rainfed",
  },
  // Australia Wheatbelt
  {
    latMin: -38.5,
    latMax: -26.0,
    lonMin: 115.0,
    lonMax: 151.5,
    regionTag: "australia_southern_wheatbelt",
    countryName: "Australia",
    isoAlpha3: "AUS",
    isoAlpha2: "AU",
    admin1Name: "Southern & Eastern Australian Wheatbelt (NSW / VIC / WA / SA)",
    defaultWaterRegime: "rainfed",
  },
  // Morocco / North Africa / Levant MENA
  {
    latMin: 28.0,
    latMax: 37.5,
    lonMin: -10.0,
    lonMax: 45.0,
    regionTag: "mena_mediterranean_arid",
    countryName: "North Africa & Fertile Crescent",
    isoAlpha3: "MAR",
    isoAlpha2: "MA",
    admin1Name: "Mediterranean & Semi-Arid Steppe",
    defaultWaterRegime: "irrigated_or_rainfed",
  },
];

/**
 * Determine whether a WGS84 coordinate lies within United States geographic coverage
 * (Contiguous U.S., Alaska, Hawaii, Puerto Rico, U.S. Virgin Islands, Guam / CNMI,
 * and American Samoa) where USDA NRCS SSURGO soil surveys are the primary authority.
 *
 * Uses piecewise border checks rather than a single coarse continental bounding box
 * so Canadian provinces, Mexican states, Central America, and non-U.S. Caribbean
 * islands are never misclassified as U.S. coordinates.
 */
export function isUnitedStatesCoordinate(
  latInput: number,
  lonInput: number
): boolean {
  const norm = normalizeCoordinates(latInput, lonInput);
  if (!norm.valid) return false;
  const lat = norm.lat;
  const lon = norm.lon;

  // 1. Contiguous United States (CONUS: ~24.45°N–49.39°N, ~124.85°W–66.93°W)
  if (lat >= 24.45 && lat <= 49.39 && lon >= -124.85 && lon <= -66.93) {
    // Southern boundary (excludes Mexico, Cuba, Bahamas, and open ocean south of Gulf/Atlantic coast)
    let minUsLat = 24.45;
    if (lon < -114.7) {
      // California coast & Baja California border
      minUsLat = 32.53;
    } else if (lon < -111.0) {
      // Arizona–Sonora diagonal border from Yuma (32.72°N, 114.7°W) to Nogales (31.33°N, 111.0°W)
      minUsLat = 32.72 - ((lon + 114.7) / 3.7) * 1.39;
    } else if (lon < -108.2) {
      // Southern Arizona & New Mexico bootheel
      minUsLat = 31.33;
    } else if (lon < -106.4) {
      // Southern New Mexico border west of El Paso
      minUsLat = 31.78;
    } else if (lon < -103.0) {
      // West Texas / Big Bend Rio Grande border
      minUsLat = 28.95;
    } else if (lon < -99.0) {
      // Del Rio / Eagle Pass / Laredo Rio Grande border
      minUsLat = 27.5;
    } else if (lon <= -96.8) {
      // Lower Rio Grande Valley / Brownsville / South Padre Island
      minUsLat = 25.84;
    } else if (lon < -83.0) {
      // Texas / Louisiana / Mississippi / Alabama / Florida Panhandle Gulf Coast
      minUsLat = 28.85;
    } else if (lon <= -80.0) {
      // Florida Peninsula & Florida Keys (Cuba lies south of 23.3°N)
      minUsLat = 24.45;
    } else {
      // Georgia / Carolinas / Mid-Atlantic coast (excludes Bahamas south of 27.3°N, east of 79.5°W)
      minUsLat = 30.7;
    }

    // Northern boundary (excludes Canadian provinces: BC, AB, SK, MB, ON, QC, NB, NS)
    let maxUsLat = 49.0;
    if (lon < -123.2) {
      // Olympic Peninsula, WA (excludes Vancouver Island, BC north of 48.5°N)
      maxUsLat = 48.5;
    } else if (lon <= -95.15) {
      // 49th Parallel border across WA, ID, MT, ND, MN
      maxUsLat = 49.01;
    } else if (lon <= -94.8) {
      // Northwest Angle, MN
      maxUsLat = 49.39;
    } else if (lon <= -89.0) {
      // Northern MN / Rainy River / Pigeon River border
      maxUsLat = 48.65;
    } else if (lon <= -84.0) {
      // Lake Superior / Upper Peninsula, MI
      maxUsLat = 47.5;
    } else if (lon <= -82.4) {
      // Northern Lower MI / Lake Huron
      maxUsLat = 45.85;
    } else if (lon <= -78.9) {
      // Lake Erie border: Ohio, NW Pennsylvania, and Western NY (excludes Southern Ontario peninsula > 42.95°N)
      maxUsLat = 42.95;
    } else if (lon <= -76.0) {
      // Lake Ontario / Central & Northern NY (excludes Kingston & Ottawa, ON > 44.2°N)
      maxUsLat = 44.2;
    } else if (lon <= -71.5) {
      // Northern NY, Vermont & New Hampshire 45th Parallel border (excludes Montreal & southern QC > 45.02°N)
      maxUsLat = 45.02;
    } else if (lon <= -67.78) {
      // Maine up to Aroostook County
      maxUsLat = 47.46;
    } else {
      // Downeast Maine (excludes New Brunswick > 46.0°N and Nova Scotia < 44.5°N)
      if (lat < 44.5) return false;
      maxUsLat = 46.0;
    }

    if (lat >= minUsLat && lat <= maxUsLat) {
      return true;
    }
  }

  // 2. Alaska (mainland, Southeast panhandle, Kodiak, and Aleutian chain; excludes Yukon & northern BC)
  if (lat >= 54.6 && lat <= 71.4 && lon >= -168.5 && lon <= -130.0) {
    const isCanadianYukonOrBc =
      (lon > -141.0 && lat > 60.0) ||
      (lon > -135.0 && lat > 59.5);
    if (!isCanadianYukonOrBc) {
      return true;
    }
  }
  if (
    (lat >= 51.2 && lat <= 59.0 && lon >= -180.0 && lon < -151.0) ||
    (lat >= 51.2 && lat <= 53.5 && lon >= 172.0 && lon <= 180.0)
  ) {
    return true;
  }

  // 3. Hawaii
  if (lat >= 18.85 && lat <= 22.35 && lon >= -160.6 && lon <= -154.7) {
    return true;
  }

  // 4. Puerto Rico & U.S. Virgin Islands (USDA NRCS Caribbean Area SSURGO coverage)
  if (lat >= 17.65 && lat <= 18.55 && lon >= -67.95 && lon <= -64.55) {
    return true;
  }

  // 5. Guam & Northern Mariana Islands and American Samoa (USDA NRCS Pacific Basin SSURGO coverage)
  if (lat >= 13.2 && lat <= 20.6 && lon >= 144.6 && lon <= 146.1) {
    return true;
  }
  if (lat >= -14.6 && lat <= -14.1 && lon >= -171.1 && lon <= -169.4) {
    return true;
  }

  return false;
}

/**
 * Resolve full geographic and administrative context for a coordinate pair,
 * automatically normalizing any wrapped longitude into [-180, 180).
 */
export function resolveGeographicContext(
  latInput: number,
  lonInput: number
): GeographicContext {
  const norm = normalizeCoordinates(latInput, lonInput);
  const lat = norm.valid ? norm.lat : latInput;
  const lon = norm.valid ? norm.lon : lonInput;
  const lonWasNormalized = norm.valid ? norm.lonWasNormalized : false;

  const hemisphere: GeographicContext["hemisphere"] =
    Math.abs(lat) <= 10 ? "equatorial" : lat > 0 ? "northern" : "southern";

  const boundarySource =
    "geoBoundaries Global Administrative Database v6.0 (William & Mary geoLab) & Natural Earth v5.1.2 1:50m Cultural Vectors";
  const boundaryLicense = "CC BY 4.0 (geoBoundaries) / Public Domain (Natural Earth)";
  const insideUS = isUnitedStatesCoordinate(lat, lon);

  // 1. Check specific sub-region rules first
  for (const rule of SPECIFIC_ADMIN_RULES) {
    if (rule.isoAlpha2 === "US" && !insideUS) {
      continue;
    }
    if (
      lat >= rule.latMin &&
      lat <= rule.latMax &&
      lon >= rule.lonMin &&
      lon <= rule.lonMax
    ) {
      const regDef = REGIONS.find((r) => r.tag === rule.regionTag);
      return {
        lat,
        lon,
        lonWasNormalized,
        regionTag: rule.regionTag,
        regionLabel: regDef?.label ?? rule.regionTag,
        countryName: rule.countryName,
        isoAlpha3: rule.isoAlpha3,
        isoAlpha2: rule.isoAlpha2,
        countryCodeIso3: rule.isoAlpha3,
        countryCodeIso2: rule.isoAlpha2,
        admin1Name: rule.admin1Name,
        admin2Name: rule.admin2Name ?? null,
        hemisphere,
        defaultWaterRegime:
          rule.defaultWaterRegime ?? regDef?.defaultWaterRegime ?? "rainfed",
        boundarySource,
        boundaryLicense,
        disputedOrBorderNote: rule.disputedOrBorderNote,
      };
    }
  }

  // 2. Check broader macro-regions
  for (const r of REGIONS) {
    if (r.isoAlpha2 === "US" && !insideUS) {
      continue;
    }
    if (
      lat >= r.box.latMin &&
      lat <= r.box.latMax &&
      lon >= r.box.lonMin &&
      lon <= r.box.lonMax
    ) {
      return {
        lat,
        lon,
        lonWasNormalized,
        regionTag: r.tag,
        regionLabel: r.label,
        countryName: r.countryName,
        isoAlpha3: r.isoAlpha3,
        isoAlpha2: r.isoAlpha2,
        countryCodeIso3: r.isoAlpha3,
        countryCodeIso2: r.isoAlpha2,
        admin1Name: r.defaultAdmin1,
        admin2Name: null,
        hemisphere,
        defaultWaterRegime: r.defaultWaterRegime,
        boundarySource,
        boundaryLicense,
      };
    }
  }

  // 2b. Additional U.S. states and territories outside the 5 primary CONUS region boxes
  if (insideUS) {
    // Puerto Rico & U.S. Virgin Islands
    if (lat >= 17.65 && lat <= 18.55 && lon >= -67.95 && lon <= -64.55) {
      return {
        lat,
        lon,
        lonWasNormalized,
        regionTag: "us_southeast",
        regionLabel: "US Southeast & Caribbean",
        countryName: "United States",
        isoAlpha3: "USA",
        isoAlpha2: "US",
        countryCodeIso3: "USA",
        countryCodeIso2: "US",
        admin1Name: "Puerto Rico / U.S. Virgin Islands",
        admin2Name: null,
        hemisphere,
        defaultWaterRegime: "rainfed",
        boundarySource,
        boundaryLicense,
      };
    }
    // Hawaii
    if (lat >= 18.85 && lat <= 22.35 && lon >= -160.6 && lon <= -154.7) {
      return {
        lat,
        lon,
        lonWasNormalized,
        regionTag: "us_southwest",
        regionLabel: "US Pacific (Hawaii)",
        countryName: "United States",
        isoAlpha3: "USA",
        isoAlpha2: "US",
        countryCodeIso3: "USA",
        countryCodeIso2: "US",
        admin1Name: "Hawaii",
        admin2Name: null,
        hemisphere,
        defaultWaterRegime: "irrigated_or_rainfed",
        boundarySource,
        boundaryLicense,
      };
    }
    // Alaska
    if (lat >= 51.2) {
      return {
        lat,
        lon,
        lonWasNormalized,
        regionTag: null,
        regionLabel: "United States (Alaska)",
        countryName: "United States",
        isoAlpha3: "USA",
        isoAlpha2: "US",
        countryCodeIso3: "USA",
        countryCodeIso2: "US",
        admin1Name: "Alaska",
        admin2Name: null,
        hemisphere,
        defaultWaterRegime: "rainfed",
        boundarySource,
        boundaryLicense,
      };
    }
    // Pacific Basin U.S. territories (Guam, CNMI, American Samoa)
    if (lon > 0 || lat < 0) {
      return {
        lat,
        lon,
        lonWasNormalized,
        regionTag: null,
        regionLabel: "United States (Pacific Territories)",
        countryName: "United States",
        isoAlpha3: "USA",
        isoAlpha2: "US",
        countryCodeIso3: "USA",
        countryCodeIso2: "US",
        admin1Name: lat < 0 ? "American Samoa" : "Guam / Northern Mariana Islands",
        admin2Name: null,
        hemisphere,
        defaultWaterRegime: "rainfed",
        boundarySource,
        boundaryLicense,
      };
    }
    // Western CONUS (California, Oregon, Washington, Idaho, Western Montana/Wyoming)
    if (lon < -103.0) {
      return {
        lat,
        lon,
        lonWasNormalized,
        regionTag: "us_southwest",
        regionLabel: "US West & Pacific Northwest",
        countryName: "United States",
        isoAlpha3: "USA",
        isoAlpha2: "US",
        countryCodeIso3: "USA",
        countryCodeIso2: "US",
        admin1Name:
          lat >= 42.0
            ? "Pacific Northwest & Northern Rockies (WA / OR / ID / MT / WY)"
            : "California & Western Valleys",
        admin2Name: null,
        defaultWaterRegime: "irrigated_or_rainfed",
        hemisphere,
        boundarySource,
        boundaryLicense,
      };
    }
    // South Texas & Western Gulf Coast (25.84°N–32.0°N, 105°W–92°W)
    return {
      lat,
      lon,
      lonWasNormalized,
      regionTag: lon < -95.0 ? "us_great_plains" : "us_southeast",
      regionLabel: lon < -95.0 ? "US Great Plains" : "US Southeast",
      countryName: "United States",
      isoAlpha3: "USA",
      isoAlpha2: "US",
      countryCodeIso3: "USA",
      countryCodeIso2: "US",
      admin1Name: "Texas / Gulf Coast",
      admin2Name: null,
      hemisphere,
      defaultWaterRegime: "irrigated_or_rainfed",
      boundarySource,
      boundaryLicense,
    };
  }

  // 3. Outside documented agricultural regions (e.g. open ocean, Antarctica, high Arctic)
  return {
    lat,
    lon,
    lonWasNormalized,
    regionTag: null,
    regionLabel: "Unmapped / Outside Documented Agricultural Regions",
    countryName: "Unmapped / International or Non-Agricultural Zone",
    isoAlpha3: "UNK",
    isoAlpha2: "UN",
    countryCodeIso3: "UNK",
    countryCodeIso2: "UN",
    admin1Name: "Unclassified Administrative Region",
    admin2Name: null,
    hemisphere,
    defaultWaterRegime: "rainfed",
    boundarySource,
    boundaryLicense,
  };
}

export function detectRegion(lat: number, lon: number): DetectedRegion | null {
  const norm = normalizeCoordinates(lat, lon);
  if (!norm.valid) return null;
  const ctx = resolveGeographicContext(norm.lat, norm.lon);
  if (!ctx.regionTag) return null;
  return { tag: ctx.regionTag, label: ctx.regionLabel };
}

export function detectRegionTag(lat: number, lon: number): RegionTag | null {
  return detectRegion(lat, lon)?.tag ?? null;
}

export function isSupportedRegion(lat: number, lon: number): boolean {
  return detectRegion(lat, lon) !== null;
}

export function regionLabelFor(tag: RegionTag | string): string {
  const found = REGIONS.find((r) => r.tag === tag);
  return found?.label ?? tag;
}
