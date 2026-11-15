"use client";

import { useEffect, useState, useMemo } from "react";
import { useParams, useRouter } from "next/navigation";
import Link from "next/link";
import {
  useField,
  useFieldEnvironmentalData,
} from "@/components/providers";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import {
  scoreVerifiedAiStrategies,
  type StrategyResult,
} from "@/lib/rotation-scoring";
import {
  buildFieldCalendar,
  CALENDAR_MONTH_NAMES,
  type CalendarSeasonEntry,
  type CalendarYearSchedule,
  type MonthStageRole,
} from "@/lib/field-calendar";
import {
  applyWhatIfScenarioToClimate,
  formatScenarioSummary,
  isBaselineScenario,
} from "@/lib/what-if-simulator";
import { detectRegion, resolveGeographicContext } from "@/lib/region";
import {
  CalendarDays,
  Thermometer,
  Droplets,
  Sun,
  AlertTriangle,
  RotateCcw,
  Sparkles,
  Globe,
  Sprout,
  Clock,
  SlidersHorizontal,
  ArrowRight,
  Info,
} from "lucide-react";

function fmt(val: number | null | undefined, decimals = 1): string {
  if (val === null || val === undefined || Number.isNaN(val)) return "—";
  return val.toFixed(decimals);
}

function roleColorClasses(
  cropType: "cash" | "cover" | "fallow",
  role: MonthStageRole
): string {
  if (cropType === "fallow") {
    return "bg-slate-200 text-slate-700 border-slate-300";
  }
  if (role === "sensitive_stage") {
    return "bg-amber-500 text-white border-amber-600";
  }
  if (cropType === "cover") {
    if (role === "planting") return "bg-emerald-600 text-white border-emerald-700";
    if (role === "termination") return "bg-teal-700 text-white border-teal-800";
    return "bg-emerald-100 text-emerald-900 border-emerald-300";
  }
  // cash crop
  if (role === "planting") return "bg-electric text-white border-electric-dark";
  if (role === "harvest") return "bg-indigo-600 text-white border-indigo-700";
  return "bg-sky-100 text-sky-900 border-sky-300";
}

function roleShortBadge(role: MonthStageRole): string {
  switch (role) {
    case "planting":
      return "Plant";
    case "active_growth":
      return "Grow";
    case "sensitive_stage":
      return "Crit.";
    case "harvest":
      return "Harv";
    case "termination":
      return "Term";
    case "fallow":
      return "Fallow";
  }
}

