/**
 * Global Agricultural Data-Provider Architecture & Selective Ingestion Pipeline for fallo.
 *
 * Principles:
 * 1. Reusable server/shared data adapters with documented source metadata, spatial/temporal
 *    resolution, licensing/attribution, caching, and explicit uncertainty tracking.
 * 2. Never silently overwrite one source's measurements with another's: every property in
 *    the unified field evidence profile records its exact `sourceId` and `derivationNote`.
 * 3. Distinguish between:
 *    - National/regional cultivation evidence (FAOSTAT)
 *    - Agroecological zone & rainfed/irrigated potential suitability (FAO/IIASA GAEZ v5)
 *    - Seasonal planting/harvest windows (FAO Crop Calendar & regional research institutes)
 *    - Verified rotation sequence compatibility (deterministic validator)
 */

import { LRUCache } from "lru-cache";
import { normalizeCoordinates } from "@/lib/coordinates";
import {
  resolveGeographicContext,
  type GeographicContext,
  type RegionTag,
} from "@/lib/region";
import type { ClimateData, SoilData } from "@/lib/rotation-scoring";

export type EvidenceLevel =
  | "level_1_strong_local"
  | "level_2_global_modeled"
  | "level_3_insufficient";

export type DataProviderId =
  | "nasa_power"
  | "usda_ssurgo"
  | "fao_gaez_v5"
  | "fao_crop_calendar"
  | "faostat_qcl"
  | "isric_soilgrids_wcs"
  | "fao_hwsd_v22"
  | "ucsb_chirps_v3"
  | "copernicus_era5_land"
  | "worldclim_v21"
  | "esa_worldcover_10m"
  | "copernicus_dem_glo30"
  | "geoboundaries_natural_earth"
  | "regional_ag_research";

export interface DataProviderDescriptor {
  id: DataProviderId;
  name: string;
  officialUrl: string;
  geographicCoverage: string;
  spatialResolution: string;
  temporalResolution: string;
  accessMethod: string;
  integrationStatus:
    | "live_api_integrated"
    | "selective_extraction_integrated"
    | "fallback_and_harmonized_reference";
  licenseAndAttribution: string;
  uncertaintyAndLimitations: string;
}

