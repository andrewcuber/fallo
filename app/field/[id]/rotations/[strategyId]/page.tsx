"use client";

import { useEffect, useState, useCallback } from "react";
import { useParams, useRouter } from "next/navigation";
import Link from "next/link";
import { useField } from "@/components/providers";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { StrategyDetail } from "@/components/rotation/strategy-detail";
import {
  StrategyResult,
  resolveScoredStrategyById,
} from "@/lib/rotation-scoring";
import { detectRegion } from "@/lib/region";
import { ArrowLeft, RotateCcw, AlertTriangle } from "lucide-react";

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

export default function StrategyDetailPage() {
  const params = useParams();
  const router = useRouter();
  const { fields, activeField, priorities, setActiveField, isLoaded } = useField();

  const [climate, setClimate] = useState<ClimateData | null>(null);
  const [soil, setSoil] = useState<SoilData | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fieldId = typeof params.id === "string" ? params.id : undefined;
  const strategyId = typeof params.strategyId === "string" ? params.strategyId : undefined;

  useEffect(() => {
    if (!isLoaded || !fieldId) return;
    const found = fields.find((f) => f.id === fieldId);
    if (found && (!activeField || activeField.id !== fieldId || activeField.generatedRotations !== found.generatedRotations)) {
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

  // Compute scores
  const [result, setResult] = useState<StrategyResult | null>(null);
  const regionTag = field ? detectRegion(field.lat, field.lon)?.tag ?? null : null;

  useEffect(() => {
    if (!strategyId || (!climate && !soil)) {
      setResult(null);
      return;
    }
    const adaptedClimate = adaptClimate(climate);
    if (!adaptedClimate) {
      setResult(null);
      return;
    }
    const adaptedSoil = adaptSoil(soil);
    const resolved = resolveScoredStrategyById(
      strategyId,
      field?.generatedRotations?.strategies,
      adaptedClimate,
      adaptedSoil,
      priorities,
      regionTag,
      field?.id
    );
    setResult(resolved);
  }, [climate, soil, strategyId, regionTag, priorities, field?.generatedRotations, field?.id]);

  if (!isLoaded) {
    return <DetailSkeleton />;
  }

  if (!field) {
    return (
      <div className="space-y-6">
        <div>
          <h2 className="text-2xl font-serif font-bold text-foreground">Strategy Detail</h2>
          <p className="text-muted-foreground mt-1 max-w-2xl">Field not found.</p>
        </div>
        <Button onClick={() => router.push("/fields/new")}>Create a Field</Button>
      </div>
    );
  }

  return (
    <div className="space-y-8">
      {/* Header */}
      <div className="space-y-2">
        <Link href={`/field/${field.id}/rotations`}>
          <Button variant="ghost" size="sm" className="text-xs text-muted-foreground hover:text-foreground">
            <ArrowLeft className="mr-1 h-4 w-4" />
            Back to Rotation Lab
          </Button>
        </Link>
        <h2 className="text-2xl font-serif font-bold text-foreground">
          {result?.strategy.name ?? "Strategy Detail"}
        </h2>
        <p className="text-muted-foreground max-w-2xl text-sm">
          {result?.strategy.description ?? "Loading strategy details..."}
        </p>
        <p className="text-xs text-muted-foreground">
          Coordinates: {field.lat.toFixed(4)}, {field.lon.toFixed(4)}
        </p>
      </div>

      {/* Loading */}
      {loading && <DetailSkeleton />}

      {/* Error */}
      {error && !loading && (
        <Card className="border-accent-red/20 bg-accent-red/5">
          <CardHeader className="pb-3">
            <CardTitle className="flex items-center gap-2 text-accent-red">
              <AlertTriangle className="h-5 w-5" />
              Could not load field data
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-accent-red/80 text-sm mb-4">{error}</p>
            <Button variant="outline" size="sm" onClick={fetchData} className="border-accent-red/30 text-accent-red hover:bg-accent-red/10">
              <RotateCcw className="mr-2 h-4 w-4" />
              Retry
            </Button>
          </CardContent>
        </Card>
      )}

      {/* Content */}
      {!loading && !error && result && (
        <StrategyDetail result={result} />
      )}

      {!loading && !error && !result && climate && (
        <Card className="border-dashed">
          <CardContent className="flex flex-col items-center justify-center py-16 text-center">
            <h3 className="text-lg font-serif font-semibold text-foreground">
              No AI-generated plan found
            </h3>
            <p className="mt-2 max-w-md text-muted-foreground text-sm">
              No AI-generated 3-year crop rotation plan was found for this field. Return to the Rotation Lab to generate field-specific plans.
            </p>
            <Link href={`/field/${field.id}/rotations`}>
              <Button variant="outline" size="sm" className="mt-4">
                <ArrowLeft className="mr-1 h-4 w-4" />
                Back to Rotation Lab
              </Button>
            </Link>
          </CardContent>
        </Card>
      )}
    </div>
  );
}

function DetailSkeleton() {
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
    </div>
  );
}
