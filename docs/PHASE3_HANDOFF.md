# Phase 3 — Rotation Lab Handoff Report

**Date:** 2026-11-14
**Status:** Completed
**Next Step:** Do not proceed to Phase 4 without explicit approval.

---

## Phase 3 Redesign Summary

An 8-task redesign was completed to make the Rotation Lab genuinely region-aware, fix two bugs, improve labeling/navigation, and redesign strategies as generic archetypes. All tasks preserve existing architecture, scoring model, and visual theme unless explicitly changed.

### Task 1 — Missing fields bug fixed
- `isLoaded` hydration guard in `FieldProvider` confirmed working.
- Port mismatch behavior (dev server 3000 vs production 3001) documented; existing `useEffect` + `isLoaded` pattern already handles this correctly.

### Task 2 — Map crash fixed
- `components/field-creator.tsx` preserves raw `latText`/`lonText` string state.
- `parseFloat` only runs on blur/save; Leaflet is guarded against NaN propagation.
- Invalid coordinates show a coordinate-overlay warning instead of crashing the map.

### Task 3 — Archetype strategies redesigned
- `data/rotations.json` rewritten with three generic archetypes:
  - `soil_health_building` — Soil Health Building (corn -> soybean -> wheat + heavy legume cover: hairy vetch, crimson clover, forage radish + winter oat)
  - `water_resilience` — Water Resilience (grain sorghum -> sunflower -> soybean + pearl millet cover; drought-tolerant cash crops, shifted water demand)
  - `crop_diversity` — Crop Diversity & Pest Break (corn -> sunflower -> soybean with clover/radish + oat + vetch covers; maximizes botanical family diversity: Poaceae -> Asteraceae -> Fabaceae)
- Each strategy includes `archetype` (machine tag), generic `description`, and `regionExample` ("NC Piedmont example").
- Agronomic warnings preserved:
  - Fusarium head blight risk when wheat follows sorghum.
  - Sclerotinia host stacking between sunflower and soybean (moderate risk).
  - Single soybean appearance avoids SCN pressure.

### Task 4 — Region-aware crop catalog
- `data/crops.json` updated with `supportedRegions` arrays per crop (e.g., `["us_southeast", "us_midwest"]`).
- New `lib/region.ts`: coarse US bounding-box region detector (`us_southeast`, `us_midwest`, `us_northeast`, `us_great_plains`, `us_southwest`).
- Scoring engine (`lib/rotation-scoring.ts`) updated:
  - `scoreStrategy` and `scoreAllStrategies` accept optional `regionTag`.
  - `getUnsupportedCrops()` identifies crops in a strategy not documented for the detected region.
  - `addRegionLimitations()` adds notes to all factor scores when unsupported crops are present.
- UI region banner: amber `Card` on Rotation Lab page when `!isSupportedRegion(lat, lon)`, advising users to treat strategies as archetype examples and substitute locally adapted alternatives.

### Task 5 — AI rotation architecture evaluated & documented
- A 7-step structured pipeline for future AI-generated rotations is documented in this file (see "AI Rotation Architecture Pipeline" below).
- **AI integration is NOT implemented.** This is architectural evaluation only, ensuring that if AI is ever added, it follows deterministic validation, transparent scoring, and honest labeling.

### Task 6 — Data Confidence renamed to Data Coverage
- All references updated: `overallConfidence` -> `overallCoverage`; labels `High|Moderate|Limited` -> `Good|Partial|Limited`.
- Files touched: `lib/rotation-scoring.ts`, `components/rotation/strategy-card.tsx`, `components/rotation/factor-comparison.tsx`, `components/rotation/explain-panel.tsx`, `app/field/[id]/rotations/page.tsx`, `test-scoring.ts`.
- Tooltip updated: "Reflects data completeness, not agronomic certainty."
- Suitability labels (`overallFitLabel`: Strong/Moderate/Weak fit) remain separate from coverage labels.

