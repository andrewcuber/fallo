"use client";

import { useEffect, useState, useCallback, useMemo, useRef } from "react";
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
  scoreVerifiedAiStrategies,
  STRATEGY_OBJECTIVES,
  buildObjectiveFieldContextBullets,
  getAvailableCropsForContext,
  evaluateFieldCropEvidenceLevel,
  cropLibrary,
  DEFAULT_AI_TIMEOUT_MS,
} from "@/lib/rotation-scoring";
import {
  classifyAgGroup,
  AG_GROUP_LABELS,
  formatAgGroupLabel,
  formatAgGroupDescription,
  formatMoistureZoneLabel,
  formatMoistureZoneDescription,
  formatWaterRegimeLabel,
  formatWaterRegimeDescription,
} from "@/lib/agro-classifier";
import type { GenerationResult } from "@/lib/rotation-generator";
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
  Compass,
  CheckCircle2,
  Database,
  Globe,
} from "lucide-react";
import { detectRegion, resolveGeographicContext } from "@/lib/region";

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
  const inFlightFieldRef = useRef<string | null>(null);

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
  const geoContext = useMemo(
    () => (field ? resolveGeographicContext(field.lat, field.lon) : null),
    [field]
  );
  const detectedRegion = useMemo(
    () => (field ? detectRegion(field.lat, field.lon) : null),
    [field]
  );
  const regionTag = detectedRegion?.tag ?? geoContext?.regionTag ?? null;

  // Deterministic agroecological classification & local crop availability
  const fieldClassification = useMemo(() => {
    if (!adaptedClimate) return null;
    return classifyAgGroup(adaptedClimate, adaptedSoil);
  }, [adaptedClimate, adaptedSoil]);

  const availableCropIds = useMemo(() => {
    if (!fieldClassification) return [];
    return getAvailableCropsForContext(fieldClassification.group, regionTag);
  }, [fieldClassification, regionTag]);

  const fieldEvidence = useMemo(() => {
    if (!fieldClassification) return null;
    return evaluateFieldCropEvidenceLevel({
      agGroup: fieldClassification.group,
      regionTag,
      availableCropIds,
      soil: adaptedSoil,
    });
  }, [fieldClassification, regionTag, availableCropIds, adaptedSoil]);

  const availableCropNames = useMemo(
    () =>
      availableCropIds
        .map((id) => cropLibrary[id]?.commonName)
        .filter((n): n is string => typeof n === "string"),
    [availableCropIds]
  );

  // Score ONLY verified AI-generated strategies for this field (never static predefined templates)
  const generatedResults: StrategyResult[] = useMemo(() => {
    if (!adaptedClimate || !field) return [];
    return scoreVerifiedAiStrategies(
      field.generatedRotations?.strategies,
      field.id,
      adaptedClimate,
      adaptedSoil,
      priorities,
      regionTag
    );
  }, [adaptedClimate, adaptedSoil, field, priorities, regionTag]);

  const handleGenerate = useCallback(async () => {
    if (!field || !adaptedClimate) return;
    if (generating || inFlightFieldRef.current === field.id) {
      return;
    }

    inFlightFieldRef.current = field.id;
    setGenerating(true);
    setGenerateError(null);

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

      if (!res.ok || !Array.isArray(data.proposals) || data.proposals.length === 0) {
        setGenerateError("We couldn't finish generating your plans. Please try again later.");
        return;
      }

      const rawStrategies = data.proposals.map((p) => p.strategy);
      setFieldRotations(field.id, {
        strategies: rawStrategies,
        generatedAt: data.generatedAt ?? new Date().toISOString(),
        agGroup: data.classification.group,
        version: "1.0",
        fieldId: field.id,
        aiProvider: data.aiProvider,
        aiModel: data.aiModel,
        validationStatus: "passed",
        usageMetadata: data.usageMetadata,
      });
    } catch {
      setGenerateError("We couldn't finish generating your plans. Please try again later.");
    } finally {
      clearTimeout(timeoutId);
      inFlightFieldRef.current = null;
      setGenerating(false);
    }
  }, [field, adaptedClimate, adaptedSoil, priorities, regionTag, setFieldRotations, generating]);

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

  const climateTemp = adaptedClimate?.fullRecord.avgAnnualTemp;
  const climatePrecip = adaptedClimate?.fullRecord.avgAnnualPrecip;
  const gsPrecip = adaptedClimate?.stressMetrics.growingSeasonPrecip.avgTotalMm;
  const dryDays = adaptedClimate?.stressMetrics.summerDrySpells.avgMaxConsecutiveDryDays;
  const heatDays = adaptedClimate?.stressMetrics.summerHeatDays.avgDaysAboveThreshold;
  const soilAwc = adaptedSoil?.aggregated.depth0_30cm.awc ?? null;
  const soilOm = adaptedSoil?.aggregated.depth0_30cm.om ?? null;
  const soilPh = adaptedSoil?.aggregated.depth0_30cm.ph ?? null;
  const soilDrainage = adaptedSoil?.aggregated.drainage ?? null;
  const soilSlope = adaptedSoil?.aggregated.slope ?? null;
  const soilCoveragePct =
    adaptedSoil?.dataCoverage.depth0_30cm.awc ?? adaptedSoil?.dataCoverage.slope ?? null;

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="space-y-1">
        <h2 className="text-2xl font-serif font-bold text-foreground">Rotation Lab</h2>
        <p className="text-sm text-muted-foreground max-w-2xl">
          Super Intelligence (SI)-generated 3-year crop rotation planning tailored to your field&apos;s climate regime, soil properties, and local crop suitability.
        </p>
        <p className="text-xs text-muted-foreground">
          Field: <strong className="text-foreground">{field.name}</strong> ({field.lat.toFixed(4)},{" "}
          {field.lon.toFixed(4)})
          {geoContext
            ? ` · ${geoContext.countryName} (${geoContext.countryCodeIso3}) — ${geoContext.admin1Name}`
            : ""}
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
          {/* 1. Field Agroecological Profile, Data Coverage Summary, & SI Plan Generation */}
          <Card>
            <CardHeader className="pb-3">
              <div className="flex items-start justify-between gap-4 flex-wrap">
                <div className="space-y-1.5">
                  <div className="flex items-center gap-2 flex-wrap">
                    <Compass className="h-4 w-4 text-electric" />
                    <CardTitle className="text-sm font-semibold text-foreground">
                      Field Agroecological Profile:{" "}
                      {AG_GROUP_LABELS[fieldClassification.group]}
                    </CardTitle>
                    <span
                      className={`rounded px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide ${
                        fieldClassification.confidence === "high"
                          ? "bg-emerald-50 text-emerald-700 border border-emerald-100"
                          : fieldClassification.confidence === "moderate"
                          ? "bg-amber-50 text-amber-700 border border-amber-100"
                          : "bg-red-50 text-red-700 border border-red-100"
                      }`}
                    >
                      {fieldClassification.confidence} confidence
                    </span>
                    {fieldEvidence && (
                      <span
                        className={`rounded px-1.5 py-0.5 text-[10px] font-medium tracking-wide ${
                          fieldEvidence.level === "level_1_strong_local"
                            ? "bg-blue-50 text-blue-700 border border-blue-200"
                            : fieldEvidence.level === "level_2_global_modeled"
                            ? "bg-indigo-50 text-indigo-700 border border-indigo-200"
                            : "bg-red-50 text-red-700 border border-red-200"
                        }`}
                      >
                        {fieldEvidence.label}
                      </span>
                    )}
                  </div>
                  <CardDescription className="text-xs leading-relaxed">
                    {formatAgGroupDescription(fieldClassification.group)}{" "}
                    {fieldClassification.reasons[0] ??
                      "Classified from NASA POWER climate history and recorded soil context."}
                  </CardDescription>
                  {fieldClassification.estimatedLgpDays !== null &&
                    fieldClassification.estimatedLgpDays !== undefined && (
                      <div className="rounded-md bg-muted/40 px-2.5 py-1.5 text-[11px] text-muted-foreground space-y-0.5">
                        <p>
                          <strong className="text-foreground">Growing season &amp; moisture:</strong>{" "}
                          {formatMoistureZoneLabel(fieldClassification.gaezMoistureZone)} (~
                          {fieldClassification.estimatedLgpDays} moist growing-period days/year) ·{" "}
                          <strong className="text-foreground">Water regime:</strong>{" "}
                          {formatWaterRegimeLabel(fieldClassification.waterRegime)}
                        </p>
                        <p className="text-muted-foreground/90">
                          {formatMoistureZoneDescription(fieldClassification.gaezMoistureZone)}{" "}
                          {formatWaterRegimeDescription(fieldClassification.waterRegime)}
                        </p>
                      </div>
                    )}
                  {geoContext?.disputedOrBorderNote && (
                    <p className="text-[11px] text-muted-foreground flex items-center gap-1 pt-0.5">
                      <Globe className="h-3 w-3 text-electric shrink-0" />
                      <span>{geoContext.disputedOrBorderNote}</span>
                    </p>
                  )}
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
                        Generating Plans...
                      </>
                    ) : hasGeneratedPlans ? (
                      <>
                        <Sparkles className="mr-1.5 h-3.5 w-3.5" />
                        Regenerate Field-Specific Plans
                      </>
                    ) : (
                      <>
                        <Sparkles className="mr-1.5 h-3.5 w-3.5" />
                        Generate Field-Specific Plans
                      </>
                    )}
                  </Button>
                  {hasGeneratedPlans && (
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={generating}
                      onClick={() => {
                        setFieldRotations(field.id, null);
                        setGenerateError(null);
                      }}
                    >
                      Clear
                    </Button>
                  )}
                </div>
              </div>
            </CardHeader>

            <CardContent className="space-y-2.5 pt-0 text-xs">
              {/* Climate & Soil Data Coverage Summary */}
              <div className="grid gap-2 md:grid-cols-2">
                <div className="rounded-md border border-border/70 bg-muted/25 px-3 py-2 space-y-1">
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-semibold text-foreground flex items-center gap-1.5">
                      <Database className="h-3.5 w-3.5 text-electric" />
                      Climate Data Coverage (NASA POWER)
                    </span>
                    <span className="rounded bg-emerald-50 px-1.5 py-0.5 text-[10px] font-medium text-emerald-700 border border-emerald-100">
                      Available (~55 km grid)
                    </span>
                  </div>
                  <p className="text-[11px] text-muted-foreground">
                    Annual: {climateTemp !== null && climateTemp !== undefined ? `${climateTemp.toFixed(1)} °C` : "—"},{" "}
                    {climatePrecip !== null && climatePrecip !== undefined ? `${climatePrecip.toFixed(0)} mm/yr` : "—"} ·
                    May–Aug precip: {gsPrecip !== null && gsPrecip !== undefined ? `${gsPrecip.toFixed(0)} mm` : "—"} ·
                    Summer dry spells: {dryDays !== null && dryDays !== undefined ? `${dryDays.toFixed(1)} d` : "—"} ·
                    Heat days (&gt;35 °C): {heatDays !== null && heatDays !== undefined ? `${heatDays.toFixed(1)} d` : "—"}
                  </p>
                </div>

                <div className="rounded-md border border-border/70 bg-muted/25 px-3 py-2 space-y-1">
                  <div className="flex items-center justify-between gap-2 flex-wrap">
                    <span className="font-semibold text-foreground flex items-center gap-1.5">
                      <Database className="h-3.5 w-3.5 text-electric" />
                      {adaptedSoil?.source.toUpperCase().includes("SSURGO")
                        ? "Soil Data Coverage (USDA SSURGO 0–30 cm Survey)"
                        : "Soil Context (Regional Topsoil Reference Estimate)"}
                    </span>
                    {adaptedSoil ? (
                      adaptedSoil.source.toUpperCase().includes("SSURGO") ? (
                        <span className="rounded bg-emerald-50 px-1.5 py-0.5 text-[10px] font-medium text-emerald-700 border border-emerald-100">
                          {soilCoveragePct !== null ? `${soilCoveragePct.toFixed(0)}% map-unit coverage` : "Survey available"}
                        </span>
                      ) : (
                        <span className="rounded bg-amber-50 px-1.5 py-0.5 text-[10px] font-medium text-amber-800 border border-amber-200">
                          Regional reference (not coordinate-extracted)
                        </span>
                      )
                    ) : (
                      <span className="rounded bg-amber-50 px-1.5 py-0.5 text-[10px] font-medium text-amber-800 border border-amber-200">
                        Unavailable (lower confidence)
                      </span>
                    )}
                  </div>
                  {adaptedSoil ? (
                    <p className="text-[11px] text-muted-foreground">
                      AWC: {soilAwc !== null ? `${soilAwc.toFixed(3)} cm/cm` : "—"} · OM:{" "}
                      {soilOm !== null ? `${soilOm.toFixed(1)}%` : "—"} · pH:{" "}
                      {soilPh !== null ? soilPh.toFixed(1) : "—"} · Drainage: {soilDrainage ?? "—"} · Slope:{" "}
                      {soilSlope !== null ? `${soilSlope.toFixed(1)}%` : "—"}
                      {soil?.mapUnit?.name
                        ? ` · ${
                            adaptedSoil.source.toUpperCase().includes("SSURGO")
                              ? "Unit"
                              : "Reference group"
                          }: ${soil.mapUnit.name}`
                        : ""}
                    </p>
                  ) : (
                    <p className="text-[11px] text-amber-800">
                      Soil profile data is currently unavailable for these coordinates. Soil AWC, organic matter, pH, drainage, and slope are recorded as null and lower classification/scoring coverage.
                    </p>
                  )}
                </div>
              </div>

              {/* Verified Crop Catalog Coverage */}
              <div className="flex items-start gap-2 rounded-md bg-muted/40 px-3 py-2 text-muted-foreground">
                <Info className="h-3.5 w-3.5 shrink-0 mt-0.5 text-electric" />
                <div className="space-y-1">
                  {availableCropNames.length > 0 ? (
                    <p>
                      <strong className="text-foreground">
                        {availableCropNames.length} locally verified crops supported for{" "}
                        {formatAgGroupLabel(fieldClassification.group)}
                        {detectedRegion ? ` (${detectedRegion.label})` : ""}:
                      </strong>{" "}
                      {availableCropNames.join(", ")}.
                    </p>
                  ) : (
                    <div className="space-y-1">
                      <p>
                        <strong className="text-foreground">
                          Verified crop catalog unavailable for this location:
                        </strong>{" "}
                        No verified crop records in the catalog currently match the{" "}
                        <strong className="text-foreground">
                          {formatAgGroupLabel(fieldClassification.group)}
                        </strong>{" "}
                        climate zone
                        {detectedRegion
                          ? ` in ${detectedRegion.label}`
                          : ` at (${field.lat.toFixed(4)}, ${field.lon.toFixed(4)})`}
                        . fallo does not display predefined or US reference crop rotations for unsupported regions.
                      </p>
                      <p className="text-[11px]">
                        <strong className="text-foreground">Requirements for rotation support here:</strong>{" "}
                        Regionally verified crop calendars, drought/heat thresholds, and host-disease rules from national or international agricultural research institutes for this climate zone.
                      </p>
                    </div>
                  )}

                  {!hasGeneratedPlans && availableCropNames.length > 0 && !generateError && !generating && (
                    <p className="text-[11px]">
                      Click <strong className="text-foreground">Generate Field-Specific Plans</strong> to create three SI-generated 3-year crop rotation plans (Soil Health Building, Water Resilience, Crop Diversity &amp; Pest Break) using the verified crops above.
                    </p>
                  )}
                </div>
              </div>

              {generating && (
                <div
                  role="status"
                  aria-live="polite"
                  className="rounded-lg bg-electric/5 px-4 py-3.5 text-xs text-foreground border border-electric/25 flex items-start gap-3"
                >
                  <RefreshCw className="h-4 w-4 text-electric animate-spin shrink-0 mt-0.5" />
                  <div className="space-y-1">
                    <p className="font-semibold text-foreground">
                      Generating your crop rotation plans. This may take up to 2 minutes.
                    </p>
                    <p className="text-[11px] text-muted-foreground">
                      Evaluating local climate patterns, topsoil properties, and 3-year crop sequences for {field.name}&hellip;
                    </p>
                  </div>
                </div>
              )}

              {generateError && !generating && (
                <div className="rounded-md bg-amber-50 px-3 py-2.5 text-xs text-amber-900 border border-amber-200 space-y-1">
                  <p className="font-semibold">{generateError}</p>
                  {hasGeneratedPlans && (
                    <p className="text-[11px] text-emerald-800 font-medium">
                      Your existing SI-generated plans for {field.name} remain available below.
                    </p>
                  )}
                </div>
              )}

              {hasGeneratedPlans && !generating && (
                <div className="rounded-md bg-emerald-50/90 px-3 py-2 text-xs text-emerald-800 border border-emerald-200 flex items-center gap-2">
                  <CheckCircle2 className="h-4 w-4 text-emerald-700 shrink-0" />
                  <span className="font-medium">
                    SI-generated crop rotation plans tailored to {field.name}
                  </span>
                </div>
              )}
            </CardContent>
          </Card>

          {/* 2. Farmer Priority Sliders — Set Weights Before Generation or Re-Rank SI Plans Locally */}
          <Card>
            <CardHeader className="pb-2">
              <div className="flex items-center gap-2">
                <SlidersHorizontal className="h-4 w-4 text-electric" />
                <CardTitle className="text-sm font-semibold text-foreground">
                  Farmer Priority Weights
                </CardTitle>
              </div>
              <CardDescription className="text-xs">
                {hasGeneratedPlans
                  ? "Weight the five suitability factors for your operation. SI-generated plans re-score and re-rank immediately."
                  : "Set your relative priority weights across the five suitability factors before generating field-specific plans."}
              </CardDescription>
            </CardHeader>
            <CardContent>
              <PrioritySliders priorities={priorities} onChange={setPriorities} />
            </CardContent>
          </Card>

          {/* 3A. After Generation: Display SI-Generated 3-Year Plans */}
          {hasGeneratedPlans && (
            <div className="space-y-6">
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
                      Factor comparison (SI-generated plans)
                    </CardTitle>
                  </div>
                </CardHeader>
                <CardContent>
                  <FactorComparison results={generatedResults} />
                </CardContent>
              </Card>
            </div>
          )}

          {/* 3B. Before Generation: Display Only Strategy Planning Objectives (No Predefined 3-Year Sequences) */}
          {!hasGeneratedPlans && (
            <div className="space-y-3">
              <div className="flex items-center justify-between gap-2 flex-wrap">
                <div>
                  <h3 className="text-sm font-semibold text-foreground">
                    Planning Objectives for {field.name} (Goals — Not Completed Crop Recommendations)
                  </h3>
                  <p className="text-xs text-muted-foreground">
                    fallo does not display predefined static 3-year crop rotations. Below are the three planning objectives that will guide Super Intelligence (SI) generation once you click{" "}
                    <strong className="text-foreground">Generate Field-Specific Plans</strong>.
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
                        <div className="flex items-center justify-between gap-2 flex-wrap">
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
                          <span className="rounded bg-amber-50 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-amber-800 border border-amber-200">
                            No SI-generated plan yet
                          </span>
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
                            ? "Planning goal only — click Generate Field-Specific Plans above to create a 3-year crop rotation plan."
                            : "No SI-generated plan yet — verified local crop catalog coverage is required before 3-year sequences can be generated."}
                        </div>
                      </CardContent>
                    </Card>
                  );
                })}
              </div>
            </div>
          )}

          {/* Concise Scoring Disclaimer */}
          <div className="rounded-lg border border-border bg-card/70 px-4 py-3 text-xs text-muted-foreground leading-relaxed">
            <strong className="text-foreground">Decision-support note:</strong> Suitability scores (0–100) are deterministic heuristics computed from NASA POWER regional climate (~55 km grid) and 0–30 cm topsoil context (USDA SSURGO survey averages in the US, or macro-regional topsoil reference estimates elsewhere)—not calibrated yield predictions.{" "}
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
