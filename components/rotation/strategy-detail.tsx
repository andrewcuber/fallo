"use client";

import { useState } from "react";
import {
  StrategyResult,
  Crop,
  cropLibrary,
  FactorKey,
  FACTOR_LABELS,
} from "@/lib/rotation-scoring";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ExplainPanel } from "./explain-panel";
import {
  BookOpen,
  AlertTriangle,
  ShieldAlert,
  Clock,
  Calendar,
  Sparkles,
  Trophy,
  ChevronDown,
  ChevronUp,
  ExternalLink,
} from "lucide-react";

interface Props {
  result: StrategyResult;
}

const MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

const FACTOR_ORDER: FactorKey[] = [
  "waterSuitability",
  "nitrogenContribution",
  "soilCoverage",
  "diversityPestBreak",
  "climateRiskResilience",
];

function MonthBar({ months, colorClass }: { months: number[]; colorClass: string }) {
  return (
    <div className="flex gap-0.5 mt-1">
      {MONTH_NAMES.map((name, i) => {
        const active = months.includes(i + 1);
        return (
          <div
            key={i}
            className={`h-2 flex-1 rounded-sm ${active ? colorClass : "bg-muted"}`}
            title={name}
          />
        );
      })}
    </div>
  );
}

function CropPurposeLine({ crop }: { crop: Crop }) {
  const role =
    crop.type === "cover"
      ? "Role: Living soil cover, erosion protection, and weed suppression"
      : "Role: Primary cash crop";
  const water = crop.waterDemand ? `Water demand: ${crop.waterDemand.replace(/_/g, " ")}` : null;
  const drought = crop.droughtTolerance ? `Drought tolerance: ${crop.droughtTolerance}` : null;

  const credit = crop.nitrogenBehavior?.residualNcredit;
  const creditSource = credit
    ? crop.sources.find((s) => s.citation === credit.source) ?? crop.sources[0]
    : null;
  const primarySource = crop.sources?.[0] ?? null;

  return (
    <div className="text-[11px] text-muted-foreground leading-relaxed space-y-0.5">
      <p>
        {[role, water, drought].filter(Boolean).join(" · ")}
        {!credit && primarySource?.url && (
          <>
            {" "}
            <a
              href={primarySource.url}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-0.5 text-electric hover:underline underline-offset-2 break-words"
            >
              [{primarySource.citation}]
              <ExternalLink className="h-2.5 w-2.5 inline shrink-0" />
            </a>
          </>
        )}
      </p>
      {credit && (
        <p className="text-emerald-800/90">
          Estimated N credit: {credit.value} (contextual estimate){" "}
          {creditSource?.url ? (
            <a
              href={creditSource.url}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-0.5 text-electric hover:underline underline-offset-2 break-words"
            >
              [{credit.source}]
              <ExternalLink className="h-2.5 w-2.5 inline shrink-0" />
            </a>
          ) : (
            <span className="text-muted-foreground">[{credit.source}]</span>
          )}
        </p>
      )}
    </div>
  );
}

function SeasonBlock({
  season,
  crop,
}: {
  season: { season: string; crop: string; activity: string; months: number[] };
  crop: Crop | undefined;
}) {
  const isCover = crop?.type === "cover";
  return (
    <div className="rounded-lg border border-border bg-card p-3 space-y-2">
      <div className="flex items-start justify-between gap-2 flex-wrap">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5 flex-wrap">
            <span
              className={`inline-flex items-center rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${
                isCover ? "bg-emerald-50 text-emerald-700" : "bg-cyan-50 text-cyan-700"
              }`}
            >
              {isCover ? "Cover" : "Cash"}
            </span>
            <h5 className="text-sm font-semibold text-foreground">
              {crop?.commonName ?? season.crop}
            </h5>
            {crop?.family && (
              <span className="text-[10px] text-muted-foreground">({crop.family})</span>
            )}
          </div>
          <p className="text-xs text-muted-foreground mt-0.5">{season.activity}</p>
        </div>

        {crop?.growingWindow && (
          <div className="shrink-0 text-right">
            <div className="inline-flex items-center gap-1 rounded bg-muted/60 px-2 py-0.5 text-[11px] text-muted-foreground">
              <Calendar className="h-3 w-3 shrink-0" />
              <span>
                {crop.growingWindow.planting ?? "—"} →{" "}
                {crop.growingWindow.harvest ?? crop.growingWindow.termination ?? "—"}
              </span>
            </div>
          </div>
        )}
      </div>

      <MonthBar months={season.months} colorClass={isCover ? "bg-emerald-400" : "bg-cyan-400"} />

      {crop && <CropPurposeLine crop={crop} />}

      {crop?.diseasePestNotes && crop.diseasePestNotes.length > 0 && (
        <p className="text-[11px] text-amber-800/90 flex items-start gap-1">
          <AlertTriangle className="h-3 w-3 shrink-0 mt-0.5 text-amber-600" />
          <span>{crop.diseasePestNotes[0]}</span>
        </p>
      )}
    </div>
  );
}