### Task 7 — Dedicated strategy detail page
- New route: `app/field/[id]/rotations/[strategyId]/page.tsx`.
- Fetches climate + soil independently; computes scores; renders `StrategyDetail`.
- `StrategyCard` now links to detail page instead of toggling inline detail view.
- Works on refresh; back navigation to Rotation Lab preserved.
- Full build generates 10 pages (was 9).

---

## What Was Built

### 1. Data Layer

**`data/crops.json`** — Complete 11-crop library with region support
| Crop | Family | Type | Key Traits |
|------|--------|------|------------|
| Field Corn | Poaceae | Cash | High water demand, heavy N feeder, moderate drought tolerance |
| Soybean | Fabaceae | Cash | Low N demand (fixes ~15–30 lb/ac residual), moderate water |
| Soft Red Winter Wheat | Poaceae | Cash | Low-moderate water, low N demand, Fusarium risk after sorghum |
| Grain Sorghum | Poaceae | Cash | Low water, high heat tolerance, produces allelopathic residue |
| Sunflower | Asteraceae | Cash | Deep roots, moderate drought, Sclerotinia host |
| Cereal Rye | Poaceae | Cover | Low water, N immobilization risk, excellent winter coverage |
| Crimson Clover | Fabaceae | Cover | Low water, high N credit (~60–75 lb/ac), good winter kill |
| Hairy Vetch | Fabaceae | Cover | Low-moderate water, very high N credit (~80–100 lb/ac), winter hardy |
| Forage Radish | Brassicaceae | Cover | Low water, bio-drill effect, winter kill |
| Pearl Millet | Poaceae | Cover/Cash | Very low water, extreme heat tolerance |
| Winter Oat | Poaceae | Cover | Low N demand, good winter coverage, moderate water |

Each crop includes:
- `waterDemand`, `droughtTolerance`, `heatTolerance`
- `nitrogenBehavior` with `residualNcredit` after termination
- `residue` properties (persistence, allelopathy)
- `sensitivePeriods` (germination, flowering, grain fill temperature ranges)
- `growingWindow`
- `diseasePestNotes`
- `supportedRegions` (array of region tags)
- Cited `source` per trait (USDA NASS, university extension)

**`data/rotations.json`** — Three complete 3-year archetype strategies
1. **`soil_health_building`** — Corn -> Soybean -> Wheat. Heavy legume integration: hairy vetch before corn, crimson clover before soybean, forage radish + winter oat before wheat. Focus: building organic N and soil structure.
2. **`water_resilience`** — Grain Sorghum -> Sunflower -> Soybean. Forage radish between sorghum and soybean; pearl millet cover after wheat. Focus: minimizing water stress with drought-tolerant cash crops and shifted water demand.
3. **`crop_diversity`** — Corn -> Sunflower -> Soybean. Clover/radish pre-corn, oat fall after corn; oat winter + vetch fall after sunflower; vetch winter-spring before soybean. Focus: maximizing botanical family diversity (Poaceae -> Asteraceae -> Fabaceae) for pest break.

Each strategy includes:
- `archetype` (machine tag), generic `description`, `regionExample`
- `years[0..2].seasons` (Fall, Spring, Summer, Winter) with crop + activity + months
- `tradeoffs.advantages`, `disadvantages`, `operational`
- `tradeoffs.warnings`: explicit agronomic risks

**`lib/region.ts`** — Coarse US region detector
- Bounding boxes for 5 US regions.
- `detectRegion(lat, lon)` returns `{ tag, label }` or `null`.
- `isSupportedRegion(lat, lon)` boolean helper.
- Intentionally conservative: anything outside known boxes is unsupported.

### 2. API Extensions

**`/api/climate`** (augmented, not replaced)
- Added `StressMetrics` to the response:
  - `summerDrySpells`: Jun–Aug max consecutive days with precip < 1.0 mm
  - `summerHeatDays`: Jul–Aug days with T2M_MAX > 35°C
  - `springPrecip`: Mar–May total precipitation
  - `growingSeasonPrecip`: May–Aug total precipitation
