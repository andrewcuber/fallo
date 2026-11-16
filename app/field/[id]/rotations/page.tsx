"use client";

import { useEffect, useState, useCallback, useMemo, useRef } from "react";
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
import { StrategyCard } from "@/components/rotation/strategy-card";
import { PrioritySliders } from "@/components/rotation/priority-sliders";
import { FactorComparison } from "@/components/rotation/factor-comparison";
import {
  StrategyResult,
  scoreVerifiedAiStrategies,
  buildFieldSpecificObjectives,
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
  formatWaterRegimeLabel,
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
  const {
    climateRaw,
    soilRaw,
    loading,
    error,
    refresh: fetchData,
  } = useFieldEnvironmentalData(field);
  const climate = climateRaw as ClimateData | null;
  const soil = soilRaw as SoilData | null;

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

  const fieldObjectives = useMemo(
    () =>
      buildFieldSpecificObjectives({
        climate: adaptedClimate,
        soil: adaptedSoil,
        priorities,
        availableCropIds,
      }),
    [adaptedClimate, adaptedSoil, priorities, availableCropIds]
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
        const serverReason = (data.message || data.aiUnavailableReason || "").trim();
        setGenerateError(
          serverReason || "We couldn't finish generating your plans. Please try again later."
        );
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
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") {
        setGenerateError(
          "Rotation generation timed out after 2 minutes. Please try again."
        );
      } else {
        setGenerateError(
          err instanceof Error && err.message
            ? err.message
            : "We couldn't finish generating your plans. Please try again later."
        );
      }
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
          <h2 className="text-2xl font-serif font-bold text-foreground">Crop Rotation Lab</h2>
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
        <h2 className="text-2xl font-serif font-bold text-foreground">Crop Rotation Lab</h2>
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
          {/* 1. Simplified Field Agroecological Profile */}
          <Card>
            <CardHeader className="pb-2.5">
              <div className="space-y-1.5">
                <div className="flex items-center gap-2 flex-wrap">
                  <Compass className="h-4 w-4 text-electric" />
                  <CardTitle className="text-sm font-semibold text-foreground">
                    Field Agroecological Profile:{" "}
                    {AG_GROUP_LABELS[fieldClassification.group]}
                  </CardTitle>
                </div>
                <CardDescription className="text-xs leading-relaxed">
                  {formatAgGroupDescription(fieldClassification.group)}
                </CardDescription>
                {fieldClassification.estimatedLgpDays !== null &&
                  fieldClassification.estimatedLgpDays !== undefined && (
                    <div className="rounded-md bg-muted/40 px-2.5 py-1.5 text-[11px] text-muted-foreground">
                      <p>
                        <strong className="text-foreground">Growing season &amp; moisture:</strong>{" "}
                        {formatMoistureZoneLabel(fieldClassification.gaezMoistureZone)} (~
                        {fieldClassification.estimatedLgpDays} moist growing-period days/year) ·{" "}
                        <strong className="text-foreground">Water regime:</strong>{" "}
                        {formatWaterRegimeLabel(fieldClassification.waterRegime)}
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
            </CardHeader>

            <CardContent className="space-y-2.5 pt-0 text-xs">
              {/* Concise Agricultural Climate & Soil Context */}
              <div className="grid gap-2 md:grid-cols-2">
                <div className="rounded-md border border-border/70 bg-muted/25 px-3 py-2 space-y-1">
                  <span className="font-semibold text-foreground block">
                    Climate Summary (20-Year Average)
                  </span>
                  <p className="text-[11px] text-muted-foreground">
                    Annual: {climateTemp !== null && climateTemp !== undefined ? `${climateTemp.toFixed(1)} °C` : "—"},{" "}
                    {climatePrecip !== null && climatePrecip !== undefined ? `${climatePrecip.toFixed(0)} mm/yr` : "—"} ·
                    Growing-season rain: {gsPrecip !== null && gsPrecip !== undefined ? `${gsPrecip.toFixed(0)} mm` : "—"} ·
                    Dry spells: {dryDays !== null && dryDays !== undefined ? `${dryDays.toFixed(1)} d` : "—"} ·
                    Heat days (&gt;35 °C): {heatDays !== null && heatDays !== undefined ? `${heatDays.toFixed(1)} d` : "—"}
                  </p>
                </div>

                <div className="rounded-md border border-border/70 bg-muted/25 px-3 py-2 space-y-1">
                  <div className="flex items-center justify-between gap-2 flex-wrap">
                    <span className="font-semibold text-foreground">
                      Topsoil Context (0–30 cm)
                    </span>
                    {adaptedSoil && (
                      adaptedSoil.source.toUpperCase().includes("SSURGO") ? (
                        <span className="rounded bg-emerald-50 px-1.5 py-0.5 text-[10px] font-medium text-emerald-800 border border-emerald-200">
                          Surveyed map unit
                        </span>
                      ) : adaptedSoil.source.includes("SoilGrids v2.0") &&
                        !adaptedSoil.source.toLowerCase().includes("fallback") ? (
                        <span className="rounded bg-blue-50 px-1.5 py-0.5 text-[10px] font-medium text-blue-800 border border-blue-200">
                          Modeled ~250 m grid
                        </span>
                      ) : (
                        <span className="rounded bg-amber-50 px-1.5 py-0.5 text-[10px] font-medium text-amber-800 border border-amber-200">
                          Regional estimate
                        </span>
                      )
                    )}
                  </div>
                  {adaptedSoil ? (
                    <p className="text-[11px] text-muted-foreground">
                      AWC: {soilAwc !== null ? `${soilAwc.toFixed(3)} cm/cm` : "—"} · OM:{" "}
                      {soilOm !== null ? `${soilOm.toFixed(1)}%` : "—"} · pH:{" "}
                      {soilPh !== null ? soilPh.toFixed(1) : "—"} · Drainage: {soilDrainage ?? "—"} · Slope:{" "}
                      {soilSlope !== null ? `${soilSlope.toFixed(1)}%` : "—"}
                      {soil?.mapUnit?.name
                        ? ` · ${soil.mapUnit.name.replace(
                            /^ISRIC SoilGrids v2\.0\s*\([^)]*\)\s*(?:—\s*)?/i,
                            "Modeled soil grid cell — "
                          ).replace(/Modeled soil grid cell — $/, "Modeled soil grid cell")}`
                        : ""}
                    </p>
                  ) : (
                    <p className="text-[11px] text-amber-800">
                      Soil profile data is unavailable for these coordinates.
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
                        .
                      </p>
                    </div>
                  )}
                </div>
              </div>
            </CardContent>
          </Card>

          {/* 2. Farmer Priority Sliders + Generate Field-Specific Plans Action */}
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
                  : "Select your priorities and adjust the sliders below, then generate field-specific 3-year crop rotation plans."}
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <PrioritySliders priorities={priorities} onChange={setPriorities} />

              <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 pt-3 border-t border-border/70">
                <p className="text-xs text-muted-foreground">
                  {hasGeneratedPlans
                    ? `SI-generated crop rotation plans are active for ${field.name}. You can regenerate plans at any time.`
                    : `Ready to design three 3-year crop rotation plans (${fieldObjectives.map((o) => o.name).join(", ")}) guided by your weights above.`}
                </p>

                <div className="flex items-center gap-2 shrink-0">
                  <Button
                    size="sm"
                    onClick={handleGenerate}
                    disabled={generating || availableCropIds.length === 0}
                    className={
                      hasGeneratedPlans
                        ? "bg-purple-600 hover:bg-purple-700 text-white"
                        : "bg-electric hover:bg-electric-dark text-white"
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

          {/* 3B. Before Generation: Display Strategy Planning Objectives */}
          {!hasGeneratedPlans && (
            <div className="space-y-3">
              <div>
                <h3 className="text-sm font-semibold text-foreground">
                  Planning Objectives for {field.name}
                </h3>
                <p className="text-xs text-muted-foreground">
                  Three agronomic focus areas tailored to your field&apos;s climate, topsoil properties, and priority weights.
                </p>
              </div>

              <div className="grid gap-4 lg:grid-cols-3">
                {fieldObjectives.map((obj) => {
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
                        <div className="flex items-start justify-between gap-2 flex-wrap">
                          <div className="flex items-center gap-2">
                            <span
                              className={`inline-flex h-7 w-7 items-center justify-center rounded-md shrink-0 ${badgeClass}`}
                            >
                              <Icon className="h-4 w-4" />
                            </span>
                            <CardTitle className="text-base font-semibold text-foreground leading-snug">
                              {obj.name}
                            </CardTitle>
                          </div>
                          <span
                            className={`inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium ${badgeClass}`}
                          >
                            {obj.emphasisTag}
                          </span>
                        </div>
                        <CardDescription className="text-xs leading-relaxed text-muted-foreground">
                          {obj.objective}
                        </CardDescription>
                      </CardHeader>
                      <CardContent className="flex-1 flex flex-col justify-between gap-3 pt-0">
                        <ul className="space-y-1.5 text-xs text-foreground/90">
                          {obj.bullets.map((b, i) => (
                            <li key={i} className="flex items-start gap-2 leading-snug">
                              <span className="mt-1.5 h-1.5 w-1.5 rounded-full bg-electric shrink-0" />
                              <span>{b}</span>
                            </li>
                          ))}
                        </ul>
                        {obj.recommendedCropNames.length > 0 && (
                          <div className="pt-2 border-t border-border/60 text-[11px] text-muted-foreground">
                            <span className="font-medium text-foreground">
                              Candidate field crops:
                            </span>{" "}
                            {obj.recommendedCropNames.join(", ")}
                          </div>
                        )}
                      </CardContent>
                    </Card>
                  );
                })}
              </div>
            </div>
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
            <div className="mt-3 space-y-2 border-t border-border/60 pt-3 leading-relaxed">
              <p>
                <strong className="text-foreground">Live Climate Data:</strong>{" "}
                <a
                  href="https://power.larc.nasa.gov/"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-electric hover:underline"
                >
                  {adaptedClimate.source}
                </a>{" "}
                ({adaptedClimate.spatialResolution}).{" "}
                {fieldClassification.reasons[0] ?? ""}
              </p>
              <p>
                <strong className="text-foreground">Topsoil Data:</strong>{" "}
                {adaptedSoil
                  ? adaptedSoil.source.toUpperCase().includes("SSURGO")
                    ? `${adaptedSoil.source} (${soilCoveragePct !== null ? `${soilCoveragePct.toFixed(0)}% map-unit coverage` : "0–30 cm depth-weighted survey"}) — live polygon soil survey.`
                    : adaptedSoil.source.includes("SoilGrids v2.0") &&
                      !adaptedSoil.source.toLowerCase().includes("fallback")
                    ? `${adaptedSoil.source} — live ~250 m modeled 0–30 cm topsoil predictions across 0–5, 5–15, and 15–30 cm layers (with OM derived from SOC × 1.724 and AWC from 33/1500 kPa retention; drainage and slope unmodeled).`
                    : `${adaptedSoil.source} — static macro-regional 0–30 cm topsoil reference estimate (used when coordinate-specific soil extraction is unavailable).`
                  : "Soil data unavailable for these coordinates."}
              </p>
              <p>
                <strong className="text-foreground">Crop Catalog, Validation &amp; Scoring:</strong>{" "}
                Verified crop traits (<code>data/crops.json</code>) cite USDA ARS/NASS, FAO, and university extension guides. Super Intelligence (SI) proposals arrange only verified crops for the{" "}
                <strong className="text-foreground">{formatAgGroupLabel(fieldClassification.group)}</strong>{" "}
                zone and must pass deterministic rotation compatibility rules before scoring. Classification confidence is{" "}
                <strong className="text-foreground">{fieldClassification.confidence}</strong>
                {fieldEvidence ? ` (${fieldEvidence.label})` : ""}. Suitability scores (0–100) are deterministic decision-support heuristics, not calibrated yield or economic predictions.{" "}
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
