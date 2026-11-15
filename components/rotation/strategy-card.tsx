"use client";

import { StrategyResult, FactorKey, FACTOR_LABELS } from "@/lib/rotation-scoring";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { RotationTimeline } from "./rotation-timeline";
import { useParams } from "next/navigation";
import Link from "next/link";
import {
  Trophy,
  AlertTriangle,
  ShieldAlert,
  Info,
  CalendarDays,
  ArrowRight,
  Sparkles,
} from "lucide-react";

interface Props {
  result: StrategyResult;
  loading?: boolean;
}

function ScoreBar({ score, label }: { score: number | null; label: string }) {
  const width = score !== null ? `${score}%` : "0%";
  const color = score !== null
    ? score >= 70
      ? "bg-emerald-500"
      : score >= 50
      ? "bg-amber-500"
      : "bg-accent-red"
    : "bg-muted";

  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between text-xs">
        <span className="text-muted-foreground">{label}</span>
        <span className="tabular-nums font-medium text-foreground">
          {score !== null ? score : "—"}/100
        </span>
      </div>
      <div className="h-2 w-full rounded-full bg-muted overflow-hidden">
        <div className={`h-full rounded-full ${color} transition-all duration-500`} style={{ width }} />
      </div>
    </div>
  );
}

function OverallScoreBadge({ score, fitLabel }: { score: number | null; fitLabel: string }) {
  if (score === null) {
    return (
      <div className="inline-flex items-center gap-1.5 rounded-lg bg-muted px-3 py-1.5 text-sm">
        <span className="text-muted-foreground">Score unavailable</span>
      </div>
    );
  }

  const color = score >= 70 ? "text-emerald-700 bg-emerald-50 border border-emerald-200" : score >= 50 ? "text-amber-700 bg-amber-50 border border-amber-200" : "text-accent-red bg-accent-red/5 border border-accent-red/20";

  return (
    <div className={`inline-flex flex-col items-end gap-0.5 rounded-lg px-3 py-1.5 ${color}`}>
      <div className="flex items-center gap-2">
        <Trophy className="h-4 w-4" />
        <span className="tabular-nums font-bold text-lg">{score}</span>
        <span className="text-xs opacity-80">/ 100</span>
      </div>
      <span className="text-[10px] font-semibold uppercase tracking-wide opacity-90">{fitLabel}</span>
    </div>
  );
}

