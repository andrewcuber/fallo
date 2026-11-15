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
                <CardTitle>NASA POWER &amp; Global Climate / Seasonality Baseline</CardTitle>
                <CardDescription>
                  NASA POWER Daily API · UCSB CHIRPS v3 · Copernicus ERA5-Land · WorldClim v2.1
                </CardDescription>
              </div>
            </div>
          </CardHeader>
          <CardContent className="space-y-3">
            <p className="text-sm text-muted-foreground">
              Provides 20-year daily temperature, precipitation, solar radiation, and root-zone wetness
              from NASA MERRA-2/GEOS reanalysis (~0.5° grid), supplemented by UCSB CHIRPS v3 (0.05°
              quasi-global 60°S–60°N rainfall seasonality), ERA5-Land (~9 km), and WorldClim v2.1
              (1 km long-term bioclimatic normals).
            </p>
            <div className="flex flex-wrap gap-2">
              <span className="inline-flex items-center gap-1 rounded-full bg-electric/10 px-2.5 py-0.5 text-xs font-medium text-electric">
                <CheckCircle2 className="h-3 w-3" />
                Free, no API key
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
              <strong>Important limitation:</strong> Reanalysis and satellite-gauge climate products
              represent regional climate context, not in-field weather stations. Use them to evaluate
              long-term seasonal regimes and drought/heat frequency rather than daily irrigation scheduling.
            </div>
          </CardContent>
        </Card>

        {/* Soil Architecture: USDA SSURGO + FAO HWSD v2.2 & ISRIC SoilGrids */}
        <Card>
          <CardHeader>
            <div className="flex items-center gap-3">
              <div className="inline-flex h-10 w-10 items-center justify-center rounded-lg bg-electric/10">
                <Database className="h-5 w-5 text-electric" />
              </div>
              <div>
                <CardTitle>Dual-Tier Soil Architecture: USDA SSURGO &amp; FAO HWSD v2.2 / ISRIC SoilGrids v2.0</CardTitle>
                <CardDescription>
                  Primary US polygon survey (SSURGO) with global 0–30 cm regional reference &amp; estimated topsoil data (HWSD v2.2 1 km &amp; SoilGrids 250 m)
                </CardDescription>
              </div>
            </div>
          </CardHeader>
          <CardContent className="space-y-3">
            <p className="text-sm text-muted-foreground">
              Inside the United States, fallo queries USDA NRCS Soil Data Access (SSURGO) for depth-weighted
              0–30 cm topsoil properties. Outside the US (or where SSURGO has no polygon coverage), fallo
              resolves estimated 0–30 cm topsoil data from regional reference sources combining FAO/IIASA Harmonized
              World Soil Database v2.2 (1 km, 7 depth layers) and ISRIC SoilGrids v2.0 (250 m WCS/WebDAV
              mean &amp; Q0.05–Q0.95 prediction intervals), converting soil organic carbon (SOC) to organic
              matter via the Van Bemmelen factor (1.724) and deriving available water capacity (AWC) via
              Saxton &amp; Rawls (2006) pedotransfer functions.
            </p>
            <div className="flex flex-wrap gap-2">
              <span className="inline-flex items-center gap-1 rounded-full bg-electric/10 px-2.5 py-0.5 text-xs font-medium text-electric">
                <CheckCircle2 className="h-3 w-3" />
                USDA SSURGO (US primary)
              </span>
              <span className="inline-flex items-center gap-1 rounded-full bg-electric/10 px-2.5 py-0.5 text-xs font-medium text-electric">
                <Globe className="h-3 w-3" />
                FAO HWSD v2.2 (1 km) &amp; ISRIC SoilGrids (250 m)
              </span>
              <span className="inline-flex items-center gap-1 rounded-full bg-muted px-2.5 py-0.5 text-xs font-medium text-foreground">
                <AlertTriangle className="h-3 w-3" />
                Q0.05–Q0.95 uncertainty intervals tracked
              </span>
            </div>
            <div className="rounded-md bg-muted p-3 text-xs text-muted-foreground border border-border">
              <strong>Important limitation:</strong> Global HWSD v2.2 and SoilGrids v2.0 values are regional
              soil-landscape and machine-learning predictions with explicit Q0.05–Q0.95 uncertainty ranges.
              Per-property provenance is preserved so primary survey data and global modeled estimates are
              never silently conflated.
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
                  <span className="font-semibold text-foreground">{p.name}</span>
                  <span className="font-mono text-[11px] text-muted-foreground">
                    {p.spatialResolution} · {p.licenseAndAttribution}
                  </span>
                </div>
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
