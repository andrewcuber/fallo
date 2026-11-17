"use client";

import React, {
  createContext,
  useContext,
  useState,
  useCallback,
  useEffect,
} from "react";
import {
  type RotationStrategy,
  type FarmerPriorities,
  type AIUsageMetadata,
  type ClimateData as ScoringClimateData,
  type SoilData as ScoringSoilData,
  type HistoricalYearClimateRecord,
  type ClimatePeriodSummary,
  DEFAULT_PRIORITIES,
  isVerifiedAiStrategyForField,
} from "@/lib/rotation-scoring";
import {
  type WhatIfScenario,
  DEFAULT_WHAT_IF_SCENARIO,
} from "@/lib/what-if-simulator";
import { normalizeCoordinates } from "@/lib/coordinates";
import {
  isUsableCachedSoilResponse,
  type SoilDataTier,
  type UsSsurgoFallbackMeta,
} from "@/lib/soil-profile-utils";

export interface RawClimateApiResponse {
  location: {
    lat: number;
    lon: number;
    elevation: number | null;
  };
  periods: {
    startYear: number;
    endYear: number;
    recentStart: number;
    recentEnd: number;
    baselineStart: number;
    baselineEnd: number;
  };
  fullRecord: ClimatePeriodSummary;
  baseline: ClimatePeriodSummary;
  recent: ClimatePeriodSummary;
  historicalYears?: HistoricalYearClimateRecord[];
  stressMetrics: ScoringClimateData["stressMetrics"];
  units: {
    temp: string;
    precip: string;
    solar: string;
    wetness: string;
  };
  source: string;
  spatialResolution: string;
  dataQuality: {
    totalDays: number;
    validDays: Record<string, number>;
    missingDays: Record<string, number>;
  };
  parameters: string[];
  warnings: string[];
  cached?: boolean;
}

export interface RawSoilHorizon {
  depthTop: number;
  depthBottom: number;
  sand: number | null;
  silt: number | null;
  clay: number | null;
  om: number | null;
  ph: number | null;
  awc: number | null;
}

export interface RawSoilComponent {
  cokey: string;
  name: string;
  percent: number;
  kind: string;
  majcompflag: string | null;
  drainage: string | null;
  slope: number | null;
  horizons: RawSoilHorizon[];
}

export interface RawSoilApiResponse {
  location: { lat: number; lon: number };
  dataTier?: SoilDataTier;
  source: string;
  coverage: string;
  wrbSoilGroup?: string;
  mapUnit: { mukey: string; name: string } | null;
  totalComponentPercent: number;
  components: RawSoilComponent[];
  aggregated: ScoringSoilData["aggregated"];
  dataCoverage: ScoringSoilData["dataCoverage"];
  limitations: string[];
  usSsurgoFallback?: UsSsurgoFallbackMeta;
  cached?: boolean;
}

export function adaptClimateResponse(
  data: RawClimateApiResponse | null
): ScoringClimateData | null {
  if (!data) return null;
  return {
    location: data.location,
    periods: data.periods,
    fullRecord: {
      avgAnnualTemp: data.fullRecord.avgAnnualTemp,
      avgAnnualPrecip: data.fullRecord.avgAnnualPrecip,
      avgDailySolar: data.fullRecord.avgDailySolar,
      monthlyTemp: data.fullRecord.monthlyTemp,
      monthlyPrecip: data.fullRecord.monthlyPrecip,
      monthlySolar: data.fullRecord.monthlySolar,
      annualPrecipTotals: data.fullRecord.annualPrecipTotals,
      precipCV: data.fullRecord.precipCV,
    },
    baseline: data.baseline,
    recent: data.recent,
    historicalYears: data.historicalYears,
    stressMetrics: data.stressMetrics,
    source: data.source,
    spatialResolution: data.spatialResolution,
    limitations: [data.spatialResolution, ...data.warnings],
  };
}

