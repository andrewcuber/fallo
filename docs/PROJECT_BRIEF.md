# fallo — Project Brief

> **Confirmed** = decision made and documented. **Tentative** = idea under consideration; do not implement without approval.

---

## 1. Purpose
fallo is a decision-support tool for farmers who want to explore crop rotation strategies that could strengthen soil health and adapt their farms to changing climate conditions. It combines real NASA Earth observation data with documented crop characteristics and farmer priorities to make rotation trade-offs transparent.

## 2. Target Users
- Small-to-medium-scale farmers with internet access.
- Agricultural extension agents advising farmers.
- Researchers and students exploring climate-adapted agriculture.

## 3. Complete Intended Workflow
1. Farmer creates or selects a field (lat/lon via map, address geocode, or manual input).
2. Application fetches **10–20 years** of NASA POWER climate data for the location.
3. Application displays a **Climate Fingerprint**: temperature regime, precipitation regime, solar & moisture trends, labeled as regional context.
4. Application fetches soil data:
   - **US locations:** USDA SSURGO named soil components, texture, drainage, AWC.
   - **Non-US locations:** ISRIC SoilGrids numeric properties, presented with uncertainty.
5. Farmer compares **three pre-built rotation strategies** side by side.
6. Application shows a transparent, factor-by-factor comparison with citations.
7. Farmer adjusts priority sliders (Water Efficiency, Soil Health, Risk Resilience, Income Stability) and sees rankings update.
8. Farmer reads plain-language explainability for each score.
9. **What-If Simulator:** Farmer adjusts hypothetical rainfall and temperature assumptions and re-runs rotation comparisons.
10. **Field Calendar:** Farmer views crop sequences, planting windows, harvest periods, and growing-season conditions on a timeline.
11. **Climate Analogues:** Farmer compares current or hypothetical conditions with historically similar growing seasons.

## 4. Visual Identity (Confirmed)
- **Brand name:** fallo (always lowercase).
- **Tagline:** "Understand your land. Explore its future."
- **Palette:**
  - Deep space navy (sidebar/hero): #080D19
  - Midnight blue: #101B35
  - Slate blue: #24334F
  - Electric blue (primary accent): #4D9FFF
  - Cyan (secondary accent): #62D5E8
  - Accent red (alerts/warming): #E34B5B
  - Cool light gray (main background): #E9EDF1
  - Supporting gray: #E0E5EB
  - Content cards: #FFFFFF
  - Off-white text (on dark): #F3F5FA
  - Dark text (on light): #0A1429
- **Typography:** Serif headings (Lora) + sans-serif body (Inter) for sophistication and readability.
- **Design goals:** Modern, spacious, clear hierarchy. Scientific credibility without excessive complexity. Dark navy sidebar with subtle starfield pattern against cool gray content areas.
- **Wordmark:** Simple text-based logo, no complicated graphic.
- Charts via Recharts, maps via React Leaflet.
- Accessible contrast ratios (WCAG AA minimum).

## 5. MVP Features (Confirmed)
- [x] Field creation with map + coordinate validation.
- [x] NASA POWER 20-year climate fingerprint + 3-year recent comparison.
- [x] Soil profile: SSURGO (US primary) -> honest unavailable state with explanation for non-US (SoilGrids global fallback currently unavailable).
- [x] Three pre-built rotation strategies with documented crops (11-crop library). Strategies are generic archetypes with regional examples, not location-specific prescriptions.
- [x] Region-aware crop catalog: each crop lists `supportedRegions`; fields outside known US regions trigger an honest fallback banner.
- [x] Five-factor transparent scoring: Water Suitability, Nitrogen Contribution, Soil Coverage, Diversity/Pest Break, Climate Risk Resilience.
- [x] Priority sliders that recompute weighted rankings instantly.
- [x] Explainability panel with citations, rubrics, and input transparency.
- [x] Dedicated strategy detail page (`/field/[id]/rotations/[strategyId]`) with full 3-year plan.
- [ ] What-If Simulator: adjust rainfall / temperature assumptions and re-run comparisons.
- [ ] Field Calendar: visualize planting windows, harvest periods, and rotation schedules.
- [ ] Climate Analogues: match current or hypothetical conditions against historically similar growing seasons.
- [ ] Responsive, accessible UI.
- [ ] Demo default field pre-loaded on first visit.

## 6. Application Navigation (Confirmed)
- Overview (`/`)
- My Fields (`/fields`)
- Climate (`/field/[id]/climate`)
- Soil (`/field/[id]/soil`)
- Rotation Lab (`/field/[id]/rotations`)
- Strategy Detail (`/field/[id]/rotations/[strategyId]`)
- Data Sources (`/data-sources`)

## 7. Future Features (Tentative)
- Custom rotation builder (arbitrary crop sequences).
- NDVI / satellite imagery integration (requires clear use case).
- Meteomatics real-time forecasts (requires credentials).
- Multi-field management dashboards.
- Economic modeling with market price data.
- Alerts via email/SMS.

## 8. Data Sources

