"use client";

import { useEffect } from "react";
import { useParams, useRouter } from "next/navigation";
import Link from "next/link";
import { useField, useFieldEnvironmentalData } from "@/components/providers";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Mountain,
  Layers,
  FlaskConical,
  Droplets,
  AlertTriangle,
  RotateCcw,
  Database,
  MapPin,
  Info,
} from "lucide-react";

interface SoilHorizon {
  depthTop: number;
  depthBottom: number;
  sand: number | null;
  silt: number | null;
  clay: number | null;
  om: number | null;
  ph: number | null;
  awc: number | null;
}

interface SoilComponent {
  cokey: string;
  name: string;
  percent: number;
  kind: string;
  majcompflag: string | null;
  drainage: string | null;
  slope: number | null;
  horizons: SoilHorizon[];
}

interface SoilData {
  location: { lat: number; lon: number };
  dataTier?: "usda_ssurgo" | "soilgrids_wcs_250m" | "regional_reference_fallback";
  source: string;
  coverage: string;
  wrbSoilGroup?: string;
  mapUnit: { mukey: string; name: string } | null;
  totalComponentPercent: number;
  components: SoilComponent[];
  aggregated: {
    depth0_30cm: {
      sand: number | null;
      silt: number | null;
      clay: number | null;
      om: number | null;
      ph: number | null;
      awc: number | null;
      organicCarbonPct?: number | null;
      bulkDensityGcm3?: number | null;
      coarseFragmentsPct?: number | null;
    };
    drainage: string | null;
    slope: number | null;
  };
  layerUncertainty?: {
    depthInterval: string;
    depthLabel: string;
    note: string;
    properties: Partial<
      Record<
        "sand" | "silt" | "clay" | "soc" | "om" | "ph",
        { q05: number; q50: number; q95: number; unit: string }
      >
    >;
  };
  pixelResolution?: {
    gridSizeMeters: number;
    usedNeighborPixel: boolean;
    neighborDistanceMeters: number;
    extractedLat: number;
    extractedLon: number;
  };
  propertySources?: Record<string, string>;
  dataCoverage: {
    depth0_30cm: {
      sand: number | null;
      silt: number | null;
      clay: number | null;
      om: number | null;
      ph: number | null;
      awc: number | null;
    };
    drainage: number | null;
    slope: number | null;
  };
  limitations: string[];
  cached?: boolean;
}

function fmt(value: number | null, decimals = 1): string {
  if (value === null || Number.isNaN(value)) return "—";
  return value.toFixed(decimals);
}

function textureColor(type: "sand" | "silt" | "clay"): string {
  if (type === "sand") return "#D4A574"; // warm tan
  if (type === "silt") return "#94A3B8"; // slate
  return "#C45C5C"; // muted red for clay
}

function TextureBar({
  sand,
  silt,
  clay,
}: {
  sand: number | null;
  silt: number | null;
  clay: number | null;
}) {
  const total =
    (sand ?? 0) + (silt ?? 0) + (clay ?? 0);
  if (total === 0) {
    return (
      <div className="h-3 w-full rounded-full bg-muted" />
    );
  }

  const sandPct = ((sand ?? 0) / total) * 100;
  const siltPct = ((silt ?? 0) / total) * 100;
  const clayPct = ((clay ?? 0) / total) * 100;

  return (
    <div className="flex h-3 w-full rounded-full overflow-hidden">
      {sandPct > 0 && (
        <div
          style={{ width: `${sandPct}%`, backgroundColor: textureColor("sand") }}
          title={`Sand ${fmt(sand, 1)}%`}
        />
      )}
      {siltPct > 0 && (
        <div
          style={{ width: `${siltPct}%`, backgroundColor: textureColor("silt") }}
          title={`Silt ${fmt(silt, 1)}%`}
        />
      )}
      {clayPct > 0 && (
        <div
          style={{ width: `${clayPct}%`, backgroundColor: textureColor("clay") }}
          title={`Clay ${fmt(clay, 1)}%`}
        />
      )}
    </div>
  );
}

