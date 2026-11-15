"use client";

import { useEffect, useState, useCallback, useMemo } from "react";
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
import { StrategyCard } from "@/components/rotation/strategy-card";
import { PrioritySliders } from "@/components/rotation/priority-sliders";
import { FactorComparison } from "@/components/rotation/factor-comparison";
import {
  StrategyResult,
  scoreAllStrategies,
  scoreStrategy,
  rankStrategyResults,
  STRATEGY_OBJECTIVES,
  buildObjectiveFieldContextBullets,
  isReferenceStrategyApplicable,
  cropLibrary,
} from "@/lib/rotation-scoring";
import { classifyAgGroup, type AgGroup } from "@/lib/agro-classifier";
import {
  getAvailableCropsForContext,
  type GenerationResult,
  type RejectedProposalInfo,
} from "@/lib/rotation-generator";
import {
  RefreshCw,
  AlertTriangle,
  RotateCcw,
  BarChart3,
  SlidersHorizontal,
  Sparkles,
  Info,
  Sprout,
  Droplets,
  Layers,
  ChevronDown,
  ChevronUp,
  Compass,
} from "lucide-react";
import { detectRegion } from "@/lib/region";

interface StressMetrics {
  summerDrySpells: {
    avgMaxConsecutiveDryDays: number | null;
    thresholdMm: number;
    monthsDesc: string;
  };
  summerHeatDays: {
    avgDaysAboveThreshold: number | null;
    thresholdC: number;
    monthsDesc: string;
  };
  springPrecip: {
    avgTotalMm: number | null;
    monthsDesc: string;
  };
  growingSeasonPrecip: {
    avgTotalMm: number | null;
    monthsDesc: string;
  };
}

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
  location: { lat: number; lon: number; elevation: number | null };
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
  stressMetrics: StressMetrics;
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

