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
  Thermometer,
  Droplets,
  Sun,
  TrendingUp,
  AlertTriangle,
  RotateCcw,
  ArrowUpRight,
  ArrowDownRight,
  Minus,
  Database,
  Info,
} from "lucide-react";
import {
  LineChart,
  Line,
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ResponsiveContainer,
  ReferenceLine,
} from "recharts";

interface PeriodData {
  avgAnnualTemp: number | null;
  avgAnnualPrecip: number | null;
  avgDailySolar: number | null;
  monthlyTemp: (number | null)[];
  monthlyPrecip: (number | null)[];
  monthlySolar: (number | null)[];
  annualPrecipTotals: { year: number; total: number | null }[];
  precipCV: number | null;
}

interface ClimateData {
  location: {
    lat: number;
    lon: number;
    elevation: number | null;
  };
  periods: {
    startYear: number;
    endYear: number;
    recentStart: number;
    recentEnd: number;
    baselineStart: number;
    baselineEnd: number;
  };
  fullRecord: PeriodData;
  baseline: PeriodData;
  recent: PeriodData;
  units: {
    temp: string;
    precip: string;
    solar: string;
    wetness: string;
  };
  source: string;
  spatialResolution: string;
  dataQuality: {
    totalDays: number;
    validDays: Record<string, number>;
    missingDays: Record<string, number>;
  };
  parameters: string[];
  warnings: string[];
  cached?: boolean;
}

const MONTHS = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

// Formatting helpers — only round for display, keep internal precision
function fmt(value: number | null, decimals = 1): string {
  if (value === null || Number.isNaN(value)) return "—";
  return value.toFixed(decimals);
}

function fmtInt(value: number | null): string {
  if (value === null || Number.isNaN(value)) return "—";
  return Math.round(value).toString();
}

function deltaArrow(baseline: number | null, recent: number | null) {
  if (baseline === null || recent === null) {
    return <Minus className="h-4 w-4 text-muted-foreground" />;
  }
  const diff = recent - baseline;
  const pct = baseline !== 0 ? (diff / baseline) * 100 : 0;
  if (Math.abs(diff) < 0.01) {
    return <Minus className="h-4 w-4 text-muted-foreground" />;
  }
  if (diff > 0) {
    return (
      <div className="flex items-center text-accent-red">
        <ArrowUpRight className="h-4 w-4" />
        <span className="ml-0.5 text-xs font-medium">
          +{fmt(Math.abs(pct), 0)}%
        </span>
      </div>
    );
  }
  return (
    <div className="flex items-center text-electric">
      <ArrowDownRight className="h-4 w-4" />
      <span className="ml-0.5 text-xs font-medium">
        -{fmt(Math.abs(pct), 0)}%
      </span>
    </div>
  );
}