function formatSoilDisplayName(
  rawName: string,
  isSoilGridsWcs: boolean,
  wrbGroup?: string
): string {
  if (isSoilGridsWcs) {
    const wrb =
      wrbGroup ||
      (rawName.includes("—") ? rawName.split("—")[1]?.trim() : undefined);
    return wrb
      ? `Modeled soil grid cell — ${wrb}`
      : "Modeled soil grid cell (~250 m)";
  }
  return rawName;
}

export default function SoilPage() {
  const params = useParams();
  const router = useRouter();
  const { fields, activeField, setActiveField, isLoaded } = useField();

  const fieldId = typeof params.id === "string" ? params.id : undefined;

  // Ensure the field from URL is active
  useEffect(() => {
    if (!isLoaded || !fieldId) return;
    if (!activeField || activeField.id !== fieldId) {
      const found = fields.find((f) => f.id === fieldId);
      if (found) {
        setActiveField(found);
      }
    }
  }, [isLoaded, fieldId, activeField, fields, setActiveField]);

  const field = activeField ?? (fieldId ? fields.find((f) => f.id === fieldId) : undefined);
  const {
    soilRaw,
    loading,
    soilError: error,
    refresh: fetchSoil,
  } = useFieldEnvironmentalData(field);
  const data = soilRaw as SoilData | null;

  if (!isLoaded) {
    return <SoilSkeleton />;
  }

  if (!field) {
    return (
      <div className="space-y-6">
        <div>
          <h2 className="text-2xl font-serif font-bold text-foreground">
            Soil Profile
          </h2>
          <p className="text-muted-foreground mt-1 max-w-2xl">
            Field not found. Create a field to view its soil profile.
          </p>
        </div>
        <Button onClick={() => router.push("/fields/new")}>
          Create a Field
        </Button>
      </div>
    );
  }

  const depth0_30cm = data?.aggregated.depth0_30cm;
  const sand = depth0_30cm?.sand ?? null;
  const silt = depth0_30cm?.silt ?? null;
  const clay = depth0_30cm?.clay ?? null;
  const om = depth0_30cm?.om ?? null;
  const ph = depth0_30cm?.ph ?? null;
  const awc = depth0_30cm?.awc ?? null;
  const hasTexture = sand !== null || silt !== null || clay !== null;

  const isSsurgoSurvey =
    data?.dataTier === "usda_ssurgo" ||
    (data?.source.toUpperCase().includes("SSURGO") ?? false);
  const isSoilGridsWcs =
    !isSsurgoSurvey &&
    (data?.dataTier === "soilgrids_wcs_250m" ||
      (data?.source.includes("maps.isric.org") ?? false));
  const socPct = depth0_30cm?.organicCarbonPct ?? null;
  const bulkDensity = depth0_30cm?.bulkDensityGcm3 ?? null;
  const coarseFragments = depth0_30cm?.coarseFragmentsPct ?? null;

  return (
    <div className="space-y-8">
      {/* Header */}
      <div className="space-y-1">
        <h2 className="text-2xl font-serif font-bold text-foreground">
          Soil Profile
        </h2>
        <p className="text-muted-foreground max-w-2xl">
          Topsoil properties (0–30 cm) for {field.name} — texture, organic matter, pH, water-holding capacity, drainage, and slope.
        </p>
        <p className="text-xs text-muted-foreground">
          Coordinates: {field.lat.toFixed(4)}, {field.lon.toFixed(4)}
          {data?.mapUnit &&
            ` · ${
              isSsurgoSurvey
                ? "Map unit"
                : isSoilGridsWcs
                ? "Soil unit"
                : "Reference soil group"
            }: ${formatSoilDisplayName(
              data.mapUnit.name,
              isSoilGridsWcs,
              data.wrbSoilGroup
            )}`}
        </p>
      </div>

      {/* Loading */}
      {loading && <SoilSkeleton />}

      {/* Error */}
      {error && !loading && (
        <Card className="border-accent-red/20 bg-accent-red/5">
          <CardHeader className="pb-3">
            <CardTitle className="flex items-center gap-2 text-accent-red">
              <AlertTriangle className="h-5 w-5" />
              Could not load soil data
            </CardTitle>
            <CardDescription className="text-accent-red/80">
              {error}
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Button
              variant="outline"
              size="sm"
              onClick={fetchSoil}
              className="border-accent-red/30 text-accent-red hover:bg-accent-red/10"
            >
              <RotateCcw className="mr-2 h-4 w-4" />
              Retry
            </Button>
          </CardContent>
        </Card>
      )}

      {/* Data */}
      {data && !loading && (
        <>
          {/* Compact Farmer Warning Near Results */}
          {isSoilGridsWcs ? (
            <div className="flex items-start gap-2 rounded-lg border border-blue-200 bg-blue-50/70 px-3.5 py-2.5 text-xs text-blue-950">
              <Info className="h-4 w-4 text-blue-700 shrink-0 mt-0.5" />
              <p className="leading-relaxed">
                <strong>Modeled topsoil estimate (~250 m grid):</strong>{" "}
                Values are machine-learning predictions for 0–30 cm topsoil (with organic matter derived from SOC × 1.724), not on-site soil test measurements. Field-scale soil properties vary over short distances—verify with laboratory soil sampling before making lime, fertilizer, or drainage decisions.
                {data.pixelResolution?.usedNeighborPixel && (
                  <>
                    {" "}
                    <strong>Neighbor pixel note:</strong> The exact coordinate fell on a masked pixel (water/built-up); values come from the nearest unmasked pixel ~{data.pixelResolution.neighborDistanceMeters} m away (≤ 250 m limit).
                  </>
                )}
              </p>
            </div>
          ) : !isSsurgoSurvey ? (
            <div className="flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50/70 px-3.5 py-2.5 text-xs text-amber-900">
              <AlertTriangle className="h-4 w-4 text-amber-700 shrink-0 mt-0.5" />
              <p className="leading-relaxed">
                <strong>Regional topsoil reference estimate:</strong>{" "}
                Coordinate-specific soil data was unavailable for this location. Values represent typical 0–30 cm topsoil properties for this agroecological zone—verify with on-site soil sampling before making fertilizer or lime decisions.
              </p>
            </div>
          ) : (
            <div className="flex items-start gap-2 rounded-lg border border-border/80 bg-muted/30 px-3.5 py-2.5 text-xs text-muted-foreground">
              <Info className="h-4 w-4 text-electric shrink-0 mt-0.5" />
              <p className="leading-relaxed">
                <strong className="text-foreground">Survey map-unit estimate (0–30 cm):</strong>{" "}
                Values represent depth-weighted soil survey component averages. Field borders and local inclusions vary; confirm with on-site laboratory soil testing before applying lime or fertilizer.
              </p>
            </div>
          )}

          {/* Aggregated Metric Cards */}
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <Card className="h-full sm:col-span-2">
              <CardHeader className="pb-2">
                <div className="flex items-center gap-2">
                  <div className="inline-flex h-9 w-9 items-center justify-center rounded-lg bg-electric/10">
                    <Mountain className="h-5 w-5 text-electric" />
                  </div>
                  <CardTitle className="text-sm font-medium text-muted-foreground">
                    Texture (0-30 cm)
                  </CardTitle>
                </div>
              </CardHeader>
              <CardContent className="pt-0 space-y-3">
                {hasTexture ? (
                  <>
                    <TextureBar sand={sand} silt={silt} clay={clay} />
                    <div className="flex justify-between text-sm">
                      <span className="text-muted-foreground">
                        Sand{" "}
                        <span className="font-medium text-foreground tabular-nums">
                          {fmt(sand, 1)}%
                        </span>
                      </span>
                      <span className="text-muted-foreground">
                        Silt{" "}
                        <span className="font-medium text-foreground tabular-nums">
                          {fmt(silt, 1)}%
                        </span>
                      </span>
                      <span className="text-muted-foreground">
                        Clay{" "}
                        <span className="font-medium text-foreground tabular-nums">
                          {fmt(clay, 1)}%
                        </span>
                      </span>
                    </div>
                  </>
                ) : (
                  <p className="text-sm text-muted-foreground">
                    No texture data available for this depth.
                  </p>
                )}
              </CardContent>
            </Card>

            <MetricCard
              icon={<FlaskConical className="h-5 w-5 text-cyan" />}
              label="Organic Matter"
              value={om}
              unit="%"
              decimals={2}
            />
            <MetricCard
              icon={<Droplets className="h-5 w-5 text-electric" />}
              label="pH (1:1 H₂O)"
              value={ph}
              unit=""
              decimals={1}
            />
            <MetricCard
              icon={<Layers className="h-5 w-5 text-space" />}
              label="AWC"
              value={awc}
              unit="cm/cm"
              decimals={3}
            />
            <MetricCard
              icon={<Database className="h-5 w-5 text-muted-foreground" />}
              label="Slope"
              value={data.aggregated.slope}
              unit="%"
              decimals={1}
            />
            <MetricCard
              icon={<MapPin className="h-5 w-5 text-muted-foreground" />}
              label="Drainage"
              value={data.aggregated.drainage}
              unit=""
              decimals={0}
              stringFallback="—"
            />
          </div>

          {/* Soil Profile / Component Breakdown */}
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-base font-semibold text-foreground">
                {isSsurgoSurvey
                  ? "Soil Component Composition"
                  : isSoilGridsWcs
                  ? "Soil Profile Breakdown"
                  : "Regional Reference Profile"}
              </CardTitle>
              <CardDescription className="text-xs">
                {isSsurgoSurvey
                  ? "Named soil components in the map unit. Percentages reflect the share of each component within the map unit polygon."
                  : isSoilGridsWcs
                  ? "Modeled 0–30 cm profile synthesized across the three topsoil depth intervals (0–5 cm, 5–15 cm, and 15–30 cm)."
                  : "Representative 0–30 cm topsoil profile for this agroecological zone."}
              </CardDescription>
            </CardHeader>
            <CardContent>
              {data.components.length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  {isSsurgoSurvey
                    ? "No component data available."
                    : `Using macro-regional reference profile: ${data.mapUnit?.name ?? "Regional Reference Soil Group"}.`}
                </p>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b border-border">
                        <th className="text-left py-2 pr-4 font-medium text-muted-foreground">
                          {isSoilGridsWcs ? "Soil Unit" : "Component"}
                        </th>
                        <th className="text-right py-2 px-3 font-medium text-muted-foreground">
                          %
                        </th>
                        <th className="text-left py-2 px-3 font-medium text-muted-foreground">
                          Kind
                        </th>
                        <th className="text-left py-2 px-3 font-medium text-muted-foreground">
                          Major
                        </th>
                        <th className="text-left py-2 px-3 font-medium text-muted-foreground">
                          Drainage
                        </th>
                        <th className="text-right py-2 px-3 font-medium text-muted-foreground">
                          Slope
                        </th>
                        <th className="text-right py-2 px-3 font-medium text-muted-foreground">
                          {isSoilGridsWcs ? "Depth Layers" : "Horizons"}
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.components.map((comp) => (
                        <tr
                          key={comp.cokey}
                          className="border-b border-border/50"
                        >
                          <td className="py-2 pr-4 text-foreground font-medium">
                            {formatSoilDisplayName(
                              comp.name,
                              isSoilGridsWcs,
                              data.wrbSoilGroup
                            )}
                          </td>
                          <td className="text-right py-2 px-3 tabular-nums">
                            {comp.percent}%
                          </td>
                          <td className="py-2 px-3 text-muted-foreground">
                            {comp.kind}
                          </td>
                          <td className="py-2 px-3 text-muted-foreground">
                            {comp.majcompflag === "Yes" ? (
                              <span className="inline-flex items-center rounded-full bg-electric/10 px-2 py-0.5 text-xs font-medium text-electric">
                                Yes
                              </span>
                            ) : comp.majcompflag === "No" ? (
                              <span className="inline-flex items-center rounded-full bg-muted px-2 py-0.5 text-xs font-medium text-muted-foreground">
                                No
                              </span>
                            ) : (
                              "—"
                            )}
                          </td>
                          <td className="py-2 px-3 text-muted-foreground">
                            {comp.drainage ?? "—"}
                          </td>
                          <td className="text-right py-2 px-3 tabular-nums text-muted-foreground">
                            {fmt(comp.slope, 1)}%
                          </td>
                          <td className="text-right py-2 px-3 tabular-nums text-muted-foreground">
                            {comp.horizons.length}
                          </td>
                        </tr>
                      ))}
                      <tr className="border-b border-border/50 bg-muted/30">
                        <td className="py-2 pr-4 text-foreground font-medium">
                          Known total
                        </td>
                        <td className="text-right py-2 px-3 tabular-nums font-medium">
                          {data.totalComponentPercent}%
                        </td>
                        <td colSpan={5} className="py-2 px-3 text-muted-foreground text-xs">
                          {100 - data.totalComponentPercent > 0
                            ? `${100 - data.totalComponentPercent}% unaccounted in component records`
                            : "All accounted"}
                        </td>
                      </tr>
                    </tbody>
                  </table>
                </div>
              )}
            </CardContent>
          </Card>

          {/* Horizon / Depth Layer details per component */}
          {data.components.map((comp) =>
            comp.horizons.length > 0 ? (
              <Card key={comp.cokey}>
                <CardHeader className="pb-3">
                  <CardTitle className="text-base font-semibold text-foreground">
                    {formatSoilDisplayName(
                      comp.name,
                      isSoilGridsWcs,
                      data.wrbSoilGroup
                    )}{" "}
                    — {isSoilGridsWcs ? "Depth Layer Breakdown" : "Horizon Data"}
                  </CardTitle>
                  <CardDescription className="text-xs">
                    {isSoilGridsWcs
                      ? "Depth-interval values (0–5 cm, 5–15 cm, and 15–30 cm) used to compute the thickness-weighted 0–30 cm topsoil summary."
                      : `Depth-weighted contributions to the 0–30 cm aggregate from this component (${comp.percent}% of map unit).`}
                  </CardDescription>
                </CardHeader>
                <CardContent>
                  <div className="overflow-x-auto">
                    <table className="w-full text-sm">
                      <thead>
                        <tr className="border-b border-border">
                          <th className="text-left py-2 pr-4 font-medium text-muted-foreground">
                            Depth (cm)
                          </th>
                          <th className="text-right py-2 px-3 font-medium text-muted-foreground">
                            Sand (%)
                          </th>
                          <th className="text-right py-2 px-3 font-medium text-muted-foreground">
                            Silt (%)
                          </th>
                          <th className="text-right py-2 px-3 font-medium text-muted-foreground">
                            Clay (%)
                          </th>
                          <th className="text-right py-2 px-3 font-medium text-muted-foreground">
                            OM (%)
                          </th>
                          <th className="text-right py-2 px-3 font-medium text-muted-foreground">
                            pH
                          </th>
                          <th className="text-right py-2 px-3 font-medium text-muted-foreground">
                            AWC
                          </th>
                        </tr>
                      </thead>
                      <tbody>
                        {comp.horizons.map((hz, i) => (
                          <tr
                            key={i}
                            className="border-b border-border/50"
                          >
                            <td className="py-2 pr-4 text-foreground font-medium tabular-nums">
                              {hz.depthTop}-{hz.depthBottom}
                            </td>
                            <td className="text-right py-2 px-3 tabular-nums">
                              {fmt(hz.sand, 1)}
                            </td>
                            <td className="text-right py-2 px-3 tabular-nums">
                              {fmt(hz.silt, 1)}
                            </td>
                            <td className="text-right py-2 px-3 tabular-nums">
                              {fmt(hz.clay, 1)}
                            </td>
                            <td className="text-right py-2 px-3 tabular-nums">
                              {fmt(hz.om, 2)}
                            </td>
                            <td className="text-right py-2 px-3 tabular-nums">
                              {fmt(hz.ph, 1)}
                            </td>
                            <td className="text-right py-2 px-3 tabular-nums">
                              {fmt(hz.awc, 3)}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </CardContent>
              </Card>
            ) : null
          )}

          {/* Data Sources & Methodology */}
          <details className="group rounded-lg border border-border/70 bg-muted/20 px-4 py-3 text-xs text-muted-foreground">
            <summary className="flex cursor-pointer items-center justify-between font-medium text-foreground/80 hover:text-foreground list-none">
              <span className="flex items-center gap-2">
                <Database className="h-3.5 w-3.5 text-muted-foreground" />
                Data Sources &amp; Methodology
              </span>
              <span className="text-[11px] text-muted-foreground group-open:rotate-180 transition-transform">
                ▼
              </span>
            </summary>
            <div className="mt-3 space-y-2.5 border-t border-border/60 pt-3 leading-relaxed">
              <p>
                <strong className="text-foreground">
                  {isSsurgoSurvey
                    ? "Live Survey Data Source:"
                    : isSoilGridsWcs
                    ? "Live Modeled Grid Source:"
                    : "Static Regional Reference Source:"}
                </strong>{" "}
                {isSsurgoSurvey ? (
                  <>
                    <a
                      href="https://sdmdataaccess.sc.egov.usda.gov/"
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-electric hover:underline"
                    >
                      {data.source}
                    </a>{" "}
                    (polygon soil survey, 1:12,000–1:24,000 scale).
                  </>
                ) : isSoilGridsWcs ? (
                  <>
                    <a
                      href="https://maps.isric.org/"
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-electric hover:underline"
                    >
                      {data.source}
                    </a>{" "}
                    (
                    <a
                      href="https://docs.isric.org/globaldata/soilgrids/wcs.html"
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-electric hover:underline"
                    >
                      OGC WCS documentation
                    </a>
                    , ~250 m / 0.00225° WGS84 grid).
                  </>
                ) : (
                  <>{data.source} (macro-regional reference fallback).</>
                )}
              </p>
              <p>
                <strong className="text-foreground">Coverage &amp; Depth Aggregation:</strong>{" "}
                {data.coverage}
              </p>
              {isSoilGridsWcs && (
                <p>
                  <strong className="text-foreground">Direct vs. Derived Values:</strong>{" "}
                  Sand, silt, clay, soil organic carbon
                  {socPct !== null ? ` (SOC ${fmt(socPct, 2)}%)` : ""}, pH in H₂O
                  {bulkDensity !== null ? `, bulk density (${fmt(bulkDensity, 2)} g/cm³)` : ""}
                  {coarseFragments !== null ? `, and coarse fragments (${fmt(coarseFragments, 1)}%)` : ""}{" "}
                  are direct SoilGrids v2.0 median (Q0.5) predictions extracted from a single geographic pixel across 0–5 cm, 5–15 cm, and 15–30 cm. Organic matter ({fmt(om, 2)}%) is a derived estimate computed from SOC using the Van Bemmelen factor (<code>OM = SOC × 1.724</code>), and AWC ({awc !== null ? `${fmt(awc, 3)} cm/cm` : "unavailable"}) is derived from volumetric water retention at 33 kPa and 1500 kPa adjusted for coarse fragments. Drainage class and slope are not published by SoilGrids and remain unpopulated (<code>null</code>).
                </p>
              )}
              {data.layerUncertainty && (
                <div className="space-y-1">
                  <p className="font-medium text-foreground">
                    Surface Layer Prediction Uncertainty ({data.layerUncertainty.depthLabel} Q0.05–Q0.95):
                  </p>
                  <p className="text-muted-foreground">{data.layerUncertainty.note}</p>
                  <ul className="list-disc list-inside space-y-0.5 text-muted-foreground">
                    {Object.entries(data.layerUncertainty.properties).map(([key, u]) =>
                      u ? (
                        <li key={key}>
                          <span className="uppercase font-medium text-foreground/80">{key}:</span>{" "}
                          median {u.q50} {u.unit} (90% prediction interval Q0.05–Q0.95: {u.q05}–{u.q95}{" "}
                          {u.unit})
                        </li>
                      ) : null
                    )}
                  </ul>
                </div>
              )}
              {data.propertySources && Object.keys(data.propertySources).length > 0 && (
                <div className="space-y-1">
                  <p className="font-medium text-foreground">Property Provenance &amp; Conversions:</p>
                  <ul className="list-disc list-inside space-y-0.5 text-muted-foreground">
                    {Object.entries(data.propertySources).map(([prop, desc]) => (
                      <li key={prop}>
                        <span className="font-medium text-foreground/80">{prop}:</span> {desc}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              {data.limitations.length > 0 && (
                <div className="space-y-1">
                  <p className="font-medium text-foreground">Limitations &amp; Caveats:</p>
                  <ul className="list-disc list-inside space-y-1 text-muted-foreground">
                    {data.limitations.map((l, i) => (
                      <li key={i}>{l}</li>
                    ))}
                  </ul>
                </div>
              )}
              <p>
                <Link
                  href="/data-sources"
                  className="text-electric hover:underline font-medium"
                >
                  View complete data sources catalog →
                </Link>
              </p>
            </div>
          </details>
        </>
      )}
    </div>
  );
}

function MetricCard({
  icon,
  label,
  value,
  unit,
  decimals,
  stringFallback,
}: {
  icon: React.ReactNode;
  label: string;
  value: number | string | null;
  unit: string;
  decimals: number;
  stringFallback?: string;
}) {
  const display =
    typeof value === "string"
      ? value || stringFallback || "—"
      : fmt(value as number | null, decimals);

  return (
    <Card className="h-full">
      <CardHeader className="pb-2">
        <div className="inline-flex h-9 w-9 items-center justify-center rounded-lg bg-electric/10">
          {icon}
        </div>
        <CardTitle className="text-sm font-medium text-muted-foreground mt-2">
          {label}
        </CardTitle>
      </CardHeader>
      <CardContent className="pt-0">
        <div className="flex items-baseline gap-1.5">
          <span className="text-3xl font-bold text-foreground tabular-nums">
            {display}
          </span>
          {unit && (
            <span className="text-sm font-medium text-muted-foreground">
              {unit}
            </span>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

function SoilSkeleton() {
  return (
    <div className="space-y-8">
      <div className="space-y-2">
        <Skeleton className="h-8 w-56" />
        <Skeleton className="h-4 w-96" />
      </div>
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Card className="h-full sm:col-span-2">
          <CardHeader className="pb-2">
            <Skeleton className="h-9 w-9 rounded-lg" />
            <Skeleton className="h-4 w-32 mt-2" />
          </CardHeader>
          <CardContent className="pt-0">
            <Skeleton className="h-3 w-full rounded-full" />
            <Skeleton className="h-4 w-48 mt-3" />
          </CardContent>
        </Card>
        {Array.from({ length: 4 }).map((_, i) => (
          <Card key={i} className="h-full">
            <CardHeader className="pb-2">
              <Skeleton className="h-9 w-9 rounded-lg" />
              <Skeleton className="h-4 w-28 mt-2" />
            </CardHeader>
            <CardContent className="pt-0">
              <Skeleton className="h-8 w-20" />
            </CardContent>
          </Card>
        ))}
      </div>
      <Card>
        <CardHeader className="pb-2">
          <Skeleton className="h-5 w-48" />
        </CardHeader>
        <CardContent>
          <Skeleton className="h-[120px] w-full rounded-md" />
        </CardContent>
      </Card>
    </div>
  );
}
