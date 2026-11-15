"use client";

import React, {
  createContext,
  useContext,
  useState,
  useCallback,
  useEffect,
} from "react";
import { type RotationStrategy } from "@/lib/rotation-scoring";

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
  addField: (field: Omit<Field, "id" | "generatedRotations">) => Field;
  setActiveField: (field: Field | null) => void;
  removeField: (id: string) => void;
  setFieldRotations: (id: string, rotations: StoredRotations | null) => void;
  isLoaded: boolean;
}

const STORAGE_KEY = "fallo-fields";
const ACTIVE_KEY = "fallo-active-field-id";

const FieldContext = createContext<FieldContextValue | undefined>(undefined);

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

export function FieldProvider({ children }: { children: React.ReactNode }) {
  const [fields, setFields] = useState<Field[]>([]);
  const [activeField, setActiveFieldState] = useState<Field | null>(null);
  const [isLoaded, setIsLoaded] = useState(false);

  useEffect(() => {
    const saved = loadFields();
    const activeId = loadActiveId();
    setFields(saved);
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
  }, []);

  const setActiveField = useCallback((field: Field | null) => {
    setActiveFieldState(field);
  }, []);

  const removeField = useCallback(
    (id: string) => {
      setFields((prev) => prev.filter((f) => f.id !== id));
      if (activeField?.id === id) {
        setActiveFieldState(null);
      }
    },
    [activeField]
  );

  return (
    <FieldContext.Provider
      value={{ fields, activeField, addField, setActiveField, removeField, setFieldRotations, isLoaded }}
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
