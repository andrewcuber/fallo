# fallo — Development Roadmap

> Status: `⏳ Not Started` | `🔄 In Progress` | `✅ Completed` | `⛔ Blocked`

---

## Milestone 0 — Foundation (The First Working Website)
**Objective:** Build a polished, navigable website with field creation, localStorage persistence, a responsive sidebar, and honest placeholder pages for all planned features.

**Status:** ✅ Completed

**Deliverables:**
- [x] Next.js 15 + TypeScript + Tailwind CSS 3.4 scaffolded.
- [x] Design system with brand palette (forest green, cream, sand, mint, brown) and serif/sans typography (Lora + Inter via next/font).
- [x] Responsive sidebar navigation (desktop) / slide-out drawer (mobile) with all six sections.
- [x] React Leaflet 5 map component with click-to-set and draggable marker.
- [x] Field creation: name, lat/lon, Nominatim geocoding, coordinate validation.
- [x] Field state persisted in localStorage via React Context (survives refresh).
- [x] `/fields` page: list, select active, delete fields.
- [x] `/fields/new` page: full field creation form.
- [x] `/field/[id]/climate`, `/soil`, `/rotations` with enhanced honest empty states.
- [x] `/data-sources` page: transparent data-source documentation with limitations.
- [x] Overview dashboard (`/`) with hero, saved fields preview, and six feature preview cards (Climate Fingerprint, Soil Profile, Rotation Lab, What-If Simulator, Field Calendar, Climate Analogues).
- [x] `data/crops.json` skeleton with 8 crops.
- [x] `data/rotations.json` skeleton with 3 strategies.