interface SoilData {
  location: { lat: number; lon: number };
  source: string;
  coverage: string;
  mapUnit: { mukey: string; name: string } | null;
  totalComponentPercent: number;
  components: unknown[];
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

const AG_GROUP_LABELS: Record<AgGroup, string> = {
  temperate_humid: "Temperate Humid",
  semi_arid_temperate: "Semi-Arid Temperate",
  subtropical_humid: "Subtropical Humid",
  temperate_mediterranean: "Temperate Mediterranean",
  unknown: "Unclassified / Insufficient Data",
};

function adaptClimate(data: ClimateData | null): import("@/lib/rotation-scoring").ClimateData | null {
  if (!data) return null;
  return {
    location: data.location,
    fullRecord: {
      avgAnnualTemp: data.fullRecord.avgAnnualTemp,
      avgAnnualPrecip: data.fullRecord.avgAnnualPrecip,
      avgDailySolar: data.fullRecord.avgDailySolar,
      monthlyTemp: data.fullRecord.monthlyTemp,
      monthlyPrecip: data.fullRecord.monthlyPrecip,
      monthlySolar: data.fullRecord.monthlySolar,
    },
    stressMetrics: data.stressMetrics,
    source: data.source,
    spatialResolution: data.spatialResolution,
    limitations: [data.spatialResolution, ...data.warnings],
  };
}

function adaptSoil(data: SoilData | null): import("@/lib/rotation-scoring").SoilData | null {
  if (!data) return null;
  return {
    aggregated: data.aggregated,
    dataCoverage: data.dataCoverage,
    totalComponentPercent: data.totalComponentPercent,
    source: data.source,
    limitations: data.limitations,
  };
}

export default function RotationsPage() {
  const params = useParams();
  const router = useRouter();
  const { fields, activeField, priorities, setPriorities, setActiveField, setFieldRotations, isLoaded } =
    useField();

  const [climate, setClimate] = useState<ClimateData | null>(null);
  const [soil, setSoil] = useState<SoilData | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [generating, setGenerating] = useState(false);
  const [generateError, setGenerateError] = useState<string | null>(null);
  const [generationStatus, setGenerationStatus] = useState<string | null>(null);
  const [rejectedProposals, setRejectedProposals] = useState<RejectedProposalInfo[]>([]);
  const [showNonLocalReference, setShowNonLocalReference] = useState(false);

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

  const field = (fieldId ? fields.find((f) => f.id === fieldId) : undefined) ?? activeField ?? undefined;

  const fetchData = useCallback(async () => {
    if (!field) return;
    setLoading(true);
    setError(null);
    try {
      const [climateRes, soilRes] = await Promise.all([
        fetch(`/api/climate?lat=${field.lat.toFixed(4)}&lon=${field.lon.toFixed(4)}`),
        fetch(`/api/soil?lat=${field.lat.toFixed(4)}&lon=${field.lon.toFixed(4)}`),
      ]);

      const climateJson = await climateRes.json();
      if (!climateRes.ok) {
        setError(climateJson.error || `Climate API failed (${climateRes.status})`);
        setClimate(null);
        setSoil(null);
        setLoading(false);
        return;
      }
      setClimate(climateJson);

      const soilJson = await soilRes.json();
      if (!soilRes.ok) {
        setSoil(null);
      } else {
        setSoil(soilJson);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Network error");
      setClimate(null);
      setSoil(null);
    } finally {
      setLoading(false);
    }
  }, [field]);

  useEffect(() => {
    if (field) {
      fetchData();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [field?.id]);

  const adaptedClimate = useMemo(() => adaptClimate(climate), [climate]);
  const adaptedSoil = useMemo(() => adaptSoil(soil), [soil]);
  const detectedRegion = useMemo(
    () => (field ? detectRegion(field.lat, field.lon) : null),
    [field]
  );
  const regionTag = detectedRegion?.tag ?? null;

  // Deterministic agroecological classification & local crop availability
  const fieldClassification = useMemo(() => {
    if (!adaptedClimate) return null;
    return classifyAgGroup(adaptedClimate, adaptedSoil);
  }, [adaptedClimate, adaptedSoil]);

  const availableCropIds = useMemo(() => {
    if (!fieldClassification) return [];
    return getAvailableCropsForContext(fieldClassification.group, regionTag);
  }, [fieldClassification, regionTag]);

  const availableCropNames = useMemo(
    () =>
      availableCropIds
        .map((id) => cropLibrary[id]?.commonName)
        .filter((n): n is string => typeof n === "string"),
    [availableCropIds]
  );

  // Score persisted field-specific strategies (when generated)
  const generatedResults: StrategyResult[] = useMemo(() => {
    if (!adaptedClimate || !field?.generatedRotations?.strategies?.length) return [];
    const scored = field.generatedRotations.strategies.map((s) =>
      scoreStrategy(s, adaptedClimate, adaptedSoil, priorities, regionTag)
    );
    return rankStrategyResults(scored);
  }, [adaptedClimate, adaptedSoil, field?.generatedRotations, priorities, regionTag]);

  // Score reference archetype templates
  const referenceResults: StrategyResult[] = useMemo(() => {
    if (!adaptedClimate) return [];
    return scoreAllStrategies(adaptedClimate, adaptedSoil, priorities, regionTag);
  }, [adaptedClimate, adaptedSoil, priorities, regionTag]);

  // Check whether reference templates are genuinely applicable to this field's group & region
  const referenceTemplatesApplicable = useMemo(() => {
    if (!fieldClassification || referenceResults.length === 0) return false;
    return referenceResults.every((r) =>
      isReferenceStrategyApplicable(r.strategy, fieldClassification.group, regionTag)
    );
  }, [fieldClassification, referenceResults, regionTag]);

  const handleGenerate = useCallback(async () => {
    if (!field || !adaptedClimate) return;
    setGenerating(true);
    setGenerateError(null);
    setGenerationStatus(null);
    setRejectedProposals([]);
    try {
      const res = await fetch("/api/rotations/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          fieldId: field.id,
          fieldName: field.name,
          lat: field.lat,
          lon: field.lon,
          climate: adaptedClimate,
          soil: adaptedSoil,
          priorities,
          regionTag,
        }),
      });
      const data = (await res.json()) as GenerationResult & { error?: string; message?: string };

      if (Array.isArray(data.rejectedProposals) && data.rejectedProposals.length > 0) {
        setRejectedProposals(data.rejectedProposals);
      }

      if (!res.ok) {
        setGenerateError(data.message ?? data.aiUnavailableReason ?? `Generation failed (${res.status})`);
        setGenerationStatus("unavailable");
        return;
      }
      if (data.proposals.length === 0) {
        setGenerationStatus(data.supportStatus ?? "unavailable");
        setGenerateError(
          data.aiUnavailableReason ?? "Field-specific crop sequences are not yet available."
        );
        return;
      }

      const rawStrategies = data.proposals.map((p) => p.strategy);
      setFieldRotations(field.id, {
        strategies: rawStrategies,
        generatedAt: new Date().toISOString(),
        agGroup: data.classification.group,
        version: "1.0",
      });
      setGenerationStatus(data.supportStatus);
    } catch (err) {
      setGenerateError(err instanceof Error ? err.message : "Network error");
    } finally {
      setGenerating(false);
    }
  }, [field, adaptedClimate, adaptedSoil, priorities, regionTag, setFieldRotations]);

  if (!isLoaded) {
    return <RotationsSkeleton />;
  }

  if (!field) {
    return (
      <div className="space-y-6">
        <div>
          <h2 className="text-2xl font-serif font-bold text-foreground">Rotation Lab</h2>
          <p className="text-muted-foreground mt-1 max-w-2xl">
            Field not found. Create a field to evaluate rotation strategies.
          </p>
        </div>
        <Button onClick={() => router.push("/fields/new")}>Create a Field</Button>
      </div>
    );
  }

  const hasGeneratedPlans = generatedResults.length > 0;

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="space-y-1">
        <h2 className="text-2xl font-serif font-bold text-foreground">Rotation Lab</h2>
        <p className="text-sm text-muted-foreground max-w-2xl">
          Field-specific rotation planning driven by your field&apos;s climate regime, soil properties, and verified crop suitability.
        </p>
        <p className="text-xs text-muted-foreground">
          Field: <strong className="text-foreground">{field.name}</strong> ({field.lat.toFixed(4)},{" "}
          {field.lon.toFixed(4)})
          {detectedRegion ? ` · ${detectedRegion.label}` : ""}
        </p>
      </div>

      {/* Loading */}
      {loading && <RotationsSkeleton />}

      {/* Error */}
      {error && !loading && (
        <Card className="border-accent-red/20 bg-accent-red/5">
          <CardHeader className="pb-3">
            <CardTitle className="flex items-center gap-2 text-accent-red text-base">
              <AlertTriangle className="h-5 w-5" />
              Could not load field data
            </CardTitle>
            <CardDescription className="text-accent-red/80">{error}</CardDescription>
          </CardHeader>
          <CardContent>
            <Button
              variant="outline"
              size="sm"
              onClick={fetchData}
              className="border-accent-red/30 text-accent-red hover:bg-accent-red/10"
            >
              <RotateCcw className="mr-2 h-4 w-4" />
              Retry
            </Button>
          </CardContent>
        </Card>
      )}

      {/* Main Content */}
      {!loading && !error && adaptedClimate && fieldClassification && (
        <>
          {/* 1. Field Agroecological Context & Plan Generation Bar */}
          <Card>
            <CardHeader className="pb-3">
              <div className="flex items-start justify-between gap-4 flex-wrap">
                <div className="space-y-1">
                  <div className="flex items-center gap-2 flex-wrap">
                    <Compass className="h-4 w-4 text-electric" />
                    <CardTitle className="text-sm font-semibold text-foreground">
                      Field Agroecological Profile:{" "}
                      {AG_GROUP_LABELS[fieldClassification.group]}
                    </CardTitle>
                    <span className="rounded bg-muted px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">
                      {fieldClassification.group}
                    </span>
                    <span
                      className={`rounded px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide ${
                        fieldClassification.confidence === "high"
                          ? "bg-emerald-50 text-emerald-700 border border-emerald-100"
                          : fieldClassification.confidence === "moderate"
                          ? "bg-amber-50 text-amber-700 border border-amber-100"
                          : "bg-red-50 text-red-700 border border-red-100"
                      }`}
                    >
                      {fieldClassification.confidence} confidence (provisional climate-based)
                    </span>
                  </div>
                  <CardDescription className="text-xs">
                    {fieldClassification.reasons[0] ??
                      "Classified from NASA POWER climate history and recorded SSURGO soil context."}
                  </CardDescription>
                </div>

                <div className="flex items-center gap-2 shrink-0">
                  <Button
                    size="sm"
                    onClick={handleGenerate}
                    disabled={generating || availableCropIds.length === 0}
                    className={
                      hasGeneratedPlans ? "bg-purple-600 hover:bg-purple-700 text-white" : ""
                    }
                  >
                    {generating ? (
                      <>
                        <RefreshCw className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                        Generating...
                      </>
                    ) : hasGeneratedPlans ? (
                      <>
                        <Sparkles className="mr-1.5 h-3.5 w-3.5" />
                        Regenerate field plans
                      </>
                    ) : (
                      <>
                        <Sparkles className="mr-1.5 h-3.5 w-3.5" />
                        Generate field-specific plans
                      </>
                    )}
                  </Button>
                  {hasGeneratedPlans && (
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => {
                        setFieldRotations(field.id, null);
                        setGenerateError(null);
                        setGenerationStatus(null);
                        setRejectedProposals([]);
                      }}
                    >
                      Clear
                    </Button>
                  )}
                </div>
              </div>
            </CardHeader>

            <CardContent className="space-y-2.5 pt-0 text-xs">
              <div className="flex items-start gap-2 rounded-md bg-muted/40 px-3 py-2 text-muted-foreground">
                <Info className="h-3.5 w-3.5 shrink-0 mt-0.5 text-electric" />
                <div className="space-y-1">
                  {availableCropNames.length > 0 ? (
                    <p>
                      <strong className="text-foreground">
                        {availableCropNames.length} verified crops supported for this group
                        {detectedRegion ? ` & ${detectedRegion.label}` : ""}:
                      </strong>{" "}
                      {availableCropNames.join(", ")}.
                    </p>
                  ) : (
                    <p>
                      <strong className="text-foreground">
                        Local crop catalog coverage pending:
                      </strong>{" "}
                      No verified crop records in the catalog currently match agroecological group{" "}
                      <code className="font-mono text-[11px]">{fieldClassification.group}</code>
                      {detectedRegion
                        ? ` in ${detectedRegion.label}`
                        : " at these coordinates"}
                      . Locally supported 3-year crop sequences cannot yet be assembled without verified local crop data.
                    </p>
                  )}

                  {!hasGeneratedPlans && availableCropNames.length > 0 && !generateError && (
                    <p className="text-[11px]">
                      Field-specific 3-year crop sequences have not been generated yet. Configure a runtime AI provider (<code className="font-mono">FALLO_AI_PROVIDER</code> and{" "}
                      <code className="font-mono">FALLO_AI_API_KEY</code>) to assemble and deterministically validate custom 3-year sequences from the verified crops above.
                    </p>
                  )}
                </div>
              </div>

              {generateError && (
                <div className="rounded-md bg-amber-50 px-3 py-2 text-[11px] text-amber-800 border border-amber-200">
                  {generateError}
                </div>
              )}

              {rejectedProposals.length > 0 && (
                <div className="rounded-md bg-red-50 px-3 py-2 text-[11px] text-red-700 border border-red-100 space-y-1">
                  <p className="font-semibold">
                    Rejected invalid AI proposal{rejectedProposals.length > 1 ? "s" : ""}:
                  </p>
                  <ul className="list-disc list-inside space-y-0.5">
                    {rejectedProposals.map((r) => (
                      <li key={r.id}>
                        <strong>{r.name}</strong>: {r.errors.join("; ")}
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              {generationStatus && !generateError && hasGeneratedPlans && (
                <div className="rounded-md bg-emerald-50 px-3 py-2 text-[11px] text-emerald-700 border border-emerald-100">
                  Validated field-specific plans active ({generationStatus}).
                </div>
              )}
            </CardContent>
          </Card>

          {/* 2A. When Validated Field-Specific Rotations Exist: Show Them as Primary */}
          {hasGeneratedPlans && (
            <div className="space-y-6">
              <Card>
                <CardHeader className="pb-2">
                  <div className="flex items-center gap-2">
                    <SlidersHorizontal className="h-4 w-4 text-electric" />
                    <CardTitle className="text-sm font-semibold text-foreground">
                      Adjust your priorities
                    </CardTitle>
                  </div>
                  <CardDescription className="text-xs">
                    Weight the five suitability factors for your operation. Scores update immediately.
                  </CardDescription>
                </CardHeader>
                <CardContent>
                  <PrioritySliders priorities={priorities} onChange={setPriorities} />
                </CardContent>
              </Card>

              <div className="grid gap-4 lg:grid-cols-3">
                {generatedResults.map((result) => (
                  <StrategyCard
                    key={result.strategy.id}
                    result={result}
                    climate={adaptedClimate}
                    soil={adaptedSoil}
                  />
                ))}
              </div>

              <Card>
                <CardHeader className="pb-2">
                  <div className="flex items-center gap-2">
                    <BarChart3 className="h-4 w-4 text-electric" />
                    <CardTitle className="text-sm font-semibold text-foreground">
                      Factor comparison
                    </CardTitle>
                  </div>
                </CardHeader>
                <CardContent>
                  <FactorComparison results={generatedResults} />
                </CardContent>
              </Card>
            </div>
          )}

          {/* 2B. When No Field-Specific Crop Sequences Have Been Generated Yet: Show the 3 Strategy Objectives */}
          {!hasGeneratedPlans && (
            <div className="space-y-3">
              <div className="flex items-center justify-between gap-2 flex-wrap">
                <div>
                  <h3 className="text-sm font-semibold text-foreground">
                    Target Strategy Objectives for {field.name}
                  </h3>
                  <p className="text-xs text-muted-foreground">
                    Three core rotation objectives tailored to this field&apos;s recorded climate and soil conditions.{" "}
                    {availableCropNames.length > 0
                      ? "Specific 3-year crop sequences will be populated once a runtime AI provider is configured."
                      : "Locally supported 3-year crop sequences are not yet available for this location."}
                  </p>
                </div>
              </div>

              <div className="grid gap-4 lg:grid-cols-3">
                {STRATEGY_OBJECTIVES.map((obj) => {
                  const bullets = buildObjectiveFieldContextBullets(
                    obj.archetype,
                    adaptedClimate,
                    adaptedSoil
                  );
                  const Icon =
                    obj.archetype === "soil_health"
                      ? Sprout
                      : obj.archetype === "water_resilience"
                      ? Droplets
                      : Layers;
                  const accentClass =
                    obj.archetype === "soil_health"
                      ? "border-l-4 border-l-emerald-500"
                      : obj.archetype === "water_resilience"
                      ? "border-l-4 border-l-electric"
                      : "border-l-4 border-l-indigo-500";
                  const badgeClass =
                    obj.archetype === "soil_health"
                      ? "bg-emerald-50 text-emerald-700"
                      : obj.archetype === "water_resilience"
                      ? "bg-electric/10 text-electric"
                      : "bg-indigo-50 text-indigo-700";

                  return (
                    <Card key={obj.archetype} className={`h-full flex flex-col ${accentClass}`}>
                      <CardHeader className="pb-2.5 space-y-2">
                        <div className="flex items-center justify-between gap-2">
                          <div className="flex items-center gap-2">
                            <span
                              className={`inline-flex h-7 w-7 items-center justify-center rounded-md ${badgeClass}`}
                            >
                              <Icon className="h-4 w-4" />
                            </span>
                            <CardTitle className="text-base font-semibold text-foreground">
                              {obj.name}
                            </CardTitle>
                          </div>
                        </div>
                        <CardDescription className="text-xs leading-relaxed text-muted-foreground">
                          {obj.objective}
                        </CardDescription>
                      </CardHeader>
                      <CardContent className="flex-1 flex flex-col justify-between gap-3 pt-0">
                        <ul className="space-y-1.5 text-xs text-foreground/90">
                          {bullets.map((b, i) => (
                            <li key={i} className="flex items-start gap-2 leading-snug">
                              <span className="mt-1.5 h-1.5 w-1.5 rounded-full bg-electric shrink-0" />
                              <span>{b}</span>
                            </li>
                          ))}
                        </ul>

                        <div className="rounded-md bg-muted/50 px-2.5 py-1.5 text-[11px] text-muted-foreground mt-auto">
                          {availableCropNames.length > 0
                            ? "3-year crop sequence: Pending runtime AI provider"
                            : "3-year crop sequence: Local crop catalog unavailable"}
                        </div>
                      </CardContent>
                    </Card>
                  );
                })}
              </div>
            </div>
          )}

          {/* 3. Secondary Reference Templates — Shown Directly Only When Regionally Applicable, Otherwise Collapsed */}
          {referenceResults.length > 0 && (
            <div className="space-y-4 pt-2 border-t border-border/60">
              {referenceTemplatesApplicable ? (
                <>
                  <div className="flex items-start justify-between gap-4 flex-wrap">
                    <div className="space-y-0.5">
                      <div className="flex items-center gap-2">
                        <h3 className="text-sm font-semibold text-foreground">
                          Regional Reference Templates ({detectedRegion?.label})
                        </h3>
                        <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                          Secondary reference material
                        </span>
                      </div>
                      <p className="text-xs text-muted-foreground">
                        Predefined reference rotations using crops documented for this agroecological group and region, scored against {field.name}&apos;s climate and soil data.
                      </p>
                    </div>
                  </div>

                  {!hasGeneratedPlans && (
                    <Card>
                      <CardHeader className="pb-2">
                        <div className="flex items-center gap-2">
                          <SlidersHorizontal className="h-4 w-4 text-electric" />
                          <CardTitle className="text-sm font-semibold text-foreground">
                            Adjust your priorities
                          </CardTitle>
                        </div>
                        <CardDescription className="text-xs">
                          Change the sliders to weight the five suitability factors. Reference scores recalculate immediately.
                        </CardDescription>
                      </CardHeader>
                      <CardContent>
                        <PrioritySliders priorities={priorities} onChange={setPriorities} />
                      </CardContent>
                    </Card>
                  )}

                  <div className="grid gap-4 lg:grid-cols-3">
                    {referenceResults.map((result) => (
                      <StrategyCard
                        key={result.strategy.id}
                        result={result}
                        climate={adaptedClimate}
                        soil={adaptedSoil}
                      />
                    ))}
                  </div>

                  {!hasGeneratedPlans && (
                    <Card>
                      <CardHeader className="pb-2">
                        <div className="flex items-center gap-2">
                          <BarChart3 className="h-4 w-4 text-electric" />
                          <CardTitle className="text-sm font-semibold text-foreground">
                            Reference factor comparison
                          </CardTitle>
                        </div>
                      </CardHeader>
                      <CardContent>
                        <FactorComparison results={referenceResults} />
                      </CardContent>
                    </Card>
                  )}
                </>
              ) : (
                <div className="space-y-3">
                  <button
                    type="button"
                    onClick={() => setShowNonLocalReference(!showNonLocalReference)}
                    className="inline-flex items-center gap-1.5 text-xs font-medium text-muted-foreground hover:text-foreground transition-colors"
                  >
                    {showNonLocalReference ? (
                      <>
                        <ChevronUp className="h-3.5 w-3.5" />
                        Hide non-local reference templates (development & scoring preview)
                      </>
                    ) : (
                      <>
                        <ChevronDown className="h-3.5 w-3.5" />
                        View temperate-humid reference templates (non-local reference material)
                      </>
                    )}
                  </button>

                  {showNonLocalReference && (
                    <div className="space-y-4">
                      <div className="rounded-md border border-amber-200 bg-amber-50/70 px-3 py-2 text-xs text-amber-800">
                        <strong>Reference only — not personalized for this field:</strong> These static reference templates include crops documented for temperate-humid US Southeast production and are not fully verified for{" "}
                        {detectedRegion ? detectedRegion.label : "this location"}. They are provided strictly as secondary reference material to inspect the deterministic scoring engine.
                      </div>

                      {!hasGeneratedPlans && (
                        <Card>
                          <CardHeader className="pb-2">
                            <div className="flex items-center gap-2">
                              <SlidersHorizontal className="h-4 w-4 text-electric" />
                              <CardTitle className="text-sm font-semibold text-foreground">
                                Adjust priority weights
                              </CardTitle>
                            </div>
                          </CardHeader>
                          <CardContent>
                            <PrioritySliders priorities={priorities} onChange={setPriorities} />
                          </CardContent>
                        </Card>
                      )}

                      <div className="grid gap-4 lg:grid-cols-3">
                        {referenceResults.map((result) => (
                          <StrategyCard
                            key={result.strategy.id}
                            result={result}
                            climate={adaptedClimate}
                            soil={adaptedSoil}
                          />
                        ))}
                      </div>

                      {!hasGeneratedPlans && (
                        <Card>
                          <CardHeader className="pb-2">
                            <div className="flex items-center gap-2">
                              <BarChart3 className="h-4 w-4 text-electric" />
                              <CardTitle className="text-sm font-semibold text-foreground">
                                Factor comparison (reference templates)
                              </CardTitle>
                            </div>
                          </CardHeader>
                          <CardContent>
                            <FactorComparison results={referenceResults} />
                          </CardContent>
                        </Card>
                      )}
                    </div>
                  )}
                </div>
              )}
            </div>
          )}

          {/* Concise Scoring Disclaimer */}
          <div className="rounded-lg border border-border bg-card/70 px-4 py-3 text-xs text-muted-foreground leading-relaxed">
            <strong className="text-foreground">Decision-support note:</strong> Suitability scores (0–100) are deterministic heuristics computed from NASA POWER regional climate (~55 km grid) and USDA SSURGO 0–30 cm soil averages—not calibrated yield predictions.{" "}
            <strong className="text-foreground">Data coverage</strong> indicates input completeness, not agronomic certainty.
          </div>
        </>
      )}
    </div>
  );
}

function RotationsSkeleton() {
  return (
    <div className="space-y-6">
      <div className="space-y-2">
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-4 w-80" />
      </div>
      <Card>
        <CardHeader className="pb-2">
          <Skeleton className="h-5 w-64" />
        </CardHeader>
        <CardContent>
          <Skeleton className="h-10 w-full" />
        </CardContent>
      </Card>
      <div className="grid gap-4 lg:grid-cols-3">
        {Array.from({ length: 3 }).map((_, i) => (
          <Card key={i} className="h-full">
            <CardHeader className="pb-3">
              <Skeleton className="h-5 w-44" />
              <Skeleton className="h-3 w-full mt-2" />
            </CardHeader>
            <CardContent className="space-y-2">
              <Skeleton className="h-3.5 w-full" />
              <Skeleton className="h-3.5 w-5/6" />
              <Skeleton className="h-3.5 w-4/6" />
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  );
}
