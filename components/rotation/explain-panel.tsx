"use client";

import { StrategyResult, FactorKey, FACTOR_LABELS } from "@/lib/rotation-scoring";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ChevronDown, ChevronUp, BookOpen } from "lucide-react";
import { useState } from "react";

interface Props {
  factorScores: StrategyResult["factorScores"];
  strategy: StrategyResult["strategy"];
}

function FactorDetail({ factorKey, score }: { factorKey: FactorKey; score: StrategyResult["factorScores"][FactorKey] }) {
  const [open, setOpen] = useState(false);

  return (
    <div className="rounded-lg border border-border overflow-hidden">
      <button
        onClick={() => setOpen(!open)}
        className="flex items-center justify-between w-full px-3 py-2.5 text-left hover:bg-muted/50 transition-colors"
      >
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium text-foreground">{FACTOR_LABELS[factorKey]}</span>
          <span className="text-xs tabular-nums text-muted-foreground">
            {score.score !== null ? `${score.score}/100` : "unavailable"}
          </span>
          <span
            className={`text-[10px] uppercase tracking-wide px-1.5 py-0.5 rounded ${
              score.coverage === "Good"
                ? "bg-emerald-50 text-emerald-700"
                : score.coverage === "Partial"
                ? "bg-amber-50 text-amber-700"
                : "bg-red-50 text-red-700"
            }`}
          >
            {score.coverage}
          </span>
        </div>
        {open ? <ChevronUp className="h-4 w-4 text-muted-foreground" /> : <ChevronDown className="h-4 w-4 text-muted-foreground" />}
      </button>

      {open && (
        <div className="px-3 pb-3 space-y-3 border-t border-border/50 bg-muted/20">
          <p className="text-xs text-foreground mt-2">{score.interpretation}</p>

          {score.inputsUsed.length > 0 && (
            <div>
              <p className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground mb-1">Inputs used</p>
              <ul className="space-y-0.5">
                {score.inputsUsed.map((input, i) => (
                  <li key={i} className="text-[11px] text-muted-foreground">• {input}</li>
                ))}
              </ul>
            </div>
          )}

          {score.positiveContributors.length > 0 && (
            <div>
              <p className="text-[10px] font-semibold uppercase tracking-wide text-emerald-700 mb-1">Positive contributors</p>
              <ul className="space-y-0.5">
                {score.positiveContributors.map((pos, i) => (
                  <li key={i} className="text-[11px] text-emerald-700/90">+ {pos}</li>
                ))}
              </ul>
            </div>
          )}

          {score.negativeContributors.length > 0 && (
            <div>
              <p className="text-[10px] font-semibold uppercase tracking-wide text-accent-red/80 mb-1">Concerns</p>
              <ul className="space-y-0.5">
                {score.negativeContributors.map((neg, i) => (
                  <li key={i} className="text-[11px] text-accent-red/70">− {neg}</li>
                ))}
              </ul>
            </div>
          )}

          {score.dataCoverageLimitations.length > 0 && (
            <div>
              <p className="text-[10px] font-semibold uppercase tracking-wide text-amber-700 mb-1">Coverage notes</p>
              <ul className="space-y-0.5">
                {score.dataCoverageLimitations.map((lim, i) => (
                  <li key={i} className="text-[11px] text-amber-700/80">• {lim}</li>
                ))}
              </ul>
            </div>
          )}

          <div>
            <p className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground mb-1">Rubric</p>
            <p className="text-[11px] text-muted-foreground leading-relaxed">{score.rubric}</p>
          </div>

          {score.citations.length > 0 && (
            <div>
              <p className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground mb-1 flex items-center gap-1">
                <BookOpen className="h-3 w-3" />
                Citations
              </p>
              <ul className="space-y-0.5">
                {score.citations.map((cite, i) => (
                  <li key={i} className="text-[11px]">
                    {cite.url ? (
                      <a
                        href={cite.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-electric hover:underline underline-offset-2"
                      >
                        {cite.text}
                      </a>
                    ) : (
                      <span className="text-muted-foreground">{cite.text}</span>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export function ExplainPanel({ factorScores, strategy }: Props) {
  const keys: FactorKey[] = [
    "waterSuitability",
    "nitrogenContribution",
    "soilCoverage",
    "diversityPestBreak",
    "climateRiskResilience",
  ];

  return (
    <div className="space-y-3">
      <div>
        <p className="text-sm font-semibold text-foreground">How the scores work</p>
        <p className="text-xs text-muted-foreground mt-0.5">
          These are decision-support heuristics, not validated yield predictions. Expand each factor for the full rubric.
        </p>
      </div>

      {keys.map((key) => (
        <FactorDetail key={key} factorKey={key} score={factorScores[key]} />
      ))}

      {/* Rotation tradeoffs */}
      <Card className="border-dashed">
        <CardHeader className="pb-2">
          <CardTitle className="text-xs font-semibold text-foreground">Tradeoffs for this strategy</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3 text-xs">
          {strategy.tradeoffs.advantages.length > 0 && (
            <div>
              <p className="text-[10px] uppercase tracking-wide text-emerald-700 font-semibold mb-1">Advantages</p>
              <ul className="list-disc list-inside text-muted-foreground space-y-0.5">
                {strategy.tradeoffs.advantages.slice(0, 4).map((a, i) => (
                  <li key={i}>{a}</li>
                ))}
              </ul>
            </div>
          )}
          {strategy.tradeoffs.disadvantages.length > 0 && (
            <div>
              <p className="text-[10px] uppercase tracking-wide text-accent-red/80 font-semibold mb-1">Disadvantages</p>
              <ul className="list-disc list-inside text-muted-foreground space-y-0.5">
                {strategy.tradeoffs.disadvantages.slice(0, 4).map((d, i) => (
                  <li key={i}>{d}</li>
                ))}
              </ul>
            </div>
          )}
          {strategy.tradeoffs.operational.length > 0 && (
            <div>
              <p className="text-[10px] uppercase tracking-wide text-muted-foreground font-semibold mb-1">Operational notes</p>
              <ul className="list-disc list-inside text-muted-foreground space-y-0.5">
                {strategy.tradeoffs.operational.map((o, i) => (
                  <li key={i}>{o}</li>
                ))}
              </ul>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
