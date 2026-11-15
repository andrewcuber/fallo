import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import {
  CloudSun,
  Layers,
  Database,
  MapPin,
  AlertTriangle,
  CheckCircle2,
  Globe,
} from "lucide-react";

export const metadata = {
  title: "Data Sources — fallo",
  description: "Information about the data sources used in fallo.",
};

export default function DataSourcesPage() {
  return (
    <div className="max-w-3xl mx-auto space-y-8">
      <div>
        <h1 className="text-3xl font-serif font-bold tracking-tight text-foreground">
          Data Sources
        </h1>
        <p className="text-muted-foreground mt-2">
          fallo combines multiple public data sources. We are transparent about what
          each source provides, its limitations, and how we use it.
        </p>
      </div>

      <div className="space-y-4">
        {/* NASA POWER */}
        <Card>
          <CardHeader>
            <div className="flex items-center gap-3">
              <div className="inline-flex h-10 w-10 items-center justify-center rounded-lg bg-electric/10">
                <CloudSun className="h-5 w-5 text-electric" />
              </div>
              <div>
                <CardTitle>NASA POWER</CardTitle>
                <CardDescription>Prediction of Worldwide Energy Resources</CardDescription>
              </div>
            </div>
          </CardHeader>
          <CardContent className="space-y-3">
            <p className="text-sm text-muted-foreground">
              Provides historical daily climate data including temperature, precipitation,
              solar radiation, humidity, and soil wetness indices from the MERRA-2 reanalysis.
            </p>
            <div className="flex flex-wrap gap-2">
              <span className="inline-flex items-center gap-1 rounded-full bg-electric/10 px-2.5 py-0.5 text-xs font-medium text-electric">
                <CheckCircle2 className="h-3 w-3" />
                Free, no API key
              </span>
              <span className="inline-flex items-center gap-1 rounded-full bg-muted px-2.5 py-0.5 text-xs font-medium text-foreground">
                <Globe className="h-3 w-3" />
                Global coverage
              </span>
              <span className="inline-flex items-center gap-1 rounded-full bg-muted px-2.5 py-0.5 text-xs font-medium text-foreground">
                <AlertTriangle className="h-3 w-3" />
                Resolution varies by parameter
              </span>
            </div>
            <div className="rounded-md bg-muted p-3 text-xs text-muted-foreground border border-border">
              <strong>Important limitation:</strong> NASA POWER data represent regional
              climate context, not field-level weather. Native spatial resolution varies
              by parameter and source (MERRA-2, GEOS, etc.). Use it to understand long-term
              patterns, not daily field decisions.
            </div>
          </CardContent>
        </Card>

        {/* USDA SSURGO */}
        <Card>
          <CardHeader>
            <div className="flex items-center gap-3">
              <div className="inline-flex h-10 w-10 items-center justify-center rounded-lg bg-electric/10">
                <Database className="h-5 w-5 text-electric" />
              </div>
              <div>
                <CardTitle>USDA SSURGO</CardTitle>
                <CardDescription>Soil Survey Geographic Database</CardDescription>
              </div>
            </div>
          </CardHeader>
          <CardContent className="space-y-3">
            <p className="text-sm text-muted-foreground">
              The primary US soil source. Provides named soil map units and components,
              texture fractions, drainage class, available water capacity, and slope.
              Properties are depth-weighted averages for the upper 30 cm, aggregated
              across components by their map-unit percentage.
            </p>
            <div className="flex flex-wrap gap-2">
              <span className="inline-flex items-center gap-1 rounded-full bg-electric/10 px-2.5 py-0.5 text-xs font-medium text-electric">
                <CheckCircle2 className="h-3 w-3" />
                Free, official USDA
              </span>
              <span className="inline-flex items-center gap-1 rounded-full bg-muted px-2.5 py-0.5 text-xs font-medium text-foreground">
                <AlertTriangle className="h-3 w-3" />
                US only
              </span>
            </div>
          </CardContent>
        </Card>

        {/* SoilGrids */}
        <Card>
          <CardHeader>
            <div className="flex items-center gap-3">
              <div className="inline-flex h-10 w-10 items-center justify-center rounded-lg bg-electric/10">
                <Layers className="h-5 w-5 text-electric" />
              </div>
              <div>
                <CardTitle>ISRIC SoilGrids</CardTitle>
                <CardDescription>Global soil property predictions</CardDescription>
              </div>
            </div>
          </CardHeader>
          <CardContent className="space-y-3">
            <p className="text-sm text-muted-foreground">
              A global fallback for non-US locations. Provides predictions of soil texture,
              pH, organic carbon, and water content at 250 m resolution, with uncertainty estimates.
            </p>
            <div className="flex flex-wrap gap-2">
              <span className="inline-flex items-center gap-1 rounded-full bg-electric/10 px-2.5 py-0.5 text-xs font-medium text-electric">
                <CheckCircle2 className="h-3 w-3" />
                Free, global
              </span>
              <span className="inline-flex items-center gap-1 rounded-full bg-muted px-2.5 py-0.5 text-xs font-medium text-foreground">
                <AlertTriangle className="h-3 w-3" />
                REST API paused (2024)
              </span>
              <span className="inline-flex items-center gap-1 rounded-full bg-muted px-2.5 py-0.5 text-xs font-medium text-foreground">
                <AlertTriangle className="h-3 w-3" />
                250 m predictions
              </span>
            </div>
            <div className="rounded-md bg-muted p-3 text-xs text-muted-foreground border border-border">
              <strong>Important limitation:</strong> SoilGrids values are model predictions
              with associated uncertainty, not field samples. The REST API v2.0 is currently
              paused. WCS and WebDAV are documented alternative access methods. The current
              fallo implementation has not successfully integrated a global SoilGrids fallback,
              so non-US locations show an honest unavailable state.
            </div>
          </CardContent>
        </Card>

        {/* Nominatim */}
        <Card>
          <CardHeader>
            <div className="flex items-center gap-3">
              <div className="inline-flex h-10 w-10 items-center justify-center rounded-lg bg-electric/10">
                <MapPin className="h-5 w-5 text-electric" />
              </div>
              <div>
                <CardTitle>OpenStreetMap Nominatim</CardTitle>
                <CardDescription>Free geocoding service</CardDescription>
              </div>
            </div>
          </CardHeader>
          <CardContent className="space-y-3">
            <p className="text-sm text-muted-foreground">
              Converts addresses and place names into latitude and longitude coordinates
              so you can locate your field on the map without manually entering coordinates.
            </p>
            <div className="flex flex-wrap gap-2">
              <span className="inline-flex items-center gap-1 rounded-full bg-electric/10 px-2.5 py-0.5 text-xs font-medium text-electric">
                <CheckCircle2 className="h-3 w-3" />
                Free with attribution
              </span>
              <span className="inline-flex items-center gap-1 rounded-full bg-muted px-2.5 py-0.5 text-xs font-medium text-foreground">
                <Globe className="h-3 w-3" />
                Global
              </span>
            </div>
          </CardContent>
        </Card>
      </div>

      <div className="rounded-lg border border-border bg-secondary p-5">
        <h3 className="font-serif font-semibold text-foreground">Scientific honesty</h3>
        <p className="mt-2 text-sm text-muted-foreground">
          fallo presents all data-source limitations clearly. We do not claim field-level
          precision where the underlying data are regional. All rotation scores are labeled
          as decision-support heuristics, not validated agronomic recommendations.
        </p>
      </div>
    </div>
  );
}
