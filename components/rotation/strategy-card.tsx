"use client";

import {
  StrategyResult,
  ClimateData,
  SoilData,
  buildStrategyOverviewBullets,
} from "@/lib/rotation-scoring";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { useParams } from "next/navigation";
import Link from "next/link";
import {
  AlertTriangle,
  ShieldAlert,
  CalendarDays,
  ArrowRight,
  Sparkles,
} from "lucide-react";

interface Props {
  result: StrategyResult;
  climate?: ClimateData | null;
  soil?: SoilData | null;
  loading?: boolean;
}

function firstSentence(text: string): string {
  const trimmed = text.trim();
  const match = trimmed.match(/^[^.!?]+[.!?]/);
  return match ? match[0].trim() : trimmed;
}

function OverallScoreBadge({ score, fitLabel }: { score: number | null; fitLabel: string }) {
  if (score === null) {
    return (
      <div className="inline-flex items-center gap-1.5 rounded-lg bg-muted px-3 py-1.5 text-sm">
        <span className="text-muted-foreground">Score unavailable</span>
      </div>
    );
  }

  const color =
    score >= 70
      ? "text-emerald-700 bg-emerald-50 border border-emerald-200"
      : score >= 50
      ? "text-amber-700 bg-amber-50 border border-amber-200"
      : "text-accent-red bg-accent-red/5 border border-accent-red/20";

  return (
    <div className={`inline-flex flex-col items-end gap-0.5 rounded-lg px-3 py-1.5 shrink-0 ${color}`}>
      <div className="flex items-baseline gap-1">
        <span className="tabular-nums font-bold text-lg leading-none">{score}</span>
        <span className="text-xs opacity-80">/ 100</span>
      </div>
      <span className="text-[10px] font-semibold uppercase tracking-wide opacity-90">{fitLabel}</span>
    </div>
  );
}

export function StrategyCard({ result, climate, soil, loading }: Props) {
  const params = useParams();
  const fieldId = typeof params.id === "string" ? params.id : undefined;
  const { strategy, overallScore, overallCoverage, overallFitLabel, rank, availableWeightPercent } = result;

  if (loading) {
    return <StrategyCardSkeleton />;
  }

  const warnings = strategy.tradeoffs.warnings.map((w) =>
    typeof w === "string"
      ? { severity: "moderate" as const, text: w }
      : (w as { severity: "high" | "moderate"; text: string })
  );

  // Pick the single most important warning (high severity first)
  const primaryWarning =
    warnings.find((w) => w.severity === "high") ?? warnings[0] ?? null;

  const bullets = buildStrategyOverviewBullets(strategy, climate, soil);
  const conciseObjective = firstSentence(strategy.description);

  return (
    <Card className="h-full flex flex-col" id={`strategy-${strategy.id}`}>
      <CardHeader className="pb-3 space-y-2.5">
        <div className="flex items-start justify-between gap-3">
          <div className="space-y-1.5 flex-1 min-w-0">
            <div className="flex items-center gap-2">
              <span className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-electric/10 text-xs font-bold text-electric">
                {rank}
              </span>
              <CardTitle className="text-base font-semibold text-foreground leading-snug">
                {strategy.name}
              </CardTitle>
            </div>

            <div className="flex items-center gap-1.5 flex-wrap">
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

              {strategy.generationInfo?.source === "ai-assisted" && (
                <span className="inline-flex items-center gap-1 rounded bg-purple-50 px-1.5 py-0.5 text-[10px] font-medium text-purple-700 border border-purple-100">
                  <Sparkles className="h-3 w-3" />
                  Field-specific
                </span>
              )}
            </div>
          </div>

          <OverallScoreBadge score={overallScore} fitLabel={overallFitLabel} />
        </div>

        {/* One-sentence objective */}
        <CardDescription className="text-xs leading-relaxed text-muted-foreground">
          {conciseObjective}
        </CardDescription>

        {overallScore !== null && availableWeightPercent < 100 && (
          <p className="text-[11px] text-amber-600">
            Score uses {availableWeightPercent}% of weighted factors due to missing inputs.
          </p>
        )}
      </CardHeader>

      <CardContent className="flex-1 flex flex-col justify-between gap-3.5 pt-0">
        <div className="space-y-3">
          {/* 2–3 short bullet points */}
          <ul className="space-y-1.5 text-xs text-foreground/90">
            {bullets.map((bullet, idx) => (
              <li key={idx} className="flex items-start gap-2 leading-snug">
                <span className="mt-1.5 h-1.5 w-1.5 rounded-full bg-electric shrink-0" />
                <span>{bullet}</span>
              </li>
            ))}
          </ul>

          {/* Single important warning when relevant */}
          {primaryWarning && (
            <div
              className={`flex items-start gap-1.5 rounded-md px-2.5 py-1.5 text-[11px] leading-snug ${
                primaryWarning.severity === "high"
                  ? "bg-accent-red/5 text-accent-red border border-accent-red/15"
                  : "bg-amber-50 text-amber-800 border border-amber-200/60"
              }`}
            >
              {primaryWarning.severity === "high" ? (
                <ShieldAlert className="h-3.5 w-3.5 shrink-0 mt-0.5" />
              ) : (
                <AlertTriangle className="h-3.5 w-3.5 shrink-0 mt-0.5" />
              )}
              <span>{firstSentence(primaryWarning.text)}</span>
            </div>
          )}
        </div>

        {fieldId && (
          <Link
            href={`/field/${fieldId}/rotations/${strategy.id}`}
            className="inline-flex items-center justify-center gap-1.5 whitespace-nowrap rounded-md border border-input bg-background px-3 py-2 text-xs font-medium shadow-sm transition-colors hover:bg-accent hover:text-accent-foreground h-8 w-full mt-auto"
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
            <Skeleton className="h-5 w-44" />
            <Skeleton className="h-3 w-28" />
            <Skeleton className="h-3 w-full" />
          </div>
          <Skeleton className="h-10 w-20 rounded-lg" />
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        {Array.from({ length: 3 }).map((_, i) => (
          <Skeleton key={i} className="h-3.5 w-full" />
        ))}
        <Skeleton className="h-8 w-full mt-4 rounded-md" />
      </CardContent>
    </Card>
  );
}