**Post-Inspection Design Updates (applied after initial review):**
- [x] Removed NASA Space Apps challenge branding from visible UI (hero badge + sidebar footer). Attribution kept in docs and data-source citations.
- [x] Adopted cool light-gray content background (#E9EDF1) with dark navy sidebar (#080D19), electric blue accents (#4D9FFF), and cyan highlights (#62D5E8).
- [x] Added `suppressHydrationWarning` to `<html>` in `app/layout.tsx` to eliminate the Next.js hydration mismatch warning caused by a browser extension.

**Testing Requirements:**
- [x] `npx tsc --noEmit` passes (zero errors).
- [x] `npm run lint` passes (zero errors).
- [x] `npm run build` passes (all 7 pages generated successfully).
- [x] Dev server starts and serves all routes (verified via curl).
- [x] Map renders and responds to clicks (verified manually in browser; dynamic `ssr: false` import prevents prerender crash).
- [x] Field creation saves to localStorage (verified by refreshing after creation; data persists).
- [x] Navigation works on desktop and mobile (verified via responsive inspector and manual click-through).

**Remaining Before Completion:**
- ~~Fix any TypeScript or build errors.~~ None.
- ~~Update this roadmap with final test results.~~ Done.
- **Stop here.** Do not proceed to Milestone 1 without explicit approval.

---

## Milestone 1 — Climate Fingerprint
**Objective:** Integrate NASA POWER and display a meaningful 20-year climate profile with a 3-year recent comparison.

**Status:** ✅ Completed

**Deliverables:**
- [x] `/api/climate` route: fetches POWER 20-year + 3-year data, aggregates, caches via LRU.
- [x] Server-side aggregation: monthly averages/totals, annual precip totals, precip CV, recent vs baseline comparison.
- [x] `ClimateProfile` component (`/field/[id]/climate`): metric cards, monthly temp line chart, monthly precip bar chart, annual precip trend bar chart, delta indicators.
- [x] Graceful error handling for POWER timeouts (25s), fill values (`-999`), and invalid coordinates.
- [x] Data-source label and resolution disclaimer on every page.
- [x] Source attribution and data-quality notes (valid days / missing days).

**API Design:**
- Query: `GET /api/climate?lat={lat}&lon={lon}`
- Returns: `location`, `periods` (baseline + recent), `baseline`/`recent` stats, `units`, `source`, `spatialResolution`, `dataQuality`, `parameters`, `warnings`
- Server-side LRU cache keyed by rounded lat/lon + year range, TTL 24 hours.
- One NASA POWER request per call (20-year daily), then split into baseline and recent in-memory.

**Testing Results:**
- Rowan County, NC (35.67, -80.47): baseline ~15.6°C, ~1170 mm/yr, CV ~19%. Recent ~16.1°C, ~1159 mm/yr.
- Kenya (-1.29, 36.82): ~20.2°C, ~571 mm/yr, CV ~26%.
- São Paulo, Brazil (-23.55, -46.63): ~19.7°C, ~1320 mm/yr.
- Invalid lat (95°): returns 400 with validation message.
- Cache verified: second identical request returns `cached: true`.

**Build Verification:**
- `npx tsc --noEmit`: zero errors.
- `npm run lint`: zero warnings.
- `npm run build`: all 8 pages generated successfully.

**Post-Review Notes:**
- Monthly precipitation bug fixed: was multiplying average daily precip by total days across all years (giving multi-year totals). Now correctly sums each year’s monthly total, then averages across years.

**Targeted Improvement (2026-11-14):**
- [x] Added `fullRecord` period to API response containing full 20-year (2006–2025) averages computed from all entries.
- [x] Fixed monthly precip zero-filter bug: removed `.filter((total) => total > 0)` that incorrectly dropped valid zero-precipitation months.
- [x] Missing months now return `null` instead of `0` in all monthly arrays.
- [x] Solar unit aligned with NASA POWER metadata: AG community `ALLSKY_SFC_SW_DWN` already returns MJ/m^2/day, so the erroneous ×3.6 conversion was removed. All solar values now pass through raw.
- [x] Frontend displays full-record averages as prominent main values on metric cards; baseline + recent shown beneath with delta arrows retained.
- [x] Display precision standardized: temperature 1 decimal, precipitation whole mm, solar 1 decimal, CV 1 decimal, % changes whole percent, coordinates 4 decimals.
- [x] Added full-record monthly profile table below charts for planting-window reference.
- [x] Fixed `ReferenceLine x` type mismatch (now uses numeric `x` instead of string).
- [x] Verified API for Rowan County, NC (35.67, -80.47): all monthly arrays length 12, full record 15.7°C / 1168 mm / 16.2 MJ/m^2/day / CV 18.4%.
- [x] Build verification: `npx tsc --noEmit` zero errors, `npm run lint` zero warnings, `npm run build` all 8 pages generated successfully.

**Inspection Checkpoint:**
- Review climate data for accuracy. Verify 20-year baseline is present.
- **Stop here.** Do not proceed to Milestone 2 without explicit approval.

---

## Milestone 2 — Soil Profile
**Objective:** Fetch and display soil data with SSURGO as primary source. Non-US locations receive an honest unavailable state because ISRIC SoilGrids REST API v2.0 is paused (late 2024).

**Status:** ✅ Completed

**Deliverables:**
- [x] `/api/soil` route: SSURGO spatial query + tabular properties (`mapunit`, `component`, `chorizon`).
- [x] Depth-weighted averages over 0–30 cm per component; map-unit aggregation by `comppct_r`.
- [x] Missing/null values preserved as null, never treated as zero.
- [x] ISRIC SoilGrids REST v2.0 investigated and confirmed paused; WCS endpoint tested and not accessible for automated queries.
- [x] Non-US locations return honest unavailable state with limitations explaining SSURGO is US-only and global fallback is paused.
- [x] `SoilProfile` page (`/field/[id]/soil`): texture bar, metric cards (OM, pH, AWC, slope, drainage), component composition table, horizon tables, limitation warnings, source/disclaimer footer.
- [x] Loading skeleton, error state with retry, missing-data UI (`—`).
- [x] Server-side LRU cache (24h TTL) keyed by rounded lat/lon.
- [x] Data-sources page updated with accurate NASA POWER resolution wording (varies by parameter) and SoilGrids pause notice (WCS/WebDAV documented alternatives).
- [x] Data-coverage transparency: API returns `totalComponentPercent`, per-property coverage percentages, and coverage-aware limitations.
- [x] Frontend component table displays horizon count per component and known/unaccounted percentage total.

**Testing Results:**
- Rowan County, NC (35.67, -80.47): returns full SSURGO data with coverage audit.
  - Map unit: "Enon-Urban land complex, 2 to 10 percent slopes"
  - Components: Enon 50% (3 horizons), Urban land 30% (no horizons) = 80% known.
  - Unaccounted: 20%.
  - Depth-weighted 0-30 cm properties represent 50% of map unit (Enon only; Urban land excluded because it has no horizons).
  - Drainage represents 50% of map unit (Enon only).
  - Slope represents 80% of map unit (both components).
  - Aggregated 0-30 cm: sand ~58.9%, silt ~18.6%, clay ~22.4%, OM ~0.91%, pH ~5.9, AWC ~0.13.
  - Drainage: Well drained. Slope: ~6%.
- Kenya (-1.29, 36.82): returns honest unavailable state.
  - SSURGO spatial query times out (~20 s) as expected for non-US points.
  - Response includes limitations explaining US-only coverage and SoilGrids pause.
- Cache verified: second identical request returns from LRU cache.
- Invalid lat (95°): returns 400 with validation message.

**Build Verification:**
- `npx tsc --noEmit`: zero errors.
- `npm run lint`: zero warnings.
- `npm run build`: all pages generated successfully.

**Inspection Checkpoint:**
- Review soil data accuracy. Verify non-US behavior is honest.
- **Stop here.** Do not proceed to Milestone 3 without explicit approval.

---

## Milestone 3 — Rotation Lab
**Objective:** Build a transparent, data-driven rotation comparison engine with a documented 11-crop library, three complete rotation strategies, a 5-factor heuristic scoring system, priority sliders, and the full Rotation Lab UI.

**Status:** ✅ Completed

**Phase 3 Redesign (2026-11-14):**
- [x] **Task 1 — Missing fields bug fixed:** `isLoaded` hydration guard confirmed working in `FieldProvider`. Port mismatch behavior documented. No code changes required; existing guard pattern is correct.
- [x] **Task 2 — Map crash fixed:** `field-creator.tsx` now preserves raw coordinate text, guards Leaflet against NaN propagation, and shows an overlay when coordinates are invalid (e.g., lone `-` sign).
- [x] **Task 3 — Archetype strategies redesigned:** `data/rotations.json` rewritten with three generic archetypes:
  - `soil_health_building` — Soil Health Building (legume-heavy, residue-focused)
  - `water_resilience` — Water Resilience (drought-tolerant cash crops, shifted water demand)
  - `crop_diversity` — Crop Diversity & Pest Break (maximizes botanical family diversity: Poaceae -> Asteraceae -> Fabaceae)
  - Each strategy now has `archetype` (machine tag), generic `description`, and `regionExample` (NC Piedmont example only).
- [x] **Task 4 — Region-aware crop catalog:** `data/crops.json` updated with `supportedRegions` per crop (e.g., `us_southeast`, `us_midwest`). `lib/region.ts` adds coarse US region detector. Scoring engine passes a `regionTag` to `scoreAllStrategies`; unsupported crops add a `dataCoverageLimitations` note. UI shows an honest "Region not yet supported" banner when the field is outside known US regions.
- [x] **Task 5 — AI rotation architecture evaluated & documented:** A 7-step structured pipeline is documented in `docs/PHASE3_HANDOFF.md` (Gather verified data -> Supply AI with supported crops -> Structured proposal -> Deterministic validation -> Transparent scoring). **AI integration is NOT implemented** — this is architectural evaluation only.
- [x] **Task 6 — Data Confidence renamed to Data Coverage:** All references updated across `lib/rotation-scoring.ts`, `strategy-card.tsx`, `factor-comparison.tsx`, `explain-panel.tsx`, `app/field/[id]/rotations/page.tsx`, and `test-scoring.ts`. Labels are now Good / Partial / Limited. Tooltip and disclaimer text updated to clarify that coverage reflects data availability, not agronomic certainty. Suitability labels (Strong/Moderate/Weak fit) remain separate.
- [x] **Task 7 — Dedicated strategy detail page:** Created `app/field/[id]/rotations/[strategyId]/page.tsx`. Main Rotation Lab (`/field/[id]/rotations`) is now a comparison dashboard. Strategy cards link to detail pages. Detail pages fetch their own climate/soil data, compute scores, and render `StrategyDetail`. Works on refresh; back navigation preserved.

**Deliverables:**
- [x] `data/crops.json` fully populated with 11 crops, each with `family`, `type`, `waterDemand`, `droughtTolerance`, `nitrogenBehavior`, `residue`, `sensitivePeriods`, `growingWindow`, `diseasePestNotes`, `supportedRegions`, and cited `source` entries per trait.
- [x] `data/rotations.json` fully populated with 3 complete 3-year strategies using generic archetypes:
  - `soil_health_building` (corn–soybean–wheat + heavy legume cover)
  - `water_resilience` (sorghum–sunflower–soybean with drought-tolerant crops)
  - `crop_diversity` (corn–sunflower–soybean maximizing family diversity)
- [x] Each strategy includes seasonal timelines (Year 1–3), tradeoffs (advantages, disadvantages, operational notes), and agronomic warnings (Fusarium head blight, Sclerotinia host stacking).
- [x] Server-side climate stress metrics added to `/api/climate`: summer dry spells, summer heat days, spring precipitation, growing-season precipitation.
- [x] Pure TypeScript scoring engine (`lib/rotation-scoring.ts`) with five factors:
  1. **Water Suitability** — crop demand vs GS precip, dry spells, heat days, AWC
  2. **Nitrogen Contribution** — legume credits, N-demand penalties, rye immobilization risk
  3. **Soil Coverage** — living-cover ratio, residue persistence, slope, winter coverage
  4. **Diversity / Pest Break** — family diversity rewards, sequence penalties
  5. **Climate Risk Resilience** — crop tolerance vs historical dry spells / heat days
- [x] `PrioritySliders` component: 5 sliders (default equal weights), instant recalculation with normalized weights.
- [x] `StrategyCard` component: overall score badge, archetype tag, region example note, factor bars, timeline, warnings, expandable explain panel, link to dedicated detail page.
- [x] `ExplainPanel` component: inputs, positive/negative contributors, rubric, and citations per factor.
- [x] `FactorComparison` component: side-by-side table of all factors across all strategies.
- [x] `RotationTimeline` component: visual Year-1 month coverage bar.
- [x] `StrategyDetail` component: full 3-year plan with crop schedules, month bars, management considerations, warnings, factor summaries, aggregated sources.
- [x] Full Rotation Lab page (`/field/[id]/rotations`) replacing the placeholder: fetches climate/soil in parallel, adapts API types to scoring types, computes results client-side, renders all components with scoring disclaimer and region banner.
- [x] New detail route (`/field/[id]/rotations/[strategyId]`) with standalone data fetching and `StrategyDetail` rendering.
- [x] Data Sources link moved from main sidebar to footer.
- [x] Deterministic unit-test script (`test-scoring.ts`) using Rowan County-like mock data; all 9 tests pass.

**Testing Results:**
- Rowan County, NC (35.67, -80.47):
  - `/api/climate` returns stress metrics: 8.5 avg max dry days, 12.3 heat days/year, 292 mm spring precip, 418 mm growing-season precip.
  - `/api/soil` returns SSURGO data: Enon series, well drained, AWC ~0.13, slope ~6%.
  - All three strategies score and rank deterministically.
  - Water resilience strategy scores >=40 on water suitability and beats or ties soil_health.
  - Soil health strategy scores >=50 on nitrogen contribution.
  - Fusarium warning is present in water resilience tradeoffs.
  - Priority adjustments change overall scores as expected.
  - Missing soil data gracefully degrades to lower-coverage scores.
  - Region detection works for US Southeast; unsupported lat/lons trigger region banner.

**Build Verification:**
- `npx tsc --noEmit`: zero errors.
- `npm run lint`: zero warnings.
- `npm run build`: all 10 pages generated successfully (including new `/field/[id]/rotations/[strategyId]` route).

**Out of Scope (Do Not Build):**
- What-If Simulator, Field Calendar, and Climate Analogues remain for future milestones.
- No ET₀/ET꜀ calculation (insufficient humidity/radiation/wind inputs for FAO Penman-Monteith).
- No income-stability scoring without real market-price data.

**Post-Milestone 3 — Constrained AI Rotation Infrastructure & Field-Specific UX Polish (2026-11-14):**
- [x] **Constrained AI Generation & Deterministic Validation (`e74ceaf`, `c19a6d0`):**
  - Added provisional climate-based agroecological group classifier (`lib/agro-classifier.ts`), authoritative compatibility rules and validator (`lib/rotation-validator.ts`), and AI orchestrator (`lib/rotation-generator.ts` + `/api/rotations/generate`).
  - Enforced strict rejection of invalid proposals, preservation of soft agronomic warnings (Fusarium, SCN, low diversity), timeout/secret redaction in `OpenAICompatibleProvider`, and persistence in `FieldProvider`.
- [x] **Field-Specific Rotation Lab & Progressive Disclosure:**
  - Fixed React duplicate month key in `components/rotation/rotation-timeline.tsx`.
  - Refined visual design with space-gray main content background (`#DCE2E9`), high-contrast white cards, and distinctive restrained accents on the bottom three homepage feature cards.
  - Removed North Carolina Piedmont default labels from strategy overview cards and descriptions.
  - Updated Rotation Lab (`/field/[id]/rotations`) to foreground the field's agroecological profile, verified local crop availability, and three field-specific strategy objectives (*Soil Health Building*, *Water Resilience*, *Crop Diversity & Pest Break*), treating static reference rotations strictly as secondary reference material where regionally applicable.
  - Streamlined strategy overview cards (~10-second read) and strategy detail pages (`Sources & Methodology` and detailed factor rubrics collapsed by default; duplicate sections removed).
- [x] **Long-Term Agroecological Grouping Architecture Recorded:**
  - Documented the multi-factor direction (climate/temperature, rainfall seasonality, soil texture/drainage, water/irrigation assumptions, growing-season length/elevation) while preserving the honest provisional climate-based classifier until source-backed soil thresholds are integrated.
- [x] **Gemini Enterprise Agent Platform Runtime Integration & Removal of Static Rotations from Farmer UI:**
  - Added `GeminiEnterpriseProvider` and `resolveRuntimeAIProvider()` in `lib/rotation-generator.ts` using `@google/genai` (`new GoogleGenAI({ enterprise: true, project, location, httpOptions })`) and Application Default Credentials (ADC).
  - Diagnosed and resolved the 30-second timeout by setting a coordinated 120-second (`120_000` ms) timeout across the SDK (`httpOptions.timeout`), provider `AbortController` (`config.abortSignal`), Next.js route (`export const maxDuration = 120`), and client `fetch`, while configuring `thinkingConfig: { thinkingLevel: "LOW" }`, removing unsupported `temperature`/`topP`/`topK` parameters, and disabling automatic SDK retries (`retryOptions: { attempts: 1 }`).
  - Removed all predefined static 3-year rotations from farmer-facing pages (`/field/[id]/rotations` and `/field/[id]/rotations/[strategyId]`). Before generation, only field agroecological context, data coverage, available crops, priority sliders, and the 3 planning objectives (`No AI-generated plan yet`) are shown; after generation, only deterministically validated AI-generated plans for that field (`scoreVerifiedAiStrategies`) with provenance and real token usage metadata are displayed.

**Inspection Checkpoint:**
- Review scoring logic for scientific credibility. Verified: all scores labeled as heuristics; no invented agronomic weights; disease-sequence penalties are documented.
- **Stop here.** Do not proceed to Milestone 4 without explicit approval.

---

## Milestone 4 — Polish & Demo Prep
**Objective:** Make the app polished, responsive, and demo-ready. Deliver Field Calendar and Climate Analogues.

**Status:** ⏳ Not Started

**Deliverables:**
- [ ] Loading skeletons and error boundaries.
- [ ] Responsive layout (mobile + desktop) final verification.
- [ ] "About / Data Sources" page with full citations.
- [ ] Default demo field pre-loaded on first visit.
- [ ] **Field Calendar:** visualize planting windows, harvest periods, and rotation schedules.
- [ ] **Climate Analogues:** match current or hypothetical conditions against historically similar growing seasons.
- [ ] Performance audit: verify caching, bundle size.
- [ ] README with setup, architecture, and demo script.
- [ ] Final build passes `next build` without errors.

**Testing Requirements:**
- Lighthouse score >= 80 on Performance and Accessibility.
- Manual end-to-end workflow test.
- Build succeeds and deploys to Vercel preview.

**Inspection Checkpoint:**
- Final review. Confirm all milestones are complete.
- **Stop here.** Do not proceed beyond MVP without explicit approval.

---

## Outstanding Issues
- None yet.

## Next Milestone
**Milestone 4 — Polish & Demo Prep.** Deliver loading skeletons/error boundaries, responsive final verification, Field Calendar, Climate Analogues, demo field pre-load, and README.