- These are computed server-side during the same NASA POWER fetch to avoid duplicate API calls.
- Existing caching, error handling, and data-quality metrics unchanged.

**`/api/soil`** — Unchanged. Already returns aggregated 0–30 cm properties, drainage, slope, and data-coverage percentages needed by the scoring engine.

### 3. Scoring Engine

**`lib/rotation-scoring.ts`** — Pure TypeScript, no React dependencies
- Types: `Crop`, `RotationStrategy`, `ClimateData`, `SoilData`, `FactorScore`, `StrategyResult`, `FarmerPriorities`
- Coverage tiers: `Good` | `Partial` | `Limited` based on missing-data limitations per factor
- Region awareness:
  - `scoreStrategy(..., regionTag?)` and `scoreAllStrategies(..., regionTag?)`
  - `getUnsupportedCrops(strategy, regionTag)` flags crops not in `supportedRegions`
  - `addRegionLimitations(factorScores, unsupportedCrops)` adds notes: "Strategy includes crops not documented for this region: ... This is an archetype example; crops should be substituted with locally adapted alternatives."
- Scoring functions:

| Factor | Inputs | Key Logic |
|--------|--------|-----------|
| **Water Suitability** | GS precip, dry spells, heat days, AWC, crop water demand / tolerance | Higher scores when crop tolerance >= site stress; penalties for heat days > 10 and dry spells > 7; AWC bonus/penalty |
| **Nitrogen Contribution** | Legume sequence credits, non-legume N demand penalties, rye immobilization risk | Credits: vetch 80–100, clover 60–75, soybean 15–30 lb/ac; penalties for corn/sorghum N demand; rye after high-N crop immobilization risk |
| **Soil Coverage** | Living cover months, residue persistence, slope, winter cover | 12-month living cover = best; persistent residue bonuses; slope > 6% penalizes low-coverage strategies; winter bare = penalty |
| **Diversity / Pest Break** | Family sequence, disease sequence penalties | Rewards >=3 families over 3 years; penalizes repeated Poaceae; Fusarium (wheat after sorghum), Sclerotinia (sunflower + soybean), SCN (soybean frequency) |
| **Climate Risk Resilience** | Historical dry spells, heat days, crop tolerance | Average of per-crop resilience scores based on drought + heat tolerance vs site severity |

- **Overall score**: `sum(factorScore * normalizedWeight)` where weights are normalized from farmer priority sliders.
- **No ET₀/ET꜀ calculation** — insufficient humidity/radiation/wind inputs for FAO Penman-Monteith.
- **No income scoring** — market prices not available.

### 4. UI Components

| Component | File | Purpose |
|-----------|------|---------|
| `PrioritySliders` | `components/rotation/priority-sliders.tsx` | 5 range sliders (Water, Nitrogen, Soil Coverage, Diversity, Climate Risk) with reset button |
| `StrategyCard` | `components/rotation/strategy-card.tsx` | Overall score badge, archetype tag, region example note, 5 factor bars, timeline preview, warnings, expandable explain panel, link to detail page |
| `ExplainPanel` | `components/rotation/explain-panel.tsx` | Per-factor details: inputs seen, positive/negative contributors, rubric, citations |
| `StrategyDetail` | `components/rotation/strategy-detail.tsx` | Full 3-year plan with crop schedules, growing windows, warnings, factor summaries, aggregated sources |
| `FactorComparison` | `components/rotation/factor-comparison.tsx` | Side-by-side table comparing all 3 strategies across all 5 factors |
| `RotationTimeline` | `components/rotation/rotation-timeline.tsx` | Visual Year-1 month coverage bar |

**Rotation Lab page:** `app/field/[id]/rotations/page.tsx`
- Fetches climate + soil in parallel on field change
- Adapts API response types to scoring-engine types
- Computes `scoreAllStrategies` in `useEffect` when data or priorities change
- Computes `regionTag` from field lat/lon; shows region banner when unsupported
- Renders: header, priority sliders, strategy cards (responsive 3-column), factor comparison table, scoring disclaimer
- States: loading skeleton, error with retry, incomplete-data message

