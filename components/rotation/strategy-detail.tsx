"use client";

import { StrategyResult, Crop, cropLibrary } from "@/lib/rotation-scoring";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ExplainPanel } from "./explain-panel";
import { BookOpen, AlertTriangle, Sprout, Clock, Calendar, Sparkles, Info } from "lucide-react";

interface Props {
  result: StrategyResult;
}

const MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function MonthBar({ months, colorClass }: { months: number[]; colorClass: string }) {
  return (
    <div className="flex gap-0.5 mt-1">
      {MONTH_NAMES.map((_, i) => {
        const active = months.includes(i + 1);
        return (
          <div
            key={i}
            className={`h-2 flex-1 rounded-sm ${active ? colorClass : "bg-muted"}`}
            title={MONTH_NAMES[i]}
          />
        );
      })}
    </div>
  );
}

function CropPurposeLine({ crop }: { crop: Crop }) {
  const parts: string[] = [];
  if (crop.type === "cover") {
    parts.push("Builds soil, suppresses weeds, prevents erosion");
  } else {
    parts.push("Cash crop—primary revenue stream");
  }
  if (crop.nitrogenBehavior?.demandCategory) {
    parts.push(crop.nitrogenBehavior.demandCategory);
  }
  if (crop.waterDemand) {
    parts.push(`Water demand: ${crop.waterDemand}`);
  }
  if (crop.residue?.description) {
    parts.push(`Residue: ${crop.residue.description}`);
  }
  return <p className="text-[11px] text-muted-foreground leading-relaxed">{parts.join("; ")}</p>;
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
    <div className="rounded-lg border border-border bg-muted/20 p-3 space-y-2">
      <div className="flex items-start justify-between gap-2">
        <div>
          <div className="flex items-center gap-1.5">
            <span
              className={`inline-flex items-center rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${
                isCover ? "bg-emerald-50 text-emerald-700" : "bg-cyan-50 text-cyan-700"
              }`}
            >
              {isCover ? "Cover" : "Cash"}
            </span>
            <h5 className="text-sm font-semibold text-foreground">{crop?.commonName ?? season.crop}</h5>
          </div>
          <p className="text-[11px] text-muted-foreground mt-0.5">{season.activity}</p>
        </div>
        {crop?.growingWindow && (
          <div className="shrink-0 text-right">
            <div className="flex items-center gap-1 text-[10px] text-muted-foreground">
              <Calendar className="h-3 w-3" />
              <span>
                {crop.growingWindow.planting ?? "—"} → {crop.growingWindow.harvest ?? crop.growingWindow.termination ?? "—"}
              </span>
            </div>
          </div>
        )}
      </div>

      <MonthBar months={season.months} colorClass={isCover ? "bg-emerald-400" : "bg-cyan-400"} />

      {crop && <CropPurposeLine crop={crop} />}

      {crop?.diseasePestNotes && crop.diseasePestNotes.length > 0 && (
        <div className="space-y-0.5">
          {crop.diseasePestNotes.map((note, i) => (
            <p key={i} className="text-[10px] text-amber-700/80 flex items-start gap-1">
              <AlertTriangle className="h-3 w-3 shrink-0 mt-0.5" />
              {note}
            </p>
          ))}
        </div>
      )}
    </div>
  );
}

