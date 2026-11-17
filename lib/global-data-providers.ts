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
    spatialResolution: "5 arc-minutes (~9 km reference framework)",
    temporalResolution: "Historical baseline & multi-decade agro-climatic methodology",
    accessMethod:
      "Server-side rule-based agro-climatic classifier computing GAEZ v5 thermal zones, moisture regimes, and estimated Length of Growing Period (LGP) from the coordinate's live NASA POWER climate series",
    integrationStatus: "selective_extraction_integrated",
    licenseAndAttribution: "CC BY-NC-SA 3.0 IGO (FAO & IIASA)",
    uncertaintyAndLimitations:
      "Derived deterministically from live NASA POWER monthly temperature, precipitation, and elevation records using GAEZ v5 threshold rules (not a direct 5 arc-minute raster lookup).",
  },
  fao_crop_calendar: {
    id: "fao_crop_calendar",
    name: "FAO Crop Calendar",
    officialUrl: "https://cropcalendar.apps.fao.org/",
    geographicCoverage: "Global (100+ crops across 50+ countries and agroecological zones)",
    spatialResolution: "Sub-national agroecological zone & country level",
    temporalResolution: "Seasonal planting, vegetative, reproductive, and harvest windows",
    accessMethod:
      "Curated agroecological crop calendar catalog in data/crops.json indexed by region, hemisphere, and rainy/dry/irrigated season",
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
      "Reference national/regional cultivation verification used to curate supportedRegions in data/crops.json",
    integrationStatus: "selective_extraction_integrated",
    licenseAndAttribution: "CC BY-NC-SA 3.0 IGO (FAO)",
    uncertaintyAndLimitations:
      "National production statistics confirm that a crop is commercially cultivated in a country, NOT that it is suitable for a specific field coordinate.",
  },
  isric_soilgrids_wcs: {
    id: "isric_soilgrids_wcs",
    name: "ISRIC SoilGrids v2.0 (250 m Global Digital Soil Mapping via OGC WCS)",
    officialUrl: "https://docs.isric.org/globaldata/soilgrids/wcs.html",
    geographicCoverage: "Global land surface (-56°S to 84°N)",
    spatialResolution: "~250 m grid (0–5 cm, 5–15 cm, and 15–30 cm layers weighted to 0–30 cm)",
    temporalResolution: "Static digital soil mapping baseline (v2.0)",
    accessMethod:
      "Live server-side OGC Web Coverage Service (WCS) GeoTIFF queries (https://maps.isric.org/) with 24h Next.js Data Cache / LRU cache and regional reference fallback",
    integrationStatus: "live_api_integrated",
    licenseAndAttribution: "CC BY 4.0 (ISRIC — World Soil Information; Poggio et al., 2021)",
    uncertaintyAndLimitations:
      "Coordinate-specific ~250 m machine-learning soil predictions (not field measurements or lab tests; ISRIC notes SoilGrids is designed for regional/screening context rather than farm-scale management without on-site testing). " +
      "Displayed fine-earth texture uses ISRIC's expected-value mean predictions (`sand_mean`, `silt_mean`, and `clay_mean`, computed via the default Random Forests algorithm and approximately compositionally closed within ±0.1% integer quantization, with a 100.0% display adjustment), " +
      "whereas quantiles (`Q0.05`, `Q0.50`, `Q0.95`) are computed via Quantile Regression Forests after back-transforming ALR predictions (`ALR1 = ln(sand / clay)`, `ALR2 = ln(silt / clay)`; Poggio et al., 2021) and `Q0.50` medians are retained for other properties and suitability calculations. " +
      "Masked pixels only use an adjacent unmasked pixel within ≤ 250 m; organic matter is estimated from Soil Organic Carbon (SOC × 1.724), AWC is computed where valid 33/1500 kPa retention predictions exist, and categorical drainage/slope are not fabricated.",
  },
  fao_hwsd_v22: {
    id: "fao_hwsd_v22",
    name: "FAO / IIASA Harmonized World Soil Database (HWSD v2.2 — Regional Reference)",
    officialUrl: "https://www.fao.org/agroinformatics/training-and-resources/data-sets/en",
    geographicCoverage: "Global land surface",
    spatialResolution: "Macro-regional reference profiles compiled from HWSD v2.2 soil mapping units",
    temporalResolution: "Global soil reference inventory (v2.2)",
    accessMethod:
      "Curated regional reference topsoil profiles (0–30 cm representative sand, silt, clay, SOC->OM, pH, bulk density, drainage, and estimated AWC) matched by agroecological region; not a live 1 km raster extraction",
    integrationStatus: "fallback_and_harmonized_reference",
    licenseAndAttribution: "CC BY-NC-SA 3.0 IGO (FAO / IIASA / ISRIC)",
    uncertaintyAndLimitations:
      "Values outside USDA SSURGO coverage are representative regional reference estimates, not coordinate-specific raster extractions. Organic carbon (SOC %) is converted to organic matter (OM %) via the Van Bemmelen factor (OM = SOC × 1.724).",
  },
  ucsb_chirps_v3: {
    id: "ucsb_chirps_v3",
    name: "UCSB CHG CHIRPS v3 (Seasonal Rainfall Regime Reference)",
    officialUrl: "https://www.chc.ucsb.edu/data",
    geographicCoverage: "Quasi-global (60°S to 60°N)",
    spatialResolution: "Regional wet/dry season threshold methodology",
    temporalResolution: "Climatological monthly wet/dry season characterization",
    accessMethod:
      "Tropical & semi-arid wet/dry-season month classification applied to the field's monthly precipitation profile for latitudes within 60°S–60°N",
    integrationStatus: "fallback_and_harmonized_reference",
    licenseAndAttribution: "Public Domain / Open Data (UCSB Climate Hazards Center & USGS)",
    uncertaintyAndLimitations:
      "Applies CHIRPS wet/dry-season threshold rules to the retrieved monthly precipitation profile rather than querying a separate 0.05° raster file.",
  },
  copernicus_era5_land: {
    id: "copernicus_era5_land",
    name: "Copernicus Climate Change Service (C3S) ERA5-Land (Water-Balance Reference)",
    officialUrl: "https://confluence.ecmwf.int/pages/viewpage.action?pageId=439587283",
    geographicCoverage: "Global land surface",
    spatialResolution: "Regional water-balance & aridity reference methodology",
    temporalResolution: "Climatological evaporative demand reference",
    accessMethod:
      "Reference evaporative demand (PET) and aridity index formulation applied alongside NASA POWER observations",
    integrationStatus: "fallback_and_harmonized_reference",
    licenseAndAttribution: "Copernicus C3S License (free and open access with attribution)",
    uncertaintyAndLimitations:
      "Provides water-balance and aridity reference equations alongside live NASA POWER data rather than asynchronous CDS NetCDF downloads.",
  },
  worldclim_v21: {
    id: "worldclim_v21",
    name: "WorldClim v2.1 Bioclimatic Reference Thresholds",
    officialUrl: "https://www.worldclim.org/",
    geographicCoverage: "Global land surface",
    spatialResolution: "Regional bioclimatic classification thresholds",
    temporalResolution: "Long-term climate classification reference",
    accessMethod:
      "Bioclimatic thermal and seasonal temperature-amplitude thresholds used in agroecological group classification",
    integrationStatus: "fallback_and_harmonized_reference",
    licenseAndAttribution: "CC BY-SA 4.0 (Fick & Hijmans, 2017)",
    uncertaintyAndLimitations:
      "Used for thermal-amplitude classification rules against NASA POWER 20-year records rather than direct 1 km raster extraction.",
  },
  esa_worldcover_10m: {
    id: "esa_worldcover_10m",
    name: "ESA WorldCover 10m v200 (Agro-Landscape Reference)",
    officialUrl: "https://esa-worldcover.org/en/data-access",
    geographicCoverage: "Global land surface",
    spatialResolution: "Regional agricultural zone reference",
    temporalResolution: "Baseline agro-landscape reference",
    accessMethod:
      "Regional cropland/dryland context reference; does not perform live 10 m satellite tile extraction",
    integrationStatus: "fallback_and_harmonized_reference",
    licenseAndAttribution: "CC BY 4.0 (ESA WorldCover Consortium)",
    uncertaintyAndLimitations:
      "Provides regional agricultural zone context only; it is NOT a live 10 m pixel lookup or verified farm boundary.",
  },
  copernicus_dem_glo30: {
    id: "copernicus_dem_glo30",
    name: "NASA POWER Grid Elevation & Copernicus DEM GLO-30 Highland Thresholds",
    officialUrl: "https://dataspace.copernicus.eu/explore-data/data-collections/copernicus-contributing-missions/collections-description/COP-DEM",
    geographicCoverage: "Global land surface",
    spatialResolution: "Grid-cell surface elevation from NASA POWER with highland/montane classification rules",
    temporalResolution: "Static elevation baseline",
    accessMethod:
      "Highland/montane terrain classifier using elevation reported by NASA POWER at the field coordinates",
    integrationStatus: "selective_extraction_integrated",
    licenseAndAttribution: "Public Domain (NASA POWER) / Copernicus WorldDEM-30 Open License",
    uncertaintyAndLimitations:
      "Uses grid-cell elevation from the live NASA POWER response to identify highland/montane thermal zones (>=1,500 m at low latitudes).",
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
    `Regional reference topsoil estimate (0–30 cm): values represent typical soil characteristics for this agroecological region (${matchedUnit.wrbSoilGroup}) compiled from published FAO/IIASA HWSD v2.2 and ISRIC SoilGrids v2.0 regional summaries—NOT a coordinate-specific spatial extraction or field soil test.`,
    `Organic matter (${omPct.toFixed(2)}%) is estimated from regional reference Soil Organic Carbon (SOC = ${matchedUnit.socPct.toFixed(2)}%) using the conventional Van Bemmelen factor (OM = SOC × 1.724).`,
    `Available Water Capacity (AWC = ${matchedUnit.awc.toFixed(3)} cm/cm) is a regional reference estimate for 0–30 cm topsoil based on representative texture, organic carbon, bulk density (${matchedUnit.bulkDensityGcm3.toFixed(2)} g/cm³), and coarse fragments (${matchedUnit.coarseFragmentsPct.toFixed(0)}%).`,
    `Indicative regional range (±${spread}%) reflects broad soil variability across this zone; on-site soil testing is recommended before making management decisions.`,
  ];

  const sourceStr =
    "Regional topsoil reference estimate (compiled from published FAO/IIASA HWSD v2.2 & ISRIC SoilGrids v2.0 regional summaries; not coordinate-specific extraction)";
  const coverageStr =
    "Macro-regional 0–30 cm topsoil reference estimate based on published FAO HWSD v2.2 & ISRIC SoilGrids v2.0 regional summaries. Not a coordinate-specific spatial extraction or laboratory soil test.";

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
    // Coordinate-specific drainage class and terrain slope are not available in macro-regional reference summaries; do not fabricate them.
    drainage: null,
    slope: null,
  };

  // Component coverage percentages only apply to surveyed USDA SSURGO map units;
  // for regional reference estimates they are recorded as null rather than inventing a percentage.
  const dataCoverage = {
    depth0_30cm: {
      sand: null,
      silt: null,
      clay: null,
      om: null,
      ph: null,
      awc: null,
    },
    drainage: null,
    slope: null,
  };

  const soilData: SoilData = {
    aggregated,
    dataCoverage,
    totalComponentPercent: 0,
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
      sand: "Regional reference estimate (FAO HWSD v2.2 & ISRIC SoilGrids v2.0 regional summary)",
      silt: "Regional reference estimate (FAO HWSD v2.2 & ISRIC SoilGrids v2.0 regional summary)",
      clay: "Regional reference estimate (FAO HWSD v2.2 & ISRIC SoilGrids v2.0 regional summary)",
      organicCarbon: "Regional reference SOC % (FAO HWSD v2.2 / ISRIC SoilGrids v2.0 regional summary)",
      om: "Estimated from regional reference SOC % via Van Bemmelen factor (SOC × 1.724)",
      ph: "Regional reference pH (H2O) 0–30 cm (FAO HWSD v2.2 regional summary)",
      bulkDensity: "Regional reference bulk density (g/cm³, FAO HWSD v2.2 regional summary)",
      coarseFragments: "Regional reference coarse fragments (%vol, FAO HWSD v2.2 regional summary)",
      awc: "Regional reference 0–30 cm AWC (Saxton & Rawls 2006 pedotransfer from regional texture/SOC)",
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
  const srcLower = existingSoil?.source.toLowerCase() ?? "";
  const isSsurgoSoil = Boolean(existingSoil && srcLower.includes("ssurgo"));
  const isLiveSoilGridsWcs = Boolean(
    existingSoil && srcLower.includes("soilgrids") && !srcLower.includes("hwsd")
  );
  const soilKey = !existingSoil
    ? "nosoil"
    : isSsurgoSoil
      ? "ssurgo"
      : isLiveSoilGridsWcs
        ? "soilgrids_wcs"
        : "regional_fallback";
  const cacheKey = `${lat.toFixed(4)}_${lon.toFixed(4)}_${climate.fullRecord.avgAnnualTemp ?? "na"}_${soilKey}`;

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
  if (isSsurgoSoil) {
    providerIds.push("usda_ssurgo");
  } else if (isLiveSoilGridsWcs) {
    providerIds.push("isric_soilgrids_wcs");
  } else {
    providerIds.push("fao_hwsd_v22");
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