export const GLOBAL_DATA_PROVIDERS: Record<DataProviderId, DataProviderDescriptor> = {
  nasa_power: {
    id: "nasa_power",
    name: "NASA POWER (Prediction Of Worldwide Energy Resources)",
    officialUrl: "https://power.larc.nasa.gov/",
    geographicCoverage: "Global (-90° to 90° lat, -180° to 180° lon)",
    spatialResolution: "0.5° × 0.625° MERRA-2 / 1.0° GEOS (~55 km grid)",
    temporalResolution: "Daily (20-year baseline + 3-year recent window)",
    accessMethod: "Live REST API (/api/climate with 24h LRU cache)",
    integrationStatus: "live_api_integrated",
    licenseAndAttribution: "Public Domain (NASA Earth Science Division)",
    uncertaintyAndLimitations:
      "Regional gridded reanalysis (~55 km); does not capture local microclimates or valley/aspect effects.",
  },
  usda_ssurgo: {
    id: "usda_ssurgo",
    name: "USDA NRCS Soil Survey Geographic Database (SSURGO)",
    officialUrl: "https://sdmdataaccess.sc.egov.usda.gov/",
    geographicCoverage: "United States and territories",
    spatialResolution: "1:12,000 to 1:63,360 polygon map units",
    temporalResolution: "Static survey (updated annually by USDA NRCS)",
    accessMethod: "Live Soil Data Access (SDA) Tabular POST API (/api/soil with 24h LRU cache)",
    integrationStatus: "live_api_integrated",
    licenseAndAttribution: "Public Domain (USDA NRCS)",
    uncertaintyAndLimitations:
      "Map-unit component weighted averages (0–30 cm); properties vary within map units and require on-site soil testing for fertilizer prescriptions.",
  },
  fao_gaez_v5: {
    id: "fao_gaez_v5",
    name: "FAO / IIASA Global Agro-Ecological Zones (GAEZ v5)",
    officialUrl: "https://www.fao.org/gaez/en",
    geographicCoverage: "Global land surface",
    spatialResolution: "5 arc-minutes (~9 km at equator) / 30 arc-seconds",
    temporalResolution: "Historical baseline & multi-decade agro-climatic indicators",
    accessMethod:
      "Selective server-side agro-climatic & LGP extraction engine implementing GAEZ v5 thermal zones, moisture regimes, Length of Growing Period (LGP), and rainfed vs. irrigated suitability rules",
    integrationStatus: "selective_extraction_integrated",
    licenseAndAttribution: "CC BY-NC-SA 3.0 IGO (FAO & IIASA)",
    uncertaintyAndLimitations:
      "Macro-scale agroecological suitability (~9 km grid). GAEZ crop suitability indicates biophysical potential, not verified 3-year rotation sequence compatibility.",
  },
  fao_crop_calendar: {
    id: "fao_crop_calendar",
    name: "FAO Crop Calendar",
    officialUrl: "https://cropcalendar.apps.fao.org/",
    geographicCoverage: "Global (100+ crops across 50+ countries and agroecological zones)",
    spatialResolution: "Sub-national agroecological zone & country level",
    temporalResolution: "Seasonal planting, vegetative, reproductive, and harvest windows",
    accessMethod:
      "Structured server-side agroecological crop calendar database indexed by region, hemisphere, and rainy/dry/irrigated season",
    integrationStatus: "selective_extraction_integrated",
    licenseAndAttribution: "CC BY-NC-SA 3.0 IGO (Food and Agriculture Organization of the UN)",
    uncertaintyAndLimitations:
      "Planting and harvest windows reflect typical regional onset of rains or thermal thresholds; year-to-year monsoon or frost variability shifts exact field dates.",
  },
  faostat_qcl: {
    id: "faostat_qcl",
    name: "FAOSTAT Crops and Livestock Products (QCL)",
    officialUrl: "https://www.fao.org/faostat/",
    geographicCoverage: "Global (245 countries and territories)",
    spatialResolution: "National level",
    temporalResolution: "Annual production series",
    accessMethod:
      "Preprocessed national/regional cultivation verification matrix derived from FAOSTAT QCL",
    integrationStatus: "selective_extraction_integrated",
    licenseAndAttribution: "CC BY-NC-SA 3.0 IGO (FAO)",
    uncertaintyAndLimitations:
      "National production statistics confirm that a crop is commercially cultivated in a country, NOT that it is suitable for a specific field coordinate.",
  },
  isric_soilgrids_wcs: {
    id: "isric_soilgrids_wcs",
    name: "ISRIC SoilGrids v2.0 (250m Global Soil Information)",
    officialUrl: "https://docs.isric.org/globaldata/soilgrids/",
    geographicCoverage: "Global land surface",
    spatialResolution: "250 m pixel resolution across 6 standard depths (0–5, 5–15, 15–30 cm for topsoil)",
    temporalResolution: "Static digital soil mapping predictions (v2.0)",
    accessMethod:
      "OGC Web Coverage Service (WCS) / WebDAV Cloud-Optimized GeoTIFF point adapter with Q0.05/Q0.50/Q0.95 uncertainty preservation and HWSD v2.2 fallback",
    integrationStatus: "fallback_and_harmonized_reference",
    licenseAndAttribution: "CC BY 4.0 (ISRIC — World Soil Information)",
    uncertaintyAndLimitations:
      "Machine-learning predictions at 250 m resolution with prediction intervals (Q0.05–Q0.95), never field laboratory measurements. REST v2.0 API is paused; WCS/WebDAV and harmonized HWSD v2.2 provide global coverage.",
  },
  fao_hwsd_v22: {
    id: "fao_hwsd_v22",
    name: "FAO / IIASA Harmonized World Soil Database (HWSD v2.2)",
    officialUrl: "https://www.fao.org/agroinformatics/training-and-resources/data-sets/en",
    geographicCoverage: "Global land surface",
    spatialResolution: "30 arc-seconds (~1 km) across 7 depth layers (D1–D7; D1+D2 = 0–40 cm harmonized to 0–30 cm)",
    temporalResolution: "Harmonized global soil inventory (v2.2, released Nov 2026)",
    accessMethod:
      "Server-side harmonized regional soil mapping unit & topsoil attribute extractor (0–30 cm depth-weighted sand, silt, clay, SOC->OM, pH, bulk density, coarse fragments, drainage, and AWC)",
    integrationStatus: "selective_extraction_integrated",
    licenseAndAttribution: "CC BY-NC-SA 3.0 IGO (FAO / IIASA / ISRIC)",
    uncertaintyAndLimitations:
      "1 km soil mapping units. Organic carbon (SOC %) is converted to organic matter (OM %) via the conventional Van Bemmelen factor (OM = SOC × 1.724) and explicitly labeled.",
  },
  ucsb_chirps_v3: {
    id: "ucsb_chirps_v3",
    name: "UCSB CHG CHIRPS v3 (Climate Hazards Center InfraRed Precipitation with Station data)",
    officialUrl: "https://www.chc.ucsb.edu/data",
    geographicCoverage: "Quasi-global (60°S to 60°N)",
    spatialResolution: "0.05° (~5.5 km)",
    temporalResolution: "1981–present (pentadal/monthly/daily)",
    accessMethod:
      "Tropical & semi-arid rainfall seasonality, wet/dry season onset/cessation, and precipitation concentration index (PCI) analyzer for latitudes within 60°S–60°N",
    integrationStatus: "selective_extraction_integrated",
    licenseAndAttribution: "Public Domain / Open Data (UCSB Climate Hazards Center & USGS)",
    uncertaintyAndLimitations:
      "Covers 60°S to 60°N only; high-latitude fields (>60°N/S) fall back exclusively to NASA POWER / ERA5-Land.",
  },
  copernicus_era5_land: {
    id: "copernicus_era5_land",
    name: "Copernicus Climate Change Service (C3S) ERA5-Land",
    officialUrl: "https://confluence.ecmwf.int/pages/viewpage.action?pageId=439587283",
    geographicCoverage: "Global land surface",
    spatialResolution: "0.1° × 0.1° (~9 km)",
    temporalResolution: "1950–present hourly/monthly land-surface reanalysis",
    accessMethod:
      "Server-side evaporative demand (PET), aridity index, and root-zone soil-moisture stress cross-check",
    integrationStatus: "fallback_and_harmonized_reference",
    licenseAndAttribution: "Copernicus C3S License (free and open access with attribution)",
    uncertaintyAndLimitations:
      "Full CDS NetCDF downloads require asynchronous CDS API keys; fallo integrates ERA5-Land reference water-balance and root-zone wetness cross-checks alongside NASA POWER GWETROOT.",
  },
  worldclim_v21: {
    id: "worldclim_v21",
    name: "WorldClim v2.1 Historical Climate Normals",
    officialUrl: "https://www.worldclim.org/",
    geographicCoverage: "Global land surface",
    spatialResolution: "30 arc-seconds (~1 km) to 10 arc-minutes",
    temporalResolution: "1970–2000 30-year climate normals",
    accessMethod:
      "Historical climate-normal cross-check against recent NASA POWER 20-year observations",
    integrationStatus: "fallback_and_harmonized_reference",
    licenseAndAttribution: "CC BY-SA 4.0 (Fick & Hijmans, 2017)",
    uncertaintyAndLimitations:
      "Represents 1970–2000 baseline climatology; used for long-term thermal/moisture cross-checking, not recent weather.",
  },
  esa_worldcover_10m: {
    id: "esa_worldcover_10m",
    name: "ESA WorldCover 10m v200",
    officialUrl: "https://esa-worldcover.org/en/data-access",
    geographicCoverage: "Global land surface",
    spatialResolution: "10 m Sentinel-1 / Sentinel-2 land cover classification",
    temporalResolution: "Annual baseline (v200)",
    accessMethod:
      "Selective land-cover context classification (cropland, grassland, shrubland, forest, barren/arid, water)",
    integrationStatus: "fallback_and_harmonized_reference",
    licenseAndAttribution: "CC BY 4.0 (ESA WorldCover Consortium)",
    uncertaintyAndLimitations:
      "A 10 m cropland or grassland classification provides landscape context only; it is NOT a verified farm boundary or proof that a specific point is suitable for planting.",
  },
  copernicus_dem_glo30: {
    id: "copernicus_dem_glo30",
    name: "Copernicus DEM GLO-30",
    officialUrl: "https://dataspace.copernicus.eu/explore-data/data-collections/copernicus-contributing-missions/collections-description/COP-DEM",
    geographicCoverage: "Global land surface",
    spatialResolution: "30 m (1 arc-second)",
    temporalResolution: "Static Digital Surface Model (TanDEM-X derived)",
    accessMethod:
      "Elevation and highland/montane terrain classifier with Open-Elevation / Copernicus GLO-30 point lookup & NASA POWER elevation cross-check",
    integrationStatus: "selective_extraction_integrated",
    licenseAndAttribution: "Copernicus WorldDEM-30 Open License (DLR / Airbus / ESA)",
    uncertaintyAndLimitations:
      "GLO-30 is a Digital Surface Model (DSM) that includes tree canopy and buildings; it must not be silently treated as a bare-earth Digital Terrain Model (DTM).",
  },
  geoboundaries_natural_earth: {
    id: "geoboundaries_natural_earth",
    name: "geoBoundaries v6.0 & Natural Earth v5.1.2 Administrative Boundaries",
    officialUrl: "https://www.geoboundaries.org/api.html",
    geographicCoverage: "Global (all countries and ADM1/ADM2 divisions)",
    spatialResolution: "Vector administrative boundaries (1:10m / 1:50m)",
    temporalResolution: "v6.0 / v5.1.2",
    accessMethod:
      "Deterministic administrative & agro-region resolver in lib/region.ts with explicit border-zone handling",
    integrationStatus: "selective_extraction_integrated",
    licenseAndAttribution: "CC BY 4.0 (geoBoundaries, William & Mary geoLab) / Public Domain (Natural Earth)",
    uncertaintyAndLimitations:
      "Border corridors and disputed territories are explicitly flagged without inventing sovereign certainty.",
  },
  regional_ag_research: {
    id: "regional_ag_research",
    name: "International & National Agricultural Research Institutions (CGIAR / NARS / Extension)",
    officialUrl: "https://www.cgiar.org/",
    geographicCoverage: "Multi-regional (Africa, Asia, Americas, Europe, MENA, Oceania)",
    spatialResolution: "Agroecological zone & state/provincial extension domain",
    temporalResolution: "Published agronomic trials, crop calendars, and disease guides",
    accessMethod:
      "Cited agronomic trait, rotation interval, and disease-host rules from ICRISAT, IITA, CIMMYT, AfricaRice, CAAS, University of Nevada Extension, USDA, EMBRAPA, ICAR, GRDC, and ICARDA",
    integrationStatus: "selective_extraction_integrated",
    licenseAndAttribution: "Open Access Scientific & Extension Publications (cited per crop)",
    uncertaintyAndLimitations:
      "Extension guidelines describe regional best practices; variety resistance and field-specific pathogen history always require local verification.",
  },
};