function StrategySources({ result }: { result: StrategyResult }) {
  // Collect all unique citations from factor scores plus crop sources
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

  // Also pull crop-level sources from crops in the strategy
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

  if (sources.length === 0) return null;

  return (
    <div>
      <h4 className="text-sm font-semibold text-foreground mb-2 flex items-center gap-1.5">
        <BookOpen className="h-4 w-4 text-muted-foreground" />
        Sources
      </h4>
      <ul className="space-y-1">
        {sources.map((s, i) => (
          <li key={i} className="text-[11px]">
            {s.url ? (
              <a
                href={s.url}
                target="_blank"
                rel="noopener noreferrer"
                className="text-electric hover:underline underline-offset-2"
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
  );
}

export function StrategyDetail({ result }: Props) {
  const { strategy, factorScores } = result;

  const warnings = strategy.tradeoffs.warnings.map((w) =>
    typeof w === "string" ? { severity: "moderate" as const, text: w } : (w as { severity: "high" | "moderate"; text: string })
  );

  return (
    <div className="space-y-6">
      {/* Generation source banner */}
      {strategy.generationInfo && (
        <div
          className={`rounded-md border px-3 py-2 text-[11px] space-y-1 ${
            strategy.generationInfo.source === "ai-assisted"
              ? "bg-purple-50 border-purple-100 text-purple-800"
              : "bg-muted/40 border-border text-muted-foreground"
          }`}
        >
          <div className="flex items-center gap-1.5 font-semibold">
            {strategy.generationInfo.source === "ai-assisted" ? (
              <>
                <Sparkles className="h-3.5 w-3.5" />
                AI-assisted proposal
              </>
            ) : (
              <>
                <Info className="h-3.5 w-3.5" />
                Static archetype example
              </>
            )}
          </div>
          {strategy.generationInfo.generatedAt && (
            <p>Generated: {new Date(strategy.generationInfo.generatedAt).toLocaleDateString()}</p>
          )}
          {strategy.generationInfo.agGroup && (
            <p>Agricultural group: {strategy.generationInfo.agGroup}</p>
          )}
          {strategy.generationInfo.aiProvider && (
            <p>Provider: {strategy.generationInfo.aiProvider}</p>
          )}
          {strategy.generationInfo.rationale && (
            <p className="italic">Rationale: {strategy.generationInfo.rationale}</p>
          )}
          {strategy.generationInfo.validationWarnings && strategy.generationInfo.validationWarnings.length > 0 && (
            <div className="text-amber-800">
              <p className="font-semibold">Validation warnings:</p>
              <ul className="list-disc list-inside">
                {strategy.generationInfo.validationWarnings.map((w, i) => (
                  <li key={i}>{w}</li>
                ))}
              </ul>
            </div>
          )}
          {strategy.generationInfo.validationErrors && strategy.generationInfo.validationErrors.length > 0 && (
            <div className="text-red-700">
              <p className="font-semibold">Validation issues:</p>
              <ul className="list-disc list-inside">
                {strategy.generationInfo.validationErrors.map((e, i) => (
                  <li key={i}>{e}</li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}

      {/* 3-Year Schedule */}
      <div>
        <h4 className="text-sm font-semibold text-foreground mb-3 flex items-center gap-1.5">
          <Clock className="h-4 w-4 text-muted-foreground" />
          3-Year Rotation Schedule
        </h4>
        <div className="space-y-5">
          {strategy.years.map((year) => (
            <div key={year.year}>
              <h5 className="text-xs font-bold text-muted-foreground uppercase tracking-wide mb-2">Year {year.year}</h5>
              <div className="space-y-2">
                {year.seasons.map((season, idx) => (
                  <SeasonBlock key={idx} season={season} crop={cropLibrary[season.crop]} />
                ))}
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Crop purposes summary */}
      <Card className="border-dashed">
        <CardHeader className="pb-2">
          <CardTitle className="text-xs font-semibold text-foreground flex items-center gap-1.5">
            <Sprout className="h-4 w-4 text-muted-foreground" />
            Why each crop is in this rotation
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3 text-xs">
          {strategy.years.flatMap((y) => y.seasons).map((s, i) => {
            const crop = cropLibrary[s.crop];
            if (!crop) return null;
            return (
              <div key={i} className="flex items-start gap-2">
                <span
                  className={`inline-flex items-center rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase shrink-0 ${
                    crop.type === "cover" ? "bg-emerald-50 text-emerald-700" : "bg-cyan-50 text-cyan-700"
                  }`}
                >
                  {crop.type === "cover" ? "Cover" : "Cash"}
                </span>
                <div>
                  <p className="font-medium text-foreground">{crop.commonName}</p>
                  <p className="text-[11px] text-muted-foreground">{s.activity}</p>
                  <CropPurposeLine crop={crop} />
                </div>
              </div>
            );
          })}
        </CardContent>
      </Card>

      {/* Management considerations */}
      {(strategy.tradeoffs.advantages.length > 0 ||
        strategy.tradeoffs.disadvantages.length > 0 ||
        strategy.tradeoffs.operational.length > 0) && (
        <div>
          <h4 className="text-sm font-semibold text-foreground mb-2">Management considerations</h4>
          <div className="space-y-3 text-xs">
            {strategy.tradeoffs.advantages.length > 0 && (
              <div>
                <p className="text-[10px] uppercase tracking-wide text-emerald-700 font-semibold mb-1">Advantages</p>
                <ul className="list-disc list-inside text-muted-foreground space-y-0.5">
                  {strategy.tradeoffs.advantages.map((a, i) => (
                    <li key={i}>{a}</li>
                  ))}
                </ul>
              </div>
            )}
            {strategy.tradeoffs.disadvantages.length > 0 && (
              <div>
                <p className="text-[10px] uppercase tracking-wide text-accent-red/80 font-semibold mb-1">Disadvantages</p>
                <ul className="list-disc list-inside text-muted-foreground space-y-0.5">
                  {strategy.tradeoffs.disadvantages.map((d, i) => (
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
          </div>
        </div>
      )}

      {/* Disease/compatibility warnings */}
      {warnings.length > 0 && (
        <div>
          <h4 className="text-sm font-semibold text-foreground mb-2">Warnings & compatibility</h4>
          <div className="space-y-1.5">
            {warnings.map((w, i) => (
              <div
                key={i}
                className={`flex items-start gap-1.5 rounded-md px-2 py-1.5 text-[11px] ${
                  w.severity === "high"
                    ? "bg-accent-red/5 text-accent-red"
                    : "bg-amber-50 text-amber-700"
                }`}
              >
                <AlertTriangle className="h-3.5 w-3.5 shrink-0 mt-0.5" />
                <span>{w.text}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Factor performance summary (brief) */}
      <div>
        <h4 className="text-sm font-semibold text-foreground mb-2">Why this strategy scores this way</h4>
        <div className="space-y-2">
          {(
            [
              "waterSuitability",
              "nitrogenContribution",
              "soilCoverage",
              "diversityPestBreak",
              "climateRiskResilience",
            ] as const
          ).map((key) => {
            const fs = factorScores[key];
            return (
              <div key={key} className="flex items-start gap-2">
                <span
                  className={`inline-block h-2 w-2 rounded-full mt-1.5 shrink-0 ${
                    fs.score !== null
                      ? fs.score >= 70
                        ? "bg-emerald-500"
                        : fs.score >= 50
                        ? "bg-amber-500"
                        : "bg-accent-red"
                      : "bg-muted"
                  }`}
                />
                <div>
                  <p className="text-xs font-medium text-foreground">
                    {(
                      {
                        waterSuitability: "Water Suitability",
                        nitrogenContribution: "Nitrogen Contribution",
                        soilCoverage: "Soil Coverage",
                        diversityPestBreak: "Diversity / Pest Break",
                        climateRiskResilience: "Climate Risk Resilience",
                      } as const
                    )[key]}{" "}
                    —{" "}
                    <span className="tabular-nums">
                      {fs.score !== null ? fs.score : "—"}/100
                    </span>
                  </p>
                  <p className="text-[11px] text-muted-foreground">{fs.interpretation}</p>
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* Detailed explanations */}
      <ExplainPanel factorScores={factorScores} strategy={strategy} />

      {/* Sources */}
      <StrategySources result={result} />
    </div>
  );
}
