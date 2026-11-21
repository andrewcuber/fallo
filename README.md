# fallo

**Understand your land. Explore its future.**

fallo is an agricultural decision-support application for exploring 3-year crop rotation strategies using local climate patterns, topsoil characteristics, regional crop availability, and farmer priorities.

> **Decision-support only:** Scores and schedules are transparent heuristics, not calibrated yield predictions, economic forecasts, or field-specific agronomic prescriptions.

## Features

### Field management

- Create fields by map selection, address search, or manual coordinates
- Validate and normalize coordinates worldwide
- Save fields in browser local storage
- Switch, review, and manage saved fields

### Climate fingerprint

The `/field/[id]/climate` view summarizes approximately 20 years of NASA POWER data:

- Temperature and precipitation profiles
- Annual variability and recent-period comparisons
- Growing-season conditions
- Solar radiation and modeled root-zone moisture
- Summer heat and dry-spell stress indicators

NASA POWER values provide regional climate context rather than on-farm measurements.

### Soil profile

The `/field/[id]/soil` view reports depth-weighted 0–30 cm topsoil properties:

- Sand, silt, and clay
- Organic matter and pH
- Available water capacity
- Drainage and slope where available

For United States coordinates, fallo queries USDA NRCS SSURGO and can use nearby mapped soil data when the exact point lacks usable properties. For other locations, it uses live ISRIC SoilGrids v2.0 data where available, followed by clearly labeled macro-regional reference estimates where necessary.

### Crop rotation lab

The `/field/[id]/rotations` view:

- Summarizes the field's agroecological context
- Identifies locally supported crops
- Allows priority weights across five suitability factors
- Generates and compares three 3-year planning objectives
- Links each ranking to an understandable factor breakdown
- Provides a dedicated detail view for each strategy

AI-assisted proposals are checked deterministically for botanical-family rotation, disease-host intervals, seasonal fit, crop eligibility, and other agronomic constraints before display.

### What-if climate simulator

The `/field/[id]/simulator` view lets users test hypothetical changes in temperature and precipitation without modifying observed baseline data or saved rotations.

It recalculates:

- Agroecological climate classification
- Five-factor rotation suitability
- Crop-level climate fit
- Crop-specific agronomic explanations
- User-triggered SI-assisted rotation proposals

### Field calendar

The `/field/[id]/calendar` view presents a hemisphere-aware, 3-year × 12-month schedule with:

- Estimated planting periods
- Active growth periods
- Sensitive growth stages
- Harvest or cover-crop termination windows
- Crop-season temperature, rainfall, solar, and drought context

### Historical climate analogues

The `/field/[id]/analogues` view compares:

- Recent field conditions
- A selected historical year
- An active What-If scenario

against the field's annual and monthly climate archive. The closest historical growing seasons are ranked using standardized temperature, rainfall, seasonality, and growing-period metrics.

## How it works

```text
Field location
      │
      ├── NASA POWER climate archive
      ├── USDA SSURGO or international soil source
      └── Regional and crop-trait data
      │
      ▼
Field-specific agroecological context
      │
      ├── Priority weights
      ├── Deterministic agronomic validation
      └── Optional Gemini-assisted generation
      │
      ▼
Transparent, scored 3-year rotation options
```

## AI-assisted rotations

fallo uses Google's **Gemini Developer API** through `@google/genai`.

Every AI-generated proposal passes deterministic validation against the crop catalog and `lib/rotation-validator.ts`. Invalid proposals are rejected or repaired where safe; documented agronomic warnings are preserved for review.

Configure AI generation with server-side environment variables:

```dotenv
GEMINI_API_KEY=your_api_key
GEMINI_MODEL=gemini-2.5-flash
FALLO_AI_ENABLED=true
FALLO_AI_TIMEOUT_MS=120000
```

See `.env.example` for optional provider and usage-limit settings.

## Data sources

| Source | Usage |
|---|---|
| NASA POWER Daily / Agroclimatology | Coordinate-specific climate observations and 20-year archive |
| USDA NRCS SSURGO | Live mapped soil polygons and horizons within the United States |
| ISRIC SoilGrids v2.0 | Live ~250 m modeled soil estimates where available |
| FAO / IIASA HWSD v2.2 | Macro-regional soil reference estimates |
| Crop and rotation catalog | Documented crop traits, regional eligibility, and rotation safeguards |

## Scientific limitations

- NASA POWER is a regional climate dataset, not a replacement for an on-farm weather station.
- SSURGO values represent map units and components rather than field soil samples.
- SoilGrids values are modeled predictions with uncertainty.
- Macro-regional soil estimates are references, not coordinate-level measurements.
- Suitability scores are heuristic rankings derived from climate, soil, and crop traits.
- Planting and harvest windows are planning estimates, not exact local dates.
- falle does not currently model irrigation scheduling, tillage, real-time pests, yield, or market economics.

## Tech stack

- Next.js 15 App Router
- TypeScript
- Tailwind CSS
- shadcn/ui and Radix UI
- React Leaflet
- Recharts
- React Context and browser local storage
- Google Gemini Developer API
- Server-side LRU caching
- Vercel deployment

## Getting started

### Requirements

- Node.js 18 or newer
- npm
- A Gemini API key for AI-assisted rotation generation

### Installation

```bash
npm install
cp .env.example .env.local
npm run dev
```

Open `http://localhost:3000`.

The Gemini API key is optional for climate and soil features, but required to generate AI-assisted rotation plans.

## Verification

```bash
npx tsx test-scoring.ts
npx tsx test-generation.ts
npx tsx test-soil.ts
npx tsx test-mukey.ts
npx tsx test-polygon.ts
npx tsc --noEmit
npm run lint
npm run build
```

## Project structure

```text
app/        Next.js routes and API handlers
components/ Shared UI and visualization components
data/       Crop, region, and rotation data
lib/        Climate, soil, scoring, and validation utilities
docs/       Project documentation and implementation records
public/     Static assets
```

## Documentation

- [Project brief](docs/PROJECT_BRIEF.md)
- [Development roadmap](docs/ROADMAP.md)
- [Phase 3 handoff](docs/PHASE3_HANDOFF.md)
- [Data sources](app/data-sources)