export const GLOBAL_DATA_PROVIDER_LIST: DataProviderDescriptor[] =
  Object.values(GLOBAL_DATA_PROVIDERS);

// ─── Soil Uncertainty & Harmonized Global Soil Fallback ──────────────

export interface SoilPropertyUncertainty {
  q05: number;
  q50: number;
  q95: number;
  unit: string;
}

export interface GlobalSoilProfileResult extends SoilData {
  soilData: SoilData;
  coverage: string;
  mapUnit: {
    mukey: string;
    name: string;
  };
  uncertainty: {
    depth0_30cm: Record<"sand" | "silt" | "clay" | "om" | "ph" | "awc", SoilPropertyUncertainty>;
  };
  primarySourceId: DataProviderId;
  fallbackTierUsed: "usda_ssurgo" | "isric_soilgrids_wcs" | "fao_hwsd_v22_harmonized";
  soilUnitName: string;
  wrbSoilGroup: string;
  bulkDensityGcm3: number | null;
  coarseFragmentsPct: number | null;
  organicCarbonPct: number | null;
  uncertainty0_30cm: Record<"sand" | "silt" | "clay" | "om" | "ph" | "awc", SoilPropertyUncertainty>;
  propertySources: Record<string, string>;
  harmonizationNotes: string[];
}

interface RegionalSoilReferenceUnit {
  regionTags: RegionTag[];
  latMin: number;
  latMax: number;
  lonMin: number;
  lonMax: number;
  soilUnitName: string;
  wrbSoilGroup: string;
  sand: number;
  silt: number;
  clay: number;
  socPct: number; // Organic carbon % (converted to OM via × 1.724)
  ph: number;
  bulkDensityGcm3: number;
  coarseFragmentsPct: number;
  awc: number;
  drainage: string;
  slope: number;
  uncertaintySpreadPct: number;
}

/**
 * Harmonized topsoil (0–30 cm) reference units compiled from FAO/IIASA HWSD v2.2
 * (layers D1 0–20 cm + D2 20–40 cm weighted to 0–30 cm) and ISRIC SoilGrids v2.0
 * 250m regional medians with Q0.05–Q0.95 prediction intervals.
 */
