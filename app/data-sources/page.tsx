import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { GLOBAL_DATA_PROVIDER_LIST } from "@/lib/global-data-providers";
import {
  CloudSun,
  Layers,
  Database,
  MapPin,
  AlertTriangle,
  CheckCircle2,
  Globe,
  BookOpen,
} from "lucide-react";

export const metadata = {
  title: "Data Sources — fallo",
  description: "Information about the global and regional agricultural data sources used in fallo.",
};

export default function DataSourcesPage() {
  return (
    <div className="max-w-4xl mx-auto space-y-8">
      <div>
        <h1 className="text-3xl font-serif font-bold tracking-tight text-foreground">
          Global &amp; Regional Agricultural Data Sources
        </h1>
        <p className="text-muted-foreground mt-2">
          fallo combines authoritative public datasets for climate, soil, agroecological zoning,
          administrative boundaries, and regional crop calendars. Every source is documented with its
          spatial resolution, coverage, license, and uncertainty caveats.
        </p>
      </div>

      <div className="space-y-4">
        {/* Core Primary Live Endpoints */}
        <Card>
          <CardHeader>
            <div className="flex items-center gap-3">
              <div className="inline-flex h-10 w-10 items-center justify-center rounded-lg bg-electric/10">
                <CloudSun className="h-5 w-5 text-electric" />
              </div>
              <div>
                <CardTitle>NASA POWER Live Climate API &amp; Agro-Climatic Seasonality Rules</CardTitle>
                <CardDescription>
                  Live coordinate extraction from NASA POWER Daily API · Methodological rules from FAO GAEZ v5, UCSB CHIRPS v3, ERA5-Land &amp; WorldClim v2.1
                </CardDescription>
              </div>
            </div>
          </CardHeader>
          <CardContent className="space-y-3">
            <p className="text-sm text-muted-foreground">
              At every field coordinate, fallo queries the <strong>NASA POWER Agroclimatology Daily API</strong> live to retrieve 20-year daily temperature, precipitation, solar radiation, root-zone soil wetness, and grid-cell elevation (~0.5° MERRA-2/GEOS grid, ~55 km). From that retrieved time series, fallo deterministically computes thermal zones, moisture regimes, estimated Length of Growing Period (LGP), and wet/dry season windows using published FAO GAEZ v5, CHIRPS v3, ERA5-Land, and WorldClim v2.1 agro-climatic threshold methodologies.
            </p>
            <div className="flex flex-wrap gap-2">
              <span className="inline-flex items-center gap-1 rounded-full bg-electric/10 px-2.5 py-0.5 text-xs font-medium text-electric">
                <CheckCircle2 className="h-3 w-3" />
                Live coordinate query (NASA POWER)
              </span>
              <span className="inline-flex items-center gap-1 rounded-full bg-muted px-2.5 py-0.5 text-xs font-medium text-foreground">
                <Globe className="h-3 w-3" />
                Global coverage (90°S–90°N)
              </span>
              <span className="inline-flex items-center gap-1 rounded-full bg-muted px-2.5 py-0.5 text-xs font-medium text-foreground">
                <AlertTriangle className="h-3 w-3" />
                Regional grid (~55 km NASA POWER)
              </span>
            </div>
            <div className="rounded-md bg-muted p-3 text-xs text-muted-foreground border border-border">
              <strong>Important limitation:</strong> Reanalysis climate data represent ~55 km regional context, not in-field weather stations. Use them to evaluate long-term seasonal regimes and drought/heat frequency rather than daily irrigation scheduling.
            </div>
          </CardContent>
        </Card>

        {/* Soil Architecture: USDA SSURGO + Regional Reference Profiles */}
        <Card>
          <CardHeader>
            <div className="flex items-center gap-3">
              <div className="inline-flex h-10 w-10 items-center justify-center rounded-lg bg-electric/10">
                <Database className="h-5 w-5 text-electric" />
              </div>
              <div>
                <CardTitle>Dual-Tier Soil Architecture: USDA SSURGO Survey &amp; Global Regional Reference Profiles</CardTitle>
                <CardDescription>
                  Live US polygon survey extraction (USDA SSURGO) · Macro-regional 0–30 cm topsoil reference estimates outside SSURGO coverage (compiled from FAO HWSD v2.2 &amp; ISRIC SoilGrids v2.0)
                </CardDescription>
              </div>
            </div>
          </CardHeader>
          <CardContent className="space-y-3">
            <p className="text-sm text-muted-foreground">
              <strong>United States (live coordinate extraction):</strong> Inside the US, fallo queries USDA NRCS Soil Data Access (SSURGO) live at the field&apos;s coordinates for polygon map-unit components and depth-weighted 0–30 cm topsoil properties (sand, silt, clay, organic matter, pH, available water capacity, drainage, and slope).
            </p>
            <p className="text-sm text-muted-foreground">
              <strong>Outside USDA SSURGO coverage (macro-regional reference estimates):</strong> Because ISRIC&apos;s public SoilGrids v2.0 REST API is paused, non-US locations do not perform live coordinate-specific raster or WCS queries. Instead, fallo resolves a representative 0–30 cm topsoil reference profile for the field&apos;s agroecological region compiled from published FAO/IIASA HWSD v2.2 and ISRIC SoilGrids v2.0 regional summaries (converting reference SOC % to OM % via the Van Bemmelen factor 1.724 and estimating AWC via Saxton &amp; Rawls 2006 pedotransfer equations).
            </p>
            <div className="flex flex-wrap gap-2">
              <span className="inline-flex items-center gap-1 rounded-full bg-electric/10 px-2.5 py-0.5 text-xs font-medium text-electric">
                <CheckCircle2 className="h-3 w-3" />
                USDA SSURGO (live US spatial query)
              </span>
              <span className="inline-flex items-center gap-1 rounded-full bg-amber-50 px-2.5 py-0.5 text-xs font-medium text-amber-800 border border-amber-200">
                <Globe className="h-3 w-3" />
                Non-US: Macro-regional reference estimates (not coordinate-extracted)
              </span>
            </div>
            <div className="rounded-md bg-muted p-3 text-xs text-muted-foreground border border-border">
              <strong>Important limitation:</strong> Global reference soil values represent typical topsoil characteristics for a broad agroecological zone, not a coordinate-specific spatial extraction or laboratory soil test. fallo labels regional reference profiles explicitly and never reports synthetic map-unit component percentages for non-SSURGO locations.
            </div>
          </CardContent>
        </Card>

        {/* FAO GAEZ v5, FAO Crop Calendar, & Regional Research Institutions */}
        <Card>
          <CardHeader>
            <div className="flex items-center gap-3">
              <div className="inline-flex h-10 w-10 items-center justify-center rounded-lg bg-electric/10">
                <Layers className="h-5 w-5 text-electric" />
              </div>
              <div>
                <CardTitle>FAO/IIASA GAEZ v5, FAO Crop Calendar &amp; Regional Research Catalog</CardTitle>
                <CardDescription>
                  Agro-ecological thermal/moisture zoning, Length of Growing Period (LGP), and source-backed crop rules
                </CardDescription>
              </div>
            </div>
          </CardHeader>
          <CardContent className="space-y-3">
            <p className="text-sm text-muted-foreground">
              Field classification uses FAO/IIASA GAEZ v5 thermal zones, moisture regimes, and estimated Length
              of Growing Period (LGP days) across 13 global agroecological classes (including tropical humid,
              subhumid, savanna, monsoon, semi-arid, arid, subtropical humid, Mediterranean, temperate humid,
              semi-arid temperate, continental, boreal, and highland/montane). Crop eligibility is grounded in
              FAO Crop Calendar, FAOSTAT, and regional research institutions (ICRISAT, IITA, CIMMYT, AfricaRice,
              CAAS China, University of Nevada Cooperative Extension / USDA ARS, EMBRAPA, ICAR, GRDC, ICARDA).
            </p>
            <div className="flex flex-wrap gap-2">
              <span className="inline-flex items-center gap-1 rounded-full bg-electric/10 px-2.5 py-0.5 text-xs font-medium text-electric">
                <CheckCircle2 className="h-3 w-3" />
                33 source-backed crops
              </span>
              <span className="inline-flex items-center gap-1 rounded-full bg-muted px-2.5 py-0.5 text-xs font-medium text-foreground">
                <Globe className="h-3 w-3" />
                15 global macro-regions
              </span>
              <span className="inline-flex items-center gap-1 rounded-full bg-muted px-2.5 py-0.5 text-xs font-medium text-foreground">
                <BookOpen className="h-3 w-3" />
                3-tier evidence system (Levels 1–3)
              </span>
            </div>
          </CardContent>
        </Card>

        {/* Geocoding & Administrative Boundaries */}
        <Card>
          <CardHeader>
            <div className="flex items-center gap-3">
              <div className="inline-flex h-10 w-10 items-center justify-center rounded-lg bg-electric/10">
                <MapPin className="h-5 w-5 text-electric" />
              </div>
              <div>
                <CardTitle>OpenStreetMap Nominatim, geoBoundaries v6.0 &amp; Natural Earth v5.1.2</CardTitle>
                <CardDescription>
                  International coordinate normalization, geocoding, and ADM0/ADM1/ADM2 boundary identification
                </CardDescription>
              </div>
            </div>
          </CardHeader>
          <CardContent className="space-y-3">
            <p className="text-sm text-muted-foreground">
              Wrapped world-map longitudes (such as -250° when panning across the Pacific to China) are
              automatically normalized into [-180°, 180°). Country, ISO code, and sub-national administrative
              context (including border-corridor notes) are resolved using geoBoundaries v6.0 (CC BY 4.0) and
              Natural Earth v5.1.2 (Public Domain).
            </p>
          </CardContent>
        </Card>
      </div>

      {/* Complete Provider Registry Table */}
      <Card>
        <CardHeader>
          <CardTitle className="text-lg">
            Registered Global Data Providers ({GLOBAL_DATA_PROVIDER_LIST.length})
          </CardTitle>
          <CardDescription>
            Complete technical registry of datasets integrated into fallo&apos;s global agricultural data layer.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="divide-y divide-border text-xs">
            {GLOBAL_DATA_PROVIDER_LIST.map((p) => (
              <div key={p.id} className="py-3 space-y-1">
                <div className="flex items-center justify-between gap-2 flex-wrap">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="font-semibold text-foreground">{p.name}</span>
                    <span
                      className={`rounded px-1.5 py-0.5 text-[10px] font-medium ${
                        p.integrationStatus === "live_api_integrated"
                          ? "bg-emerald-50 text-emerald-700 border border-emerald-200"
                          : p.integrationStatus === "selective_extraction_integrated"
                          ? "bg-blue-50 text-blue-700 border border-blue-200"
                          : "bg-amber-50 text-amber-800 border border-amber-200"
                      }`}
                    >
                      {p.integrationStatus === "live_api_integrated"
                        ? "Live coordinate query"
                        : p.integrationStatus === "selective_extraction_integrated"
                        ? "Rule-based classifier / catalog"
                        : "Regional reference baseline"}
                    </span>
                  </div>
                  <span className="font-mono text-[11px] text-muted-foreground">
                    {p.spatialResolution} · {p.licenseAndAttribution}
                  </span>
                </div>
                <p className="text-muted-foreground">
                  <strong>How used in fallo:</strong> {p.accessMethod}
                </p>
                <p className="text-muted-foreground">
                  <strong>Coverage:</strong> {p.geographicCoverage} · <strong>Temporal:</strong>{" "}
                  {p.temporalResolution}
                </p>
                <p className="text-muted-foreground">
                  <strong>Uncertainty / Caveats:</strong> {p.uncertaintyAndLimitations}
                </p>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>

      <div className="rounded-lg border border-border bg-secondary p-5">
        <h3 className="font-serif font-semibold text-foreground">Scientific honesty</h3>
        <p className="mt-2 text-sm text-muted-foreground">
          fallo presents all data-source limitations clearly. We do not claim field-level
          precision where the underlying data are regional or globally modeled. All rotation scores
          are labeled as decision-support heuristics, and locations with insufficient evidence
          (Level 3) refuse rotation generation rather than fabricating unsupported plans.
        </p>
      </div>
    </div>
  );
}
