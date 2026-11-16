"use client";

import { useEffect, useState, useMemo } from "react";
import { useParams, useRouter } from "next/navigation";
import Link from "next/link";
import {
  useField,
  useFieldEnvironmentalData,
} from "@/components/providers";
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
  computeClimateAnalogues,
  type AnalogueTargetMode,
  type HistoricalAnalogueMatch,
} from "@/lib/climate-analogues";
import {
  formatScenarioSummary,
  isBaselineScenario,
} from "@/lib/what-if-simulator";
import {
  GitCompare,
  Thermometer,
  Droplets,
  AlertTriangle,
  RotateCcw,
  SlidersHorizontal,
  Calendar,
  CheckCircle2,
  BookOpen,
  Info,
  Award,
} from "lucide-react";
import {
  ComposedChart,
  Line,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ResponsiveContainer,
} from "recharts";

const MONTHS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];

function fmt(val: number | null | undefined, decimals = 1): string {
  if (val === null || val === undefined || Number.isNaN(val)) return "—";
  return val.toFixed(decimals);
}

function fmtSigned(
  val: number | null | undefined,
  decimals = 1,
  unit = ""
): string {
  if (val === null || val === undefined || Number.isNaN(val)) return "—";
  const sign = val > 0 ? "+" : "";
  return `${sign}${val.toFixed(decimals)}${unit}`;
}