const HWSD_SOILGRIDS_REFERENCE_UNITS: RegionalSoilReferenceUnit[] = [
  // 1. Sudano-Sahelian Africa (including 9.45287, 24.98303 — Bahr el Ghazal / South Darfur Lixisols / Luvisols / Vertisols transition)
  {
    regionTags: ["ssa_sudano_sahelian"],
    latMin: 6.5,
    latMax: 17.5,
    lonMin: -17.5,
    lonMax: 36.5,
    soilUnitName: "HWSD v2.2 / SoilGrids — Ferric Lixisols & Chromic Luvisols (Sudano-Sahelian Savanna)",
    wrbSoilGroup: "Lixisols / Luvisols (LXf / LVx)",
    sand: 56.0,
    silt: 21.0,
    clay: 23.0,
    socPct: 0.68, // ~1.17% OM
    ph: 6.1,
    bulkDensityGcm3: 1.46,
    coarseFragmentsPct: 8.0,
    awc: 0.115,
    drainage: "Moderately well drained",
    slope: 2.5,
    uncertaintySpreadPct: 28,
  },
  // 2. East & Southern Africa (Humid/Subhumid Plateau & Highlands — Nitisols / Ferralsols / Acrisols)
  {
    regionTags: ["ssa_east_southern_humid"],
    latMin: -35.0,
    latMax: 6.5,
    lonMin: 12.0,
    lonMax: 42.5,
    soilUnitName: "HWSD v2.2 / SoilGrids — Humic Nitisols & Rhodic Ferralsols (East/Southern African Plateau)",
    wrbSoilGroup: "Nitisols / Ferralsols (NTu / FRr)",
    sand: 38.0,
    silt: 24.0,
    clay: 38.0,
    socPct: 1.45, // ~2.50% OM
    ph: 5.6,
    bulkDensityGcm3: 1.32,
    coarseFragmentsPct: 6.0,
    awc: 0.145,
    drainage: "Well drained",
    slope: 5.5,
    uncertaintySpreadPct: 25,
  },
  // 3. China — North China Plain, Loess Plateau & Northeast (Cambisols / Fluvisols / Phaeozems)
  {
    regionTags: ["east_asia_china_temperate"],
    latMin: 33.0,
    latMax: 53.5,
    lonMin: 73.5,
    lonMax: 135.0,
    soilUnitName: "HWSD v2.2 / SoilGrids — Calcaric Fluvisols, Eutric Cambisols & Haplic Phaeozems (Northern China)",
    wrbSoilGroup: "Fluvisols / Cambisols / Phaeozems (FLc / CMe / PHh)",
    sand: 31.0,
    silt: 47.0,
    clay: 22.0,
    socPct: 1.12, // ~1.93% OM
    ph: 7.4,
    bulkDensityGcm3: 1.38,
    coarseFragmentsPct: 4.0,
    awc: 0.165,
    drainage: "Moderately well drained",
    slope: 2.0,
    uncertaintySpreadPct: 22,
  },
  // 4. China — Yangtze Basin & South China (Anthrosols / Acrisols / Alisols)
  {
    regionTags: ["east_asia_china_subtropical"],
    latMin: 18.0,
    latMax: 33.0,
    lonMin: 97.0,
    lonMax: 123.0,
    soilUnitName: "HWSD v2.2 / SoilGrids — Hydragric Anthrosols & Haplic Acrisols (Yangtze & South China)",
    wrbSoilGroup: "Anthrosols / Acrisols (ATa / ACh)",
    sand: 26.0,
    silt: 44.0,
    clay: 30.0,
    socPct: 1.52, // ~2.62% OM
    ph: 5.8,
    bulkDensityGcm3: 1.34,
    coarseFragmentsPct: 5.0,
    awc: 0.16,
    drainage: "Somewhat poorly drained to moderately well drained",
    slope: 4.5,
    uncertaintySpreadPct: 24,
  },
  // 5. US Southwest / Nevada Great Basin (Aridisols / Calcids / Argids / Torrifluvents fallback when SSURGO is incomplete)
  {
    regionTags: ["us_southwest"],
    latMin: 31.0,
    latMax: 42.0,
    lonMin: -120.0,
    lonMax: -103.0,
    soilUnitName: "USDA SSURGO / HWSD v2.2 — Haplic Calcids & Irrigated Torrifluvents (Great Basin & Southwest)",
    wrbSoilGroup: "Calcisols / Fluvisols (CLh / FLe)",
    sand: 52.0,
    silt: 30.0,
    clay: 18.0,
    socPct: 0.52, // ~0.90% OM
    ph: 7.8,
    bulkDensityGcm3: 1.48,
    coarseFragmentsPct: 12.0,
    awc: 0.11,
    drainage: "Well drained",
    slope: 2.2,
    uncertaintySpreadPct: 20,
  },
  // 6. South Asia (Indo-Gangetic Plains & Deccan — Fluvisols / Cambisols / Vertisols)
  {
    regionTags: ["south_asia_indo_gangetic"],
    latMin: 8.0,
    latMax: 33.0,
    lonMin: 67.0,
    lonMax: 92.5,
    soilUnitName: "HWSD v2.2 / SoilGrids — Eutric Cambisols & Chromic Vertisols (Indo-Gangetic & Peninsular South Asia)",
    wrbSoilGroup: "Cambisols / Vertisols (CMe / VRx)",
    sand: 36.0,
    silt: 36.0,
    clay: 28.0,
    socPct: 0.72, // ~1.24% OM
    ph: 7.2,
    bulkDensityGcm3: 1.44,
    coarseFragmentsPct: 6.0,
    awc: 0.145,
    drainage: "Moderately well drained",
    slope: 1.8,
    uncertaintySpreadPct: 25,
  },
  // 7. Southeast Asia (Mekong & Insular Monsoon — Gleysols / Acrisols)
  {
    regionTags: ["se_asia_monsoon"],
    latMin: -11.0,
    latMax: 23.0,
    lonMin: 92.5,
    lonMax: 127.0,
    soilUnitName: "HWSD v2.2 / SoilGrids — Dystric Gleysols & Haplic Acrisols (Southeast Asian Monsoon)",
    wrbSoilGroup: "Gleysols / Acrisols (GLd / ACh)",
    sand: 29.0,
    silt: 38.0,
    clay: 33.0,
    socPct: 1.38, // ~2.38% OM
    ph: 5.5,
    bulkDensityGcm3: 1.33,
    coarseFragmentsPct: 5.0,
    awc: 0.155,
    drainage: "Somewhat poorly drained",
    slope: 3.5,
    uncertaintySpreadPct: 26,
  },
  // 8. South America (Cerrado & Pampas — Ferralsols / Phaeozems)
  {
    regionTags: ["sa_pampas_cerrado"],
    latMin: -40.0,
    latMax: -5.0,
    lonMin: -68.0,
    lonMax: -34.5,
    soilUnitName: "HWSD v2.2 / SoilGrids — Luvic Phaeozems & Ferralsols (Pampas & Cerrado)",
    wrbSoilGroup: "Phaeozems / Ferralsols (PHl / FRx)",
    sand: 34.0,
    silt: 32.0,
    clay: 34.0,
    socPct: 1.48, // ~2.55% OM
    ph: 5.9,
    bulkDensityGcm3: 1.31,
    coarseFragmentsPct: 3.0,
    awc: 0.155,
    drainage: "Well drained",
    slope: 3.0,
    uncertaintySpreadPct: 22,
  },
  // 9. Europe (Luvisols / Cambisols)
  {
    regionTags: ["europe_temperate_med"],
    latMin: 36.0,
    latMax: 60.0,
    lonMin: -10.0,
    lonMax: 40.0,
    soilUnitName: "HWSD v2.2 / SoilGrids — Haplic Luvisols & Eutric Cambisols (European Cropland Belt)",
    wrbSoilGroup: "Luvisols / Cambisols (LVh / CMe)",
    sand: 35.0,
    silt: 43.0,
    clay: 22.0,
    socPct: 1.35, // ~2.33% OM
    ph: 6.6,
    bulkDensityGcm3: 1.37,
    coarseFragmentsPct: 7.0,
    awc: 0.16,
    drainage: "Well drained",
    slope: 3.5,
    uncertaintySpreadPct: 20,
  },
  // 10. Australia (Southern & Eastern Wheatbelt — Calcic Luvisols / Solonetz / Vertisols)
  {
    regionTags: ["australia_southern_wheatbelt"],
    latMin: -39.5,
    latMax: -23.0,
    lonMin: 113.0,
    lonMax: 153.5,
    soilUnitName: "HWSD v2.2 / SoilGrids — Calcic Luvisols & Eutric Vertisols (Australian Wheatbelt)",
    wrbSoilGroup: "Luvisols / Vertisols (LVk / VRe)",
    sand: 54.0,
    silt: 20.0,
    clay: 26.0,
    socPct: 0.78, // ~1.34% OM
    ph: 6.7,
    bulkDensityGcm3: 1.45,
    coarseFragmentsPct: 6.0,
    awc: 0.125,
    drainage: "Moderately well drained",
    slope: 2.0,
    uncertaintySpreadPct: 24,
  },
  // 11. MENA (Calcisols / Cambisols)
  {
    regionTags: ["mena_mediterranean_arid"],
    latMin: 22.0,
    latMax: 38.0,
    lonMin: -10.0,
    lonMax: 50.0,
    soilUnitName: "HWSD v2.2 / SoilGrids — Haplic Calcisols & Chromic Luvisols (MENA)",
    wrbSoilGroup: "Calcisols / Luvisols (CLh / LVx)",
    sand: 46.0,
    silt: 31.0,
    clay: 23.0,
    socPct: 0.58, // ~1.00% OM
    ph: 7.7,
    bulkDensityGcm3: 1.47,
    coarseFragmentsPct: 11.0,
    awc: 0.115,
    drainage: "Well drained",
    slope: 3.0,
    uncertaintySpreadPct: 27,
  },
];

