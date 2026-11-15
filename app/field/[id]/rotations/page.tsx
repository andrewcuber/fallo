"use client";

import { useEffect, useState, useCallback } from "react";
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
  StrategyCard,
} from "@/components/rotation/strategy-card";
import { PrioritySliders } from "@/components/rotation/priority-sliders";
import { FactorComparison } from "@/components/rotation/factor-comparison";
import {
  StrategyResult,
  FarmerPriorities,
  DEFAULT_PRIORITIES,
  scoreAllStrategies,
  scoreStrategy,
} from "@/lib/rotation-scoring";
import { type GenerationResult } from "@/lib/rotation-generator";

import {
  RefreshCw,
  AlertTriangle,
  RotateCcw,
  BarChart3,
  SlidersHorizontal,
  Globe,
  Sparkles,
  Info,
} from "lucide-react";
import { detectRegion, isSupportedRegion } from "@/lib/region";

// re-use types from climate API (must match route.ts exactly)
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
    limitations: [
      data.spatialResolution,
      ...data.warnings,
    ],
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
  const { fields, activeField, setActiveField, setFieldRotations, isLoaded } = useField();

  const [climate, setClimate] = useState<ClimateData | null>(null);
  const [soil, setSoil] = useState<SoilData | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [priorities, setPriorities] = useState<FarmerPriorities>({ ...DEFAULT_PRIORITIES });
  const [generating, setGenerating] = useState(false);
  const [generateError, setGenerateError] = useState<string | null>(null);
  const [generationStatus, setGenerationStatus] = useState<string | null>(null);

  const fieldId = typeof params.id === "string" ? params.id : undefined;

  useEffect(() => {
    if (!isLoaded || !fieldId) return;
    if (!activeField || activeField.id !== fieldId) {
      const found = fields.find((f) => f.id === fieldId);
      if (found) setActiveField(found);
    }
  }, [isLoaded, fieldId, activeField, fields, setActiveField]);

  const field = activeField ?? (fieldId ? fields.find((f) => f.id === fieldId) : undefined);

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
        // Non-fatal: we can still score without soil data
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

  // Compute scores when data or priorities change
  const [results, setResults] = useState<StrategyResult[]>([]);
  const regionTag = field ? detectRegion(field.lat, field.lon)?.tag ?? null : null;
  const isSupported = isSupportedRegion(field?.lat ?? 0, field?.lon ?? 0);

  useEffect(() => {
    if (!climate && !soil) {
      setResults([]);
      return;
    }
    const adaptedClimate = adaptClimate(climate);
    if (!adaptedClimate) {
      setResults([]);
      return;
    }
    const adaptedSoil = adaptSoil(soil);
    const staticResults = scoreAllStrategies(adaptedClimate, adaptedSoil, priorities, regionTag);

    // Re-score any persisted generated strategies with current priorities locally
    const generatedStrategies = field?.generatedRotations?.strategies ?? [];
    const generatedResults = generatedStrategies.map((s) =>
      scoreStrategy(s, adaptedClimate, adaptedSoil, priorities, regionTag)
    );

    const all = [...generatedResults, ...staticResults];
    // Re-rank after merge
    all.forEach((r, i) => {
      r.rank = i + 1;
    });
    setResults(all);
  }, [climate, soil, priorities, regionTag, field?.generatedRotations]);

  const handleGenerate = useCallback(async () => {
    if (!field || !climate) return;
    setGenerating(true);
    setGenerateError(null);
    setGenerationStatus(null);
    try {
      const adaptedClimate = adaptClimate(climate);
      const adaptedSoil = adaptSoil(soil);
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
      if (!res.ok) {
        setGenerateError(data.message ?? `Generation failed (${res.status})`);
        setGenerationStatus(data.supportStatus ?? "unavailable");
        return;
      }
      if (data.proposals.length === 0) {
        setGenerationStatus(data.supportStatus ?? "limited-evidence");
        setGenerateError(data.aiUnavailableReason ?? "No proposals were generated.");
        return;
      }
      // Persist raw strategies so priority changes re-score locally
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
  }, [field, climate, soil, priorities, regionTag, setFieldRotations]);

  if (!isLoaded) {
    return <RotationsSkeleton />;
  }

  if (!field) {
    return (
      <div className="space-y-6">
        <div>
          <h2 className="text-2xl font-serif font-bold text-foreground">Rotation Lab</h2>
          <p className="text-muted-foreground mt-1 max-w-2xl">
            Field not found. Create a field to compare rotation strategies.
          </p>
        </div>
        <Button onClick={() => router.push("/fields/new")}>Create a Field</Button>
      </div>
    );
  }

  return (
    <div className="space-y-8">
      {/* Header */}
      <div className="space-y-1">
        <h2 className="text-2xl font-serif font-bold text-foreground">Rotation Lab</h2>
        <p className="text-muted-foreground max-w-2xl">
          Compare three rotation strategies scored against your field&apos;s climate and soil data.
        </p>
        <p className="text-xs text-muted-foreground">
          Coordinates: {field.lat.toFixed(4)}, {field.lon.toFixed(4)}
        </p>
      </div>

      {/* Loading */}
      {loading && <RotationsSkeleton />}

      {/* Error */}
      {error && !loading && (
        <Card className="border-accent-red/20 bg-accent-red/5">
          <CardHeader className="pb-3">
            <CardTitle className="flex items-center gap-2 text-accent-red">
              <AlertTriangle className="h-5 w-5" />
              Could not load field data
            </CardTitle>
            <CardDescription className="text-accent-red/80">{error}</CardDescription>
          </CardHeader>
          <CardContent>
            <Button variant="outline" size="sm" onClick={fetchData} className="border-accent-red/30 text-accent-red hover:bg-accent-red/10">
              <RotateCcw className="mr-2 h-4 w-4" />
              Retry
            </Button>
          </CardContent>
        </Card>
      )}

      {/* Content */}
      {!loading && !error && results.length > 0 && (
        <>
          {/* AI Generation Panel */}
          <Card className={field.generatedRotations ? "border-purple-200 bg-purple-50/30" : "border-dashed"}>
            <CardHeader className="pb-2">
              <div className="flex items-center gap-2">
                <Sparkles className={`h-4 w-4 ${field.generatedRotations ? "text-purple-600" : "text-electric"}`} />
                <CardTitle className="text-sm font-semibold text-foreground">
                  {field.generatedRotations ? "AI-Assisted Plans" : "Generate custom rotations"}
                </CardTitle>
              </div>
              <CardDescription className="text-xs">
                {field.generatedRotations
                  ? `Generated ${new Date(field.generatedRotations.generatedAt).toLocaleDateString()} for group "${field.generatedRotations.agGroup}".`
                  : "Request AI-assisted rotation proposals tailored to this field's climate and soil. The deterministic validator scores every proposal before display."}
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              {!field.generatedRotations && (
                <div className="flex items-start gap-2 rounded-md bg-muted/40 p-2.5 text-[11px] text-muted-foreground">
                  <Info className="h-3.5 w-3.5 shrink-0 mt-0.5" />
                  <span>
                    AI generation requires a separate runtime provider (e.g., OpenAI) configured via environment variables.
                    Without a provider, the app works fully with static archetype strategies.
                  </span>
                </div>
              )}
              {generateError && (
                <div className="rounded-md bg-red-50 px-3 py-2 text-[11px] text-red-700 border border-red-100">
                  {generateError}
                </div>
              )}
              {generationStatus && !generateError && (
                <div className="rounded-md bg-emerald-50 px-3 py-2 text-[11px] text-emerald-700 border border-emerald-100">
                  Status: {generationStatus === "supported" ? "Supported — proposals generated and validated." : generationStatus === "limited-evidence" ? "Limited evidence — proposals generated but classification confidence is moderate." : "Unavailable — could not generate proposals."}
                </div>
              )}
              <div className="flex items-center gap-2">
                <Button
                  size="sm"
                  onClick={handleGenerate}
                  disabled={generating || !climate}
                  className={field.generatedRotations ? "bg-purple-600 hover:bg-purple-700 text-white" : ""}
                >
                  {generating ? (
                    <>
                      <RefreshCw className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                      Generating...
                    </>
                  ) : field.generatedRotations ? (
                    <>
                      <Sparkles className="mr-1.5 h-3.5 w-3.5" />
                      Regenerate
                    </>
                  ) : (
                    <>
                      <Sparkles className="mr-1.5 h-3.5 w-3.5" />
                      Generate AI-assisted rotations
                    </>
                  )}
                </Button>
                {field.generatedRotations && (
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => {
                      setFieldRotations(field.id, null);
                      setGenerateError(null);
                      setGenerationStatus(null);
                    }}
                  >
                    Clear
                  </Button>
                )}
              </div>
            </CardContent>
          </Card>

          {/* Priority Controls */}
          <Card>
            <CardHeader className="pb-2">
              <div className="flex items-center gap-2">
                <SlidersHorizontal className="h-4 w-4 text-electric" />
                <CardTitle className="text-sm font-semibold text-foreground">Adjust your priorities</CardTitle>
              </div>
              <CardDescription className="text-xs">
                Change the sliders to emphasize what matters most for your operation. Scores recalculate instantly.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <PrioritySliders priorities={priorities} onChange={setPriorities} />
            </CardContent>
          </Card>

          {/* Strategy Cards */}
          {!isSupported && field && (
            <Card className="border-amber-200 bg-amber-50/50">
              <CardHeader className="pb-2">
                <CardTitle className="flex items-center gap-2 text-amber-800 text-sm">
                  <Globe className="h-4 w-4" />
                  Region not yet supported
                </CardTitle>
                <CardDescription className="text-xs text-amber-700/80">
                  Your field is outside the regions where we have verified crop data (US Southeast, Midwest, Northeast, Great Plains, Southwest).
                  You can still browse the strategies below, but they are shown as archetype examples only.
                  Replace crops with locally adapted alternatives that match the same functional roles (legume cover, drought-tolerant cash crop, etc.).
                </CardDescription>
              </CardHeader>
            </Card>
          )}
          <div className="grid gap-4 lg:grid-cols-3">
            {results.map((result) => (
              <StrategyCard key={result.strategy.id} result={result} />
            ))}
          </div>

          {/* Comparison Table */}
          <Card>
            <CardHeader className="pb-2">
              <div className="flex items-center gap-2">
                <BarChart3 className="h-4 w-4 text-electric" />
                <CardTitle className="text-sm font-semibold text-foreground">Factor comparison</CardTitle>
              </div>
              <CardDescription className="text-xs">
                Side-by-side view of every factor across all strategies.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <FactorComparison results={results} />
            </CardContent>
          </Card>

          {/* Scoring Disclaimer */}
          <div className="rounded-lg border border-border bg-muted/40 p-4 space-y-2">
            <h3 className="text-xs font-semibold text-foreground">About these scores</h3>
            <p className="text-xs text-muted-foreground leading-relaxed">
              All scores are <strong>decision-support heuristics</strong> (0–100), not validated crop yield predictions.
              They are computed from regional climate summaries (NASA POWER, ~55 km grid) and soil map-unit averages
              (SSURGO/SoilGrids), not field-level measurements. Scores incorporate documented agronomic principles
              such as legume nitrogen credits, crop drought tolerance, disease-sequence risks, and soil coverage
              metrics—but they cannot replace local expertise, soil testing, or on-farm observation.
            </p>
            <p className="text-xs text-muted-foreground leading-relaxed">
              Data coverage labels reflect data availability, not agronomic certainty. A &quot;Good&quot; coverage score
              simply means all required data inputs were available; it does not guarantee success.
            </p>
          </div>
        </>
      )}

      {/* Not ready state (no data yet but not loading/error) */}
      {!loading && !error && results.length === 0 && climate && (
        <Card className="border-dashed">
          <CardContent className="flex flex-col items-center justify-center py-16 text-center">
            <div className="mb-4 inline-flex h-12 w-12 items-center justify-center rounded-full bg-electric/10">
              <RefreshCw className="h-6 w-6 text-electric" />
            </div>
            <h3 className="text-lg font-serif font-semibold text-foreground">Scoring data incomplete</h3>
            <p className="mt-2 max-w-md text-muted-foreground">
              Climate or soil data is missing required fields for scoring. Check the raw responses and try again.
            </p>
            <Button variant="outline" size="sm" onClick={fetchData} className="mt-4">
              Retry
            </Button>
          </CardContent>
        </Card>
      )}
    </div>
  );
}