**Strategy Detail page:** `app/field/[id]/rotations/[strategyId]/page.tsx`
- Independently fetches climate + soil, computes scores, finds matching strategy by URL param
- Renders `StrategyDetail result={result}` with back link to Rotation Lab
- Includes `DetailSkeleton`, error retry state, and "Strategy not found" fallback
- Works on direct navigation and refresh

**Nav update:** `components/app-shell.tsx`
- Data Sources removed from main sidebar nav; added as footer link.

### 5. Testing

**Deterministic unit test:** `test-scoring.ts`
- Runs standalone with `npx tsx test-scoring.ts`
- Uses Rowan County, NC–like mock climate + soil data
- 9 tests, all passing:
  1. Default priorities return 3 strategies
  2. All strategies have overall scores
  3. All factor scores in 0–100 range
  4. Water resilience strategy >=40 on water and beats soil_health
  5. Soil health strategy >=50 on nitrogen
  6. Fusarium warning present in water resilience tradeoffs
  7. Priority adjustments change scores
  8. Missing soil data produces lower-coverage scores gracefully
  9. All factor scores include interpretation and rubric metadata

**Live API test:** Rowan County, NC (35.67, -80.47)
- `/api/climate` — 200 OK with stress metrics
- `/api/soil` — 200 OK with SSURGO Enon-Urban land complex data
- Page shell (`/field/demo/rotations`) — 200 OK, correct chunk loading
- Detail page (`/field/demo/rotations/water_resilience`) — 200 OK, renders detail view

**Build verification:**
- `npx tsc --noEmit` — zero errors
- `npm run lint` — zero warnings
- `npm run build` — 10 pages generated successfully (including new detail route)

---

## Files Changed / Created

### New files
- `data/crops.json` (rewritten with `supportedRegions`)
- `data/rotations.json` (rewritten with archetypes)
- `lib/region.ts` (created)
- `lib/rotation-scoring.ts` (created)
- `components/rotation/priority-sliders.tsx` (created)
- `components/rotation/strategy-card.tsx` (created)
- `components/rotation/explain-panel.tsx` (created)
- `components/rotation/factor-comparison.tsx` (created)
- `components/rotation/rotation-timeline.tsx` (created)
- `components/rotation/strategy-detail.tsx` (created)
- `app/field/[id]/rotations/[strategyId]/page.tsx` (created)
- `test-scoring.ts` (created)

### Modified files
- `app/api/climate/route.ts` — added `StressMetrics` interface and `computeStressMetrics()`
- `app/field/[id]/rotations/page.tsx` — complete rewrite from placeholder to full Rotation Lab with region banner
- `components/rotation/strategy-card.tsx` — archetype badge, region example, link to detail page
- `components/app-shell.tsx` — moved Data Sources to footer link
- `docs/ROADMAP.md` — marked Milestone 3 complete with redesign tasks
- `docs/PROJECT_BRIEF.md` — updated MVP checklist, navigation, architecture, limitations

---

## What Was Explicitly NOT Built (Per Specification)

- **AI-generated rotation recommendations** — Architecture documented (see below) but no AI integration implemented.
- **What-If Simulator** — Requires UI for hypothetical climate adjustment and re-scoring. Deferred to Phase 4 or beyond.
- **Field Calendar** — Timeline visualization of multi-year planting/harvest schedules across strategies. Deferred.
- **Climate Analogues** — Historical season matching. Deferred.
- **Income Stability scoring** — Requires market price data not available in MVP.
- **ET₀/ET꜀ calculation** — Requires humidity, wind, radiation inputs not present in NASA POWER response at this aggregation level.
- **Custom rotation builder** — Future feature.

---

## AI Rotation Architecture Pipeline (Evaluated, Not Implemented)