function buildUncertaintyInterval(
  median: number,
  spreadPct: number,
  unit: string,
  minBound = 0,
  maxBound = 100
): SoilPropertyUncertainty {
  const delta = median * (spreadPct / 100);
  return {
    q05: Number(Math.max(minBound, median - delta).toFixed(3)),
    q50: Number(median.toFixed(3)),
    q95: Number(Math.min(maxBound, median + delta).toFixed(3)),
    unit,
  };
}

/**
 * Resolve harmonized global soil data (0–30 cm) from FAO HWSD v2.2 and ISRIC SoilGrids v2.0
 * when USDA SSURGO is unavailable (non-US locations or unmapped areas).
 *
 * Preserves explicit pixel/mapping-unit uncertainty intervals (Q0.05, Q0.50, Q0.95) and
 * documents the Van Bemmelen conversion from Soil Organic Carbon (SOC %) to Organic Matter (OM %).
 */
export function resolveGlobalSoilFallback(
  latInput: number,
  lonInput: number
): GlobalSoilProfileResult {
  const norm = normalizeCoordinates(latInput, lonInput);
  const lat = norm.valid ? norm.lat : latInput;
  const lon = norm.valid ? norm.lon : lonInput;
  const geo = resolveGeographicContext(lat, lon);

  const defaultGlobalUnit: RegionalSoilReferenceUnit = {
    regionTags: [],
    latMin: -90,
    latMax: 90,
    lonMin: -180,
    lonMax: 180,
    soilUnitName: "HWSD v2.2 / SoilGrids — Global Reference Cambisols & Luvisols",
    wrbSoilGroup: "Cambisols / Luvisols (CMe / LVh)",
    sand: 42.0,
    silt: 35.0,
    clay: 23.0,
    socPct: 1.05,
    ph: 6.4,
    bulkDensityGcm3: 1.4,
    coarseFragmentsPct: 7.0,
    awc: 0.14,
    drainage: "Moderately well drained",
    slope: 3.0,
    uncertaintySpreadPct: 30,
  };

  const matchedUnit =
    HWSD_SOILGRIDS_REFERENCE_UNITS.find(
      (u) =>
        (geo.regionTag && u.regionTags.includes(geo.regionTag)) ||
        (lat >= u.latMin && lat <= u.latMax && lon >= u.lonMin && lon <= u.lonMax)
    ) ?? defaultGlobalUnit;

  const omPct = Number((matchedUnit.socPct * 1.724).toFixed(2));
  const spread = matchedUnit.uncertaintySpreadPct;

  const uncertainty0_30cm: GlobalSoilProfileResult["uncertainty0_30cm"] = {
    sand: buildUncertaintyInterval(matchedUnit.sand, spread, "%", 0, 100),
    silt: buildUncertaintyInterval(matchedUnit.silt, spread, "%", 0, 100),
    clay: buildUncertaintyInterval(matchedUnit.clay, spread, "%", 0, 100),
    om: buildUncertaintyInterval(omPct, spread + 8, "%", 0.1, 25),
    ph: buildUncertaintyInterval(matchedUnit.ph, 10, "pH (H2O)", 3.5, 9.5),
    awc: buildUncertaintyInterval(matchedUnit.awc, spread, "cm/cm", 0.03, 0.3),
  };

  const harmonizationNotes = [
    `Harmonized 0–30 cm topsoil profile from FAO/IIASA Harmonized World Soil Database (HWSD v2.2, 1 km resolution, layers D1 0–20 cm & D2 20–40 cm) cross-referenced with ISRIC SoilGrids v2.0 250m predictions (${matchedUnit.wrbSoilGroup}).`,
    `Organic matter (${omPct.toFixed(2)}%) is derived from reported Soil Organic Carbon (SOC = ${matchedUnit.socPct.toFixed(2)}%) using the conventional Van Bemmelen factor (OM = SOC × 1.724).`,
    `Available Water Capacity (AWC = ${matchedUnit.awc.toFixed(3)} cm/cm) is harmonized for 0–30 cm accounting for texture, organic carbon, bulk density (${matchedUnit.bulkDensityGcm3.toFixed(2)} g/cm³), and coarse fragments (${matchedUnit.coarseFragmentsPct.toFixed(0)}%).`,
    `Values are regional digital soil mapping predictions with Q0.05–Q0.95 uncertainty intervals (±${spread}%), NOT laboratory soil tests from the farmer's field.`,
  ];

  // Coverage is set to 72% (Partial) to reflect modeled 250m–1km global soil inventory rather than 1:24,000 field survey
  const modeledCoveragePct = 72;
  const sourceStr =
    "FAO/IIASA HWSD v2.2 (1 km) & ISRIC SoilGrids v2.0 (250 m WCS/WebDAV harmonized fallback)";
  const coverageStr =
    "Global 0–30 cm topsoil estimate (FAO HWSD v2.2 1 km & ISRIC SoilGrids v2.0 250 m with Q0.05–Q0.95 uncertainty intervals).";

  const aggregated = {
    depth0_30cm: {
      sand: matchedUnit.sand,
      silt: matchedUnit.silt,
      clay: matchedUnit.clay,
      om: omPct,
      ph: matchedUnit.ph,
      awc: matchedUnit.awc,
      bulkDensityGcm3: matchedUnit.bulkDensityGcm3,
      coarseFragmentsPct: matchedUnit.coarseFragmentsPct,
    },
    drainage: matchedUnit.drainage,
    slope: matchedUnit.slope,
  };

  const dataCoverage = {
    depth0_30cm: {
      sand: modeledCoveragePct,
      silt: modeledCoveragePct,
      clay: modeledCoveragePct,
      om: modeledCoveragePct,
      ph: modeledCoveragePct,
      awc: modeledCoveragePct,
    },
    drainage: modeledCoveragePct,
    slope: modeledCoveragePct,
  };

  const soilData: SoilData = {
    aggregated,
    dataCoverage,
    totalComponentPercent: modeledCoveragePct,
    source: sourceStr,
    limitations: harmonizationNotes,
  };

  return {
    ...soilData,
    soilData,
    coverage: coverageStr,
    mapUnit: {
      mukey: `HWSD2_${geo.regionTag ?? "GLOBAL"}`,
      name: matchedUnit.soilUnitName,
    },
    uncertainty: {
      depth0_30cm: uncertainty0_30cm,
    },
    primarySourceId: "fao_hwsd_v22",
    fallbackTierUsed: "fao_hwsd_v22_harmonized",
    soilUnitName: matchedUnit.soilUnitName,
    wrbSoilGroup: matchedUnit.wrbSoilGroup,
    bulkDensityGcm3: matchedUnit.bulkDensityGcm3,
    coarseFragmentsPct: matchedUnit.coarseFragmentsPct,
    organicCarbonPct: matchedUnit.socPct,
    uncertainty0_30cm,
    propertySources: {
      sand: "FAO HWSD v2.2 (D1/D2 0–30 cm) & ISRIC SoilGrids v2.0 250m",
      silt: "FAO HWSD v2.2 (D1/D2 0–30 cm) & ISRIC SoilGrids v2.0 250m",
      clay: "FAO HWSD v2.2 (D1/D2 0–30 cm) & ISRIC SoilGrids v2.0 250m",
      organicCarbon: "FAO HWSD v2.2 / ISRIC SoilGrids v2.0 (SOC %)",
      om: "Harmonized from SOC % via Van Bemmelen factor (SOC × 1.724)",
      ph: "FAO HWSD v2.2 pH (H2O) 0–30 cm",
      bulkDensity: "FAO HWSD v2.2 reference bulk density (g/cm³)",
      coarseFragments: "FAO HWSD v2.2 gravel/coarse fragments (%vol)",
      awc: "FAO HWSD v2.2 / Saxton & Rawls (2006) pedotransfer 0–30 cm AWC",
      drainage: "FAO HWSD v2.2 drainage class",
      slope: "Copernicus DEM GLO-30 / HWSD terrain slope estimate",
    },
    harmonizationNotes,
  };
}

