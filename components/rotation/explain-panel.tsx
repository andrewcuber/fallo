"use client";

import { StrategyResult, FactorKey, FACTOR_LABELS } from "@/lib/rotation-scoring";
import { ChevronDown, ChevronUp, BookOpen } from "lucide-react";
import { useState } from "react";

interface Props {
  factorScores: StrategyResult["factorScores"];
  strategy?: StrategyResult["strategy"];
}

function FactorDetail({
  factorKey,
  score,
}: {
  factorKey: FactorKey;
  score: StrategyResult["factorScores"][FactorKey];
}) {
  const [open, setOpen] = useState(false);

  return (
    <div className="rounded-lg border border-border bg-card overflow-hidden">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="flex items-center justify-between w-full px-3 py-2.5 text-left hover:bg-muted/50 transition-colors"
      >
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-xs font-semibold text-foreground">{FACTOR_LABELS[factorKey]}</span>
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
            {score.coverage} coverage
          </span>
        </div>
        {open ? (
          <ChevronUp className="h-4 w-4 text-muted-foreground shrink-0" />
        ) : (
          <ChevronDown className="h-4 w-4 text-muted-foreground shrink-0" />
        )}
      </button>

      {open && (
        <div className="px-3 pb-3 space-y-3 border-t border-border/50 bg-muted/20">
          <p className="text-xs text-foreground mt-2">{score.interpretation}</p>

          {score.inputsUsed.length > 0 && (
            <div>
              <p className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground mb-1">
                Inputs used
              </p>
              <ul className="space-y-0.5">
                {score.inputsUsed.map((input, i) => (
                  <li key={i} className="text-[11px] text-muted-foreground">
                    • {input}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {score.positiveContributors.length > 0 && (
            <div>
              <p className="text-[10px] font-semibold uppercase tracking-wide text-emerald-700 mb-1">
                Positive contributors
              </p>
              <ul className="space-y-0.5">
                {score.positiveContributors.map((pos, i) => (
                  <li key={i} className="text-[11px] text-emerald-700/90">
                    + {pos}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {score.negativeContributors.length > 0 && (
            <div>
              <p className="text-[10px] font-semibold uppercase tracking-wide text-accent-red/80 mb-1">
                Concerns
              </p>
              <ul className="space-y-0.5">
                {score.negativeContributors.map((neg, i) => (
                  <li key={i} className="text-[11px] text-accent-red/70">
                    − {neg}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {score.dataCoverageLimitations.length > 0 && (
            <div>
              <p className="text-[10px] font-semibold uppercase tracking-wide text-amber-700 mb-1">
                Coverage notes
              </p>
              <ul className="space-y-0.5">
                {score.dataCoverageLimitations.map((lim, i) => (
                  <li key={i} className="text-[11px] text-amber-700/80">
                    • {lim}
                  </li>
                ))}
              </ul>
            </div>
          )}

          <div>
            <p className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground mb-1">
              Scoring rubric
            </p>
            <p className="text-[11px] text-muted-foreground leading-relaxed">{score.rubric}</p>
          </div>

          {score.citations.length > 0 && (
            <div>
              <p className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground mb-1 flex items-center gap-1">
                <BookOpen className="h-3 w-3" />
                Factor references
              </p>
              <ul className="space-y-0.5">
                {score.citations.map((cite, i) => (
                  <li key={i} className="text-[11px] break-words">
                    {cite.url ? (
                      <a
                        href={cite.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-electric hover:underline underline-offset-2 break-words"
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

export function ExplainPanel({ factorScores }: Props) {
  const keys: FactorKey[] = [
    "waterSuitability",
    "nitrogenContribution",
    "soilCoverage",
    "diversityPestBreak",
    "climateRiskResilience",
  ];

  return (
    <div className="space-y-2">
      <p className="text-xs text-muted-foreground">
        Scores are decision-support heuristics (0–100), not calibrated yield predictions. Select any factor to inspect its inputs, contributors, and rubric.
      </p>

      <div className="space-y-2">
        {keys.map((key) => (
          <FactorDetail key={key} factorKey={key} score={factorScores[key]} />
        ))}
      </div>
    </div>
  );
}