export default function ClimateAnaloguesPage() {
  const params = useParams();
  const router = useRouter();
  const {
    fields,
    activeField,
    setActiveField,
    getFieldWhatIfScenario,
    isLoaded,
  } = useField();

  const fieldId = typeof params.id === "string" ? params.id : undefined;

  useEffect(() => {
    if (!isLoaded || !fieldId) return;
    const found = fields.find((f) => f.id === fieldId);
    if (
      found &&
      (!activeField ||
        activeField.id !== fieldId ||
        activeField.generatedRotations !== found.generatedRotations)
    ) {
      setActiveField(found);
    }
  }, [isLoaded, fieldId, activeField, fields, setActiveField]);

  const field =
    (fieldId ? fields.find((f) => f.id === fieldId) : undefined) ??
    activeField ??
    undefined;

  const { climate, loading, error, refresh } =
    useFieldEnvironmentalData(field);

  const whatIfScenario = useMemo(
    () => (field ? getFieldWhatIfScenario(field.id) : undefined),
    [field, getFieldWhatIfScenario]
  );
  const hasActiveWhatIf = Boolean(
    whatIfScenario && !isBaselineScenario(whatIfScenario)
  );

  const [targetMode, setTargetMode] =
    useState<AnalogueTargetMode>("recent_window");
  const [selectedTargetYear, setSelectedTargetYear] = useState<
    number | undefined
  >(undefined);
  const [inspectedMatchYear, setInspectedMatchYear] = useState<number | null>(
    null
  );

  const availableYears = useMemo(() => {
    if (!climate?.historicalYears) return [];
    return [...climate.historicalYears]
      .filter((y) => y.avgTemp !== null && y.totalPrecip !== null)
      .map((y) => y.year)
      .sort((a, b) => b - a);
  }, [climate]);

  useEffect(() => {
    if (selectedTargetYear === undefined && availableYears.length > 0) {
      setSelectedTargetYear(availableYears[0]);
    }
  }, [availableYears, selectedTargetYear]);

  const analoguesResult = useMemo(() => {
    if (!climate) return null;
    return computeClimateAnalogues({
      climate,
      mode: targetMode,
      targetYear: selectedTargetYear,
      whatIfScenario,
      topN: 6,
    });
  }, [climate, targetMode, selectedTargetYear, whatIfScenario]);

  const activeMatch: HistoricalAnalogueMatch | null = useMemo(() => {
    if (!analoguesResult || analoguesResult.matches.length === 0) return null;
    if (inspectedMatchYear !== null) {
      const found = analoguesResult.matches.find(
        (m) => m.year === inspectedMatchYear
      );
      if (found) return found;
    }
    return analoguesResult.matches[0];
  }, [analoguesResult, inspectedMatchYear]);

  if (!isLoaded) {
    return <AnaloguesSkeleton />;
  }

  if (!field) {
    return (
      <div className="space-y-6">
        <div>
          <h2 className="text-2xl font-serif font-bold text-foreground">
            Climate Analogues
          </h2>
          <p className="text-muted-foreground mt-1 max-w-2xl">
            Field not found. Create a field to compare historical growing
            seasons.
          </p>
        </div>
        <Button onClick={() => router.push("/fields/new")}>
          Create a Field
        </Button>
      </div>
    );
  }

  const overlayChartData =
    analoguesResult?.target && activeMatch
      ? MONTHS.map((m, i) => ({
          month: m,
          targetTemp: analoguesResult.target?.monthlyTemp[i] ?? null,
          analogueTemp: activeMatch.record.monthlyTemp[i] ?? null,
          targetPrecip: analoguesResult.target?.monthlyPrecip[i] ?? null,
          analoguePrecip: activeMatch.record.monthlyPrecip[i] ?? null,
        }))
      : [];

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="space-y-1">
          <h2 className="text-2xl font-serif font-bold text-foreground">
            Historical Climate Analogues
          </h2>
          <p className="text-sm text-muted-foreground max-w-2xl">
            Identify which historical growing seasons in the 20-year climate
            record for <strong className="text-foreground">{field.name}</strong>{" "}
            most closely match your current climate, a specific reference year,
            or a hypothetical What-If scenario.
          </p>
        </div>

        <Link href={`/field/${field.id}/simulator`}>
          <Button variant="outline" size="sm" className="text-xs shrink-0">
            <SlidersHorizontal className="mr-1.5 h-3.5 w-3.5 text-amber-600" />
            Configure What-If Scenario
          </Button>
        </Link>
      </div>

      {loading && <AnaloguesSkeleton />}

      {error && !loading && (
        <Card className="border-accent-red/20 bg-accent-red/5">
          <CardHeader className="pb-3">
            <CardTitle className="flex items-center gap-2 text-accent-red text-base">
              <AlertTriangle className="h-5 w-5" />
              Could not load historical climate archive
            </CardTitle>
            <CardDescription className="text-accent-red/80">
              {error}
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Button
              variant="outline"
              size="sm"
              onClick={refresh}
              className="border-accent-red/30 text-accent-red hover:bg-accent-red/10"
            >
              <RotateCcw className="mr-2 h-4 w-4" />
              Retry
            </Button>
          </CardContent>
        </Card>
      )}

      {!loading && !error && analoguesResult && (
        <>
          {/* 1. Target Condition Selector */}
          <Card className="border-l-4 border-l-indigo-500">
            <CardHeader className="pb-3">
              <CardTitle className="text-base font-semibold text-foreground flex items-center gap-2">
                <GitCompare className="h-4 w-4 text-indigo-600" />
                Select Target Conditions to Match Against the Historical Archive
              </CardTitle>
              <CardDescription className="text-xs">
                Archive period:{" "}
                <strong className="text-foreground">
                  {analoguesResult.archivePeriodLabel}
                </strong>{" "}
                ({analoguesResult.totalValidArchiveYears} complete years) ·{" "}
                {analoguesResult.growingSeasonLabel}
              </CardDescription>
            </CardHeader>

            <CardContent className="space-y-4">
              <div className="grid gap-3 md:grid-cols-3">
                {/* Option 1: Recent Climate Window */}
                <button
                  type="button"
                  onClick={() => {
                    setTargetMode("recent_window");
                    setInspectedMatchYear(null);
                  }}
                  className={`rounded-lg border p-3.5 text-left transition-colors space-y-1 ${
                    targetMode === "recent_window"
                      ? "border-indigo-600 bg-indigo-50/70 text-foreground shadow-sm"
                      : "border-border bg-background hover:bg-muted/50"
                  }`}
                >
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-bold text-foreground">
                      1. Recent Field Climate
                    </span>
                    {targetMode === "recent_window" && (
                      <CheckCircle2 className="h-4 w-4 text-indigo-600" />
                    )}
                  </div>
                  <p className="text-[11px] text-muted-foreground">
                    Compare recent 5-year average conditions against prior
                    baseline historical years.
                  </p>
                </button>

                {/* Option 2: Hypothetical What-If Scenario */}
                <button
                  type="button"
                  onClick={() => {
                    setTargetMode("what_if_scenario");
                    setInspectedMatchYear(null);
                  }}
                  className={`rounded-lg border p-3.5 text-left transition-colors space-y-1 ${
                    targetMode === "what_if_scenario"
                      ? "border-indigo-600 bg-indigo-50/70 text-foreground shadow-sm"
                      : "border-border bg-background hover:bg-muted/50"
                  }`}
                >
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-bold text-foreground">
                      2. What-If Scenario
                    </span>
                    {hasActiveWhatIf ? (
                      <span className="rounded bg-amber-100 px-1.5 py-0.5 text-[10px] font-semibold text-amber-900">
                        Active
                      </span>
                    ) : (
                      targetMode === "what_if_scenario" && (
                        <CheckCircle2 className="h-4 w-4 text-indigo-600" />
                      )
                    )}
                  </div>
                  <p className="text-[11px] text-muted-foreground">
                    {whatIfScenario
                      ? formatScenarioSummary(whatIfScenario)
                      : "Find real past years that resembled a hypothetical scenario."}
                  </p>
                </button>

                {/* Option 3: Specific Historical Year */}
                <div
                  onClick={() => {
                    setTargetMode("specific_year");
                    setInspectedMatchYear(null);
                  }}
                  className={`rounded-lg border p-3.5 text-left transition-colors space-y-1.5 cursor-pointer ${
                    targetMode === "specific_year"
                      ? "border-indigo-600 bg-indigo-50/70 text-foreground shadow-sm"
                      : "border-border bg-background hover:bg-muted/50"
                  }`}
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-xs font-bold text-foreground">
                      3. Specific Historical Year
                    </span>
                    <select
                      aria-label="Select reference historical year"
                      value={selectedTargetYear ?? ""}
                      onChange={(e) => {
                        setTargetMode("specific_year");
                        setSelectedTargetYear(Number(e.target.value));
                        setInspectedMatchYear(null);
                      }}
                      onClick={(e) => e.stopPropagation()}
                      className="rounded border border-border bg-background px-2 py-0.5 text-xs font-semibold text-foreground"
                    >
                      {availableYears.map((yr) => (
                        <option key={yr} value={yr}>
                          {yr}
                        </option>
                      ))}
                    </select>
                  </div>
                  <p className="text-[11px] text-muted-foreground">
                    Find other years in the archive most similar to{" "}
                    {selectedTargetYear ?? "the chosen year"} (excluding itself).
                  </p>
                </div>
              </div>

              {/* Target Summary Banner */}
              {analoguesResult.target && (
                <div className="rounded-lg border border-indigo-200/80 bg-indigo-50/30 p-3.5 text-xs space-y-2">
                  <div className="flex items-center justify-between gap-2 flex-wrap">
                    <div>
                      <span className="text-[10px] font-semibold uppercase tracking-wide text-indigo-700">
                        Active Target Profile
                      </span>
                      <h3 className="text-sm font-semibold text-foreground">
                        {analoguesResult.target.label}
                      </h3>
                    </div>
                    <span className="text-[11px] text-muted-foreground">
                      Compared against{" "}
                      <strong className="text-foreground">
                        {analoguesResult.candidateYearsEvaluated}
                      </strong>{" "}
                      candidate years
                      {analoguesResult.target.excludedYears.length > 0 &&
                        ` (excluded target years: ${analoguesResult.target.excludedYears.join(", ")})`}
                    </span>
                  </div>

                  <p className="text-muted-foreground">
                    {analoguesResult.target.description}
                  </p>

                  <div className="grid grid-cols-2 sm:grid-cols-4 gap-2.5 pt-1">
                    <div className="rounded bg-white/90 border border-border/60 px-2.5 py-1.5">
                      <p className="text-[10px] text-muted-foreground">
                        Target Annual Temp
                      </p>
                      <p className="text-sm font-bold tabular-nums text-foreground">
                        {fmt(analoguesResult.target.avgTempC, 1)} °C
                      </p>
                    </div>
                    <div className="rounded bg-white/90 border border-border/60 px-2.5 py-1.5">
                      <p className="text-[10px] text-muted-foreground">
                        Target Annual Rain
                      </p>
                      <p className="text-sm font-bold tabular-nums text-foreground">
                        {fmt(analoguesResult.target.totalPrecipMm, 0)} mm
                      </p>
                    </div>
                    <div className="rounded bg-white/90 border border-border/60 px-2.5 py-1.5">
                      <p className="text-[10px] text-muted-foreground">
                        Growing-Season Temp
                      </p>
                      <p className="text-sm font-bold tabular-nums text-foreground">
                        {fmt(analoguesResult.target.growingSeasonTempC, 1)} °C
                      </p>
                    </div>
                    <div className="rounded bg-white/90 border border-border/60 px-2.5 py-1.5">
                      <p className="text-[10px] text-muted-foreground">
                        Growing-Season Rain
                      </p>
                      <p className="text-sm font-bold tabular-nums text-foreground">
                        {fmt(analoguesResult.target.growingSeasonPrecipMm, 0)} mm
                      </p>
                    </div>
                  </div>
                </div>
              )}
            </CardContent>
          </Card>

          {/* Insufficient Data State */}
          {analoguesResult.status === "insufficient_data" && (
            <Card className="border-amber-200 bg-amber-50/50">
              <CardHeader className="pb-2">
                <CardTitle className="text-sm font-semibold text-amber-900 flex items-center gap-2">
                  <AlertTriangle className="h-4 w-4 text-amber-700" />
                  Insufficient Historical Archive Data for Analogue Ranking
                </CardTitle>
              </CardHeader>
              <CardContent className="text-xs text-amber-900/90">
                {analoguesResult.insufficientReason}
              </CardContent>
            </Card>
          )}

          {/* 2. Ranked Historical Analogue Cards */}
          {analoguesResult.status === "ready" && (
            <>
              <div className="space-y-3">
                <div className="flex items-center justify-between gap-2 flex-wrap">
                  <h3 className="text-base font-serif font-bold text-foreground">
                    Closest Historical Growing Seasons (Ranked by Multi-Metric Similarity)
                  </h3>
                  <p className="text-xs text-muted-foreground">
                    Click any historical year card to overlay its 12-month curve below
                  </p>
                </div>

                <div className="flex items-start gap-2 rounded-lg border border-border/80 bg-muted/30 px-3.5 py-2 text-xs text-muted-foreground">
                  <Info className="h-4 w-4 text-electric shrink-0 mt-0.5" />
                  <p>
                    <strong className="text-foreground">Historical analogue context:</strong>{" "}
                    Matches rank real past years from this field&apos;s ~55 km regional climate archive ({analoguesResult.archivePeriodLabel}) by seasonal temperature, rainfall, and stress similarity—they do not predict upcoming weather or replicate sub-monthly storm timing.
                  </p>
                </div>

                <div className="grid gap-4 lg:grid-cols-3">
                  {analoguesResult.matches.map((match) => {
                    const isInspected = activeMatch?.year === match.year;
                    const badgeColor =
                      match.similarityScore >= 80
                        ? "bg-emerald-50 text-emerald-800 border-emerald-200"
                        : match.similarityScore >= 65
                        ? "bg-indigo-50 text-indigo-800 border-indigo-200"
                        : "bg-amber-50 text-amber-900 border-amber-200";

                    return (
                      <Card
                        key={match.year}
                        onClick={() => setInspectedMatchYear(match.year)}
                        className={`cursor-pointer transition-all flex flex-col justify-between ${
                          isInspected
                            ? "border-2 border-indigo-600 shadow-md"
                            : "hover:border-indigo-300"
                        }`}
                      >
                        <CardHeader className="pb-2.5 space-y-2">
                          <div className="flex items-start justify-between gap-2">
                            <div className="flex items-center gap-2">
                              <span
                                className={`inline-flex h-7 w-7 items-center justify-center rounded-full text-xs font-bold ${
                                  match.rank === 1
                                    ? "bg-indigo-600 text-white"
                                    : "bg-muted text-foreground"
                                }`}
                              >
                                #{match.rank}
                              </span>
                              <div>
                                <CardTitle className="text-lg font-bold tabular-nums text-foreground flex items-center gap-1.5">
                                  {match.year}
                                  {match.rank === 1 && (
                                    <Award className="h-4 w-4 text-indigo-600" />
                                  )}
                                </CardTitle>
                                <p className="text-[11px] font-medium text-muted-foreground">
                                  {match.seasonCharacterLabel}
                                </p>
                              </div>
                            </div>

                            <div
                              className={`rounded-lg border px-2.5 py-1 text-right ${badgeColor}`}
                            >
                              <div className="text-base font-bold tabular-nums leading-none">
                                {match.similarityScore}%
                              </div>
                              <div className="text-[10px] font-semibold uppercase tracking-wide mt-0.5">
                                Similarity
                              </div>
                            </div>
                          </div>
                        </CardHeader>

                        <CardContent className="space-y-3 pt-0 text-xs">
                          {/* Temperature & Rainfall Deltas vs Target */}
                          <div className="grid grid-cols-2 gap-2 rounded-md bg-muted/35 p-2.5">
                            <div>
                              <p className="text-[10px] text-muted-foreground flex items-center gap-1">
                                <Thermometer className="h-3 w-3 text-accent-red" />
                                Annual Temp
                              </p>
                              <p className="font-bold text-foreground tabular-nums">
                                {fmt(match.record.avgTemp, 1)} °C{" "}
                                <span className="text-[11px] font-medium text-muted-foreground">
                                  ({fmtSigned(match.deltas.annualTempDeltaC, 1, "°C")})
                                </span>
                              </p>
                            </div>
                            <div>
                              <p className="text-[10px] text-muted-foreground flex items-center gap-1">
                                <Droplets className="h-3 w-3 text-electric" />
                                Annual Rain
                              </p>
                              <p className="font-bold text-foreground tabular-nums">
                                {fmt(match.record.totalPrecip, 0)} mm{" "}
                                <span className="text-[11px] font-medium text-muted-foreground">
                                  ({fmtSigned(match.deltas.annualPrecipDeltaPct, 0, "%")})
                                </span>
                              </p>
                            </div>
                            <div>
                              <p className="text-[10px] text-muted-foreground">
                                Grow-Season Temp
                              </p>
                              <p className="font-semibold text-foreground tabular-nums">
                                {fmt(match.growingSeasonTempC, 1)} °C{" "}
                                <span className="text-[10px] text-muted-foreground">
                                  ({fmtSigned(match.deltas.growingSeasonTempDeltaC, 1, "°C")})
                                </span>
                              </p>
                            </div>
                            <div>
                              <p className="text-[10px] text-muted-foreground">
                                Grow-Season Rain
                              </p>
                              <p className="font-semibold text-foreground tabular-nums">
                                {fmt(match.growingSeasonPrecipMm, 0)} mm{" "}
                                <span className="text-[10px] text-muted-foreground">
                                  ({fmtSigned(match.deltas.growingSeasonPrecipDeltaPct, 0, "%")})
                                </span>
                              </p>
                            </div>
                          </div>

                          {/* Observed Stress Indicators in that Historical Year */}
                          <div className="flex items-center justify-between text-[11px] text-muted-foreground px-0.5">
                            <span>
                              Dry spell:{" "}
                              <strong className="text-foreground tabular-nums">
                                {match.record.summerDrySpellDays} d
                              </strong>
                            </span>
                            <span>
                              Heat (&gt;35°C):{" "}
                              <strong className="text-foreground tabular-nums">
                                {match.record.summerHeatDays} d
                              </strong>
                            </span>
                            <span>
                              Dist:{" "}
                              <strong className="text-foreground tabular-nums">
                                {match.compositeDistance.toFixed(2)}σ
                              </strong>
                            </span>
                          </div>

                          {/* Why this year matched */}
                          <ul className="space-y-1 border-t border-border/60 pt-2 text-[11px] text-muted-foreground">
                            {match.selectionReasons.map((reason, idx) => (
                              <li key={idx} className="flex items-start gap-1.5 leading-snug">
                                <span className="mt-1.5 h-1.5 w-1.5 rounded-full bg-indigo-500 shrink-0" />
                                <span>{reason}</span>
                              </li>
                            ))}
                          </ul>
                        </CardContent>
                      </Card>
                    );
                  })}
                </div>
              </div>

              {/* 3. Monthly Overlay Chart for Inspected Analogue Year */}
              {activeMatch && analoguesResult.target && (
                <Card>
                  <CardHeader className="pb-2">
                    <div className="flex items-center justify-between gap-2 flex-wrap">
                      <div>
                        <CardTitle className="text-base font-semibold text-foreground flex items-center gap-2">
                          <Calendar className="h-4 w-4 text-indigo-600" />
                          12-Month Seasonal Comparison: {analoguesResult.target.label} vs.{" "}
                          {activeMatch.year} (#{activeMatch.rank} Match,{" "}
                          {activeMatch.similarityScore}% Similarity)
                        </CardTitle>
                        <CardDescription className="text-xs">
                          Monthly temperature (°C) and precipitation (mm) trajectory
                          comparing target conditions against observed {activeMatch.year}{" "}
                          records.
                        </CardDescription>
                      </div>
                    </div>
                  </CardHeader>
                  <CardContent>
                    <ResponsiveContainer width="100%" height={300}>
                      <ComposedChart data={overlayChartData}>
                        <CartesianGrid strokeDasharray="3 3" stroke="#E2E8F0" />
                        <XAxis dataKey="month" tick={{ fontSize: 12 }} />
                        <YAxis
                          yAxisId="temp"
                          tick={{ fontSize: 12 }}
                          label={{
                            value: "°C",
                            angle: -90,
                            position: "insideLeft",
                            style: { fontSize: 11 },
                          }}
                        />
                        <YAxis
                          yAxisId="precip"
                          orientation="right"
                          tick={{ fontSize: 12 }}
                          label={{
                            value: "mm",
                            angle: 90,
                            position: "insideRight",
                            style: { fontSize: 11 },
                          }}
                        />
                        <Tooltip
                          formatter={(value, name) => {
                            const num =
                              typeof value === "number" ? value : Number(value);
                            if (!Number.isFinite(num)) return ["—", String(name)];
                            const isTemp =
                              String(name).includes("Temp") ||
                              String(name).includes("°C");
                            return [
                              isTemp
                                ? `${num.toFixed(1)} °C`
                                : `${Math.round(num)} mm`,
                              String(name),
                            ];
                          }}
                          contentStyle={{
                            fontSize: 12,
                            borderRadius: 8,
                            border: "1px solid #E2E8F0",
                          }}
                        />
                        <Legend wrapperStyle={{ fontSize: 12 }} />
                        <Bar
                          yAxisId="precip"
                          dataKey="targetPrecip"
                          name="Target Precip (mm)"
                          fill="#94A3B8"
                          radius={[3, 3, 0, 0]}
                        />
                        <Bar
                          yAxisId="precip"
                          dataKey="analoguePrecip"
                          name={`${activeMatch.year} Precip (mm)`}
                          fill="#6366F1"
                          radius={[3, 3, 0, 0]}
                        />
                        <Line
                          yAxisId="temp"
                          type="monotone"
                          dataKey="targetTemp"
                          name="Target Temp (°C)"
                          stroke="#64748B"
                          strokeWidth={2}
                          strokeDasharray="4 4"
                          dot={false}
                        />
                        <Line
                          yAxisId="temp"
                          type="monotone"
                          dataKey="analogueTemp"
                          name={`${activeMatch.year} Temp (°C)`}
                          stroke="#E34B5B"
                          strokeWidth={2.5}
                          dot={false}
                        />
                      </ComposedChart>
                    </ResponsiveContainer>
                  </CardContent>
                </Card>
              )}
            </>
          )}

          {/* 4. Data Sources & Methodology */}
          <details className="group rounded-lg border border-border/70 bg-muted/20 px-4 py-3 text-xs text-muted-foreground">
            <summary className="flex cursor-pointer items-center justify-between font-medium text-foreground/80 hover:text-foreground list-none">
              <span className="flex items-center gap-2">
                <BookOpen className="h-3.5 w-3.5 text-muted-foreground" />
                Data Sources &amp; Methodology
              </span>
              <span className="text-[11px] text-muted-foreground group-open:rotate-180 transition-transform">
                ▼
              </span>
            </summary>
            <div className="mt-3 space-y-2 border-t border-border/60 pt-3 leading-relaxed">
              <p>
                <strong className="text-foreground">Historical Climate Archive (Live):</strong>{" "}
                <a
                  href="https://power.larc.nasa.gov/"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-electric hover:underline"
                >
                  {analoguesResult.source}
                </a>{" "}
                ({analoguesResult.spatialResolution}, archive period {analoguesResult.archivePeriodLabel} with {analoguesResult.totalValidArchiveYears} complete years having ≥300 valid daily observations).
              </p>
              <p>
                <strong className="text-foreground">Similarity Engine (Derived Calculations):</strong>{" "}
                {analoguesResult.methodologySummary}
              </p>
              <p>
                <strong className="text-foreground">Limitations:</strong>{" "}
                Analogue rankings reflect regional grid-cell averages (~55 km) and seasonal/monthly totals rather than local hail, wind, or farm-gauge extremes.{" "}
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

function AnaloguesSkeleton() {
  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <Skeleton className="h-5 w-72" />
          <Skeleton className="h-3 w-96 mt-1" />
        </CardHeader>
        <CardContent className="grid gap-3 md:grid-cols-3">
          <Skeleton className="h-24 w-full rounded-lg" />
          <Skeleton className="h-24 w-full rounded-lg" />
          <Skeleton className="h-24 w-full rounded-lg" />
        </CardContent>
      </Card>
      <div className="grid gap-4 lg:grid-cols-3">
        <Skeleton className="h-64 w-full rounded-xl" />
        <Skeleton className="h-64 w-full rounded-xl" />
        <Skeleton className="h-64 w-full rounded-xl" />
      </div>
    </div>
  );
}