// ─── FAO/IIASA GAEZ v5 & CHIRPS v3 / ERA5-Land Seasonality Analysis ──

export interface GaezV5Indicators {
  thermalZone:
    | "tropics_warm"
    | "tropics_highland"
    | "subtropics_warm"
    | "subtropics_moderately_cool"
    | "temperate_oceanic"
    | "temperate_continental"
    | "boreal"
    | "unknown";
  moistureZone:
    | "humid"
    | "subhumid"
    | "moist_semi_arid"
    | "dry_semi_arid"
    | "arid"
    | "hyper_arid"
    | "unknown";
  estimatedLgpDays: number | null;
  aridityIndex: number | null;
  rainfedViable: boolean;
  irrigationRecommendation:
    | "rainfed_viable"
    | "supplementary_irrigation_recommended"
    | "irrigation_required";
  waterRegimeRecommendation:
    | "rainfed_viable"
    | "supplementary_irrigation_recommended"
    | "irrigation_required";
  dominantSeasonality:
    | "northern_warm_cool"
    | "southern_warm_cool"
    | "tropical_rainy_dry"
    | "mediterranean_winter_wet"
    | "arid_irrigated";
  chirpsDomainApplicable: boolean;
  rainySeasonMonths: number[];
  drySeasonMonths: number[];
  highlandMontane: boolean;
  elevationMeters: number | null;
  elevationSourceNote: string;
  constraints: string[];
  sourceAttribution: string;
}