export function adaptSoilResponse(
  data: RawSoilApiResponse | null
): ScoringSoilData | null {
  if (!data) return null;
  return {
    aggregated: data.aggregated,
    dataCoverage: data.dataCoverage,
    totalComponentPercent: data.totalComponentPercent,
    source: data.source,
    limitations: data.limitations,
  };
}

export interface StoredRotations {
  /** Raw generated strategies (not pre-scored, so priority changes can re-run scoring locally) */
  strategies: RotationStrategy[];
  generatedAt: string;
  agGroup: string;
  version: string;
  fieldId?: string;
  aiProvider?: string;
  aiModel?: string;
  validationStatus?: "passed";
  usageMetadata?: AIUsageMetadata;
}

export interface Field {
  id: string;
  name: string;
  lat: number;
  lon: number;
  /** Persisted AI-generated or custom rotation proposals for this field */
  generatedRotations?: StoredRotations | null;
  /** Active strategy ID selected by the user for Field Calendar & cross-feature views */
  selectedStrategyId?: string | null;
}

interface FieldContextValue {
  fields: Field[];
  activeField: Field | null;
  priorities: FarmerPriorities;
  setPriorities: (priorities: FarmerPriorities) => void;
  addField: (field: Omit<Field, "id" | "generatedRotations">) => Field;
  setActiveField: (field: Field | null) => void;
  removeField: (id: string) => void;
  setFieldRotations: (id: string, rotations: StoredRotations | null) => void;
  getSelectedStrategyId: (fieldId: string) => string | null;
  setSelectedStrategyId: (fieldId: string, strategyId: string | null) => void;
  getFieldWhatIfScenario: (fieldId: string) => WhatIfScenario;
  setFieldWhatIfScenario: (fieldId: string, scenario: WhatIfScenario) => void;
  resetFieldWhatIfScenario: (fieldId: string) => void;
  getFieldScenarioRotations: (fieldId: string) => StoredRotations | null;
  setFieldScenarioRotations: (
    fieldId: string,
    rotations: StoredRotations | null
  ) => void;
  isLoaded: boolean;
}

const STORAGE_KEY = "fallo-fields";
const ACTIVE_KEY = "fallo-active-field-id";
const PRIORITIES_KEY = "fallo-priorities";

const FieldContext = createContext<FieldContextValue | undefined>(undefined);

/**
 * Pure state-transition helper for updating a field's generatedRotations across
 * both the stored `fields` list and `activeField` reference.
 *
 * When `rotations` is provided, only verified AI-generated strategies for the target
 * field are accepted. If `rotations` has no valid strategies, existing valid saved
 * plans on the field are preserved rather than overwritten with empty/invalid data.
 */
export function applyFieldRotationsUpdate(
  fields: Field[],
  activeField: Field | null,
  id: string,
  rotations: StoredRotations | null
): { fields: Field[]; activeField: Field | null } {
  if (rotations !== null) {
    const validStrategies = rotations.strategies.filter((s) =>
      isVerifiedAiStrategyForField(s, id)
    );
    if (validStrategies.length === 0) {
      return { fields, activeField };
    }
    const sanitized: StoredRotations = {
      ...rotations,
      strategies: validStrategies,
      fieldId: id,
      validationStatus: "passed",
    };
    const nextFields = fields.map((f) =>
      f.id === id ? { ...f, generatedRotations: sanitized } : f
    );
    const nextActiveField =
      activeField && activeField.id === id
        ? { ...activeField, generatedRotations: sanitized }
        : activeField;
    return { fields: nextFields, activeField: nextActiveField };
  }

  const nextFields = fields.map((f) =>
    f.id === id ? { ...f, generatedRotations: null } : f
  );
  const nextActiveField =
    activeField && activeField.id === id
      ? { ...activeField, generatedRotations: null }
      : activeField;
  return { fields: nextFields, activeField: nextActiveField };
}

/**
 * Normalize and migrate any stored Field records so wrapped longitudes (e.g. -250 -> 110)
 * become canonical [-180, 180) and invalid coordinates are filtered out.
 */
