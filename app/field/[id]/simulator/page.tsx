"use client";

import { useEffect, useState, useCallback, useMemo, useRef } from "react";
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
  type FactorKey,
  FACTOR_LABELS,
  DEFAULT_AI_TIMEOUT_MS,
  scoreStrategy,
  rankStrategyResults,
  isVerifiedAiStrategyForField,
} from "@/lib/rotation-scoring";
import {
  formatAgGroupLabel,
  formatMoistureZoneLabel,
  formatWaterRegimeLabel,
} from "@/lib/agro-classifier";
import {
  type WhatIfScenario,
  type PrecipAdjustmentMode,
  WHAT_IF_PRESETS,
  evaluateWhatIfScenario,
  formatEnumLabel,
  formatSeasonSequenceNames,
} from "@/lib/what-if-simulator";
import { detectRegion, resolveGeographicContext } from "@/lib/region";
import type { GenerationResult } from "@/lib/rotation-generator";
import {
  SlidersHorizontal,
  RotateCcw,
  Thermometer,
  Droplets,
  Sparkles,
  RefreshCw,
  AlertTriangle,
  ArrowRight,
  CalendarDays,
  GitCompare,
  Info,
  TrendingUp,
  TrendingDown,
  Minus,
  Compass,
  Sprout,
  BookOpen,
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

const FACTOR_KEYS: FactorKey[] = [
  "waterSuitability",
  "nitrogenContribution",
  "soilCoverage",
  "diversityPestBreak",
  "climateRiskResilience",
];

function fmt(val: number | null | undefined, decimals = 1): string {
  if (val === null || val === undefined || Number.isNaN(val)) return "—";
  return val.toFixed(decimals);
}

function fmtSigned(val: number | null | undefined, decimals = 1, unit = ""): string {
  if (val === null || val === undefined || Number.isNaN(val)) return "—";
  const sign = val > 0 ? "+" : "";
  return `${sign}${val.toFixed(decimals)}${unit}`;
}

export default function WhatIfSimulatorPage() {
  const params = useParams();
  const router = useRouter();
  const {
    fields,
    activeField,
    priorities,
    setActiveField,
    getFieldWhatIfScenario,
    setFieldWhatIfScenario,
    resetFieldWhatIfScenario,
    getFieldScenarioRotations,
    setFieldScenarioRotations,
    setSelectedStrategyId,
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

  const { climate, soil, loading, error, refresh } =
    useFieldEnvironmentalData(field);

  const scenario: WhatIfScenario = useMemo(
    () =>
      field
        ? getFieldWhatIfScenario(field.id)
        : {
            tempDeltaC: 0,
            precipMode: "percent",
            precipDeltaPct: 0,
            precipDeltaMm: 0,
          },
    [field, getFieldWhatIfScenario]
  );

  const [generatingScenarioPlans, setGeneratingScenarioPlans] = useState(false);
  const [scenarioGenerateError, setScenarioGenerateError] = useState<
    string | null
  >(null);
  const [cropFilter, setCropFilter] = useState<
    "all" | "stressed" | "improved" | "boundary"
  >("all");
  const inFlightScenarioGenRef = useRef(false);

  const detectedRegion = useMemo(
    () => (field ? detectRegion(field.lat, field.lon) : null),
    [field]
  );
  const geoContext = useMemo(
    () => (field ? resolveGeographicContext(field.lat, field.lon) : null),
    [field]
  );
  const regionTag = detectedRegion?.tag ?? geoContext?.regionTag ?? null;

  const verifiedBaselineStrategies = useMemo(() => {
    if (!field?.generatedRotations?.strategies) return [];
    return field.generatedRotations.strategies.filter((s) =>
      isVerifiedAiStrategyForField(s, field.id)
    );
  }, [field]);

  const evaluation = useMemo(() => {
    if (!climate) return null;
    return evaluateWhatIfScenario({
      baselineClimate: climate,
      soil,
      priorities,
      strategies: verifiedBaselineStrategies,
      scenario,
      regionTag,
    });
  }, [climate, soil, priorities, verifiedBaselineStrategies, scenario, regionTag]);

  const scenarioRotations = useMemo(
    () => (field ? getFieldScenarioRotations(field.id) : null),
    [field, getFieldScenarioRotations]
  );

  const scoredScenarioRotations = useMemo(() => {
    if (!scenarioRotations || !evaluation) return [];
    const underScenario = rankStrategyResults(
      scenarioRotations.strategies.map((s) =>
        scoreStrategy(
          s,
          evaluation.scenarioClimate,
          soil,
          priorities,
          regionTag
        )
      )
    );
    const underBaselineMap = new Map(
      rankStrategyResults(
        scenarioRotations.strategies.map((s) =>
          scoreStrategy(
            s,
            evaluation.baselineClimate,
            soil,
            priorities,
            regionTag
          )
        )
      ).map((r) => [r.strategy.id, r])
    );
    return underScenario.map((scenRes) => ({
      scenarioResult: scenRes,
      baselineResult: underBaselineMap.get(scenRes.strategy.id) ?? scenRes,
    }));
  }, [scenarioRotations, evaluation, soil, priorities, regionTag]);

  const updateScenario = useCallback(
    (patch: Partial<WhatIfScenario>) => {
      if (!field) return;
      setFieldWhatIfScenario(field.id, {
        ...scenario,
        ...patch,
        presetName: patch.presetName,
      });
    },
    [field, scenario, setFieldWhatIfScenario]
  );

  const handleReset = useCallback(() => {
    if (!field) return;
    resetFieldWhatIfScenario(field.id);
    setScenarioGenerateError(null);
  }, [field, resetFieldWhatIfScenario]);

  const handleGenerateScenarioRotations = useCallback(async () => {
    if (!field || !evaluation) return;
    if (generatingScenarioPlans || inFlightScenarioGenRef.current) return;

    inFlightScenarioGenRef.current = true;
    setGeneratingScenarioPlans(true);
    setScenarioGenerateError(null);

    const controller = new AbortController();
    const timeoutId = setTimeout(() => {
      controller.abort();
    }, DEFAULT_AI_TIMEOUT_MS);

    try {
      const res = await fetch("/api/rotations/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: controller.signal,
        body: JSON.stringify({
          fieldId: field.id,
          fieldName: `${field.name} (${evaluation.scenarioSummary})`,
          lat: field.lat,
          lon: field.lon,
          climate: evaluation.scenarioClimate,
          soil,
          priorities,
          regionTag,
        }),
      });
      const data = (await res.json()) as GenerationResult & {
        error?: string;
        message?: string;
      };

      if (
        !res.ok ||
        !Array.isArray(data.proposals) ||
        data.proposals.length === 0
      ) {
        const serverReason = (data.message || data.aiUnavailableReason || "").trim();
        setScenarioGenerateError(
          serverReason ||
            "We couldn't finish generating scenario plans. Please try again later."
        );
        return;
      }

      setFieldScenarioRotations(field.id, {
        strategies: data.proposals.map((p) => p.strategy),
        generatedAt: data.generatedAt ?? new Date().toISOString(),
        agGroup: data.classification.group,
        version: evaluation.scenarioSummary,
        fieldId: field.id,
        aiProvider: data.aiProvider,
        aiModel: data.aiModel,
        validationStatus: "passed",
        usageMetadata: data.usageMetadata,
      });
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") {
        setScenarioGenerateError(
          "Scenario rotation generation timed out after 2 minutes. Please try again."
        );
      } else {
        setScenarioGenerateError(
          err instanceof Error && err.message
            ? err.message
            : "We couldn't finish generating scenario plans. Please try again later."
        );
      }
    } finally {
      clearTimeout(timeoutId);
      inFlightScenarioGenRef.current = false;
      setGeneratingScenarioPlans(false);
    }
  }, [
    field,
    evaluation,
    soil,
    priorities,
    regionTag,
    generatingScenarioPlans,
    setFieldScenarioRotations,
  ]);

  if (!isLoaded) {
    return <SimulatorSkeleton />;
  }

  if (!field) {
    return (
      <div className="space-y-6">
        <div>
          <h2 className="text-2xl font-serif font-bold text-foreground">
            What-If Simulator
          </h2>
          <p className="text-muted-foreground mt-1 max-w-2xl">
            Field not found. Create a field to simulate climate scenarios.
          </p>
        </div>
        <Button onClick={() => router.push("/fields/new")}>
          Create a Field
        </Button>
      </div>
    );
  }

  const monthlyChartData = evaluation
    ? MONTHS.map((m, i) => ({
        month: m,
        baselineTemp: evaluation.baselineClimate.fullRecord.monthlyTemp[i],
        scenarioTemp: evaluation.scenarioClimate.fullRecord.monthlyTemp[i],
        baselinePrecip: evaluation.baselineClimate.fullRecord.monthlyPrecip[i],
        scenarioPrecip: evaluation.scenarioClimate.fullRecord.monthlyPrecip[i],
      }))
    : [];

  const filteredCrops = evaluation
    ? evaluation.cropComparisons.filter((c) => {
        if (cropFilter === "stressed") return c.shift === "stressed" || c.shift === "no_longer_viable";
        if (cropFilter === "improved") return c.shift === "improved" || c.shift === "newly_viable";
        if (cropFilter === "boundary")
          return c.shift === "newly_viable" || c.shift === "no_longer_viable";
        return true;
      })
    : [];

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="space-y-1">
          <div className="flex items-center gap-2 flex-wrap">
            <h2 className="text-2xl font-serif font-bold text-foreground">
              What-If Climate Simulator
            </h2>
            {evaluation && (
              <span
                className={`inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-xs font-semibold border ${
                  evaluation.isBaseline
                    ? "bg-emerald-50 text-emerald-800 border-emerald-200"
                    : "bg-amber-50 text-amber-900 border-amber-300"
                }`}
              >
                {evaluation.isBaseline
                  ? "Observed Baseline Active"
                  : "Hypothetical Scenario Active"}
              </span>
            )}
          </div>
          <p className="text-sm text-muted-foreground max-w-2xl">
            Test how hypothetical shifts in temperature and rainfall affect
            agroecological classification, crop suitability, and 3-year
            rotation scores for <strong className="text-foreground">{field.name}</strong>.
          </p>
        </div>

        <div className="flex items-center gap-2 shrink-0">
          <Link href={`/field/${field.id}/analogues`}>
            <Button variant="outline" size="sm" className="text-xs">
              <GitCompare className="mr-1.5 h-3.5 w-3.5 text-indigo-600" />
              Find Historical Analogues
            </Button>
          </Link>
        </div>
      </div>

      {loading && <SimulatorSkeleton />}

      {error && !loading && (
        <Card className="border-accent-red/20 bg-accent-red/5">
          <CardHeader className="pb-3">
            <CardTitle className="flex items-center gap-2 text-accent-red text-base">
              <AlertTriangle className="h-5 w-5" />
              Could not load baseline climate data
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

      {!loading && !error && evaluation && (
        <>
          {/* 1. Scenario Controls & Presets */}
          <Card className="border-l-4 border-l-amber-500">
            <CardHeader className="pb-3">
              <div className="flex items-start justify-between gap-4 flex-wrap">
                <div className="space-y-1">
                  <CardTitle className="text-base font-semibold text-foreground flex items-center gap-2">
                    <SlidersHorizontal className="h-4 w-4 text-amber-600" />
                    Hypothetical Climate Adjustments
                  </CardTitle>
                  <CardDescription className="text-xs">
                    Adjust temperature (°C) and precipitation (% or mm/yr) to test sensitivity under hypothetical climate shifts. These are decision-support sensitivity tests, not meteorological forecasts—observed baseline climate data and saved rotation plans are never overwritten.
                  </CardDescription>
                </div>

                <Button
                  variant="outline"
                  size="sm"
                  onClick={handleReset}
                  disabled={evaluation.isBaseline}
                  className="text-xs"
                >
                  <RotateCcw className="mr-1.5 h-3.5 w-3.5" />
                  Reset to Baseline (0 °C / 0%)
                </Button>
              </div>
            </CardHeader>

            <CardContent className="space-y-5">
              {/* Preset Pills */}
              <div className="space-y-1.5">
                <p className="text-xs font-medium text-muted-foreground">
                  Quick Scenario Presets:
                </p>
                <div className="flex flex-wrap gap-2">
                  {WHAT_IF_PRESETS.map((preset) => {
                    const isSelected =
                      scenario.presetName === preset.scenario.presetName &&
                      !evaluation.isBaseline;
                    return (
                      <button
                        key={preset.id}
                        type="button"
                        onClick={() => updateScenario(preset.scenario)}
                        title={preset.shortDesc}
                        className={`rounded-md border px-2.5 py-1.5 text-xs font-medium transition-colors text-left ${
                          isSelected
                            ? "border-amber-500 bg-amber-50 text-amber-900"
                            : "border-border bg-background text-foreground hover:bg-muted"
                        }`}
                      >
                        {preset.name}
                      </button>
                    );
                  })}
                </div>
              </div>

              {/* Sliders Grid */}
              <div className="grid gap-6 md:grid-cols-2 pt-2 border-t border-border/60">
                {/* Temperature Slider */}
                <div className="space-y-2 rounded-lg border border-border/80 bg-muted/20 p-4">
                  <div className="flex items-center justify-between">
                    <label
                      htmlFor="temp-delta-slider"
                      className="text-xs font-semibold text-foreground flex items-center gap-1.5"
                    >
                      <Thermometer className="h-4 w-4 text-accent-red" />
                      Temperature Shift (°C)
                    </label>
                    <span className="rounded bg-background px-2 py-0.5 text-xs font-bold tabular-nums border border-border">
                      {fmtSigned(scenario.tempDeltaC, 1, " °C")}
                    </span>
                  </div>
                  <input
                    id="temp-delta-slider"
                    type="range"
                    min={-3.0}
                    max={5.0}
                    step={0.5}
                    value={scenario.tempDeltaC}
                    onChange={(e) =>
                      updateScenario({
                        tempDeltaC: parseFloat(e.target.value),
                        presetName: undefined,
                      })
                    }
                    className="w-full accent-electric cursor-pointer"
                  />
                  <div className="flex justify-between text-[11px] text-muted-foreground tabular-nums">
                    <span>−3.0 °C (Cooler)</span>
                    <span>0 °C (Baseline)</span>
                    <span>+5.0 °C (Extreme Warming)</span>
                  </div>
                </div>

                {/* Precipitation Slider + Mode Toggle */}
                <div className="space-y-2 rounded-lg border border-border/80 bg-muted/20 p-4">
                  <div className="flex items-center justify-between gap-2 flex-wrap">
                    <label
                      htmlFor="precip-delta-slider"
                      className="text-xs font-semibold text-foreground flex items-center gap-1.5"
                    >
                      <Droplets className="h-4 w-4 text-electric" />
                      Rainfall Shift (
                      {scenario.precipMode === "percent" ? "%" : "mm/yr"})
                    </label>

                    <div className="flex items-center gap-1.5">
                      <div className="inline-flex rounded-md border border-border bg-background p-0.5 text-[11px]">
                        {(["percent", "absolute_mm"] as PrecipAdjustmentMode[]).map(
                          (mode) => (
                            <button
                              key={mode}
                              type="button"
                              onClick={() =>
                                updateScenario({
                                  precipMode: mode,
                                  presetName: undefined,
                                })
                              }
                              className={`rounded px-2 py-0.5 font-medium transition-colors ${
                                scenario.precipMode === mode
                                  ? "bg-electric text-white"
                                  : "text-muted-foreground hover:text-foreground"
                              }`}
                            >
                              {mode === "percent" ? "% Change" : "mm/yr"}
                            </button>
                          )
                        )}
                      </div>
                      <span className="rounded bg-background px-2 py-0.5 text-xs font-bold tabular-nums border border-border">
                        {scenario.precipMode === "percent"
                          ? fmtSigned(scenario.precipDeltaPct, 0, "%")
                          : fmtSigned(scenario.precipDeltaMm, 0, " mm/yr")}
                      </span>
                    </div>
                  </div>

                  {scenario.precipMode === "percent" ? (
                    <>
                      <input
                        id="precip-delta-slider"
                        type="range"
                        min={-50}
                        max={50}
                        step={5}
                        value={scenario.precipDeltaPct}
                        onChange={(e) =>
                          updateScenario({
                            precipDeltaPct: parseFloat(e.target.value),
                            presetName: undefined,
                          })
                        }
                        className="w-full accent-electric cursor-pointer"
                      />
                      <div className="flex justify-between text-[11px] text-muted-foreground tabular-nums">
                        <span>−50% (Severe Drought)</span>
                        <span>0% (Baseline)</span>
                        <span>+50% (Wetter)</span>
                      </div>
                    </>
                  ) : (
                    <>
                      <input
                        id="precip-delta-slider"
                        type="range"
                        min={-400}
                        max={400}
                        step={25}
                        value={scenario.precipDeltaMm}
                        onChange={(e) =>
                          updateScenario({
                            precipDeltaMm: parseFloat(e.target.value),
                            presetName: undefined,
                          })
                        }
                        className="w-full accent-electric cursor-pointer"
                      />
                      <div className="flex justify-between text-[11px] text-muted-foreground tabular-nums">
                        <span>−400 mm/yr</span>
                        <span>0 mm/yr</span>
                        <span>+400 mm/yr</span>
                      </div>
                    </>
                  )}
                </div>
              </div>
            </CardContent>
          </Card>

          {/* 2. Side-by-Side Observed Baseline vs. Hypothetical Scenario Summary */}
          <div className="grid gap-4 lg:grid-cols-2">
            {/* Observed Baseline Card */}
            <Card className="border-t-4 border-t-electric">
              <CardHeader className="pb-2">
                <div className="flex items-center justify-between gap-2">
                  <span className="rounded bg-electric/10 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-electric">
                    Observed Baseline
                  </span>
                  <span className="text-xs text-muted-foreground">
                    20-Year Record
                  </span>
                </div>
                <CardTitle className="text-base font-semibold text-foreground mt-1">
                  Baseline Field Climate &amp; Agro-Zone
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-3 text-xs">
                <div className="grid grid-cols-2 sm:grid-cols-3 gap-2.5">
                  <div className="rounded-md bg-muted/40 p-2.5">
                    <p className="text-[11px] text-muted-foreground">
                      Annual Mean Temp
                    </p>
                    <p className="text-lg font-bold tabular-nums text-foreground">
                      {fmt(
                        evaluation.baselineClimate.fullRecord.avgAnnualTemp,
                        1
                      )}{" "}
                      °C
                    </p>
                  </div>
                  <div className="rounded-md bg-muted/40 p-2.5">
                    <p className="text-[11px] text-muted-foreground">
                      Annual Rainfall
                    </p>
                    <p className="text-lg font-bold tabular-nums text-foreground">
                      {fmt(
                        evaluation.baselineClimate.fullRecord.avgAnnualPrecip,
                        0
                      )}{" "}
                      mm
                    </p>
                  </div>
                  <div className="rounded-md bg-muted/40 p-2.5">
                    <p className="text-[11px] text-muted-foreground">
                      Growing-Season Rain
                    </p>
                    <p className="text-lg font-bold tabular-nums text-foreground">
                      {fmt(
                        evaluation.baselineClimate.stressMetrics
                          .growingSeasonPrecip.avgTotalMm,
                        0
                      )}{" "}
                      mm
                    </p>
                  </div>
                  <div className="rounded-md bg-muted/40 p-2.5">
                    <p className="text-[11px] text-muted-foreground">
                      Summer Dry Spell
                    </p>
                    <p className="text-sm font-semibold tabular-nums text-foreground">
                      {fmt(
                        evaluation.baselineClimate.stressMetrics.summerDrySpells
                          .avgMaxConsecutiveDryDays,
                        1
                      )}{" "}
                      days
                    </p>
                  </div>
                  <div className="rounded-md bg-muted/40 p-2.5">
                    <p className="text-[11px] text-muted-foreground">
                      Extreme Heat (&gt;35 °C)
                    </p>
                    <p className="text-sm font-semibold tabular-nums text-foreground">
                      {fmt(
                        evaluation.baselineClimate.stressMetrics.summerHeatDays
                          .avgDaysAboveThreshold,
                        1
                      )}{" "}
                      days/yr
                    </p>
                  </div>
                  <div className="rounded-md bg-muted/40 p-2.5">
                    <p className="text-[11px] text-muted-foreground">
                      Moist Growing Period
                    </p>
                    <p className="text-sm font-semibold tabular-nums text-foreground">
                      ~{evaluation.baselineClassification.estimatedLgpDays ?? "—"}{" "}
                      days/yr
                    </p>
                  </div>
                </div>

                <div className="rounded-md border border-border/70 bg-background p-2.5 space-y-1">
                  <p className="flex items-center justify-between">
                    <span className="text-muted-foreground">Agro-Zone:</span>
                    <strong className="text-foreground">
                      {formatAgGroupLabel(
                        evaluation.baselineClassification.group
                      )}
                    </strong>
                  </p>
                  <p className="flex items-center justify-between">
                    <span className="text-muted-foreground">Water Regime:</span>
                    <span className="font-medium text-foreground">
                      {formatWaterRegimeLabel(
                        evaluation.baselineClassification.waterRegime
                      )}
                    </span>
                  </p>
                  <p className="flex items-center justify-between">
                    <span className="text-muted-foreground">Moisture Class:</span>
                    <span className="font-medium text-foreground">
                      {formatMoistureZoneLabel(
                        evaluation.baselineClassification.gaezMoistureZone
                      )}
                    </span>
                  </p>
                </div>
              </CardContent>
            </Card>

            {/* Hypothetical Scenario Card */}
            <Card className="border-t-4 border-t-amber-500 bg-gradient-to-br from-white via-white to-amber-50/25">
              <CardHeader className="pb-2">
                <div className="flex items-center justify-between gap-2">
                  <span className="rounded bg-amber-100 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-amber-900">
                    Hypothetical Scenario (Simulated)
                  </span>
                  <span className="text-xs font-medium text-amber-800">
                    {evaluation.scenarioSummary}
                  </span>
                </div>
                <CardTitle className="text-base font-semibold text-foreground mt-1">
                  Simulated Scenario Climate &amp; Agro-Zone
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-3 text-xs">
                <div className="grid grid-cols-2 sm:grid-cols-3 gap-2.5">
                  <div className="rounded-md bg-amber-50/60 border border-amber-200/50 p-2.5">
                    <p className="text-[11px] text-muted-foreground">
                      Annual Mean Temp
                    </p>
                    <div className="flex items-baseline gap-1.5">
                      <span className="text-lg font-bold tabular-nums text-foreground">
                        {fmt(
                          evaluation.scenarioClimate.fullRecord.avgAnnualTemp,
                          1
                        )}{" "}
                        °C
                      </span>
                      {!evaluation.isBaseline && (
                        <span className="text-[11px] font-semibold text-amber-800 tabular-nums">
                          ({fmtSigned(scenario.tempDeltaC, 1, "°C")})
                        </span>
                      )}
                    </div>
                  </div>
                  <div className="rounded-md bg-amber-50/60 border border-amber-200/50 p-2.5">
                    <p className="text-[11px] text-muted-foreground">
                      Annual Rainfall
                    </p>
                    <div className="flex items-baseline gap-1.5">
                      <span className="text-lg font-bold tabular-nums text-foreground">
                        {fmt(
                          evaluation.scenarioClimate.fullRecord.avgAnnualPrecip,
                          0
                        )}{" "}
                        mm
                      </span>
                      {!evaluation.isBaseline && (
                        <span className="text-[11px] font-semibold text-amber-800 tabular-nums">
                          ({fmtSigned(evaluation.effectiveAnnualPrecipDeltaMm, 0, " mm")})
                        </span>
                      )}
                    </div>
                  </div>
                  <div className="rounded-md bg-amber-50/60 border border-amber-200/50 p-2.5">
                    <p className="text-[11px] text-muted-foreground">
                      Growing-Season Rain
                    </p>
                    <p className="text-lg font-bold tabular-nums text-foreground">
                      {fmt(
                        evaluation.scenarioClimate.stressMetrics
                          .growingSeasonPrecip.avgTotalMm,
                        0
                      )}{" "}
                      mm
                    </p>
                  </div>
                  <div className="rounded-md bg-amber-50/60 border border-amber-200/50 p-2.5">
                    <p className="text-[11px] text-muted-foreground">
                      Summer Dry Spell
                    </p>
                    <p className="text-sm font-semibold tabular-nums text-foreground">
                      {fmt(
                        evaluation.scenarioClimate.stressMetrics.summerDrySpells
                          .avgMaxConsecutiveDryDays,
                        1
                      )}{" "}
                      days
                    </p>
                  </div>
                  <div className="rounded-md bg-amber-50/60 border border-amber-200/50 p-2.5">
                    <p className="text-[11px] text-muted-foreground">
                      Extreme Heat (&gt;35 °C)
                    </p>
                    <p className="text-sm font-semibold tabular-nums text-foreground">
                      {fmt(
                        evaluation.scenarioClimate.stressMetrics.summerHeatDays
                          .avgDaysAboveThreshold,
                        1
                      )}{" "}
                      days/yr
                    </p>
                  </div>
                  <div className="rounded-md bg-amber-50/60 border border-amber-200/50 p-2.5">
                    <p className="text-[11px] text-muted-foreground">
                      Moist Growing Period
                    </p>
                    <div className="flex items-baseline gap-1">
                      <span className="text-sm font-semibold tabular-nums text-foreground">
                        ~{evaluation.scenarioClassification.estimatedLgpDays ?? "—"}{" "}
                        days
                      </span>
                      {evaluation.lgpDeltaDays !== null &&
                        evaluation.lgpDeltaDays !== 0 && (
                          <span className="text-[10px] font-semibold text-amber-800">
                            ({fmtSigned(evaluation.lgpDeltaDays, 0, "d")})
                          </span>
                        )}
                    </div>
                  </div>
                </div>

                <div className="rounded-md border border-amber-200/80 bg-white p-2.5 space-y-1">
                  <p className="flex items-center justify-between gap-2">
                    <span className="text-muted-foreground">Agro-Zone:</span>
                    <span className="flex items-center gap-1.5">
                      <strong className="text-foreground">
                        {formatAgGroupLabel(
                          evaluation.scenarioClassification.group
                        )}
                      </strong>
                      {evaluation.agGroupChanged && (
                        <span className="rounded bg-amber-100 px-1.5 py-0.5 text-[10px] font-semibold text-amber-900">
                          Zone Shifted
                        </span>
                      )}
                    </span>
                  </p>
                  <p className="flex items-center justify-between gap-2">
                    <span className="text-muted-foreground">Water Regime:</span>
                    <span className="font-medium text-foreground">
                      {formatWaterRegimeLabel(
                        evaluation.scenarioClassification.waterRegime
                      )}
                    </span>
                  </p>
                  <p className="flex items-center justify-between gap-2">
                    <span className="text-muted-foreground">Moisture Class:</span>
                    <span className="font-medium text-foreground">
                      {formatMoistureZoneLabel(
                        evaluation.scenarioClassification.gaezMoistureZone
                      )}
                    </span>
                  </p>
                </div>
              </CardContent>
            </Card>
          </div>

          {/* 3. Side-by-Side Rotation Comparison (Baseline vs. Scenario Scores) */}
          <Card>
            <CardHeader className="pb-3">
              <div className="flex items-start justify-between gap-4 flex-wrap">
                <div className="space-y-1">
                  <CardTitle className="text-base font-semibold text-foreground flex items-center gap-2">
                    <Compass className="h-4 w-4 text-electric" />
                    Rotation Plan Comparison: Observed Baseline vs. Hypothetical Scenario
                  </CardTitle>
                  <CardDescription className="text-xs">
                    How your saved 3-year SI rotation plans perform under{" "}
                    <strong className="text-foreground">
                      {evaluation.scenarioSummary}
                    </strong>{" "}
                    using your active farmer priority weights.
                  </CardDescription>
                </div>
              </div>
            </CardHeader>

            <CardContent className="space-y-4">
              {evaluation.strategyComparisons.length === 0 ? (
                <div className="rounded-lg border border-dashed border-border p-6 text-center space-y-3">
                  <p className="text-sm font-medium text-foreground">
                    No saved baseline rotation plans for {field.name} yet
                  </p>
                  <p className="text-xs text-muted-foreground max-w-md mx-auto">
                    Generate your field&apos;s baseline 3-year SI rotation plans in the
                    Crop Rotation Lab first to see how their scores and factor rankings
                    shift under hypothetical climate scenarios, or generate a
                    scenario-specific rotation set below.
                  </p>
                  <Link href={`/field/${field.id}/rotations`}>
                    <Button size="sm" variant="outline" className="mt-1">
                      Go to Crop Rotation Lab
                      <ArrowRight className="ml-1.5 h-3.5 w-3.5" />
                    </Button>
                  </Link>
                </div>
              ) : (
                <div className="grid gap-4 lg:grid-cols-3">
                  {evaluation.strategyComparisons.map((comp) => {
                    const baseScore = comp.baselineResult.overallScore;
                    const scenScore = comp.scenarioResult.overallScore;
                    const delta = comp.overallDelta;
                    return (
                      <div
                        key={comp.strategyId}
                        className="rounded-lg border border-border bg-card p-4 flex flex-col justify-between gap-4"
                      >
                        <div className="space-y-3">
                          <div className="flex items-start justify-between gap-2">
                            <div>
                              <span className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                                Baseline Rank #{comp.baselineResult.rank} → Scenario Rank #{comp.scenarioResult.rank}
                              </span>
                              <h4 className="text-sm font-semibold text-foreground mt-0.5">
                                {comp.strategyName}
                              </h4>
                            </div>
                            {comp.rankDelta !== 0 && (
                              <span
                                className={`rounded px-1.5 py-0.5 text-[10px] font-semibold ${
                                  comp.rankDelta > 0
                                    ? "bg-emerald-50 text-emerald-700 border border-emerald-200"
                                    : "bg-amber-50 text-amber-800 border border-amber-200"
                                }`}
                              >
                                {comp.rankDelta > 0
                                  ? `↑ +${comp.rankDelta} rank`
                                  : `↓ ${comp.rankDelta} rank`}
                              </span>
                            )}
                          </div>

                          {/* Side-by-side overall score box */}
                          <div className="grid grid-cols-2 gap-2 rounded-md bg-muted/30 p-2.5 text-xs">
                            <div>
                              <p className="text-[10px] uppercase text-muted-foreground font-medium">
                                Observed Score
                              </p>
                              <p className="text-xl font-bold tabular-nums text-foreground">
                                {baseScore !== null ? baseScore : "—"}
                                <span className="text-xs font-normal text-muted-foreground">
                                  /100
                                </span>
                              </p>
                              <p className="text-[10px] text-muted-foreground">
                                {comp.baselineResult.overallFitLabel}
                              </p>
                            </div>
                            <div className="border-l border-border pl-2.5">
                              <p className="text-[10px] uppercase text-amber-800 font-medium">
                                Scenario Score
                              </p>
                              <div className="flex items-baseline gap-1.5">
                                <span className="text-xl font-bold tabular-nums text-foreground">
                                  {scenScore !== null ? scenScore : "—"}
                                </span>
                                {delta !== null && delta !== 0 && (
                                  <span
                                    className={`text-xs font-bold tabular-nums ${
                                      delta > 0
                                        ? "text-emerald-700"
                                        : "text-accent-red"
                                    }`}
                                  >
                                    ({fmtSigned(delta, 0)})
                                  </span>
                                )}
                              </div>
                              <p className="text-[10px] text-muted-foreground">
                                {comp.scenarioResult.overallFitLabel}
                              </p>
                            </div>
                          </div>

                          {/* 5-Factor Breakdown */}
                          <div className="space-y-1.5 text-xs">
                            {FACTOR_KEYS.map((fk) => {
                              const b =
                                comp.baselineResult.factorScores[fk]?.score ?? null;
                              const s =
                                comp.scenarioResult.factorScores[fk]?.score ?? null;
                              const d = comp.factorDeltas[fk];
                              return (
                                <div
                                  key={fk}
                                  className="flex items-center justify-between text-[11px] py-0.5 border-b border-border/40 last:border-none"
                                >
                                  <span className="text-muted-foreground truncate pr-2">
                                    {FACTOR_LABELS[fk]}
                                  </span>
                                  <div className="flex items-center gap-1.5 tabular-nums shrink-0">
                                    <span className="text-muted-foreground">
                                      {b !== null ? b : "—"}
                                    </span>
                                    <span className="text-muted-foreground">→</span>
                                    <span className="font-semibold text-foreground">
                                      {s !== null ? s : "—"}
                                    </span>
                                    {d !== null && d !== 0 && (
                                      <span
                                        className={`text-[10px] font-semibold ${
                                          d > 0
                                            ? "text-emerald-700"
                                            : "text-accent-red"
                                        }`}
                                      >
                                        ({fmtSigned(d, 0)})
                                      </span>
                                    )}
                                  </div>
                                </div>
                              );
                            })}
                          </div>

                          <p className="text-[11px] text-muted-foreground leading-relaxed pt-1.5 border-t border-border/40">
                            {comp.explanation}
                          </p>
                        </div>

                        <div className="flex gap-2 pt-2 border-t border-border/50">
                          <Button
                            variant="outline"
                            size="sm"
                            className="w-full text-xs h-8"
                            onClick={() => {
                              setSelectedStrategyId(field.id, comp.strategyId);
                              router.push(`/field/${field.id}/calendar`);
                            }}
                          >
                            <CalendarDays className="mr-1.5 h-3.5 w-3.5 text-emerald-600" />
                            Open in Field Calendar
                          </Button>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </CardContent>
          </Card>

          {/* 4. Explicit User-Triggered SI Generation for Hypothetical Scenario */}
          <Card className="border-purple-200 bg-gradient-to-br from-white via-white to-purple-50/30">
            <CardHeader className="pb-3">
              <div className="flex items-start justify-between gap-4 flex-wrap">
                <div className="space-y-1">
                  <CardTitle className="text-base font-semibold text-foreground flex items-center gap-2">
                    <Sparkles className="h-4 w-4 text-purple-600" />
                    Generate SI-Assisted Rotations for This Hypothetical Scenario
                  </CardTitle>
                  <CardDescription className="text-xs max-w-2xl">
                    Want to see what Super Intelligence (SI) would design specifically
                    for{" "}
                    <strong className="text-foreground">
                      {evaluation.scenarioSummary}
                    </strong>
                    ? Click the button to run a dedicated scenario generation. Your
                    field&apos;s saved baseline rotation plans will not be overwritten.
                  </CardDescription>
                </div>

                <Button
                  size="sm"
                  onClick={handleGenerateScenarioRotations}
                  disabled={generatingScenarioPlans || evaluation.isBaseline}
                  className="bg-purple-600 hover:bg-purple-700 text-white shrink-0"
                >
                  {generatingScenarioPlans ? (
                    <>
                      <RefreshCw className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                      Generating Scenario Plans...
                    </>
                  ) : (
                    <>
                      <Sparkles className="mr-1.5 h-3.5 w-3.5" />
                      Generate Scenario SI Rotations
                    </>
                  )}
                </Button>
              </div>
            </CardHeader>

            <CardContent className="space-y-3 pt-0 text-xs">
              {evaluation.isBaseline && !scenarioRotations && (
                <p className="text-muted-foreground">
                  Adjust the temperature or rainfall sliders above away from
                  baseline (0 °C / 0%) to enable scenario-specific SI generation.
                </p>
              )}

              {generatingScenarioPlans && (
                <div
                  role="status"
                  aria-live="polite"
                  className="rounded-lg bg-purple-50/80 px-4 py-3 text-xs text-purple-950 border border-purple-200 flex items-start gap-3"
                >
                  <RefreshCw className="h-4 w-4 text-purple-600 animate-spin shrink-0 mt-0.5" />
                  <div className="space-y-1">
                    <p className="font-semibold">
                      Generating hypothetical scenario rotation plans. This may take up to 2 minutes.
                    </p>
                    <p className="text-[11px] text-purple-900/80">
                      Designing 3-year crop sequences adapted to{" "}
                      {evaluation.scenarioSummary} for {field.name}&hellip;
                    </p>
                  </div>
                </div>
              )}

              {scenarioGenerateError && !generatingScenarioPlans && (
                <div className="rounded-md bg-amber-50 px-3 py-2 text-xs text-amber-900 border border-amber-200">
                  {scenarioGenerateError}
                </div>
              )}

              {scoredScenarioRotations.length > 0 && !generatingScenarioPlans && (
                <div className="space-y-3 pt-2">
                  <div className="flex items-center justify-between gap-2 flex-wrap">
                    <span className="rounded bg-purple-100 px-2 py-0.5 text-[11px] font-semibold text-purple-900">
                      Scenario-Tailored SI Plans ({scenarioRotations?.version})
                    </span>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-7 text-xs text-muted-foreground"
                      onClick={() => setFieldScenarioRotations(field.id, null)}
                    >
                      Clear Scenario Plans
                    </Button>
                  </div>

                  <div className="grid gap-4 lg:grid-cols-3">
                    {scoredScenarioRotations.map(
                      ({ scenarioResult, baselineResult }) => (
                        <div
                          key={scenarioResult.strategy.id}
                          className="rounded-lg border border-purple-200 bg-white p-3.5 space-y-2.5"
                        >
                          <div className="flex items-start justify-between gap-2">
                            <div>
                              <span className="text-[10px] font-semibold uppercase text-purple-700">
                                Scenario Rank #{scenarioResult.rank}
                              </span>
                              <h5 className="text-sm font-semibold text-foreground">
                                {scenarioResult.strategy.name}
                              </h5>
                            </div>
                            <div className="text-right shrink-0">
                              <span className="text-base font-bold text-purple-900 tabular-nums">
                                {scenarioResult.overallScore ?? "—"}
                              </span>
                              <span className="text-[10px] text-muted-foreground">
                                /100 in scenario
                              </span>
                              <p className="text-[10px] text-muted-foreground tabular-nums">
                                ({baselineResult.overallScore ?? "—"}/100 in baseline)
                              </p>
                            </div>
                          </div>

                          <p className="text-[11px] text-muted-foreground leading-relaxed">
                            {scenarioResult.strategy.description}
                          </p>

                          <div className="space-y-1 pt-1 border-t border-border/50 text-[11px]">
                            {scenarioResult.strategy.years.map((yr) => (
                              <div key={yr.year} className="flex gap-1.5">
                                <span className="font-semibold text-foreground shrink-0">
                                  Yr {yr.year}:
                                </span>
                                <span className="text-muted-foreground">
                                  {formatSeasonSequenceNames(
                                    yr.seasons.map((s) => s.crop)
                                  )}
                                </span>
                              </div>
                            ))}
                          </div>
                        </div>
                      )
                    )}
                  </div>
                </div>
              )}
            </CardContent>
          </Card>

          {/* 5. Monthly Baseline vs. Scenario Chart */}
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-base font-semibold text-foreground">
                Monthly Climate Trajectory: Observed Baseline vs. Hypothetical Scenario
              </CardTitle>
              <CardDescription className="text-xs">
                Comparison of monthly mean temperature (°C) and monthly
                precipitation (mm) across the 12-month cycle.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <ResponsiveContainer width="100%" height={290}>
                <ComposedChart data={monthlyChartData}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#E2E8F0" />
                  <XAxis dataKey="month" tick={{ fontSize: 12 }} />
                  <YAxis
                    yAxisId="temp"
                    tick={{ fontSize: 12 }}
                    tickFormatter={(v) =>
                      typeof v === "number" ? v.toFixed(1) : String(v)
                    }
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
                    tickFormatter={(v) =>
                      typeof v === "number" ? `${Math.round(v)}` : String(v)
                    }
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
                        isTemp ? `${num.toFixed(1)} °C` : `${Math.round(num)} mm`,
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
                    dataKey="baselinePrecip"
                    name="Baseline Precip (mm)"
                    fill="#94A3B8"
                    radius={[3, 3, 0, 0]}
                  />
                  <Bar
                    yAxisId="precip"
                    dataKey="scenarioPrecip"
                    name="Scenario Precip (mm)"
                    fill="#4D9FFF"
                    radius={[3, 3, 0, 0]}
                  />
                  <Line
                    yAxisId="temp"
                    type="monotone"
                    dataKey="baselineTemp"
                    name="Baseline Temp (°C)"
                    stroke="#64748B"
                    strokeWidth={2}
                    strokeDasharray="4 4"
                    dot={false}
                  />
                  <Line
                    yAxisId="temp"
                    type="monotone"
                    dataKey="scenarioTemp"
                    name="Scenario Temp (°C)"
                    stroke="#E34B5B"
                    strokeWidth={2.5}
                    dot={false}
                  />
                </ComposedChart>
              </ResponsiveContainer>

              <div className="overflow-x-auto border-t border-border/60 pt-3">
                <table className="w-full text-[11px] tabular-nums">
                  <thead>
                    <tr className="border-b border-border text-muted-foreground">
                      <th className="text-left py-1.5 pr-3 font-medium">
                        Monthly Metric
                      </th>
                      {monthlyChartData.map((d) => (
                        <th
                          key={d.month}
                          className="text-right py-1.5 px-1.5 font-medium"
                        >
                          {d.month}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    <tr className="border-b border-border/40 text-muted-foreground">
                      <td className="py-1.5 pr-3 font-medium">
                        Baseline Temp (°C)
                      </td>
                      {monthlyChartData.map((d) => (
                        <td key={d.month} className="text-right py-1.5 px-1.5">
                          {fmt(d.baselineTemp, 1)}
                        </td>
                      ))}
                    </tr>
                    <tr className="border-b border-border/40 text-foreground font-medium">
                      <td className="py-1.5 pr-3">Scenario Temp (°C)</td>
                      {monthlyChartData.map((d) => (
                        <td key={d.month} className="text-right py-1.5 px-1.5">
                          {fmt(d.scenarioTemp, 1)}
                        </td>
                      ))}
                    </tr>
                    <tr className="border-b border-border/40 text-muted-foreground">
                      <td className="py-1.5 pr-3 font-medium">
                        Baseline Rain (mm)
                      </td>
                      {monthlyChartData.map((d) => (
                        <td key={d.month} className="text-right py-1.5 px-1.5">
                          {fmt(d.baselinePrecip, 0)}
                        </td>
                      ))}
                    </tr>
                    <tr className="text-foreground font-medium">
                      <td className="py-1.5 pr-3">Scenario Rain (mm)</td>
                      {monthlyChartData.map((d) => (
                        <td key={d.month} className="text-right py-1.5 px-1.5">
                          {fmt(d.scenarioPrecip, 0)}
                        </td>
                      ))}
                    </tr>
                  </tbody>
                </table>
              </div>
            </CardContent>
          </Card>

          {/* 6. Crop Suitability Shifts Under Scenario */}
          <Card>
            <CardHeader className="pb-3">
              <div className="flex items-start justify-between gap-4 flex-wrap">
                <div className="space-y-1">
                  <CardTitle className="text-base font-semibold text-foreground flex items-center gap-2">
                    <Sprout className="h-4 w-4 text-emerald-600" />
                    Crop-Level Climate Suitability Shifts (
                    {evaluation.cropComparisons.length} crops evaluated)
                  </CardTitle>
                  <CardDescription className="text-xs">
                    How individual cash and cover crops in your regional catalog
                    respond to{" "}
                    <strong className="text-foreground">
                      {evaluation.scenarioSummary}
                    </strong>
                    .
                  </CardDescription>
                </div>

                <div className="inline-flex rounded-md border border-border bg-muted/40 p-0.5 text-xs">
                  {(
                    [
                      { id: "all", label: "All Crops" },
                      { id: "stressed", label: "Stressed" },
                      { id: "improved", label: "Improved" },
                      { id: "boundary", label: "Zone Shifts" },
                    ] as const
                  ).map((tab) => (
                    <button
                      key={tab.id}
                      type="button"
                      onClick={() => setCropFilter(tab.id)}
                      className={`rounded px-2.5 py-1 font-medium transition-colors ${
                        cropFilter === tab.id
                          ? "bg-background text-foreground shadow-sm"
                          : "text-muted-foreground hover:text-foreground"
                      }`}
                    >
                      {tab.label}
                    </button>
                  ))}
                </div>
              </div>
            </CardHeader>
            <CardContent>
              {filteredCrops.length === 0 ? (
                <p className="text-xs text-muted-foreground py-4 text-center">
                  No crops match the selected filter under current scenario settings.
                </p>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-xs">
                    <thead>
                      <tr className="border-b border-border text-muted-foreground">
                        <th className="text-left py-2 pr-3 font-medium">Crop</th>
                        <th className="text-left py-2 px-2 font-medium">Role</th>
                        <th className="text-left py-2 px-2 font-medium">
                          Water Demand
                        </th>
                        <th className="text-left py-2 px-2 font-medium">
                          Drought Tolerance
                        </th>
                        <th className="text-right py-2 px-2 font-medium">
                          Baseline Fit
                        </th>
                        <th className="text-right py-2 px-2 font-medium">
                          Scenario Fit
                        </th>
                        <th className="text-left py-2 px-3 font-medium">
                          Response
                        </th>
                        <th className="text-left py-2 pl-2 font-medium">
                          Agronomic Explanation
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {filteredCrops.map((c) => (
                        <tr
                          key={c.cropId}
                          className="border-b border-border/50 last:border-none align-top"
                        >
                          <td className="py-2.5 pr-3 font-medium text-foreground whitespace-nowrap">
                            {c.commonName}
                            <span className="block text-[10px] font-normal text-muted-foreground">
                              {c.family}
                            </span>
                          </td>
                          <td className="py-2.5 px-2 text-muted-foreground whitespace-nowrap">
                            {formatEnumLabel(c.type)}
                          </td>
                          <td className="py-2.5 px-2 text-muted-foreground whitespace-nowrap">
                            {formatEnumLabel(c.waterDemand)}
                          </td>
                          <td className="py-2.5 px-2 text-muted-foreground whitespace-nowrap">
                            {formatEnumLabel(c.droughtTolerance)}
                          </td>
                          <td className="py-2.5 px-2 text-right tabular-nums">
                            {c.baselineSuitabilityScore}
                          </td>
                          <td className="py-2.5 px-2 text-right tabular-nums font-semibold whitespace-nowrap">
                            {c.scenarioSuitabilityScore}{" "}
                            {c.scoreDelta !== 0 && (
                              <span
                                className={
                                  c.scoreDelta > 0
                                    ? "text-emerald-700"
                                    : "text-accent-red"
                                }
                              >
                                ({fmtSigned(c.scoreDelta, 0)})
                              </span>
                            )}
                          </td>
                          <td className="py-2.5 px-3 whitespace-nowrap">
                            <ShiftBadge shift={c.shift} />
                          </td>
                          <td className="py-2.5 pl-2 text-muted-foreground leading-relaxed min-w-[260px]">
                            {c.explanation}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </CardContent>
          </Card>

          {/* 7. Data Sources & Methodology */}
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
                <strong className="text-foreground">Observed Baseline Climate (Live):</strong>{" "}
                <a
                  href="https://power.larc.nasa.gov/"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-electric hover:underline"
                >
                  {climate?.source}
                </a>{" "}
                ({climate?.spatialResolution}).
              </p>
              <p>
                <strong className="text-foreground">Topsoil Context (Held Constant):</strong>{" "}
                {soil?.source ?? "Soil data unavailable for these coordinates."}
              </p>
              <div className="space-y-1">
                <p className="font-medium text-foreground">
                  Derived Scenario Calculations &amp; Assumptions:
                </p>
                <ul className="list-disc list-inside space-y-1">
                  {evaluation.assumptions.map((a, idx) => (
                    <li key={idx}>{a}</li>
                  ))}
                </ul>
              </div>
              <p className="text-[11px] pt-1 flex items-center gap-1.5 text-muted-foreground/90">
                <Info className="h-3.5 w-3.5 text-electric shrink-0" />
                <span>
                  Hypothetical scenario outputs are decision-support sensitivity tests, not meteorological forecasts.{" "}
                  <Link
                    href="/data-sources"
                    className="text-electric hover:underline font-medium"
                  >
                    View complete data sources catalog →
                  </Link>
                </span>
              </p>
            </div>
          </details>
        </>
      )}
    </div>
  );
}

function ShiftBadge({
  shift,
}: {
  shift:
    | "improved"
    | "stable"
    | "stressed"
    | "newly_viable"
    | "no_longer_viable";
}) {
  if (shift === "improved") {
    return (
      <span className="inline-flex items-center gap-1 rounded bg-emerald-50 px-1.5 py-0.5 text-[10px] font-semibold text-emerald-700 border border-emerald-200">
        <TrendingUp className="h-3 w-3" />
        Improved
      </span>
    );
  }
  if (shift === "stressed") {
    return (
      <span className="inline-flex items-center gap-1 rounded bg-red-50 px-1.5 py-0.5 text-[10px] font-semibold text-red-700 border border-red-200">
        <TrendingDown className="h-3 w-3" />
        Stressed
      </span>
    );
  }
  if (shift === "newly_viable") {
    return (
      <span className="inline-flex items-center gap-1 rounded bg-blue-50 px-1.5 py-0.5 text-[10px] font-semibold text-blue-700 border border-blue-200">
        <TrendingUp className="h-3 w-3" />
        Enters Zone Catalog
      </span>
    );
  }
  if (shift === "no_longer_viable") {
    return (
      <span className="inline-flex items-center gap-1 rounded bg-amber-50 px-1.5 py-0.5 text-[10px] font-semibold text-amber-800 border border-amber-200">
        <TrendingDown className="h-3 w-3" />
        Outside Zone Catalog
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 rounded bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
      <Minus className="h-3 w-3" />
      Stable
    </span>
  );
}

function SimulatorSkeleton() {
  return (
    <div className="space-y-6">
      <Card>
        <CardHeader className="pb-2">
          <Skeleton className="h-5 w-64" />
          <Skeleton className="h-3 w-96 mt-1" />
        </CardHeader>
        <CardContent className="grid gap-4 md:grid-cols-2">
          <Skeleton className="h-24 w-full rounded-lg" />
          <Skeleton className="h-24 w-full rounded-lg" />
        </CardContent>
      </Card>
      <div className="grid gap-4 lg:grid-cols-2">
        <Skeleton className="h-64 w-full rounded-xl" />
        <Skeleton className="h-64 w-full rounded-xl" />
      </div>
    </div>
  );
}