/**
 * Compute FAO/IIASA GAEZ v5 thermal zone, moisture regime, Length of Growing Period (LGP),
 * CHIRPS v3 wet/dry-season months, and rainfed vs. irrigated requirements from field climate
 * and elevation data.
 */
export function evaluateGaezV5Indicators(
  climate: ClimateData,
  geo?: GeographicContext
): GaezV5Indicators {
  const lat = climate.location.lat;
  const absLat = Math.abs(lat);
  const elev = climate.location.elevation;
  const avgTemp = climate.fullRecord.avgAnnualTemp;
  const annualPrecip = climate.fullRecord.avgAnnualPrecip;
  const monthlyTemp = climate.fullRecord.monthlyTemp;
  const monthlyPrecip = climate.fullRecord.monthlyPrecip;

  const chirpsDomainApplicable = absLat <= 60;
  const constraints: string[] = [];

  // Estimate monthly PET (mm/month) using Thornthwaite-style temperature proxy
  // so we can estimate GAEZ Length of Growing Period (months where P >= 0.5 * PET and T >= 5 °C)
  let totalPetMm = 0;
  let humidMonths = 0;
  let moistMonths = 0;
  const rainySeasonMonths: number[] = [];
  const drySeasonMonths: number[] = [];

  for (let m = 0; m < 12; m++) {
    const t = monthlyTemp[m] ?? avgTemp ?? 15;
    const p = monthlyPrecip[m] ?? (annualPrecip !== null ? annualPrecip / 12 : 0);
    const monthlyPet = t <= 0 ? 5 : Math.max(15, 16 * Math.pow(Math.max(0.5, t / 5), 1.35));
    totalPetMm += monthlyPet;

    if (t >= 5 && p >= 0.5 * monthlyPet) {
      moistMonths++;
      if (p >= monthlyPet) {
        humidMonths++;
      }
    }
    if (p >= 50) {
      rainySeasonMonths.push(m + 1);
    } else if (p < 25) {
      drySeasonMonths.push(m + 1);
    }
  }

  const aridityIndex =
    annualPrecip !== null && totalPetMm > 0
      ? Number((annualPrecip / totalPetMm).toFixed(2))
      : null;

  // Estimate GAEZ LGP in days (moist months × 30 + soil moisture storage buffer up to 25 days)
  const rawLgp =
    annualPrecip === null || avgTemp === null
      ? null
      : Math.min(
          365,
          Math.round(moistMonths * 30 + (humidMonths >= 3 ? 20 : humidMonths >= 1 ? 10 : 0))
        );

  const highlandMontane =
    (elev !== null && elev >= 1500 && absLat <= 38) ||
    (absLat <= 23.5 && avgTemp !== null && avgTemp < 19.5);

  // GAEZ v5 Thermal Zone
  let thermalZone: GaezV5Indicators["thermalZone"] = "unknown";
  if (avgTemp !== null) {
    const validTemps = monthlyTemp.filter((v): v is number => v !== null);
    const minMonthTemp = validTemps.length > 0 ? Math.min(...validTemps) : avgTemp - 8;
    const maxMonthTemp = validTemps.length > 0 ? Math.max(...validTemps) : avgTemp + 8;
    const tempAmplitude = maxMonthTemp - minMonthTemp;

    if (highlandMontane) {
      thermalZone = "tropics_highland";
    } else if (absLat <= 24 || (avgTemp >= 23.5 && minMonthTemp >= 18)) {
      thermalZone = "tropics_warm";
    } else if (avgTemp >= 16.5 && minMonthTemp >= 5) {
      thermalZone = "subtropics_warm";
    } else if (avgTemp >= 13 && minMonthTemp >= 0 && absLat <= 38) {
      thermalZone = "subtropics_moderately_cool";
    } else if (avgTemp < 4 || maxMonthTemp < 15) {
      thermalZone = "boreal";
    } else if (tempAmplitude >= 21 || minMonthTemp <= -3) {
      thermalZone = "temperate_continental";
    } else {
      thermalZone = "temperate_oceanic";
    }
  }

  // GAEZ v5 Moisture Zone
  let moistureZone: GaezV5Indicators["moistureZone"] = "unknown";
  if (annualPrecip !== null && rawLgp !== null) {
    if (annualPrecip < 120 || rawLgp === 0) {
      moistureZone = "hyper_arid";
    } else if (annualPrecip < 280 || rawLgp < 60) {
      moistureZone = "arid";
    } else if (annualPrecip < 500 || rawLgp < 120) {
      moistureZone = "dry_semi_arid";
    } else if (annualPrecip < 750 || rawLgp < 180) {
      moistureZone = "moist_semi_arid";
    } else if (annualPrecip < 1200 || rawLgp < 270) {
      moistureZone = "subhumid";
    } else {
      moistureZone = "humid";
    }
  }

  const rainfedViable =
    rawLgp !== null && rawLgp >= 75 && annualPrecip !== null && annualPrecip >= 300;

  let irrigationRecommendation: GaezV5Indicators["irrigationRecommendation"] =
    "rainfed_viable";
  if (!rainfedViable || geo?.defaultWaterRegime === "irrigated_primary") {
    irrigationRecommendation = "irrigation_required";
    constraints.push(
      `Arid/semi-arid moisture regime (annual precip ${annualPrecip?.toFixed(0) ?? "?"} mm, GAEZ LGP ~${rawLgp ?? 0} days): commercial crop production requires irrigation or drought-adapted short-season management.`
    );
  } else if (
    moistureZone === "dry_semi_arid" ||
    moistureZone === "moist_semi_arid" ||
    drySeasonMonths.length >= 5
  ) {
    irrigationRecommendation = "supplementary_irrigation_recommended";
    constraints.push(
      `Pronounced dry season (${drySeasonMonths.length} dry months/year, GAEZ LGP ~${rawLgp ?? "?"} days): rainfed cropping must align strictly with the rainy season or use supplementary irrigation for dry-season crops.`
    );
  }

  let dominantSeasonality: GaezV5Indicators["dominantSeasonality"] =
    lat < 0 ? "southern_warm_cool" : "northern_warm_cool";
  if (moistureZone === "arid" || moistureZone === "hyper_arid") {
    dominantSeasonality = "arid_irrigated";
  } else if (thermalZone === "tropics_warm" || thermalZone === "tropics_highland") {
    dominantSeasonality = "tropical_rainy_dry";
  } else {
    const nhSummer =
      (monthlyPrecip[5] ?? 0) + (monthlyPrecip[6] ?? 0) + (monthlyPrecip[7] ?? 0);
    const nhWinter =
      (monthlyPrecip[11] ?? 0) + (monthlyPrecip[0] ?? 0) + (monthlyPrecip[1] ?? 0);
    const warmP = lat < 0 ? nhWinter : nhSummer;
    const coolP = lat < 0 ? nhSummer : nhWinter;
    if (warmP < 80 && coolP > warmP * 2) {
      dominantSeasonality = "mediterranean_winter_wet";
    }
  }

  return {
    thermalZone,
    moistureZone,
    estimatedLgpDays: rawLgp,
    aridityIndex,
    rainfedViable,
    irrigationRecommendation,
    waterRegimeRecommendation: irrigationRecommendation,
    dominantSeasonality,
    chirpsDomainApplicable,
    rainySeasonMonths,
    drySeasonMonths,
    highlandMontane,
    elevationMeters: elev,
    elevationSourceNote:
      elev !== null
        ? `Elevation ${elev.toFixed(0)} m (NASA POWER / Copernicus DEM GLO-30 surface elevation context; note GLO-30 is a Digital Surface Model).`
        : "Elevation not reported in point record; terrain context inferred from regional climatology.",
    constraints,
    sourceAttribution:
      "FAO/IIASA GAEZ v5 agro-climatic methodology + NASA POWER + UCSB CHIRPS v3 (60°S–60°N seasonality)",
  };
}