function SourcesAndMethodologySection({ result }: { result: StrategyResult }) {
  const [open, setOpen] = useState(false);

  const seen = new Set<string>();
  const sources: { text: string; url?: string }[] = [];

  Object.values(result.factorScores).forEach((fs) => {
    fs.citations.forEach((c) => {
      const key = c.url ?? c.text;
      if (!seen.has(key)) {
        seen.add(key);
        sources.push({ text: c.text, url: c.url });
      }
    });
  });

  result.strategy.years.forEach((y) => {
    y.seasons.forEach((s) => {
      const c = cropLibrary[s.crop];
      if (c?.sources) {
        c.sources.forEach((src) => {
          const key = src.url ?? src.citation;
          if (!seen.has(key)) {
            seen.add(key);
            sources.push({ text: src.citation, url: src.url });
          }
        });
      }
    });
  });

  return (
    <Card className="overflow-hidden">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="flex items-center justify-between w-full px-4 py-3 text-left hover:bg-muted/40 transition-colors"
      >
        <div className="flex items-center gap-2">
          <BookOpen className="h-4 w-4 text-muted-foreground" />
          <span className="text-sm font-semibold text-foreground">Sources & Methodology</span>
          <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
            {sources.length} {sources.length === 1 ? "source" : "sources"}
          </span>
        </div>
        {open ? (
          <ChevronUp className="h-4 w-4 text-muted-foreground shrink-0" />
        ) : (
          <ChevronDown className="h-4 w-4 text-muted-foreground shrink-0" />
        )}
      </button>

      {open && (
        <CardContent className="pt-3 pb-4 border-t border-border/60 bg-muted/10 space-y-4 text-xs">
          <div className="space-y-1.5">
            <h5 className="text-[11px] font-semibold uppercase tracking-wide text-foreground">
              Scoring & Data Methodology
            </h5>
            <p className="text-muted-foreground leading-relaxed">
              Rotation suitability scores (0–100) are deterministic decision-support heuristics combining five weighted factors: Water Suitability, Nitrogen Contribution, Soil Coverage, Diversity / Pest Break, and Climate Risk Resilience. They are not calibrated yield or economic predictions.
            </p>
            <ul className="list-disc list-inside text-[11px] text-muted-foreground space-y-0.5">
              <li>
                <strong>Climate inputs:</strong> NASA POWER Agroclimatology Daily API (0.5° grid, ~55 km regional context).
              </li>
              <li>
                <strong>Soil inputs:</strong> USDA NRCS SSURGO depth-weighted 0–30 cm map-unit component averages.
              </li>
              <li>
                <strong>Data Coverage:</strong> Tracked separately from suitability fit so missing inputs never silently penalize or inflate scores.
              </li>
            </ul>
          </div>

          {sources.length > 0 && (
            <div className="space-y-1.5">
              <h5 className="text-[11px] font-semibold uppercase tracking-wide text-foreground">
                Agronomic & Data References
              </h5>
              <ul className="space-y-1">
                {sources.map((s, i) => (
                  <li key={i} className="text-[11px] break-words">
                    {s.url ? (
                      <a
                        href={s.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-electric hover:underline underline-offset-2 break-words"
                      >
                        {s.text}
                      </a>
                    ) : (
                      <span className="text-muted-foreground">{s.text}</span>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </CardContent>
      )}
    </Card>
  );
}

export function StrategyDetail({ result }: Props) {
  const { strategy, factorScores, overallScore, overallCoverage, overallFitLabel, availableWeightPercent } =
    result;
  const [showFactorDetails, setShowFactorDetails] = useState(false);

  const warnings = strategy.tradeoffs.warnings.map((w) =>
    typeof w === "string"
      ? { severity: "moderate" as const, text: w }
      : (w as { severity: "high" | "moderate"; text: string })
  );

  const overallBadgeColor =
    overallScore === null
      ? "bg-muted text-muted-foreground"
      : overallScore >= 70
      ? "text-emerald-700 bg-emerald-50 border border-emerald-200"
      : overallScore >= 50
      ? "text-amber-700 bg-amber-50 border border-amber-200"
      : "text-accent-red bg-accent-red/5 border border-accent-red/20";

  return (
    <div className="space-y-6">
      {/* Generation provenance & token usage banner */}
      {strategy.generationInfo && (
        <div className="rounded-md border bg-purple-50 border-purple-100 text-purple-900 px-3 py-2 text-xs space-y-1.5">
          <div className="flex items-center justify-between gap-2 flex-wrap">
            <div className="flex items-center gap-1.5 font-semibold text-purple-800">
              <Sparkles className="h-3.5 w-3.5" />
              <span>Field-specific AI-assisted proposal (deterministically validated)</span>
            </div>
            <div className="flex items-center gap-1.5 flex-wrap font-mono text-[10px]">
              {strategy.generationInfo.aiProvider && (
                <span className="rounded bg-white/80 px-1.5 py-0.5 border border-purple-200">
                  provider: {strategy.generationInfo.aiProvider}
                </span>
              )}
              {strategy.generationInfo.aiModel && (
                <span className="rounded bg-white/80 px-1.5 py-0.5 border border-purple-200">
                  model: {strategy.generationInfo.aiModel}
                </span>
              )}
              {strategy.generationInfo.agGroup && (
                <span className="rounded bg-white/80 px-1.5 py-0.5 border border-purple-200">
                  group: {strategy.generationInfo.agGroup}
                </span>
              )}
              <span className="rounded bg-white/80 px-1.5 py-0.5 border border-purple-200">
                validation: {strategy.generationInfo.validationStatus ?? "passed"}
              </span>
            </div>
          </div>
          {strategy.generationInfo.rationale && (
            <p className="text-[11px] text-purple-800/90">{strategy.generationInfo.rationale}</p>
          )}
          {strategy.generationInfo.usageMetadata && (
            <div className="flex items-center gap-2 font-mono text-[10px] text-purple-800/90 pt-0.5">
              <span>Token usage:</span>
              {typeof strategy.generationInfo.usageMetadata.promptTokenCount === "number" && (
                <span>input={strategy.generationInfo.usageMetadata.promptTokenCount}</span>
              )}
              {typeof strategy.generationInfo.usageMetadata.candidatesTokenCount === "number" && (
                <span>output={strategy.generationInfo.usageMetadata.candidatesTokenCount}</span>
              )}
              {typeof strategy.generationInfo.usageMetadata.thoughtsTokenCount === "number" && (
                <span>thought={strategy.generationInfo.usageMetadata.thoughtsTokenCount}</span>
              )}
              {typeof strategy.generationInfo.usageMetadata.totalTokenCount === "number" && (
                <span>total={strategy.generationInfo.usageMetadata.totalTokenCount}</span>
              )}
            </div>
          )}
        </div>
      )}

      {/* Overall & 5-Factor Suitability Summary */}
      <Card>
        <CardHeader className="pb-3">
          <div className="flex items-start justify-between gap-4 flex-wrap">
            <div className="space-y-1">
              <CardTitle className="text-sm font-semibold text-foreground">
                Suitability & Factor Scores
              </CardTitle>
              <div className="flex items-center gap-2 flex-wrap">
                <span
                  className={`inline-flex items-center rounded px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide ${
                    overallCoverage === "Good"
                      ? "bg-emerald-50 text-emerald-700 border border-emerald-100"
                      : overallCoverage === "Partial"
                      ? "bg-amber-50 text-amber-700 border border-amber-100"
                      : "bg-red-50 text-red-700 border border-red-100"
                  }`}
                >
                  Data coverage: {overallCoverage}
                </span>
                {overallScore !== null && availableWeightPercent < 100 && (
                  <span className="text-[11px] text-amber-600">
                    ({availableWeightPercent}% of weighted factors available)
                  </span>
                )}
              </div>
            </div>

            <div className={`inline-flex items-center gap-2 rounded-lg px-3 py-1.5 ${overallBadgeColor}`}>
              <Trophy className="h-4 w-4" />
              <span className="tabular-nums font-bold text-lg">
                {overallScore !== null ? overallScore : "—"}
              </span>
              <span className="text-xs opacity-80">/ 100</span>
              <span className="text-[10px] font-semibold uppercase tracking-wide ml-1">
                ({overallFitLabel})
              </span>
            </div>
          </div>
        </CardHeader>

        <CardContent className="space-y-4">
          <div className="grid grid-cols-1 md:grid-cols-5 gap-3">
            {FACTOR_ORDER.map((key) => {
              const fs = factorScores[key];
              const barColor =
                fs.score !== null
                  ? fs.score >= 70
                    ? "bg-emerald-500"
                    : fs.score >= 50
                    ? "bg-amber-500"
                    : "bg-accent-red"
                  : "bg-muted";
              return (
                <div key={key} className="rounded-lg border border-border/70 bg-muted/20 p-2.5 space-y-1.5">
                  <div className="flex items-center justify-between gap-1 text-xs">
                    <span className="font-medium text-foreground truncate">{FACTOR_LABELS[key]}</span>
                    <span className="tabular-nums font-semibold text-foreground shrink-0">
                      {fs.score !== null ? `${fs.score}/100` : "—"}
                    </span>
                  </div>
                  <div className="h-1.5 w-full rounded-full bg-muted overflow-hidden">
                    <div
                      className={`h-full rounded-full ${barColor}`}
                      style={{ width: fs.score !== null ? `${fs.score}%` : "0%" }}
                    />
                  </div>
                  <p className="text-[11px] text-muted-foreground leading-snug">{fs.interpretation}</p>
                </div>
              );
            })}
          </div>

          {/* Expandable Detailed Factor Explanations */}
          <div className="pt-1 border-t border-border/50">
            <button
              type="button"
              onClick={() => setShowFactorDetails(!showFactorDetails)}
              className="inline-flex items-center gap-1.5 text-xs font-medium text-electric hover:underline"
            >
              {showFactorDetails ? (
                <>
                  <ChevronUp className="h-3.5 w-3.5" />
                  Hide detailed factor rubrics & inputs
                </>
              ) : (
                <>
                  <ChevronDown className="h-3.5 w-3.5" />
                  Show detailed factor rubrics & inputs
                </>
              )}
            </button>

            {showFactorDetails && (
              <div className="mt-3">
                <ExplainPanel factorScores={factorScores} />
              </div>
            )}
          </div>
        </CardContent>
      </Card>

      {/* 3-Year Schedule */}
      <div className="space-y-3">
        <h4 className="text-sm font-semibold text-foreground flex items-center gap-1.5">
          <Clock className="h-4 w-4 text-muted-foreground" />
          3-Year Rotation Schedule
        </h4>
        <div className="space-y-4">
          {strategy.years.map((year) => (
            <div key={year.year} className="space-y-2">
              <h5 className="text-xs font-bold text-muted-foreground uppercase tracking-wide">
                Year {year.year}
              </h5>
              <div className="space-y-2">
                {year.seasons.map((season, idx) => (
                  <SeasonBlock key={idx} season={season} crop={cropLibrary[season.crop]} />
                ))}
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Warnings & compatibility */}
      {warnings.length > 0 && (
        <div className="space-y-2">
          <h4 className="text-sm font-semibold text-foreground">Warnings & Compatibility</h4>
          <div className="space-y-1.5">
            {warnings.map((w, i) => (
              <div
                key={i}
                className={`flex items-start gap-2 rounded-md px-3 py-2 text-xs leading-relaxed ${
                  w.severity === "high"
                    ? "bg-accent-red/5 text-accent-red border border-accent-red/15"
                    : "bg-amber-50 text-amber-800 border border-amber-200/70"
                }`}
              >
                {w.severity === "high" ? (
                  <ShieldAlert className="h-4 w-4 shrink-0 mt-0.5" />
                ) : (
                  <AlertTriangle className="h-4 w-4 shrink-0 mt-0.5" />
                )}
                <span>{w.text}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Management considerations */}
      {(strategy.tradeoffs.advantages.length > 0 ||
        strategy.tradeoffs.disadvantages.length > 0 ||
        strategy.tradeoffs.operational.length > 0) && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-semibold text-foreground">
              Management Considerations
            </CardTitle>
          </CardHeader>
          <CardContent className="grid grid-cols-1 md:grid-cols-3 gap-4 text-xs">
            {strategy.tradeoffs.advantages.length > 0 && (
              <div>
                <p className="text-[10px] uppercase tracking-wide text-emerald-700 font-semibold mb-1.5">
                  Advantages
                </p>
                <ul className="list-disc list-inside text-muted-foreground space-y-1">
                  {strategy.tradeoffs.advantages.map((a, i) => (
                    <li key={i} className="leading-snug">{a}</li>
                  ))}
                </ul>
              </div>
            )}
            {strategy.tradeoffs.disadvantages.length > 0 && (
              <div>
                <p className="text-[10px] uppercase tracking-wide text-accent-red/80 font-semibold mb-1.5">
                  Watch-outs
                </p>
                <ul className="list-disc list-inside text-muted-foreground space-y-1">
                  {strategy.tradeoffs.disadvantages.map((d, i) => (
                    <li key={i} className="leading-snug">{d}</li>
                  ))}
                </ul>
              </div>
            )}
            {strategy.tradeoffs.operational.length > 0 && (
              <div>
                <p className="text-[10px] uppercase tracking-wide text-muted-foreground font-semibold mb-1.5">
                  Operational Notes
                </p>
                <ul className="list-disc list-inside text-muted-foreground space-y-1">
                  {strategy.tradeoffs.operational.map((o, i) => (
                    <li key={i} className="leading-snug">{o}</li>
                  ))}
                </ul>
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {/* Collapsed Sources & Methodology section */}
      <SourcesAndMethodologySection result={result} />
    </div>
  );
}
