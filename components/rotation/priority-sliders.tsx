"use client";

import { FarmerPriorities, DEFAULT_PRIORITIES, FACTOR_LABELS, FactorKey } from "@/lib/rotation-scoring";
import { useCallback } from "react";

interface Props {
  priorities: FarmerPriorities;
  onChange: (p: FarmerPriorities) => void;
}

export function PrioritySliders({ priorities, onChange }: Props) {
  const total = Object.values(priorities).reduce((a, b) => a + b, 0);

  const update = useCallback(
    (key: FactorKey, value: number) => {
      onChange({ ...priorities, [key]: Math.max(0, Math.min(100, value)) });
    },
    [onChange, priorities]
  );

  const reset = useCallback(() => {
    onChange({ ...DEFAULT_PRIORITIES });
  }, [onChange]);

  const keys = Object.keys(FACTOR_LABELS) as FactorKey[];

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between">
        <div>
          <p className="text-sm font-semibold text-foreground">Your Priorities</p>
          <p className="text-xs text-muted-foreground">
            {total === 0
              ? "All priorities are zero — scores will use equal weighting."
              : `Relative priority points (total: ${total}). These are not percentages and do not need to sum to 100.`}
          </p>
        </div>
        <button
          onClick={reset}
          className="text-xs font-medium text-electric hover:text-electric/80 transition-colors"
        >
          Reset to equal
        </button>
      </div>

      {/* Normalized weight summary */}
      {total > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {keys.map((key) => {
            const percent = Math.round((priorities[key] / total) * 100);
            return (
              <span
                key={`badge-${key}`}
                className="inline-flex items-center rounded-md bg-muted px-2 py-0.5 text-[10px] font-medium text-muted-foreground"
              >
                {FACTOR_LABELS[key]}: {percent}%
              </span>
            );
          })}
        </div>
      )}

      <div className="space-y-4">
        {keys.map((key) => {
          const label = FACTOR_LABELS[key];
          const value = priorities[key];
          const percent = total > 0 ? Math.round((value / total) * 100) : 20;

          return (
            <div key={key} className="space-y-1.5">
              <div className="flex items-center justify-between text-sm">
                <span className="text-foreground font-medium">{label}</span>
                <div className="flex items-center gap-2">
                  <input
                    type="number"
                    min={0}
                    max={100}
                    value={value}
                    onChange={(e) => {
                      const raw = e.target.value;
                      if (raw === "") {
                        update(key, 0);
                        return;
                      }
                      const n = parseInt(raw, 10);
                      if (!Number.isNaN(n)) {
                        update(key, Math.max(0, Math.min(100, n)));
                      }
                    }}
                    className="w-14 rounded-md border border-border bg-background px-1.5 py-0.5 text-right text-xs tabular-nums text-foreground focus:border-electric focus:outline-none"
                    aria-label={`${label} value`}
                  />
                  <span className="tabular-nums text-muted-foreground text-xs w-10 text-right">
                    {percent}%
                  </span>
                </div>
              </div>
              <input
                type="range"
                min={0}
                max={100}
                step={1}
                value={value}
                onChange={(e) => update(key, Number(e.target.value))}
                className="w-full h-2 bg-border rounded-lg appearance-none cursor-pointer accent-electric"
                aria-label={label}
              />
            </div>
          );
        })}
      </div>
    </div>
  );
}
