# fallo

**Understand your land. Explore its future.**

**fallo** is an agricultural decision-support application that helps farmers and extension advisors explore 3-year crop rotation strategies adapted to local climate patterns, topsoil properties, and farm priorities.

---

## Core Capabilities

- **Field Management & Global Coordinate Normalization:** Create and manage fields anywhere in the world via interactive map selection, address geocoding, or manual coordinates. Wrapped world-map longitudes (such as `-250°` when panning across the Pacific) are automatically normalized into canonical `[-180°, 180°)` range.
- **Climate Fingerprint (`/field/[id]/climate`):** Queries 20 years of daily temperature, precipitation, solar radiation, and root-zone wetness from the **NASA POWER Agroclimatology Daily API** (`~55 km` regional reanalysis grid), comparing baseline vs. recent 3-year trends and summer drought/heat stress metrics.
- **Soil Profile (`/field/[id]/soil`):**
  - **United States (Live Coordinate Extraction):** Queries **USDA NRCS Soil Data Access (SSURGO)** live via spatial point-in-polygon and tabular queries to compute depth-weighted `0–30 cm` topsoil properties (`sand`, `silt`, `clay`, `organic matter`, `pH`, `available water capacity`, `drainage`, and `slope`) across mapped soil components.
  - **Outside USDA SSURGO Coverage (Regional Reference Estimates):** Resolves a clearly labeled **macro-regional `0–30 cm` topsoil reference estimate** compiled from published **FAO/IIASA HWSD v2.2** and **ISRIC SoilGrids v2.0** regional summaries for the field's agroecological zone (not a coordinate-specific spatial extraction or laboratory soil test).
- **Rotation Lab (`/field/[id]/rotations`):**
  - Classifies each field's agroecological climate zone, growing-period moisture regime, and water regime in plain English.
  - Filters a source-backed catalog of 33 crops across 15 global agricultural regions.
  - Uses **Super Intelligence (SI)-assisted generation** paired with deterministic agronomic validation (botanical family rotation, disease-host interval enforcement, seasonal calendar checks, and regional crop eligibility) to propose three 3-year crop rotation plans: *Soil Health Building*, *Water Resilience*, and *Crop Diversity & Pest Break*.
  - Scores and ranks plans transparently across five farmer-weighted suitability factors: **Water Suitability**, **Nitrogen Contribution**, **Soil Coverage**, **Diversity / Pest Break**, and **Climate Risk Resilience**.

---

## Data Transparency & Scientific Honesty

- **Live Coordinate Queries vs. Regional Reference Baselines:**
  - **Climate (`/api/climate`):** Live coordinate-specific extraction from NASA POWER (`0.5° × 0.625°` MERRA-2 grid).
  - **US Soil (`/api/soil`):** Live coordinate-specific polygon and horizon extraction from USDA NRCS SSURGO.
  - **Non-US Soil (`/api/soil`):** Representative macro-regional topsoil reference profiles compiled from published FAO HWSD v2.2 and ISRIC SoilGrids v2.0 regional summaries. These are explicitly labeled as regional reference estimates rather than coordinate-extracted measurements.
- **Decision-Support Heuristics:** Suitability scores (`0–100`) are transparent decision-support heuristics, not calibrated yield or economic predictions.

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