export function StrategyCard({ result, loading }: Props) {
  const params = useParams();
  const fieldId = typeof params.id === "string" ? params.id : undefined;
  const { strategy, factorScores, overallScore, overallCoverage, overallFitLabel, rank, availableWeightPercent } = result;

  // Warnings processing
  const warnings = strategy.tradeoffs.warnings.map((w) =>
    typeof w === "string" ? { severity: "moderate" as const, text: w } : (w as { severity: "high" | "moderate"; text: string })
  );

  if (loading) {
    return <StrategyCardSkeleton />;
  }

  const factorOrder: FactorKey[] = [
    "waterSuitability",
    "nitrogenContribution",
    "soilCoverage",
    "diversityPestBreak",
    "climateRiskResilience",
  ];

  return (
    <Card className="h-full flex flex-col" id={`strategy-${strategy.id}`}>
      <CardHeader className="pb-3 space-y-0">
        <div className="flex items-start justify-between gap-3">
          <div className="space-y-1 flex-1">
            <div className="flex items-center gap-2">
              <span className="inline-flex h-6 w-6 items-center justify-center rounded-full bg-electric/10 text-xs font-bold text-electric">
                {rank}
              </span>
              <CardTitle className="text-base font-semibold text-foreground">{strategy.name}</CardTitle>
            </div>
            <div className="flex items-center gap-1.5 flex-wrap">
              {strategy.archetype && (
                <span className="inline-flex items-center rounded bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground uppercase tracking-wide">
                  {strategy.archetype.replace(/_/g, " ")}
                </span>
              )}
              {strategy.generationInfo?.source === "ai-assisted" && (
                <span className="inline-flex items-center gap-1 rounded bg-purple-50 px-1.5 py-0.5 text-[10px] font-medium text-purple-700 border border-purple-100">
                  <Sparkles className="h-3 w-3" />
                  AI-assisted
                </span>
              )}
              {strategy.generationInfo?.supportStatus === "unavailable" && (
                <span className="inline-flex items-center rounded bg-red-50 px-1.5 py-0.5 text-[10px] font-medium text-red-700 border border-red-100">
                  Unavailable
                </span>
              )}
            </div>
            <CardDescription className="text-xs leading-relaxed max-w-prose">
              {strategy.description}
            </CardDescription>
            {strategy.regionExample && (
              <p className="text-[11px] text-muted-foreground flex items-start gap-1">
                <Info className="h-3.5 w-3.5 shrink-0 mt-0.5" />
                <span><strong>Regional example:</strong> {strategy.regionExample}</span>
              </p>
            )}
          </div>
          <OverallScoreBadge score={overallScore} fitLabel={overallFitLabel} />
        </div>

        {/* Data coverage tag — separate from score fit */}
        <div className="flex items-center gap-2 mt-1">
          <span
            className={`inline-flex items-center rounded px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide ${
              overallCoverage === "Good"
                ? "bg-emerald-50 text-emerald-700 border border-emerald-100"
                : overallCoverage === "Partial"
                ? "bg-amber-50 text-amber-700 border border-amber-100"
                : "bg-red-50 text-red-700 border border-red-100"
            }`}
            title="Reflects data completeness, not agronomic certainty"
          >
            Data coverage: {overallCoverage}
          </span>
        </div>

        {overallScore !== null && availableWeightPercent < 100 && (
          <p className="text-[11px] text-amber-600 mt-1">
            Score based on {availableWeightPercent}% of weighted factors due to unavailable data.
          </p>
        )}

      </CardHeader>

      <CardContent className="flex-1 space-y-4">
        {/* Factor Scores */}
        <div className="space-y-2">
          {factorOrder.map((key) => (
            <ScoreBar key={key} score={factorScores[key].score} label={FACTOR_LABELS[key]} />
          ))}
        </div>

        {/* Timeline */}
        <RotationTimeline strategy={strategy} />

        {/* Warnings */}
        {warnings.length > 0 && (
          <div className="space-y-1.5">
            {warnings.slice(0, 2).map((w, i) => (
              <div
                key={i}
                className={`flex items-start gap-1.5 rounded-md px-2 py-1 text-[11px] ${
                  w.severity === "high"
                    ? "bg-accent-red/5 text-accent-red"
                    : "bg-amber-50 text-amber-700"
                }`}
              >
                {w.severity === "high" ? (
                  <ShieldAlert className="h-3.5 w-3.5 shrink-0 mt-0.5" />
                ) : (
                  <AlertTriangle className="h-3.5 w-3.5 shrink-0 mt-0.5" />
                )}
                <span>{w.text}</span>
              </div>
            ))}
            {warnings.length > 2 && (
              <p className="text-[10px] text-muted-foreground">
                +{warnings.length - 2} more warning{warnings.length > 3 ? "s" : ""}
              </p>
            )}
          </div>
        )}

        {fieldId && (
          <Link
            href={`/field/${fieldId}/rotations/${strategy.id}`}
            className="inline-flex items-center justify-center gap-1.5 whitespace-nowrap rounded-md border border-input bg-background px-3 py-2 text-xs font-medium shadow-sm transition-colors hover:bg-accent hover:text-accent-foreground h-8 w-full"
          >
            <CalendarDays className="h-3.5 w-3.5" />
            View 3-year plan
            <ArrowRight className="h-3.5 w-3.5" />
          </Link>
        )}
      </CardContent>
    </Card>
  );
}

function StrategyCardSkeleton() {
  return (
    <Card className="h-full">
      <CardHeader className="pb-3">
        <div className="flex items-start justify-between gap-3">
          <div className="space-y-2 flex-1">
            <Skeleton className="h-5 w-48" />
            <Skeleton className="h-3 w-full" />
            <Skeleton className="h-3 w-2/3" />
          </div>
          <Skeleton className="h-9 w-24 rounded-lg" />
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {Array.from({ length: 5 }).map((_, i) => (
          <div key={i} className="space-y-1">
            <Skeleton className="h-3 w-32" />
            <Skeleton className="h-2 w-full rounded-full" />
          </div>
        ))}
        <Skeleton className="h-3 w-full mt-4" />
      </CardContent>
    </Card>
  );
}