export function sanitizeStoredFields(rawList: unknown[]): Field[] {
  const sanitized: Field[] = [];
  for (const item of rawList) {
    if (!item || typeof item !== "object") continue;
    const rec = item as Partial<Field>;
    if (typeof rec.id !== "string" || typeof rec.name !== "string") continue;
    const norm = normalizeCoordinates(rec.lat, rec.lon);
    if (!norm.valid) continue;
    sanitized.push({
      ...(rec as Field),
      lat: norm.lat,
      lon: norm.lon,
    });
  }
  return sanitized;
}

function loadFields(): Field[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) return sanitizeStoredFields(parsed);
    return [];
  } catch {
    return [];
  }
}

function saveFields(fields: Field[]) {
  if (typeof window === "undefined") return;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(fields));
  } catch {
    // ignore
  }
}

function loadActiveId(): string | null {
  if (typeof window === "undefined") return null;
  try {
    return localStorage.getItem(ACTIVE_KEY);
  } catch {
    return null;
  }
}

function saveActiveId(id: string | null) {
  if (typeof window === "undefined") return;
  try {
    if (id) localStorage.setItem(ACTIVE_KEY, id);
    else localStorage.removeItem(ACTIVE_KEY);
  } catch {
    // ignore
  }
}

function loadPriorities(): FarmerPriorities {
  if (typeof window === "undefined") return { ...DEFAULT_PRIORITIES };
  try {
    const raw = localStorage.getItem(PRIORITIES_KEY);
    if (!raw) return { ...DEFAULT_PRIORITIES };
    const parsed = JSON.parse(raw) as Partial<FarmerPriorities>;
    if (
      parsed &&
      typeof parsed.waterSuitability === "number" &&
      typeof parsed.nitrogenContribution === "number" &&
      typeof parsed.soilCoverage === "number" &&
      typeof parsed.diversityPestBreak === "number" &&
      typeof parsed.climateRiskResilience === "number"
    ) {
      return {
        waterSuitability: parsed.waterSuitability,
        nitrogenContribution: parsed.nitrogenContribution,
        soilCoverage: parsed.soilCoverage,
        diversityPestBreak: parsed.diversityPestBreak,
        climateRiskResilience: parsed.climateRiskResilience,
      };
    }
    return { ...DEFAULT_PRIORITIES };
  } catch {
    return { ...DEFAULT_PRIORITIES };
  }
}

function savePriorities(priorities: FarmerPriorities) {
  if (typeof window === "undefined") return;
  try {
    localStorage.setItem(PRIORITIES_KEY, JSON.stringify(priorities));
  } catch {
    // ignore
  }
}

