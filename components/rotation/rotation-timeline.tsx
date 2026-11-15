"use client";

import { RotationStrategy, cropLibrary } from "@/lib/rotation-scoring";

interface Props {
  strategy: RotationStrategy;
}

const MONTH_SHORT = ["J", "F", "M", "A", "M", "J", "J", "A", "S", "O", "N", "D"] as const;

export function RotationTimeline({ strategy }: Props) {
  return (
    <div className="space-y-3 mt-2">
      <div className="flex items-center gap-1">
        {MONTH_SHORT.map((m, i) => {
          // Determine which crop occupies this month in Year 1 (approximate)
          const monthNum = i + 1;
          const season = strategy.years[0]?.seasons.find((s) => s.months.includes(monthNum));
          let bg = "bg-muted";
          if (season && season.crop !== "winter_fallow") {
            const crop = cropLibrary[season.crop];
            bg = crop?.type === "cover" ? "bg-cyan/40" : "bg-electric/40";
          }
          return (
            <div key={m} className="flex-1 flex flex-col items-center gap-0.5">
              <div className={`h-2 w-full rounded-sm ${bg}`} />
              <span className="text-[9px] text-muted-foreground tabular-nums">{m}</span>
            </div>
          );
        })}
      </div>
      <p className="text-[10px] text-muted-foreground">
        Year 1 overview. Cash crops = blue, cover crops = cyan, fallow = gray.
      </p>
    </div>
  );
}