export default function FieldCalendarPage() {
  const params = useParams();
  const router = useRouter();
  const {
    fields,
    activeField,
    priorities,
    setActiveField,
    getSelectedStrategyId,
    setSelectedStrategyId,
    getFieldWhatIfScenario,
    isLoaded,
  } = useField();

  const fieldId = typeof params.id === "string" ? params.id : undefined;

  useEffect(() => {
    if (!isLoaded || !fieldId) return;
    const found = fields.find((f) => f.id === fieldId);
    if (
      found &&
      (!activeField ||
        activeField.id !== fieldId ||
        activeField.generatedRotations !== found.generatedRotations)
    ) {
      setActiveField(found);
    }
  }, [isLoaded, fieldId, activeField, fields, setActiveField]);

  const field =
    (fieldId ? fields.find((f) => f.id === fieldId) : undefined) ??
    activeField ??
    undefined;

  const { climate, soil, loading, error, refresh } =
    useFieldEnvironmentalData(field);

  const [selectedYearTab, setSelectedYearTab] = useState<
    "all" | 1 | 2 | 3
  >("all");
  const [useScenarioClimate, setUseScenarioClimate] = useState(false);

  const detectedRegion = useMemo(
    () => (field ? detectRegion(field.lat, field.lon) : null),
    [field]
  );
  const geoContext = useMemo(
    () => (field ? resolveGeographicContext(field.lat, field.lon) : null),
    [field]
  );
  const regionTag = detectedRegion?.tag ?? geoContext?.regionTag ?? null;

  const whatIfScenario = useMemo(
    () => (field ? getFieldWhatIfScenario(field.id) : null),
    [field, getFieldWhatIfScenario]
  );
  const hasActiveWhatIf = useMemo(
    () => Boolean(whatIfScenario && !isBaselineScenario(whatIfScenario)),
    [whatIfScenario]
  );

  const activeClimate = useMemo(() => {
    if (!climate) return null;
    if (useScenarioClimate && whatIfScenario && !isBaselineScenario(whatIfScenario)) {
      return applyWhatIfScenarioToClimate(climate, whatIfScenario).scenarioClimate;
    }
    return climate;
  }, [climate, useScenarioClimate, whatIfScenario]);

  const scoredStrategies: StrategyResult[] = useMemo(() => {
    if (!activeClimate || !field) return [];
    return scoreVerifiedAiStrategies(
      field.generatedRotations?.strategies,
      field.id,
      activeClimate,
      soil,
      priorities,
      regionTag
    );
  }, [activeClimate, soil, field, priorities, regionTag]);

  const selectedStrategyId = field ? getSelectedStrategyId(field.id) : null;

  const activeStrategyResult: StrategyResult | null = useMemo(() => {
    if (scoredStrategies.length === 0) return null;
    if (selectedStrategyId) {
      const found = scoredStrategies.find(
        (r) => r.strategy.id === selectedStrategyId
      );
      if (found) return found;
    }
    return scoredStrategies[0];
  }, [scoredStrategies, selectedStrategyId]);

  const calendarModel = useMemo(() => {
    if (!activeStrategyResult || !activeClimate || !field) return null;
    return buildFieldCalendar({
      strategy: activeStrategyResult.strategy,
      climate: activeClimate,
      lat: field.lat,
      lon: field.lon,
    });
  }, [activeStrategyResult, activeClimate, field]);

  if (!isLoaded) {
    return <CalendarSkeleton />;
  }

  if (!field) {
    return (
      <div className="space-y-6">
        <div>
          <h2 className="text-2xl font-serif font-bold text-foreground">
            Field Calendar
          </h2>
          <p className="text-muted-foreground mt-1 max-w-2xl">
            Field not found. Create a field to view its 3-year crop calendar.
          </p>
        </div>
        <Button onClick={() => router.push("/fields/new")}>
          Create a Field
        </Button>
      </div>
    );
  }

  const visibleYears: CalendarYearSchedule[] = calendarModel
    ? selectedYearTab === "all"
      ? calendarModel.years
      : calendarModel.years.filter((y) => y.year === selectedYearTab)
    : [];

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="space-y-1">
          <h2 className="text-2xl font-serif font-bold text-foreground">
            Field Calendar
          </h2>
          <p className="text-sm text-muted-foreground max-w-2xl">
            Three-year crop sequence, planting and harvest windows, sensitive
            growth stages, and growing-season climate conditions for{" "}
            <strong className="text-foreground">{field.name}</strong>.
          </p>
          {calendarModel && (
            <p className="text-xs text-muted-foreground flex items-center gap-1.5 pt-0.5">
              <Globe className="h-3.5 w-3.5 text-electric shrink-0" />
              <span>{calendarModel.hemisphereSeasonNote}</span>
            </p>
          )}
        </div>

        {activeStrategyResult && (
          <div className="flex items-center gap-2 shrink-0">
            <Link
              href={`/field/${field.id}/rotations/${activeStrategyResult.strategy.id}`}
            >
              <Button variant="outline" size="sm" className="text-xs">
                View Full Rubric &amp; Citations
                <ArrowRight className="ml-1.5 h-3.5 w-3.5" />
              </Button>
            </Link>
          </div>
        )}
      </div>

      {loading && <CalendarSkeleton />}

      {error && !loading && (
        <Card className="border-accent-red/20 bg-accent-red/5">
          <CardHeader className="pb-3">
            <CardTitle className="flex items-center gap-2 text-accent-red text-base">
              <AlertTriangle className="h-5 w-5" />
              Could not load field climate data
            </CardTitle>
            <CardDescription className="text-accent-red/80">
              {error}
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Button
              variant="outline"
              size="sm"
              onClick={refresh}
              className="border-accent-red/30 text-accent-red hover:bg-accent-red/10"
            >
              <RotateCcw className="mr-2 h-4 w-4" />
              Retry
            </Button>
          </CardContent>
        </Card>
      )}

      {/* Empty state if no SI rotations generated yet */}
      {!loading && !error && scoredStrategies.length === 0 && (
        <Card className="border-dashed">
          <CardContent className="flex flex-col items-center justify-center py-14 text-center space-y-3">
            <div className="inline-flex h-12 w-12 items-center justify-center rounded-full bg-emerald-500/10">
              <CalendarDays className="h-6 w-6 text-emerald-600" />
            </div>
            <h3 className="text-lg font-serif font-semibold text-foreground">
              Generate a rotation plan to populate your Field Calendar
            </h3>
            <p className="text-sm text-muted-foreground max-w-md">
              The Field Calendar maps your field&apos;s verified 3-year Super
              Intelligence (SI) crop rotation across all 36 months with local
              temperature and rainfall profiles.
            </p>
            <Link href={`/field/${field.id}/rotations`}>
              <Button className="bg-electric hover:bg-electric-dark text-white mt-1">
                <Sparkles className="mr-2 h-4 w-4" />
                Generate Plans in Crop Rotation Lab
              </Button>
            </Link>
          </CardContent>
        </Card>
      )}

      {!loading && !error && calendarModel && activeStrategyResult && activeClimate && (
        <>
          {/* 1. Strategy Selector & Year Switcher Controls */}
          <Card className="border-l-4 border-l-emerald-500">
            <CardContent className="pt-5 pb-4 space-y-4">
              <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
                {/* Strategy Selector Pills */}
                <div className="space-y-1.5 flex-1">
                  <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                    Selected Rotation Strategy (Updates Calendar Automatically)
                  </p>
                  <div className="flex flex-wrap gap-2">
                    {scoredStrategies.map((res) => {
                      const isSelected =
                        res.strategy.id === activeStrategyResult.strategy.id;
                      return (
                        <button
                          key={res.strategy.id}
                          type="button"
                          onClick={() =>
                            setSelectedStrategyId(field.id, res.strategy.id)
                          }
                          className={`inline-flex items-center gap-2 rounded-lg border px-3 py-2 text-xs font-medium transition-colors text-left ${
                            isSelected
                              ? "border-emerald-600 bg-emerald-50/90 text-emerald-950 shadow-sm"
                              : "border-border bg-background text-foreground hover:bg-muted"
                          }`}
                        >
                          <span className="inline-flex h-5 w-5 items-center justify-center rounded-full bg-electric/10 text-[11px] font-bold text-electric">
                            #{res.rank}
                          </span>
                          <span>{res.strategy.name}</span>
                          <span className="rounded bg-white/80 px-1.5 py-0.5 text-[11px] font-bold tabular-nums border border-border/60">
                            {res.overallScore ?? "—"}/100
                          </span>
                        </button>
                      );
                    })}
                  </div>
                </div>

                {/* Year Switcher */}
                <div className="space-y-1.5 shrink-0">
                  <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                    Rotation Year View
                  </p>
                  <div className="inline-flex rounded-lg border border-border bg-muted/40 p-1 text-xs">
                    {(
                      [
                        { id: "all", label: "All 3 Years" },
                        { id: 1, label: "Year 1" },
                        { id: 2, label: "Year 2" },
                        { id: 3, label: "Year 3" },
                      ] as const
                    ).map((tab) => (
                      <button
                        key={String(tab.id)}
                        type="button"
                        onClick={() => setSelectedYearTab(tab.id)}
                        className={`rounded-md px-3 py-1.5 font-semibold transition-colors ${
                          selectedYearTab === tab.id
                            ? "bg-background text-foreground shadow-sm"
                            : "text-muted-foreground hover:text-foreground"
                        }`}
                      >
                        {tab.label}
                      </button>
                    ))}
                  </div>
                </div>
              </div>

              {/* Optional Climate Context Toggle when What-If Scenario is active */}
              {hasActiveWhatIf && whatIfScenario && (
                <div className="flex items-center justify-between gap-3 flex-wrap rounded-md border border-amber-200 bg-amber-50/60 px-3 py-2 text-xs">
                  <div className="flex items-center gap-2 text-amber-900">
                    <SlidersHorizontal className="h-3.5 w-3.5 text-amber-700 shrink-0" />
                    <span>
                      Active What-If Scenario detected:{" "}
                      <strong>{formatScenarioSummary(whatIfScenario)}</strong>
                    </span>
                  </div>
                  <div className="inline-flex rounded border border-amber-300 bg-white p-0.5 text-[11px]">
                    <button
                      type="button"
                      onClick={() => setUseScenarioClimate(false)}
                      className={`rounded px-2 py-0.5 font-medium ${
                        !useScenarioClimate
                          ? "bg-electric text-white"
                          : "text-muted-foreground"
                      }`}
                    >
                      Observed Climate
                    </button>
                    <button
                      type="button"
                      onClick={() => setUseScenarioClimate(true)}
                      className={`rounded px-2 py-0.5 font-medium ${
                        useScenarioClimate
                          ? "bg-amber-600 text-white"
                          : "text-muted-foreground"
                      }`}
                    >
                      Scenario Climate
                    </button>
                  </div>
                </div>
              )}

              {/* Summary Strip */}
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-2.5 pt-2 border-t border-border/60 text-xs">
                <div className="rounded-md bg-muted/35 px-3 py-2">
                  <p className="text-[11px] text-muted-foreground">
                    Living Soil Cover
                  </p>
                  <p className="text-sm font-bold text-foreground tabular-nums">
                    {calendarModel.averageCoveredMonthsPerYear} / 12 mos/yr avg
                  </p>
                </div>
                <div className="rounded-md bg-muted/35 px-3 py-2">
                  <p className="text-[11px] text-muted-foreground">
                    Botanical Families
                  </p>
                  <p className="text-sm font-bold text-foreground">
                    {calendarModel.totalUniqueFamilies.length} (
                    {calendarModel.totalUniqueFamilies.join(", ")})
                  </p>
                </div>
                <div className="rounded-md bg-muted/35 px-3 py-2">
                  <p className="text-[11px] text-muted-foreground">
                    Hemisphere Context
                  </p>
                  <p className="text-sm font-bold capitalize text-foreground">
                    {calendarModel.hemisphere} Hemisphere
                  </p>
                </div>
                <div className="rounded-md bg-muted/35 px-3 py-2">
                  <p className="text-[11px] text-muted-foreground">
                    Weather Profile Used
                  </p>
                  <p className="text-sm font-bold text-foreground">
                    {useScenarioClimate && hasActiveWhatIf
                      ? "Hypothetical Scenario"
                      : "Observed 20-Year Avg"}
                  </p>
                </div>
              </div>
            </CardContent>
          </Card>

          {/* 2. Legend for Timeline Grid */}
          <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border bg-card px-3.5 py-2 text-xs">
            <span className="font-semibold text-foreground">
              Timeline Stage Legend (Month-Level Estimates):
            </span>
            <div className="flex flex-wrap items-center gap-2">
              <span className="inline-flex items-center gap-1 rounded px-2 py-0.5 text-[11px] font-medium bg-electric text-white">
                Plant: Est. Planting Month
              </span>
              <span className="inline-flex items-center gap-1 rounded px-2 py-0.5 text-[11px] font-medium bg-sky-100 text-sky-900 border border-sky-300">
                Grow: Cash Crop Active Growth
              </span>
              <span className="inline-flex items-center gap-1 rounded px-2 py-0.5 text-[11px] font-medium bg-emerald-100 text-emerald-900 border border-emerald-300">
                Cover: Living Cover Crop
              </span>
              <span className="inline-flex items-center gap-1 rounded px-2 py-0.5 text-[11px] font-medium bg-amber-500 text-white">
                Crit.: Sensitive Growth Stage
              </span>
              <span className="inline-flex items-center gap-1 rounded px-2 py-0.5 text-[11px] font-medium bg-indigo-600 text-white">
                Harv / Term: Harvest or Termination
              </span>
            </div>
          </div>

          {/* 3. Year-by-Year Timeline Visualization + Crop Season Details */}
          <div className="space-y-6">
            {visibleYears.map((yr) => (
              <Card key={yr.year} className="overflow-hidden">
                <CardHeader className="pb-3 bg-muted/25 border-b border-border/60">
                  <div className="flex items-center justify-between gap-2 flex-wrap">
                    <div className="flex items-center gap-2">
                      <span className="inline-flex h-7 w-7 items-center justify-center rounded-md bg-electric text-white text-xs font-bold">
                        Y{yr.year}
                      </span>
                      <div>
                        <CardTitle className="text-base font-semibold text-foreground">
                          Year {yr.year} Rotation Sequence
                        </CardTitle>
                        <CardDescription className="text-xs">
                          {yr.yearSummary}
                        </CardDescription>
                      </div>
                    </div>
                    <span className="rounded-full bg-emerald-50 px-2.5 py-0.5 text-xs font-semibold text-emerald-800 border border-emerald-200">
                      {yr.coveredMonthsCount} / 12 months with active crop cover
                    </span>
                  </div>
                </CardHeader>

                <CardContent className="pt-4 space-y-5">
                  {/* 12-Month Visual Timeline Grid with Monthly Climate Strip */}
                  <div className="overflow-x-auto">
                    <div className="min-w-[680px] space-y-1.5">
                      {/* Month Header + Monthly Temp & Rain Strip */}
                      <div className="grid grid-cols-12 gap-1 text-center">
                        {yr.months.map((m) => (
                          <div
                            key={m.month}
                            className="rounded-md border border-border/70 bg-muted/30 px-1 py-1.5"
                          >
                            <p className="text-xs font-bold text-foreground">
                              {m.monthShort}
                            </p>
                            <p className="text-[10px] text-accent-red font-medium tabular-nums">
                              {fmt(m.avgTempC, 1)}°C
                            </p>
                            <p className="text-[10px] text-electric font-medium tabular-nums">
                              {fmt(m.totalPrecipMm, 0)}mm
                            </p>
                          </div>
                        ))}
                      </div>

                      {/* Gantt Bars for Each Season in This Year */}
                      {yr.seasons.map((sea) => (
                        <div
                          key={`${yr.year}-${sea.seasonIndex}-${sea.cropId}`}
                          className="space-y-1 pt-1"
                        >
                          <div className="flex items-center justify-between text-xs px-0.5">
                            <span className="font-semibold text-foreground flex items-center gap-1.5">
                              <span
                                className={`inline-block h-2 w-2 rounded-full ${
                                  sea.cropType === "cover"
                                    ? "bg-emerald-500"
                                    : sea.cropType === "fallow"
                                    ? "bg-slate-400"
                                    : "bg-electric"
                                }`}
                              />
                              {sea.cropName}{" "}
                              <span className="text-muted-foreground font-normal">
                                ({sea.seasonLabel} · {sea.monthRangeLabel})
                              </span>
                            </span>
                            <span className="text-[11px] text-muted-foreground">
                              {sea.seasonClimate.conditionSummary}
                            </span>
                          </div>

                          <div className="grid grid-cols-12 gap-1">
                            {CALENDAR_MONTH_NAMES.map((mName, idx) => {
                              const monthNum = idx + 1;
                              const role = sea.monthRoles[monthNum];
                              if (!role) {
                                return (
                                  <div
                                    key={monthNum}
                                    className="h-7 rounded border border-dashed border-border/50 bg-muted/15"
                                    title={`${mName}: Inactive for ${sea.cropName}`}
                                  />
                                );
                              }
                              return (
                                <div
                                  key={monthNum}
                                  className={`h-7 rounded border px-1 flex items-center justify-center text-[10px] font-semibold tracking-tight ${roleColorClasses(
                                    sea.cropType,
                                    role
                                  )}`}
                                  title={`${mName}: ${sea.cropName} — ${roleShortBadge(role)}`}
                                >
                                  {roleShortBadge(role)}
                                </div>
                              );
                            })}
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>

                  {/* Detailed Crop Cards for Year */}
                  <div className="grid gap-3 md:grid-cols-2">
                    {yr.seasons.map((sea) => (
                      <SeasonCalendarDetailCard
                        key={`${yr.year}-${sea.seasonIndex}`}
                        season={sea}
                      />
                    ))}
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>

          {/* 4. Transparent Date & Climate Data Note */}
          <div className="rounded-lg border border-border bg-muted/35 p-4 text-xs text-muted-foreground space-y-1">
            <p className="font-semibold text-foreground flex items-center gap-1.5">
              <Info className="h-4 w-4 text-electric shrink-0" />
              About Planting &amp; Harvest Timing Estimates
            </p>
            <p className="leading-relaxed">
              fallo never fabricates exact calendar dates. Scheduled planting and
              harvest/termination periods are shown as month ranges and documented
              regional extension / FAO windows adapted to your field&apos;s
              hemisphere. Actual field entry dates depend on real-time topsoil
              temperature, soil moisture trafficability, and cultivar maturity group.
            </p>
          </div>
        </>
      )}
    </div>
  );
}

function SeasonCalendarDetailCard({
  season,
}: {
  season: CalendarSeasonEntry;
}) {
  const isCover = season.cropType === "cover";
  const isFallow = season.cropType === "fallow";

  return (
    <div className="rounded-lg border border-border bg-card p-3.5 space-y-2.5 text-xs">
      <div className="flex items-start justify-between gap-2">
        <div>
          <div className="flex items-center gap-1.5 flex-wrap">
            <span
              className={`rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${
                isCover
                  ? "bg-emerald-50 text-emerald-700 border border-emerald-200"
                  : isFallow
                  ? "bg-slate-100 text-slate-700"
                  : "bg-sky-50 text-sky-800 border border-sky-200"
              }`}
            >
              {isCover ? "Cover Crop" : isFallow ? "Managed Fallow" : "Cash Crop"}
            </span>
            <h4 className="text-sm font-semibold text-foreground">
              {season.cropName}
            </h4>
            {season.family !== "None" && (
              <span className="text-[11px] text-muted-foreground">
                ({season.family})
              </span>
            )}
          </div>
          <p className="text-muted-foreground mt-0.5">{season.activity}</p>
        </div>

        <span className="rounded bg-muted px-2 py-0.5 text-[11px] font-semibold text-foreground shrink-0">
          {season.monthRangeLabel}
        </span>
      </div>

      {/* Planting & Harvest/Termination Windows */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 rounded-md bg-muted/35 p-2.5">
        <div>
          <p className="text-[10px] font-semibold uppercase text-muted-foreground flex items-center gap-1">
            <Sprout className="h-3 w-3 text-emerald-600" />
            Planting Period
          </p>
          <p className="font-medium text-foreground mt-0.5">
            {season.documentedPlantingWindow}
          </p>
          <p className="text-[10px] text-muted-foreground">
            Scheduled start: {season.estimatedPlantingMonthName}
          </p>
        </div>
        <div>
          <p className="text-[10px] font-semibold uppercase text-muted-foreground flex items-center gap-1">
            <Clock className="h-3 w-3 text-indigo-600" />
            {season.endActionLabel}
          </p>
          <p className="font-medium text-foreground mt-0.5">
            {season.documentedHarvestOrTerminationWindow}
          </p>
          <p className="text-[10px] text-muted-foreground">
            Scheduled end: {season.estimatedEndMonthName}
          </p>
        </div>
      </div>

      {/* Growing-Season Climate Conditions */}
      <div className="rounded-md border border-border/60 bg-background p-2.5 space-y-1">
        <p className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
          Growing-Period Climate Conditions ({season.monthRangeLabel})
        </p>
        <div className="flex flex-wrap gap-x-4 gap-y-1 text-[11px]">
          <span className="flex items-center gap-1">
            <Thermometer className="h-3.5 w-3.5 text-accent-red" />
            Mean:{" "}
            <strong className="text-foreground tabular-nums">
              {fmt(season.seasonClimate.avgTempC, 1)} °C
            </strong>{" "}
            {season.seasonClimate.minMonthlyTempC !== null &&
              season.seasonClimate.maxMonthlyTempC !== null && (
                <span className="text-muted-foreground tabular-nums">
                  ({fmt(season.seasonClimate.minMonthlyTempC, 1)}–
                  {fmt(season.seasonClimate.maxMonthlyTempC, 1)} °C)
                </span>
              )}
          </span>
          <span className="flex items-center gap-1">
            <Droplets className="h-3.5 w-3.5 text-electric" />
            Cumulative Rain:{" "}
            <strong className="text-foreground tabular-nums">
              {fmt(season.seasonClimate.totalPrecipMm, 0)} mm
            </strong>
          </span>
          {season.seasonClimate.avgSolarMj !== null && (
            <span className="flex items-center gap-1">
              <Sun className="h-3.5 w-3.5 text-amber-500" />
              Solar:{" "}
              <strong className="text-foreground tabular-nums">
                {fmt(season.seasonClimate.avgSolarMj, 1)} MJ/m²/d
              </strong>
            </span>
          )}
        </div>
        <p className="text-[11px] text-muted-foreground pt-0.5">
          Water demand: <span className="font-medium text-foreground">{season.waterDemand}</span> ·
          Drought tolerance:{" "}
          <span className="font-medium text-foreground">{season.droughtTolerance}</span> ·{" "}
          {season.nitrogenSummary}
        </p>
      </div>

      {/* Sensitive Growth Stages */}
      {season.sensitiveStages.length > 0 && (
        <div className="space-y-1">
          {season.sensitiveStages.map((st) => (
            <div
              key={st.stageKey}
              className="rounded bg-amber-50/90 border border-amber-200/80 px-2.5 py-1.5 text-[11px] text-amber-950"
            >
              <p className="font-semibold">
                Critical Stage ({st.monthNames.join(", ")}): {st.stageLabel}
              </p>
              <p className="text-amber-900/90">{st.note}</p>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function CalendarSkeleton() {
  return (
    <div className="space-y-6">
      <Card>
        <CardContent className="pt-5 space-y-3">
          <Skeleton className="h-5 w-64" />
          <Skeleton className="h-10 w-full rounded-lg" />
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <Skeleton className="h-6 w-48" />
        </CardHeader>
        <CardContent className="space-y-4">
          <Skeleton className="h-32 w-full rounded-md" />
          <div className="grid gap-3 md:grid-cols-2">
            <Skeleton className="h-36 w-full rounded-lg" />
            <Skeleton className="h-36 w-full rounded-lg" />
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
