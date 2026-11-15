"use client";

import { StrategyResult, FactorKey, FACTOR_LABELS } from "@/lib/rotation-scoring";

interface Props {
  results: StrategyResult[];
}

const FACTOR_ORDER: FactorKey[] = [
  "waterSuitability",
  "nitrogenContribution",
  "soilCoverage",
  "diversityPestBreak",
  "climateRiskResilience",
];

function barColor(score: number | null): string {
  if (score === null) return "bg-muted";
  if (score >= 70) return "bg-emerald-500";
  if (score >= 50) return "bg-amber-500";
  return "bg-accent-red";
}

export function FactorComparison({ results }: Props) {
  if (results.length === 0) return null;

  // Header colors for each strategy (consistent across rows)
  const headerColors = ["bg-electric/10 text-electric", "bg-cyan/10 text-cyan", "bg-amber-500/10 text-amber-600"];

  return (
    <div className="overflow-x-auto -mx-4 px-4">
      <table className="w-full text-sm border-collapse min-w-[640px]">
        <thead>
          <tr className="border-b border-border">
            <th className="text-left py-2.5 pr-4 font-medium text-muted-foreground w-40">Factor</th>
            {results.map((r, i) => (
              <th key={r.strategy.id} className="text-left py-2.5 px-3 font-medium min-w-[140px]">
                <div className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-semibold ${headerColors[i] || "bg-muted text-muted-foreground"}`}>
                  <span className="inline-flex h-4 w-4 items-center justify-center rounded-full bg-white/60 text-[10px]">
                    {r.rank}
                  </span>
                  {r.strategy.name.split(" ").slice(0, 2).join(" ")}
                </div>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {FACTOR_ORDER.map((key) => (
            <tr key={key} className="border-b border-border/50">
              <td className="py-3 pr-4 text-foreground font-medium text-xs">{FACTOR_LABELS[key]}</td>
              {results.map((r) => {
                const score = r.factorScores[key].score;
                return (
                  <td key={`${r.strategy.id}-${key}`} className="py-2 px-3">
                    <div className="space-y-1">
                      <div className="flex items-center justify-between text-xs">
                        <span className="tabular-nums font-semibold text-foreground">
                          {score !== null ? score : "—"}
                        </span>
                        <span className="text-[10px] text-muted-foreground">/100</span>
                      </div>
                      <div className="h-2 w-full rounded-full bg-muted overflow-hidden">
                        <div
                          className={`h-full rounded-full ${barColor(score)} transition-all duration-500`}
                          style={{ width: score !== null ? `${score}%` : "0%" }}
                        />
                      </div>
                    </div>
                  </td>
                );
              })}
            </tr>
          ))}
          {/* Overall row */}
          <tr className="border-b border-border bg-muted/20">
            <td className="py-3 pr-4 text-foreground font-bold text-xs">Overall</td>
            {results.map((r) => (
              <td key={`${r.strategy.id}-overall`} className="py-2 px-3">
                <div className="space-y-1.5">
                  <div className="flex items-center justify-between text-xs">
                    <span className="tabular-nums font-bold text-foreground">
                      {r.overallScore !== null ? r.overallScore : "—"}
                    </span>
                    <span
                      className={`text-[10px] font-semibold uppercase tracking-wide px-1.5 py-0.5 rounded border ${
                        r.overallFitLabel === "Strong fit"
                          ? "bg-emerald-50 text-emerald-700 border-emerald-200"
                          : r.overallFitLabel === "Moderate fit"
                          ? "bg-amber-50 text-amber-700 border-amber-200"
                          : r.overallFitLabel === "Weak fit"
                          ? "bg-red-50 text-red-700 border-red-200"
                          : "bg-muted text-muted-foreground border-border"
                      }`}
                    >
                      {r.overallFitLabel}
                    </span>
                  </div>
                  <div className="flex items-center gap-1.5">
                    <span
                      className={`inline-block h-1.5 w-1.5 rounded-full ${
                        r.overallCoverage === "Good"
                          ? "bg-emerald-500"
                          : r.overallCoverage === "Partial"
                          ? "bg-amber-500"
                          : "bg-red-500"
                      }`}
                      title={`Data coverage: ${r.overallCoverage}`}
                    />
                    <span className="text-[9px] text-muted-foreground uppercase tracking-wide">
                      Coverage: {r.overallCoverage}
                    </span>
                  </div>
                  <div className="h-2.5 w-full rounded-full bg-muted overflow-hidden">
                    <div
                      className={`h-full rounded-full ${barColor(r.overallScore)} transition-all duration-500`}
                      style={{ width: r.overallScore !== null ? `${r.overallScore}%` : "0%" }}
                    />
                  </div>
                </div>
              </td>
            ))}
          </tr>
        </tbody>
      </table>
    </div>
  );
}
