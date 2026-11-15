"use client";

import { useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { useField } from "@/components/providers";
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
  source: string;
  coverage: string;
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
    };
    drainage: string | null;
    slope: number | null;
  };
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

export default function SoilPage() {
  const params = useParams();
  const router = useRouter();
  const { fields, activeField, setActiveField, isLoaded } = useField();
  const [data, setData] = useState<SoilData | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

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

  const fetchSoil = async () => {
    if (!field) return;
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(
        `/api/soil?lat=${field.lat.toFixed(4)}&lon=${field.lon.toFixed(4)}`
      );
      const json = await res.json();
      if (!res.ok) {
        setError(json.error || `Request failed (${res.status})`);
        setData(null);
      } else {
        setData(json);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Network error");
      setData(null);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (field) {
      fetchSoil();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [field?.id]);

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

  return (
    <div className="space-y-8">
      {/* Header */}
      <div className="space-y-1">
        <h2 className="text-2xl font-serif font-bold text-foreground">
          Soil Profile
        </h2>
        <p className="text-muted-foreground max-w-2xl">
          {data
            ? `SSURGO soil data for ${field.name}. Properties are depth-weighted averages for the upper 30 cm.`
            : `Soil texture, drainage, and properties for ${field.name}`}
        </p>
        <p className="text-xs text-muted-foreground">
          Coordinates: {field.lat.toFixed(4)}, {field.lon.toFixed(4)}
          {data?.mapUnit && ` · Map unit: ${data.mapUnit.name}`}
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

          {/* Component Composition */}
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-base font-semibold text-foreground">
                Component Composition
              </CardTitle>
              <CardDescription className="text-xs">
                Named soil components in the map unit. Percentages reflect the share of each component within the map unit polygon.
              </CardDescription>
            </CardHeader>
            <CardContent>
              {data.components.length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  No component data available.
                </p>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b border-border">
                        <th className="text-left py-2 pr-4 font-medium text-muted-foreground">
                          Component
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
                          Horizons
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
                            {comp.name}
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

          {/* Horizon details per component */}
          {data.components.map((comp) =>
            comp.horizons.length > 0 ? (
              <Card key={comp.cokey}>
                <CardHeader className="pb-3">
                  <CardTitle className="text-base font-semibold text-foreground">
                    {comp.name} — Horizon Data
                  </CardTitle>
                  <CardDescription className="text-xs">
                    Depth-weighted contributions to the 0-30 cm aggregate from
                    this component ({comp.percent}% of map unit).
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

          {/* Limitations */}
          {data.limitations.length > 0 && (
            <Card className="border-amber-200 bg-amber-50/50">
              <CardHeader className="pb-2">
                <CardTitle className="flex items-center gap-2 text-amber-800 text-sm">
                  <AlertTriangle className="h-4 w-4" />
                  Data Quality & Limitations
                </CardTitle>
              </CardHeader>
              <CardContent>
                <ul className="list-disc list-inside text-sm text-amber-800/80 space-y-1">
                  {data.limitations.map((l, i) => (
                    <li key={i}>{l}</li>
                  ))}
                </ul>
              </CardContent>
            </Card>
          )}

          {/* Source & Disclaimer */}
          <div className="space-y-2 rounded-lg border border-border bg-muted/40 p-4">
            <p className="text-xs font-medium text-foreground">Data Source</p>
            <p className="text-xs text-muted-foreground">{data.source}</p>
            <p className="text-xs font-medium text-foreground mt-2">
              Coverage & Limitations
            </p>
            <p className="text-xs text-muted-foreground">{data.coverage}</p>
            <p className="text-xs text-muted-foreground mt-1">
              Aggregated values are decision-support heuristics, not
              field-level measurements. On-site soil testing is recommended
              before management decisions.
            </p>
          </div>
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