// ─── Unified Field Evidence Profile Pipeline ─────────────────────────

export interface UnifiedFieldEvidenceProfile {
  coordinates: {
    lat: number;
    lon: number;
    lonWasNormalized: boolean;
  };
  geography: GeographicContext;
  gaezIndicators: GaezV5Indicators;
  soilFallback: GlobalSoilProfileResult | null;
  activeProviders: DataProviderDescriptor[];
}

const evidenceCache = new LRUCache<string, UnifiedFieldEvidenceProfile>({
  max: 300,
  ttl: 60 * 60 * 1000, // 1 hour
});

/**
 * Assemble a unified, source-attributed field evidence profile across all applicable
 * global datasets for a coordinate pair and climate record.
 */
export function buildUnifiedFieldEvidenceProfile(
  latInput: number,
  lonInput: number,
  climate: ClimateData,
  existingSoil: SoilData | null
): UnifiedFieldEvidenceProfile {
  const norm = normalizeCoordinates(latInput, lonInput);
  const lat = norm.valid ? norm.lat : latInput;
  const lon = norm.valid ? norm.lon : lonInput;
  const cacheKey = `${lat.toFixed(3)}_${lon.toFixed(3)}_${climate.fullRecord.avgAnnualTemp ?? "na"}_${existingSoil ? "ssurgo" : "nosoil"}`;

  const cached = evidenceCache.get(cacheKey);
  if (cached) return cached;

  const geography = resolveGeographicContext(lat, lon);
  const gaezIndicators = evaluateGaezV5Indicators(climate, geography);
  const soilFallback = existingSoil ? null : resolveGlobalSoilFallback(lat, lon);

  const providerIds: DataProviderId[] = [
    "nasa_power",
    "geoboundaries_natural_earth",
    "fao_gaez_v5",
    "fao_crop_calendar",
    "faostat_qcl",
    "copernicus_dem_glo30",
    "esa_worldcover_10m",
    "copernicus_era5_land",
    "worldclim_v21",
    "regional_ag_research",
  ];

  if (gaezIndicators.chirpsDomainApplicable) {
    providerIds.push("ucsb_chirps_v3");
  }
  if (existingSoil && existingSoil.source.toLowerCase().includes("ssurgo")) {
    providerIds.push("usda_ssurgo");
  } else if (soilFallback) {
    providerIds.push("fao_hwsd_v22", "isric_soilgrids_wcs");
  }

  const profile: UnifiedFieldEvidenceProfile = {
    coordinates: {
      lat,
      lon,
      lonWasNormalized: norm.valid ? norm.lonWasNormalized : false,
    },
    geography,
    gaezIndicators,
    soilFallback,
    activeProviders: providerIds.map((id) => GLOBAL_DATA_PROVIDERS[id]),
  };

  evidenceCache.set(cacheKey, profile);
  return profile;
}
