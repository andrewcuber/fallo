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
  DEFAULT_PRIORITIES,
} from "@/lib/rotation-scoring";

export interface StoredRotations {
  /** Raw generated strategies (not pre-scored, so priority changes can re-run scoring locally) */
  strategies: RotationStrategy[];
  generatedAt: string;
  agGroup: string;
  version: string;
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
 */
export function applyFieldRotationsUpdate(
  fields: Field[],
  activeField: Field | null,
  id: string,
  rotations: StoredRotations | null
): { fields: Field[]; activeField: Field | null } {
  const nextFields = fields.map((f) =>
    f.id === id ? { ...f, generatedRotations: rotations } : f
  );
  const nextActiveField =
    activeField && activeField.id === id
      ? { ...activeField, generatedRotations: rotations }
      : activeField;
  return { fields: nextFields, activeField: nextActiveField };
}

function loadFields(): Field[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) return parsed;
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
    const id = `${Date.now()}`;
    const newField: Field = { ...field, id };
    setFields((prev) => [...prev, newField]);
    setActiveFieldState(newField);
    return newField;
  }, []);

  const setFieldRotations = useCallback((id: string, rotations: StoredRotations | null) => {
    setFields((prev) =>
      prev.map((f) => (f.id === id ? { ...f, generatedRotations: rotations } : f))
    );
    setActiveFieldState((prev) =>
      prev && prev.id === id ? { ...prev, generatedRotations: rotations } : prev
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