export function FieldProvider({ children }: { children: React.ReactNode }) {
  const [fields, setFields] = useState<Field[]>([]);
  const [activeField, setActiveFieldState] = useState<Field | null>(null);
  const [priorities, setPrioritiesState] = useState<FarmerPriorities>({ ...DEFAULT_PRIORITIES });
  const [selectedStrategyMap, setSelectedStrategyMap] = useState<Record<string, string | null>>({});
  const [whatIfScenarioMap, setWhatIfScenarioMap] = useState<Record<string, WhatIfScenario>>({});
  const [scenarioRotationsMap, setScenarioRotationsMap] = useState<
    Record<string, StoredRotations | null>
  >({});
  const [isLoaded, setIsLoaded] = useState(false);

  useEffect(() => {
    const saved = loadFields();
    const activeId = loadActiveId();
    const savedPriorities = loadPriorities();
    setFields(saved);
    setPrioritiesState(savedPriorities);
    const initialStrategyMap: Record<string, string | null> = {};
    for (const f of saved) {
      if (f.selectedStrategyId) {
        initialStrategyMap[f.id] = f.selectedStrategyId;
      }
    }
    setSelectedStrategyMap(initialStrategyMap);
    if (activeId) {
      const found = saved.find((f) => f.id === activeId) ?? null;
      setActiveFieldState(found);
    }
    setIsLoaded(true);
  }, []);

  useEffect(() => {
    if (isLoaded) saveFields(fields);
  }, [fields, isLoaded]);

  useEffect(() => {
    if (isLoaded) saveActiveId(activeField?.id ?? null);
  }, [activeField, isLoaded]);

  useEffect(() => {
    if (isLoaded) savePriorities(priorities);
  }, [priorities, isLoaded]);

  const setPriorities = useCallback((next: FarmerPriorities) => {
    setPrioritiesState(next);
  }, []);

  const addField = useCallback((field: Omit<Field, "id" | "generatedRotations">) => {
    const norm = normalizeCoordinates(field.lat, field.lon);
    const canonicalLat = norm.valid ? norm.lat : field.lat;
    const canonicalLon = norm.valid ? norm.lon : field.lon;
    const id = `${Date.now()}`;
    const newField: Field = { ...field, lat: canonicalLat, lon: canonicalLon, id };
    setFields((prev) => [...prev, newField]);
    setActiveFieldState(newField);
    return newField;
  }, []);

  const setFieldRotations = useCallback((id: string, rotations: StoredRotations | null) => {
    setFields((prev) => applyFieldRotationsUpdate(prev, null, id, rotations).fields);
    setActiveFieldState((prev) =>
      prev ? applyFieldRotationsUpdate([prev], prev, id, rotations).activeField : null
    );
    if (rotations === null) {
      setSelectedStrategyMap((prev) => ({ ...prev, [id]: null }));
    }
  }, []);

  const getSelectedStrategyId = useCallback(
    (fieldId: string): string | null => {
      const fromMap = selectedStrategyMap[fieldId];
      if (fromMap) return fromMap;
      const f = fields.find((item) => item.id === fieldId);
      if (f?.selectedStrategyId) return f.selectedStrategyId;
      return f?.generatedRotations?.strategies?.[0]?.id ?? null;
    },
    [selectedStrategyMap, fields]
  );

  const setSelectedStrategyId = useCallback(
    (fieldId: string, strategyId: string | null) => {
      setSelectedStrategyMap((prev) => ({ ...prev, [fieldId]: strategyId }));
      setFields((prev) =>
        prev.map((f) => (f.id === fieldId ? { ...f, selectedStrategyId: strategyId } : f))
      );
      setActiveFieldState((prev) =>
        prev && prev.id === fieldId ? { ...prev, selectedStrategyId: strategyId } : prev
      );
    },
    []
  );

  const getFieldWhatIfScenario = useCallback(
    (fieldId: string): WhatIfScenario => {
      return whatIfScenarioMap[fieldId] ?? { ...DEFAULT_WHAT_IF_SCENARIO };
    },
    [whatIfScenarioMap]
  );

  const setFieldWhatIfScenario = useCallback(
    (fieldId: string, scenario: WhatIfScenario) => {
      setWhatIfScenarioMap((prev) => ({ ...prev, [fieldId]: scenario }));
    },
    []
  );

  const resetFieldWhatIfScenario = useCallback((fieldId: string) => {
    setWhatIfScenarioMap((prev) => ({
      ...prev,
      [fieldId]: { ...DEFAULT_WHAT_IF_SCENARIO },
    }));
  }, []);

  const getFieldScenarioRotations = useCallback(
    (fieldId: string): StoredRotations | null => {
      return scenarioRotationsMap[fieldId] ?? null;
    },
    [scenarioRotationsMap]
  );

  const setFieldScenarioRotations = useCallback(
    (fieldId: string, rotations: StoredRotations | null) => {
      setScenarioRotationsMap((prev) => ({ ...prev, [fieldId]: rotations }));
    },
    []
  );

  const setActiveField = useCallback((field: Field | null) => {
    setActiveFieldState(field);
  }, []);

  const removeField = useCallback((id: string) => {
    setFields((prev) => prev.filter((f) => f.id !== id));
    setActiveFieldState((prev) => (prev?.id === id ? null : prev));
    setSelectedStrategyMap((prev) => {
      const next = { ...prev };
      delete next[id];
      return next;
    });
    setWhatIfScenarioMap((prev) => {
      const next = { ...prev };
      delete next[id];
      return next;
    });
    setScenarioRotationsMap((prev) => {
      const next = { ...prev };
      delete next[id];
      return next;
    });
  }, []);

  return (
    <FieldContext.Provider
      value={{
        fields,
        activeField,
        priorities,
        setPriorities,
        addField,
        setActiveField,
        removeField,
        setFieldRotations,
        getSelectedStrategyId,
        setSelectedStrategyId,
        getFieldWhatIfScenario,
        setFieldWhatIfScenario,
        resetFieldWhatIfScenario,
        getFieldScenarioRotations,
        setFieldScenarioRotations,
        isLoaded,
      }}
    >
      {children}
    </FieldContext.Provider>
  );
}

