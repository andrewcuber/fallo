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
  DEFAULT_PRIORITIES,
  isVerifiedAiStrategyForField,
} from "@/lib/rotation-scoring";
import { normalizeCoordinates } from "@/lib/coordinates";

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
  const [isLoaded, setIsLoaded] = useState(false);

  useEffect(() => {
    const saved = loadFields();
    const activeId = loadActiveId();
    const savedPriorities = loadPriorities();
    setFields(saved);
    setPrioritiesState(savedPriorities);
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
  }, []);

  const setActiveField = useCallback((field: Field | null) => {
    setActiveFieldState(field);
  }, []);

  const removeField = useCallback((id: string) => {
    setFields((prev) => prev.filter((f) => f.id !== id));
    setActiveFieldState((prev) => (prev?.id === id ? null : prev));
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