export default function ClimatePage() {
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
    climateRaw,
    loading,
    climateError: error,
    refresh: fetchClimate,
  } = useFieldEnvironmentalData(field);
  const data = climateRaw as ClimateData | null;

  if (!isLoaded) {
    return <ClimateSkeleton />;
  }

  if (!field) {
    return (
      <div className="space-y-6">
        <div>
          <h2 className="text-2xl font-serif font-bold text-foreground">
            Climate Fingerprint
          </h2>
          <p className="text-muted-foreground mt-1 max-w-2xl">
            Field not found. Create a field to view its climate profile.
          </p>
        </div>
        <Button onClick={() => router.push("/fields/new")}>
          Create a Field
        </Button>
      </div>
    );
  }

  const monthlyChartData = MONTHS.map((m, i) => ({
    month: m,
    baselineTemp: data?.baseline.monthlyTemp[i] ?? null,
    recentTemp: data?.recent.monthlyTemp[i] ?? null,
    baselinePrecip: data?.baseline.monthlyPrecip[i] ?? null,
    recentPrecip: data?.recent.monthlyPrecip[i] ?? null,
    baselineSolar: data?.baseline.monthlySolar[i] ?? null,
    recentSolar: data?.recent.monthlySolar[i] ?? null,
  }));

  const annualPrecipData = data
    ? [
        ...data.baseline.annualPrecipTotals,
        ...data.recent.annualPrecipTotals,
      ]
        .filter((item): item is { year: number; total: number } => item.total !== null)
        .sort((a, b) => a.year - b.year)
    : [];

  return (
    <div className="space-y-8">
      {/* Header */}
      <div className="space-y-1">
        <h2 className="text-2xl font-serif font-bold text-foreground">
          Climate Fingerprint
        </h2>
        <p className="text-muted-foreground max-w-2xl">
          {data
            ? `Full record ${data.periods.startYear}–${data.periods.endYear} with baseline (${data.periods.baselineStart}–${data.periods.baselineEnd}) vs. recent (${data.periods.recentStart}–${data.periods.recentEnd}) comparison for ${field.name}`
            : `20-year temperature and precipitation profile for ${field.name}`}
        </p>
        <p className="text-xs text-muted-foreground">
          Coordinates: {field.lat.toFixed(4)}, {field.lon.toFixed(4)}
          {data && data.location.elevation !== null &&
            ` · Elevation: ${fmtInt(data.location.elevation)} m`}
        </p>
      </div>

      {/* Loading */}
      {loading && <ClimateSkeleton />}

      {/* Error */}
      {error && !loading && (
        <Card className="border-accent-red/20 bg-accent-red/5">
          <CardHeader className="pb-3">
            <CardTitle className="flex items-center gap-2 text-accent-red">
              <AlertTriangle className="h-5 w-5" />
              Could not load climate data
            </CardTitle>
            <CardDescription className="text-accent-red/80">
              {error}
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Button
              variant="outline"
              size="sm"
              onClick={fetchClimate}
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
          {/* Compact Regional Context Warning */}
          <div className="flex items-start gap-2 rounded-lg border border-border/80 bg-muted/30 px-3.5 py-2.5 text-xs text-muted-foreground">
            <Info className="h-4 w-4 text-electric shrink-0 mt-0.5" />
            <div className="space-y-1">
              <p>
                <strong className="text-foreground">Regional climate context (~55 km grid):</strong>{" "}
                Values represent satellite and meteorological reanalysis averages across the surrounding region, not direct on-farm weather gauge measurements. Local topography, frost pockets, and isolated storms may differ.
              </p>
              {data.warnings.length > 0 && (
                <p className="text-amber-800 font-medium">
                  {data.warnings.join(" · ")}
                </p>
              )}
            </div>
          </div>

          {/* Metric Cards */}
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <SummaryCard
              icon={<Thermometer className="h-5 w-5 text-accent-red" />}
              label="Avg Annual Temperature"
              fullRecord={data.fullRecord.avgAnnualTemp}
              baseline={data.baseline.avgAnnualTemp}
              recent={data.recent.avgAnnualTemp}
              unit={data.units.temp}
              decimals={1}
              delta={deltaArrow(data.baseline.avgAnnualTemp, data.recent.avgAnnualTemp)}
              periodStart={data.periods.startYear}
              periodEnd={data.periods.endYear}
              baselineStart={data.periods.baselineStart}
              baselineEnd={data.periods.baselineEnd}
              recentStart={data.periods.recentStart}
              recentEnd={data.periods.recentEnd}
            />
            <SummaryCard
              icon={<Droplets className="h-5 w-5 text-electric" />}
              label="Avg Annual Precipitation"
              fullRecord={data.fullRecord.avgAnnualPrecip}
              baseline={data.baseline.avgAnnualPrecip}
              recent={data.recent.avgAnnualPrecip}
              unit={data.units.precip}
              decimals={0}
              delta={deltaArrow(
                data.baseline.avgAnnualPrecip,
                data.recent.avgAnnualPrecip
              )}
              periodStart={data.periods.startYear}
              periodEnd={data.periods.endYear}
              baselineStart={data.periods.baselineStart}
              baselineEnd={data.periods.baselineEnd}
              recentStart={data.periods.recentStart}
              recentEnd={data.periods.recentEnd}
            />
            <SummaryCard
              icon={<TrendingUp className="h-5 w-5 text-cyan" />}
              label="Precipitation Variability (CV)"
              fullRecord={data.fullRecord.precipCV}
              baseline={data.baseline.precipCV}
              recent={data.recent.precipCV}
              unit="%"
              decimals={1}
              delta={deltaArrow(data.baseline.precipCV, data.recent.precipCV)}
              periodStart={data.periods.startYear}
              periodEnd={data.periods.endYear}
              baselineStart={data.periods.baselineStart}
              baselineEnd={data.periods.baselineEnd}
              recentStart={data.periods.recentStart}
              recentEnd={data.periods.recentEnd}
            />
            <SummaryCard
              icon={<Sun className="h-5 w-5 text-space" />}
              label="Avg Daily Solar Radiation"
              fullRecord={data.fullRecord.avgDailySolar}
              baseline={data.baseline.avgDailySolar}
              recent={data.recent.avgDailySolar}
              unit={data.units.solar}
              decimals={1}
              delta={deltaArrow(
                data.baseline.avgDailySolar,
                data.recent.avgDailySolar
              )}
              periodStart={data.periods.startYear}
              periodEnd={data.periods.endYear}
              baselineStart={data.periods.baselineStart}
              baselineEnd={data.periods.baselineEnd}
              recentStart={data.periods.recentStart}
              recentEnd={data.periods.recentEnd}
            />
          </div>

          {/* Charts */}
          <div className="grid gap-6 lg:grid-cols-2">
            <ChartCard title="Monthly Temperature" description={`${data.units.temp} — average for each month`}>
              <ResponsiveContainer width="100%" height={280}>
                <LineChart data={monthlyChartData}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#E2E8F0" />
                  <XAxis dataKey="month" tick={{ fontSize: 12 }} />
                  <YAxis
                    tick={{ fontSize: 12 }}
                    label={{
                      value: data.units.temp,
                      angle: -90,
                      position: "insideLeft",
                      offset: 10,
                      style: { fontSize: 12 },
                    }}
                  />
                  <Tooltip
                    contentStyle={{
                      fontSize: 12,
                      borderRadius: 8,
                      border: "1px solid #E2E8F0",
                    }}
                    formatter={(value) => [fmt(value as number | null, 1), "Temperature"] as [string, string]}
                  />
                  <Legend wrapperStyle={{ fontSize: 12 }} />
                  <ReferenceLine y={0} stroke="#CBD5E1" />
                  <Line
                    type="monotone"
                    dataKey="baselineTemp"
                    name={`Baseline (${data.periods.baselineStart}–${data.periods.baselineEnd})`}
                    stroke="#94A3B8"
                    strokeWidth={2}
                    dot={false}
                  />
                  <Line
                    type="monotone"
                    dataKey="recentTemp"
                    name={`Recent (${data.periods.recentStart}–${data.periods.recentEnd})`}
                    stroke="#4D9FFF"
                    strokeWidth={2}
                    dot={false}
                  />
                </LineChart>
              </ResponsiveContainer>
            </ChartCard>

            <ChartCard title="Monthly Precipitation" description={`${data.units.precip} — total for each month`}>
              <ResponsiveContainer width="100%" height={280}>
                <BarChart data={monthlyChartData}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#E2E8F0" />
                  <XAxis dataKey="month" tick={{ fontSize: 12 }} />
                  <YAxis
                    tick={{ fontSize: 12 }}
                    label={{
                      value: data.units.precip,
                      angle: -90,
                      position: "insideLeft",
                      offset: 10,
                      style: { fontSize: 12 },
                    }}
                  />
                  <Tooltip
                    contentStyle={{
                      fontSize: 12,
                      borderRadius: 8,
                      border: "1px solid #E2E8F0",
                    }}
                    formatter={(value) => [fmt(value as number | null, 0), "Precipitation"] as [string, string]}
                  />
                  <Legend wrapperStyle={{ fontSize: 12 }} />
                  <Bar
                    dataKey="baselinePrecip"
                    name={`Baseline (${data.periods.baselineStart}–${data.periods.baselineEnd})`}
                    fill="#94A3B8"
                    radius={[4, 4, 0, 0]}
                  />
                  <Bar
                    dataKey="recentPrecip"
                    name={`Recent (${data.periods.recentStart}–${data.periods.recentEnd})`}
                    fill="#62D5E8"
                    radius={[4, 4, 0, 0]}
                  />
                </BarChart>
              </ResponsiveContainer>
            </ChartCard>
          </div>

          {/* Annual Precipitation Trend */}
          <ChartCard
            title="Annual Precipitation Trend"
            description={`${data.units.precip} per year across the full record`}
          >
            <ResponsiveContainer width="100%" height={300}>
              <BarChart data={annualPrecipData}>
                <CartesianGrid strokeDasharray="3 3" stroke="#E2E8F0" />
                <XAxis dataKey="year" tick={{ fontSize: 12 }} />
                <YAxis
                  tick={{ fontSize: 12 }}
                  label={{
                    value: data.units.precip,
                    angle: -90,
                    position: "insideLeft",
                    offset: 10,
                    style: { fontSize: 12 },
                  }}
                />
                <Tooltip
                  contentStyle={{
                    fontSize: 12,
                    borderRadius: 8,
                    border: "1px solid #E2E8F0",
                  }}
                  formatter={(value) => [fmt(value as number | null, 0), "Total Precipitation"] as [string, string]}
                />
                <Bar dataKey="total" fill="#4D9FFF" radius={[4, 4, 0, 0]} />
                <ReferenceLine
                  x={data.periods.recentStart}
                  stroke="#E34B5B"
                  strokeDasharray="4 4"
                  label={{
                    value: "Recent →",
                    position: "insideTopLeft",
                    style: { fontSize: 11, fill: "#E34B5B" },
                  }}
                />
              </BarChart>
            </ResponsiveContainer>
          </ChartCard>

          {/* Full-Record Monthly Profile Table */}
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-base font-semibold text-foreground">
                Full-Record Monthly Profile
              </CardTitle>
              <CardDescription className="text-xs">
                {data.periods.startYear}–{data.periods.endYear} average per month (useful for planting-window comparisons)
              </CardDescription>
            </CardHeader>
            <CardContent>
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-border">
                      <th className="text-left py-2 pr-4 font-medium text-muted-foreground">Month</th>
                      <th className="text-right py-2 px-3 font-medium text-muted-foreground">Temp</th>
                      <th className="text-right py-2 px-3 font-medium text-muted-foreground">Precip</th>
                      <th className="text-right py-2 px-3 font-medium text-muted-foreground">Solar</th>
                    </tr>
                  </thead>
                  <tbody>
                    {MONTHS.map((m, i) => (
                      <tr key={m} className="border-b border-border/50">
                        <td className="py-2 pr-4 text-foreground font-medium">{m}</td>
                        <td className="text-right py-2 px-3 tabular-nums">
                          {fmt(data.fullRecord.monthlyTemp[i], 1)}{data.units.temp}
                        </td>
                        <td className="text-right py-2 px-3 tabular-nums">
                          {fmt(data.fullRecord.monthlyPrecip[i], 0)} {data.units.precip}
                        </td>
                        <td className="text-right py-2 px-3 tabular-nums">
                          {fmt(data.fullRecord.monthlySolar[i], 1)} {data.units.solar}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </CardContent>
          </Card>

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
            <div className="mt-3 space-y-2 border-t border-border/60 pt-3 leading-relaxed">
              <p>
                <strong className="text-foreground">Live Climate Data:</strong>{" "}
                <a
                  href="https://power.larc.nasa.gov/"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-electric hover:underline"
                >
                  {data.source}
                </a>{" "}
                ({data.spatialResolution}, daily record {data.periods.startYear}–{data.periods.endYear}).
                Parameters queried: daily mean temperature (<code>T2M</code>), daily maximum/minimum temperature, bias-corrected precipitation (<code>PRECTOTCORR</code>), and all-sky surface shortwave downward irradiance (<code>ALLSKY_SFC_SW_DWN</code>).
              </p>
              <p>
                <strong className="text-foreground">Derived Calculations:</strong>{" "}
                Full-record means ({data.periods.startYear}–{data.periods.endYear}) are compared against the historical baseline window ({data.periods.baselineStart}–{data.periods.baselineEnd}) and the recent 5-year window ({data.periods.recentStart}–{data.periods.recentEnd}). Inter-annual precipitation variability is computed as the coefficient of variation (<code>CV = σ / μ × 100%</code>) across complete calendar years.
              </p>
              <p>
                <strong className="text-foreground">Record Coverage &amp; Limitations:</strong>{" "}
                Valid daily observations — temperature {fmtInt(data.dataQuality.validDays["t2m"])} /{" "}
                {data.dataQuality.totalDays} days, precipitation{" "}
                {fmtInt(data.dataQuality.validDays["precip"])} /{" "}
                {data.dataQuality.totalDays} days, solar radiation{" "}
                {fmtInt(data.dataQuality.validDays["solar"])} /{" "}
                {data.dataQuality.totalDays} days. Grid-cell values (~55 km) smooth out field-level microclimates and convective rainfall extremes.{" "}
                <Link
                  href="/data-sources"
                  className="text-electric hover:underline font-medium"
                >
                  View complete data sources catalog →
                </Link>
              </p>
              {data.warnings.length > 0 && (
                <ul className="list-disc list-inside text-amber-800/90 space-y-1 pt-1">
                  {data.warnings.map((w, i) => (
                    <li key={i}>{w}</li>
                  ))}
                </ul>
              )}
            </div>
          </details>
        </>
      )}
    </div>
  );
}

function SummaryCard({
  icon,
  label,
  fullRecord,
  baseline,
  recent,
  unit,
  decimals,
  delta,
  periodStart,
  periodEnd,
  baselineStart,
  baselineEnd,
  recentStart,
  recentEnd,
}: {
  icon: React.ReactNode;
  label: string;
  fullRecord: number | null;
  baseline: number | null;
  recent: number | null;
  unit: string;
  decimals: number;
  delta: React.ReactNode;
  periodStart: number;
  periodEnd: number;
  baselineStart: number;
  baselineEnd: number;
  recentStart: number;
  recentEnd: number;
}) {
  return (
    <Card className="h-full">
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between">
          <div className="inline-flex h-9 w-9 items-center justify-center rounded-lg bg-electric/10">
            {icon}
          </div>
          {delta}
        </div>
        <CardTitle className="text-sm font-medium text-muted-foreground mt-2">
          {label}
        </CardTitle>
      </CardHeader>
      <CardContent className="pt-0">
        {/* Full-record as prominent main value */}
        <div className="flex items-baseline gap-1.5">
          <span className="text-3xl font-bold text-foreground tabular-nums">{fmt(fullRecord, decimals)}</span>
          <span className="text-sm font-medium text-muted-foreground">{unit}</span>
        </div>
        <p className="text-[11px] font-semibold text-electric uppercase tracking-wide mt-1">
          Full record ({periodStart}–{periodEnd})
        </p>

        {/* Baseline + recent as structured sub-items */}
        <div className="mt-3 pt-2 border-t border-border/50 space-y-1.5">
          <div className="flex justify-between items-baseline text-xs">
            <span className="text-muted-foreground tabular-nums">Baseline {baselineStart}–{baselineEnd}</span>
            <span className="font-medium text-foreground tabular-nums">{fmt(baseline, decimals)} {unit}</span>
          </div>
          <div className="flex justify-between items-baseline text-xs">
            <span className="text-muted-foreground tabular-nums">Recent {recentStart}–{recentEnd}</span>
            <span className="font-medium text-foreground tabular-nums">{fmt(recent, decimals)} {unit}</span>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

function ChartCard({
  title,
  description,
  children,
}: {
  title: string;
  description?: string;
  children: React.ReactNode;
}) {
  return (
    <Card className="h-full">
      <CardHeader className="pb-2">
        <CardTitle className="text-base font-semibold text-foreground">
          {title}
        </CardTitle>
        {description && (
          <CardDescription className="text-xs">{description}</CardDescription>
        )}
      </CardHeader>
      <CardContent>{children}</CardContent>
    </Card>
  );
}

function ClimateSkeleton() {
  return (
    <div className="space-y-8">
      <div className="space-y-2">
        <Skeleton className="h-8 w-64" />
        <Skeleton className="h-4 w-96" />
      </div>
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <Card key={i} className="h-full">
            <CardHeader className="pb-2">
              <Skeleton className="h-9 w-9 rounded-lg" />
              <Skeleton className="h-4 w-32 mt-2" />
            </CardHeader>
            <CardContent className="pt-0">
              <Skeleton className="h-8 w-20" />
              <Skeleton className="h-3 w-48 mt-2" />
            </CardContent>
          </Card>
        ))}
      </div>
      <div className="grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader className="pb-2">
            <Skeleton className="h-5 w-40" />
          </CardHeader>
          <CardContent>
            <Skeleton className="h-[280px] w-full rounded-md" />
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <Skeleton className="h-5 w-48" />
          </CardHeader>
          <CardContent>
            <Skeleton className="h-[280px] w-full rounded-md" />
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
