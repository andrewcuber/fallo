# GEMINI.md — fallo Developer Guide

## Project Identity
**fallo** is an agricultural decision-support application for farmers and extension advisors exploring 3-year crop rotation strategies adapted to local climate patterns, topsoil properties, and farm priorities.

## Session Start Checklist
1. Read `docs/PROJECT_BRIEF.md` for full product vision and data sources.
2. Read `docs/ROADMAP.md` for milestone history and architecture context.
3. Understand the active feature requirements and data-transparency constraints before making code changes.

## Core Development Rules
- **Do not invent scientific data.** Crop traits must cite documented sources (USDA ARS/NASS, FAO, university extension, international agricultural research centers).
- **Label all model outputs honestly.** Present suitability scores as **decision-support heuristics**, not calibrated yield or economic predictions.
- **Distinguish real data from modeled or regional proxies.** NASA POWER is regional climate context (`~55 km` grid). USDA SSURGO provides US polygon soil survey data; outside SSURGO coverage, `fallo` uses clearly labeled macro-regional 0–30 cm topsoil reference estimates compiled from published FAO HWSD v2.2 and ISRIC SoilGrids v2.0 regional summaries.
- **Handle all failures gracefully.** Every API call needs a timeout, abort handling, and fallback UI. Never crash on external service failure.
- **Keep the UI accessible, responsive, and farmer-focused.** Keep technical data-source provenance in expandable details sections and `/data-sources` so the primary visual hierarchy focuses on agricultural insights.
- **Cache aggressively.** NASA POWER and soil responses are cached server-side (LRU keyed by normalized `lat`/`lon` rounded to 2 decimals, 1-hour TTL) and shared client-side across field tabs via `useFieldEnvironmentalData`.

## Six-Feature Field Workflow
1. **Climate Fingerprint (`/field/[id]/climate`):** 20-year temperature, precipitation, solar radiation, baseline vs. recent window comparison, and summer drought/heat stress metrics.
2. **Soil Profile (`/field/[id]/soil`):** 0–30 cm topsoil texture, organic matter, pH, available water capacity (AWC), drainage, and slope (live USDA SSURGO in the US; clearly labeled regional topsoil reference estimates elsewhere).
3. **Crop Rotation Lab (`/field/[id]/rotations`):** Agroecological classification, Farmer Priority Weights sliders, Super Intelligence (SI)-assisted 3-year rotation generation, deterministic validation, and 5-factor suitability comparison.
4. **What-If Climate Simulator (`/field/[id]/simulator`):** Interactive temperature (`°C`) and rainfall (`%` or `mm/yr`) scenario adjustments (`lib/what-if-simulator.ts`), side-by-side baseline vs. scenario agro-zone and rotation comparisons, crop-specific suitability shift explanations, and explicit user-triggered scenario SI generation.
5. **Field Calendar (`/field/[id]/calendar`):** Hemisphere-aware 3-year × 12-month visual timeline (`lib/field-calendar.ts`) showing planting windows, active growth, documented sensitive growth stages, harvest/termination windows, and growing-season climate conditions.
6. **Historical Climate Analogues (`/field/[id]/analogues`):** Standardized multi-metric similarity engine (`lib/climate-analogues.ts`) ranking real past growing seasons from the field's 20-year NASA POWER archive against recent conditions, a specific historical year, or an active What-If scenario.

## Agroecological Grouping & Deterministic Validation
- **Agroecological Classification (`lib/agro-classifier.ts`):** Classifies fields across 13 global agroecological zones (`temperate_humid`, `semi_arid_temperate`, `subtropical_humid`, `temperate_mediterranean`, `tropical_humid`, `tropical_subhumid`, `tropical_savanna`, `tropical_monsoon`, `tropical_semi_arid`, `arid_irrigated`, `continental_cool`, `boreal_subarctic`, `highland_montane`, `unknown`) along with moisture zone, estimated Length of Growing Period (LGP), and water regime.
- **Separation of Concerns:** Keep agroecological similarity (`applicableGroups`) distinct from geographic/regional crop availability (`supportedRegions` + `lib/region.ts`).
- **Authoritative Deterministic Validation (`lib/rotation-validator.ts`):** SI-assisted proposals (`lib/rotation-generator.ts`, `/api/rotations/generate`) may only arrange verified catalog crops for the field's group and region. Every proposal must pass `validateProposal()` (backed by `ROTATION_COMPATIBILITY_RULES`) before being scored, displayed, or persisted.
- **Runtime SI Provider (`GeminiDeveloperProvider` in `lib/rotation-generator.ts`):**
  - Uses Google's official `@google/genai` SDK (`new GoogleGenAI({ apiKey, httpOptions })`) on the Node.js server runtime (`export const runtime = "nodejs"; export const maxDuration = 120;` in `app/api/rotations/generate/route.ts`).
  - Reads API key exclusively from `process.env.GEMINI_API_KEY` on the server (no Google Cloud billing or Vertex AI required).
  - Configurable model via `process.env.GEMINI_MODEL` (defaults to `gemini-2.5-flash`).
  - Enforces timeouts, AbortSignal forwarding, and clear quota-exceeded / rate limit handling with API key redaction.
- **No Predefined Static Rotations in Farmer UI:** Farmer-facing pages never display static predefined 3-year rotations as field recommendations. Before generation, the Crop Rotation Lab displays the field profile, Farmer Priority Weights, the **Generate Field-Specific Plans** action, and the three Planning Objectives (*Soil Health Building*, *Water Resilience*, *Crop Diversity & Pest Break*).

## Stack Versions (Locked)
- Node.js 22+ LTS
- Next.js 15 (App Router)
- React 19
- TypeScript 5.7
- Tailwind CSS 3.4 + shadcn/ui primitives
- `@google/genai` 3.3.x
- Recharts 3.x
- Leaflet 1.9 + React Leaflet 5.x
- Zod 3.x
- `lru-cache` 10.x
