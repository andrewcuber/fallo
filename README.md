# fallo

**Understand your land. Explore its future.**

**fallo** is an agricultural decision-support application that helps farmers and extension advisors explore 3-year crop rotation strategies adapted to local climate patterns, topsoil properties, and farm priorities.

---

## Six-Feature Field Workflow

- **Field Management & Global Coordinate Normalization (`/fields`, `/fields/new`):** Create and manage fields anywhere in the world via interactive map selection, address geocoding, or manual coordinates. Wrapped world-map longitudes (such as `-250°` when panning across the Pacific) are automatically normalized into canonical `[-180°, 180°)` range.
- **1. Climate Fingerprint (`/field/[id]/climate`):** Queries 20 years of daily temperature, precipitation, solar radiation, and root-zone wetness from the **NASA POWER Agroclimatology Daily API** (`~55 km` regional reanalysis grid), comparing baseline vs. recent 5-year trends, annual precipitation variability, and summer drought/heat stress metrics.
- **2. Soil Profile (`/field/[id]/soil`):**
  - **United States (Live Coordinate Extraction):** Queries **USDA NRCS Soil Data Access (SSURGO)** live via spatial point-in-polygon and tabular queries to compute depth-weighted `0–30 cm` topsoil properties (`sand`, `silt`, `clay`, `organic matter`, `pH`, `available water capacity`, `drainage`, and `slope`) across mapped soil components.
  - **Outside USDA SSURGO Coverage (Regional Topsoil Estimates):** Resolves a clearly labeled **macro-regional `0–30 cm` topsoil reference estimate** compiled from published **FAO/IIASA HWSD v2.2** and **ISRIC SoilGrids v2.0** regional summaries for the field's agroecological zone (not a coordinate-specific spatial extraction or laboratory soil test).
- **3. Crop Rotation Lab (`/field/[id]/rotations`):**
  - Summarizes the field's agroecological climate zone, growing-period moisture regime, topsoil properties, and locally verified crops across 15 global agricultural regions.
  - Lets farmers set relative priority weights across five suitability factors (**Water Suitability**, **Nitrogen Contribution**, **Soil Coverage**, **Diversity / Pest Break**, and **Climate Risk Resilience**) and generate field-specific 3-year crop rotation plans.
  - Uses **Super Intelligence (SI)-assisted generation** powered by the **Gemini Developer API** (`@google/genai`) paired with deterministic agronomic validation (botanical family rotation, disease-host interval enforcement, seasonal calendar checks, and regional crop eligibility) to propose and score three 3-year plans: *Soil Health Building*, *Water Resilience*, and *Crop Diversity & Pest Break*.
- **4. What-If Climate Simulator (`/field/[id]/simulator`):**
  - Lets users test hypothetical shifts in temperature (`°C`) and precipitation (`%` or `mm/yr`) or select quick climate presets without overwriting observed baseline climate data or saved rotation plans.
  - Recalculates agroecological classification, 5-factor rotation suitability scores, and crop-by-crop climate suitability side by side with crop-specific agronomic explanations.
  - Supports explicit user-triggered SI rotation generation tailored to a selected hypothetical climate scenario.
- **5. Field Calendar (`/field/[id]/calendar`):**
  - Renders a hemisphere-aware 3-year × 12-month timeline for any generated rotation strategy, highlighting estimated planting months, active growth, documented sensitive growth stages, and harvest or cover-crop termination windows.
  - Displays growing-period mean temperature, temperature range, cumulative rainfall, solar radiation, water demand, drought tolerance, and nitrogen behavior for each scheduled crop season.
- **6. Historical Climate Analogues (`/field/[id]/analogues`):**
  - Compares recent field conditions, a specific historical year, or an active What-If climate scenario against the field's 20-year annual and monthly climate archive.
  - Ranks the closest historical growing seasons using a standardized multi-metric similarity score (combining annual temperature, annual rainfall, growing-season temperature/rainfall, and 12-month seasonal curve trajectory) and overlays monthly comparison curves.

---

## Runtime SI Architecture & Authentication

- **Provider:** Google **Gemini Developer API** via `@google/genai` (`GeminiDeveloperProvider` in `lib/rotation-generator.ts`, server route `app/api/rotations/generate/route.ts`).
- **Configuration:** Reads `GEMINI_API_KEY` from server-side environment variables (.env.local or Vercel). Configurable model ID via `GEMINI_MODEL` (defaults to `gemini-2.5-flash`).
- **Cost & Quotas:** Runs seamlessly on Google AI Studio's free tier without requiring Google Cloud billing or Vertex AI projects.
- **Deterministic Safeguards:** Every SI-generated rotation proposal is validated deterministically against `data/crops.json` and `lib/rotation-validator.ts` before scoring or display.

---

## Data Transparency & Scientific Honesty

- **Live Coordinate Queries vs. Regional Reference Baselines:**
  - **Climate (`/api/climate`):** Live coordinate-specific extraction from NASA POWER (`0.5° × 0.625°` MERRA-2 grid), including per-year historical records for Climate Analogues.
  - **US Soil (`/api/soil`):** Live coordinate-specific polygon and horizon extraction from USDA NRCS SSURGO.
  - **Non-US Soil (`/api/soil`):** Representative macro-regional topsoil reference profiles compiled from published FAO HWSD v2.2 and ISRIC SoilGrids v2.0 regional summaries, explicitly labeled as regional estimates rather than coordinate-extracted measurements.
- **Decision-Support Heuristics:** Suitability scores (`0–100`) and month-level planting/harvest windows are transparent decision-support heuristics, not calibrated yield predictions or exact field-entry dates.

---

## Development & Verification

```bash
# Install dependencies
npm install

# Run development server
npm run dev

# Run deterministic scoring & generation test suites
npx tsx test-scoring.ts
npx tsx test-generation.ts

# Run TypeScript & ESLint checks
npx tsc --noEmit
npm run lint

# Build for production
npm run build
```