function RotationsSkeleton() {
  return (
    <div className="space-y-8">
      <div className="space-y-2">
        <Skeleton className="h-8 w-56" />
        <Skeleton className="h-4 w-96" />
      </div>
      <Card>
        <CardHeader className="pb-2">
          <Skeleton className="h-5 w-40" />
        </CardHeader>
        <CardContent className="space-y-4">
          {Array.from({ length: 5 }).map((_, i) => (
            <div key={i} className="space-y-1">
              <Skeleton className="h-3 w-40" />
              <Skeleton className="h-2 w-full rounded-full" />
            </div>
          ))}
        </CardContent>
      </Card>
      <div className="grid gap-4 lg:grid-cols-3">
        {Array.from({ length: 3 }).map((_, i) => (
          <Card key={i} className="h-full">
            <CardHeader className="pb-3">
              <div className="flex items-start justify-between gap-3">
                <div className="space-y-2 flex-1">
                  <Skeleton className="h-5 w-48" />
                  <Skeleton className="h-3 w-full" />
                </div>
                <Skeleton className="h-9 w-24 rounded-lg" />
              </div>
            </CardHeader>
            <CardContent className="space-y-4">
              {Array.from({ length: 5 }).map((__, j) => (
                <div key={j} className="space-y-1">
                  <Skeleton className="h-3 w-32" />
                  <Skeleton className="h-2 w-full rounded-full" />
                </div>
              ))}
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  );
}