If AI-generated rotation recommendations are added in the future, the following 7-step pipeline ensures scientific honesty, deterministic validation, and transparent scoring:

1. **Gather verified data** — Only use cited crop traits from `data/crops.json` and climate/soil API responses. No hallucinated agronomic data.
2. **Supply AI with supported crops** — Filter crop list by `supportedRegions` for the detected region. The AI never sees crops not documented for the user's region.
3. **Structured proposal** — AI returns a machine-readable rotation proposal (JSON) with crop IDs, years, seasons, and rationale strings.
4. **Deterministic validation** — A pure TypeScript validator checks the proposal against hard rules:
   - No repeated families more than allowed
   - No known disease sequences (wheat after sorghum, etc.)
   - All crop IDs exist in `data/crops.json`
   - Seasonal windows do not overlap impossibly
   - Validator returns `valid: boolean` and `violations: string[]`.
5. **Transparent scoring** — The existing `scoreAllStrategies` engine scores the AI proposal alongside the three archetypes. The AI proposal is just another `RotationStrategy` object.
6. **Honest labeling** — AI proposals are labeled "AI-suggested archetype" with a disclaimer: "This sequence was generated by an AI model from verified crop data. It has not been field-tested. Treat it as a starting point for discussion with your extension agent."
7. **User override** — Farmer can edit any crop in the proposal. Edits re-run the validator and scoring engine instantly.

**Why this matters:**
- Prevents the AI from inventing crops or traits.
- Keeps the scoring engine as the single source of truth for numeric scores.
- Makes the AI's role transparent: it suggests sequences; the engine evaluates them.
- Region awareness prevents recommending crops with no documented support for the user's area.

---

## Known Limitations & Honest Labels

1. **NASA POWER resolution** (~55 km grid) is regional context, not field-level weather. All climate-derived scores are heuristics.
2. **SSURGO data** is map-unit averages, not field samples. The Enon-Urban land complex at Rowan County has 50% Enon + 30% Urban land; aggregated properties represent only the Enon component's horizons.
3. **SoilGrids fallback** remains paused. Non-US locations continue to receive honest unavailable state.
4. **Scores are decision-support heuristics (0–100)**, not validated crop-yield predictions. The UI states this explicitly in the scoring disclaimer.
5. **Data coverage levels reflect data availability**, not agronomic certainty. "Good" coverage simply means all inputs were present.
6. **Region support is limited to coarse US bounding boxes.** Fields outside these regions still see scores, but the app flags when a strategy includes crops not documented for the detected region.
7. **Strategies are archetype examples, not prescriptions.** The `regionExample` (NC Piedmont) is illustrative. Users in other regions should substitute crops with locally adapted alternatives that match the same functional roles.

---

## Next Steps for Phase 4 (When Approved)

1. Polish & Demo Prep:
   - Error boundaries and refined loading skeletons
   - Final responsive verification on mobile
   - Field Calendar component (visualize 3-year planting/harvest windows)
   - Climate Analogues (match recent conditions to historical seasons)
   - Pre-load a default demo field on first visit
   - README with setup, architecture, and demo script
   - Performance audit (bundle size, cache effectiveness)
   - Lighthouse >= 80 on Performance + Accessibility
   - Vercel preview deployment

2. Optional improvements surfaced during Phase 3:
   - Add more rotation strategies (e.g., organic vegetable rotation)
   - Expand crop library with specialty crops (cotton, peanuts)
   - Integrate soil moisture stress into Water Suitability scoring
   - Implement the AI rotation pipeline (architecture already documented)

---

## Test Commands

```bash
# TypeScript
npx tsc --noEmit

# Lint
npm run lint

# Build
npm run build

# Scoring engine unit tests
npx tsx test-scoring.ts

# Dev server
npm run dev
# Then test APIs:
# curl "http://localhost:3000/api/climate?lat=35.6700&lon=-80.4700"
# curl "http://localhost:3000/api/soil?lat=35.6700&lon=-80.4700"
```