export function useField() {
  const ctx = useContext(FieldContext);
  if (!ctx) throw new Error("useField must be used within FieldProvider");
  return ctx;
}

// ============================================================================
// Shared Environmental Data Cache & Hook (Climate + Soil per Coordinate Pair)
// ============================================================================

interface CachedEnvEntry {
  climateRaw: RawClimateApiResponse | null;
  soilRaw: RawSoilApiResponse | null;
  climateError: string | null;
  soilError: string | null;
  fetchedAt: number;
}

const envMemoryCache = new Map<string, CachedEnvEntry>();
const envInFlight = new Map<string, Promise<CachedEnvEntry>>();
const ENV_CACHE_TTL_MS = 15 * 60 * 1000;

function makeCoordKey(lat: number, lon: number): string {
  return `${lat.toFixed(4)},${lon.toFixed(4)}`;
}

async function loadEnvironmentalData(
  lat: number,
  lon: number,
  forceRefresh = false
): Promise<CachedEnvEntry> {
  const key = makeCoordKey(lat, lon);
  if (!forceRefresh) {
    const cached = envMemoryCache.get(key);
    if (
      cached &&
      Date.now() - cached.fetchedAt < ENV_CACHE_TTL_MS &&
      cached.climateRaw &&
      !cached.climateError &&
      cached.soilRaw &&
      !cached.soilError &&
      isUsableCachedSoilResponse(lat, lon, cached.soilRaw)
    ) {
      return cached;
    }
    const inflight = envInFlight.get(key);
    if (inflight) return inflight;
  } else {
    envMemoryCache.delete(key);
  }

  const promise = (async (): Promise<CachedEnvEntry> => {
    let climateRaw: RawClimateApiResponse | null = null;
    let soilRaw: RawSoilApiResponse | null = null;
    let climateError: string | null = null;
    let soilError: string | null = null;

    try {
      const soilUrl = `/api/soil?lat=${lat.toFixed(4)}&lon=${lon.toFixed(4)}${
        forceRefresh ? "&refresh=1" : ""
      }`;
      const [climateRes, soilRes] = await Promise.all([
        fetch(`/api/climate?lat=${lat.toFixed(4)}&lon=${lon.toFixed(4)}`),
        fetch(soilUrl, { cache: "no-store" }),
      ]);

      try {
        const climateJson = await climateRes.json();
        if (!climateRes.ok) {
          climateError = climateJson?.error || `Climate request failed (${climateRes.status})`;
        } else {
          climateRaw = climateJson as RawClimateApiResponse;
        }
      } catch (err) {
        climateError = err instanceof Error ? err.message : "Failed to parse climate response";
      }

      try {
        const soilJson = await soilRes.json();
        if (!soilRes.ok) {
          soilError = soilJson?.error || `Soil request failed (${soilRes.status})`;
        } else {
          const candidateSoil = soilJson as RawSoilApiResponse;
          if (isUsableCachedSoilResponse(lat, lon, candidateSoil)) {
            soilRaw = candidateSoil;
          } else {
            soilError =
              "Received an invalid regional fallback soil profile for a U.S. coordinate. Please retry to query coordinate-specific soil data.";
          }
        }
      } catch (err) {
        soilError = err instanceof Error ? err.message : "Failed to parse soil response";
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Network error";
      climateError = msg;
      soilError = msg;
    }

    const entry: CachedEnvEntry = {
      climateRaw,
      soilRaw,
      climateError,
      soilError,
      fetchedAt: Date.now(),
    };
    if (
      climateRaw &&
      !climateError &&
      soilRaw &&
      !soilError &&
      isUsableCachedSoilResponse(lat, lon, soilRaw)
    ) {
      envMemoryCache.set(key, entry);
    }
    return entry;
  })();

  envInFlight.set(key, promise);
  try {
    return await promise;
  } finally {
    envInFlight.delete(key);
  }
}

export function useFieldEnvironmentalData(field: Field | null | undefined) {
  const coordKey = field ? makeCoordKey(field.lat, field.lon) : null;
  const rawInitialCached = coordKey ? envMemoryCache.get(coordKey) ?? null : null;
  const initialSoilUsable = Boolean(
    field &&
      rawInitialCached?.soilRaw &&
      isUsableCachedSoilResponse(field.lat, field.lon, rawInitialCached.soilRaw)
  );
  const initialCached =
    rawInitialCached && initialSoilUsable ? rawInitialCached : null;

  const [climateRaw, setClimateRaw] = useState<RawClimateApiResponse | null>(
    initialCached?.climateRaw ?? null
  );
  const [soilRaw, setSoilRaw] = useState<RawSoilApiResponse | null>(
    initialCached?.soilRaw ?? null
  );
  const [climateError, setClimateError] = useState<string | null>(
    initialCached?.climateError ?? null
  );
  const [soilError, setSoilError] = useState<string | null>(
    initialCached?.soilError ?? null
  );
  const [loading, setLoading] = useState<boolean>(
    Boolean(field && (!initialCached?.climateRaw || !initialCached?.soilRaw))
  );

  const fetchEnv = useCallback(
    async (forceRefresh = false) => {
      if (!field) return;
      if (!forceRefresh) {
        const cached = envMemoryCache.get(makeCoordKey(field.lat, field.lon));
        if (
          cached &&
          Date.now() - cached.fetchedAt < ENV_CACHE_TTL_MS &&
          cached.climateRaw &&
          !cached.climateError &&
          cached.soilRaw &&
          !cached.soilError &&
          isUsableCachedSoilResponse(field.lat, field.lon, cached.soilRaw)
        ) {
          setClimateRaw(cached.climateRaw);
          setSoilRaw(cached.soilRaw);
          setClimateError(cached.climateError);
          setSoilError(cached.soilError);
          setLoading(false);
          return;
        }
      }

      setLoading(true);
      setClimateError(null);
      setSoilError(null);
      const entry = await loadEnvironmentalData(field.lat, field.lon, forceRefresh);
      setClimateRaw(entry.climateRaw);
      setSoilRaw(entry.soilRaw);
      setClimateError(entry.climateError);
      setSoilError(entry.soilError);
      setLoading(false);
    },
    [field]
  );

  useEffect(() => {
    if (field) {
      fetchEnv(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [field?.id, field?.lat, field?.lon]);

  const climate = React.useMemo(() => adaptClimateResponse(climateRaw), [climateRaw]);
  const soil = React.useMemo(() => adaptSoilResponse(soilRaw), [soilRaw]);

  const refresh = useCallback(() => fetchEnv(true), [fetchEnv]);

  return {
    climateRaw,
    soilRaw,
    climate,
    soil,
    loading,
    error: climateError,
    climateError,
    soilError,
    refresh,
  };
}