| Source | Status | Role | Reliability |
|--------|--------|------|-------------|
| **NASA POWER Daily API** | ✅ Verified live | Core climate data (temp, precip, soil wetness, radiation, wind, humidity) | High. Official NASA. No auth. 1981–NRT. Native resolution varies by parameter and source. |
| **USDA SSURGO REST** | ✅ Verified live | Primary US soil data (named map units/components, texture, drainage, AWC, slope) | High. Official USDA. US-only. Complex schema. |
| **ISRIC SoilGrids v2.0** | ⚠️ REST API paused; WCS/WebDAV documented | Fallback global soil (texture, pH, SOC, water content) | REST v2.0 paused. WCS and WebDAV are documented alternatives. Current implementation has not integrated a global fallback. 250 m predictions. |
| **OpenStreetMap Nominatim** | ✅ Standard free service | Address geocoding | High. Free with attribution. |
| **Meteomatics** | ❌ Not verified | High-res forecasts and historical weather | Requires credentials. Not in MVP. |
| **Microsoft Planetary Computer** | ❌ Not verified | Satellite imagery, STAC catalog | High complexity. Not in MVP. |

## 9. Architecture
- **Framework:** Next.js 15 App Router + TypeScript.
- **Styling:** Tailwind CSS + shadcn/ui primitives.
- **Charts:** Recharts.
- **Map:** React Leaflet 5.
- **State:** React Context + localStorage for field persistence.
- **API Routes:**
  - `/api/climate` -> NASA POWER fetch + 20-year aggregation + LRU cache.
  - `/api/soil` -> SSURGO spatial query + tabular properties. Non-US returns honest unavailable state (SoilGrids fallback paused).
- **Static Data:** `/data/crops.json` (11 crops with cited traits and `supportedRegions`), `/data/rotations.json` (3 archetype strategies with timelines and tradeoffs).
- **Region Detection:** `lib/region.ts` coarse bounding-box region detector for US regions.
- **Scoring Engine:** Pure TypeScript library (`lib/rotation-scoring.ts`) computing 5 factor scores (0–100) + weighted overall score from climate/soil + static crop data, with optional `regionTag` for region-awareness.
- **Deployment:** Vercel.

## 9a. Soil Profile API Details
- **Endpoint:** `GET /api/soil?lat={lat}&lon={lon}`
- **Source:** USDA NRCS Soil Data Access (SDA) REST POST service.
- **Method:**
  1. Spatial: `SDA_Get_Mukey_from_intersection_with_WktWgs84('POINT(lon lat)')` → mukey.
  2. Tabular: Query `mapunit`, `component`, `chorizon` tables.
  3. Depth-weighted average per component over 0–30 cm using actual horizon boundaries (`hzdept_r`, `hzdepb_r`).
  4. Map-unit aggregation by `comppct_r` (component percent). Missing values remain null, never treated as zero.
- **Fields retrieved:** `comppct_r`, `compname`, `drainagecl`, `slope_r`, `hzdept_r`, `hzdepb_r`, `sandtotal_r`, `silttotal_r`, `claytotal_r`, `om_r`, `ph1to1h2o_r`, `awc_r`.
- **Units:** sand/silt/clay/OM = %; pH = 1:1 H₂O; AWC = cm/cm; slope = %.
- **Cache:** Server-side LRU, keyed by lat/lon rounded to 2 decimals, TTL 24 hours.
- **Timeout:** 20 seconds per SDA query. Timeouts on spatial query return honest unavailable state (typical for non-US points).
- **Limitations returned:**
  - Component percentages may sum to < 100% (water/miscellaneous areas).
  - Texture fractions may not sum to exactly 100% (incomplete horizon data or rounding).
  - Aggregated values are heuristics, not field-level measurements.

## 10. Important Scientific Limitations
- NASA POWER is **regional climate context**, not field-level weather. Native spatial resolution varies by parameter and source.
- GWETROOT and other soil wetness parameters are **modeled** by MERRA-2 reanalysis, not direct measurements.
- SSURGO data is **map-unit averages**, not field samples.
- SoilGrids provides **250 m predictions** with uncertainty. Do not treat them as field samples.
- Scores are **heuristics** derived from climate averages and crop categories. They are not validated agronomic models.
- **Region support is currently limited to coarse US bounding boxes.** Fields outside these regions still generate scores from archetype strategies, but the app flags when a strategy includes crops not documented for the detected region.
- No irrigation scheduling, tillage practice, or pest-pressure modeling is included in the MVP.
- Economic modeling is limited to yield-risk proxies; market prices are not modeled.

## 11. Crop Traits (Confirmed Source Requirement)
Every crop in `data/crops.json` must include a `source` field citing:
- Water requirement: FAO crop water requirement tables or university extension.
- Nitrogen behavior: USDA NRCS or extension agronomy guides.
- Temperature thresholds: USDA NASS or peer-reviewed phenology tables.

Crops also include `supportedRegions` (e.g., `["us_southeast", "us_midwest"]`) so the scoring engine can flag when a strategy includes crops not documented for the user's detected region.

## 12. Scoring Methodology (Confirmed)
See `CLAUDE.md` and the architecture section of this brief for the five-factor heuristic formula. All scores are 0–100 per factor, then weighted by farmer priority sliders. The weighted-sum formula is visible to the user in an expandable panel. Scores labeled as heuristics, not validated recommendations.
