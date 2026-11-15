# CLAUDE.md — fallo Developer Guide

## Project Identity
**fallo** is a decision-support tool for farmers exploring crop rotation strategies adapted to local climate and soil.

## Session Start Checklist
1. Read `docs/PROJECT_BRIEF.md` for full product vision and data sources.
2. Read `docs/ROADMAP.md` for current milestone status and next steps.
3. Do not proceed with implementation until you understand the milestone objective.

## Core Development Rules
- **Do not invent scientific data.** Crop traits must cite documented sources (USDA NASS, university extension).
- **Label all model outputs honestly.** Present scores as **decision-support heuristics**, not validated recommendations.
- **Distinguish real data from modeled proxies.** NASA POWER is regional climate context (~55 km grid). SoilGrids are 250 m predictions with uncertainty.
- **Handle all failures gracefully.** Every API call needs a timeout and fallback UI. Never crash on external service failure.
- **Do not build features beyond the current milestone.** Stick to the roadmap.
- **Keep the UI accessible and responsive.** Mobile-first; all charts need labels and alt text.
- **Cache aggressively.** NASA POWER responses are large and slow. Use server-side LRU keyed by lat/lon rounded to 2 decimals, 1-hour TTL.

## Scientific Constraints
- NASA POWER = regional context (0.5° grid). Never call it field-level weather.
- Climate Fingerprint requires 10–20 year baseline + separate recent 3-year window.
- Do **not** compute a single generic "soil health score." Present properties individually with uncertainty.
- Do **not** present arbitrary rotation scores as validated. Label every score as a heuristic.
- Do **not** show a fixed regional rotation (e.g., North Carolina Piedmont) as a personalized recommendation for fields elsewhere.

## Long-Term Agroecological Grouping & Field-Specific Rotation Direction
- **Agroecological Classification (`lib/agro-classifier.ts`):** Fields are classified into agroecological groups (`temperate_humid`, `semi_arid_temperate`, `subtropical_humid`, `temperate_mediterranean`, `unknown`). Long-term classification will incorporate:
  1. Climate and temperature patterns
  2. Rainfall and seasonality
  3. Soil texture, AWC, and drainage
  4. Water availability and irrigation assumptions
  5. Growing-season length and elevation
- **Current Provisional State:** Until source-backed quantitative soil thresholds are established, `classifyAgGroup()` remains an honest, provisional climate-driven classifier that records soil properties for context/confidence without inventing soil thresholds or claiming full validation.
- **Separation of Concerns:** Keep agroecological similarity (`applicableGroups`) distinct from geographic, regulatory, or practical regional crop availability (`supportedRegions` + `lib/region.ts`).
- **Authoritative Deterministic Validation (`lib/rotation-validator.ts`):** AI-assisted proposals (`lib/rotation-generator.ts`, `/api/rotations/generate`) may only arrange verified catalog crops for the field's group and region. Every proposal must pass `validateProposal()` (backed by `ROTATION_COMPATIBILITY_RULES`) before being scored, displayed, or persisted.

## Architecture Reminders
- Next.js 15 (App Router) + TypeScript + Tailwind CSS 3.4 + shadcn/ui primitives.
- `/api/climate` proxies NASA POWER with server-side aggregation + caching.
- `/api/soil` queries USDA SSURGO first, falls back to ISRIC SoilGrids with timeout.
- Crop traits in `/data/crops.json` (static, cited).
- Rotation strategies in `/data/rotations.json` (static).
- Client-side scoring engine computes rankings from climate/soil + static crop data.
- Field state persisted in `localStorage` via React Context.
- Map via React Leaflet 5 (React 19 compatible).

## Stack Versions (Locked)
- Node.js 22+ LTS
- Next.js 15
- React 19
- TypeScript 5.7
- Tailwind CSS 3.4
- shadcn/ui primitives (manual)
- Recharts 3.x
- Leaflet 1.9 + React Leaflet 5.x
- zod 3.x
- lru-cache 10.x
