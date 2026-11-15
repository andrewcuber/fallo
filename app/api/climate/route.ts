import { NextRequest, NextResponse } from "next/server";
import { LRUCache } from "lru-cache";

const NASA_FILL_VALUE = -999;
const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

interface DailyEntry {
  date: string;
  year: number;
  month: number;
  day: number;
  t2m: number | null;
  t2mMax: number | null;
  t2mMin: number | null;
  precip: number | null;
  solar: number | null; // MJ/m^2/day from NASA POWER (AG community)
  wetness: number | null;
}

interface YearlySummary {
  year: number;
  avgTemp: number | null;
  totalPrecip: number | null;
  avgSolar: number | null; // MJ/m^2/day
  daysWithData: number;
}

interface PeriodStats {
  avgAnnualTemp: number | null;
  avgAnnualPrecip: number | null;
  avgDailySolar: number | null; // MJ/m^2/day
  monthlyTemp: (number | null)[];
  monthlyPrecip: (number | null)[];
  monthlySolar: (number | null)[]; // MJ/m^2/day
  annualPrecipTotals: { year: number; total: number | null }[];
  precipCV: number | null;
}

interface StressMetrics {
  summerDrySpells: {
    // Jun–Aug: max consecutive days with precip < threshold mm
    avgMaxConsecutiveDryDays: number | null;
    thresholdMm: number;
    monthsDesc: string;
  };
  summerHeatDays: {
    // Jul–Aug: days with T2M_MAX > threshold °C
    avgDaysAboveThreshold: number | null;
    thresholdC: number;
    monthsDesc: string;
  };
  springPrecip: {
    // Mar–May total precipitation
    avgTotalMm: number | null;
    monthsDesc: string;
  };
  growingSeasonPrecip: {
    // May–Aug total precipitation
    avgTotalMm: number | null;
    monthsDesc: string;
  };
}

interface ClimateResponse {
  location: {
    lat: number;
    lon: number;
    elevation: number | null;
  };
  periods: {
    startYear: number;
    endYear: number;
    recentStart: number;
    recentEnd: number;
    baselineStart: number;
    baselineEnd: number;
  };
  fullRecord: PeriodStats;
  baseline: PeriodStats;
  recent: PeriodStats;
  stressMetrics: StressMetrics;
  units: {
    temp: string;
    precip: string;
    solar: string;
    wetness: string;
  };
  source: string;
  spatialResolution: string;
  dataQuality: {
    totalDays: number;
    validDays: Record<string, number>;
    missingDays: Record<string, number>;
  };
  parameters: string[];
  warnings: string[];
}

// LRU cache keyed by rounded lat/lon + year range
const cache = new LRUCache<string, ClimateResponse>({
  max: 500,
  ttl: CACHE_TTL_MS,
});

function isValidFill(value: unknown): number | null {
  if (typeof value !== "number") return null;
  if (value <= NASA_FILL_VALUE) return null;
  return value;
}

export async function GET(request: NextRequest) {
  const searchParams = request.nextUrl.searchParams;
  const latStr = searchParams.get("lat");
  const lonStr = searchParams.get("lon");

  if (!latStr || !lonStr) {
    return NextResponse.json(
      { error: "Missing lat or lon parameter" },
      { status: 400 }
    );
  }

  const lat = parseFloat(latStr);
  const lon = parseFloat(lonStr);

  if (Number.isNaN(lat) || Number.isNaN(lon)) {
    return NextResponse.json(
      { error: "Invalid lat or lon" },
      { status: 400 }
    );
  }

  if (lat < -90 || lat > 90 || lon < -180 || lon > 180) {
    return NextResponse.json(
      { error: "Latitude must be -90 to 90, longitude -180 to 180" },
      { status: 400 }
    );
  }

  // Compute date range: latest 20 completed years
  const currentYear = new Date().getFullYear();
  const endYear = currentYear - 1;
  const startYear = endYear - 19;
  const recentEnd = endYear;
  const recentStart = endYear - 2;
  const baselineEnd = recentStart - 1;
  const baselineStart = startYear;

  const startDate = `${startYear}0101`;
  const endDate = `${endYear}1231`;

  const cacheKey = `${lat.toFixed(2)}_${lon.toFixed(2)}_${startYear}_${endYear}`;
  const cached = cache.get(cacheKey);
  if (cached) {
    return NextResponse.json({ ...cached, cached: true });
  }

  const parameters = [
    "T2M",
    "T2M_MAX",
    "T2M_MIN",
    "PRECTOTCORR",
    "ALLSKY_SFC_SW_DWN",
    "GWETROOT",
  ];

  const apiUrl = new URL(
    "https://power.larc.nasa.gov/api/temporal/daily/point"
  );
  apiUrl.searchParams.set("parameters", parameters.join(","));
  apiUrl.searchParams.set("community", "AG");
  apiUrl.searchParams.set("longitude", String(lon));
  apiUrl.searchParams.set("latitude", String(lat));
  apiUrl.searchParams.set("start", startDate);
  apiUrl.searchParams.set("end", endDate);
  apiUrl.searchParams.set("format", "JSON");
  apiUrl.searchParams.set("time-standard", "UTC");

  let raw: unknown;
  const warnings: string[] = [];

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 25000);

    const res = await fetch(apiUrl.toString(), {
      signal: controller.signal,
      headers: { Accept: "application/json" },
    });
    clearTimeout(timeout);

    if (!res.ok) {
      const text = await res.text().catch(() => "Unknown error");
      return NextResponse.json(
        {
          error: `NASA POWER API returned ${res.status}`,
          detail: text.slice(0, 500),
        },
        { status: 502 }
      );
    }

    raw = await res.json();
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json(
      { error: "Failed to fetch NASA POWER data", detail: message },
      { status: 504 }
    );
  }

  // Parse NASA POWER response
  const geo =
    typeof raw === "object" && raw !== null && "geometry" in raw
      ? (raw as Record<string, unknown>).geometry
      : null;

  const props =
    typeof raw === "object" && raw !== null && "properties" in raw
      ? (raw as Record<string, unknown>).properties
      : null;

  const paramData =
    props && typeof props === "object" && "parameter" in props
      ? (props as Record<string, unknown>).parameter
      : null;

  if (!paramData || typeof paramData !== "object" || paramData === null) {
    return NextResponse.json(
      { error: "Unexpected NASA POWER response format" },
      { status: 502 }
    );
  }

  const params = paramData as Record<string, Record<string, number>>;

  // Check which parameters were actually returned
  const returnedParams = Object.keys(params);
  const missingParams = parameters.filter((p) => !returnedParams.includes(p));
  if (missingParams.length > 0) {
    warnings.push(
      `Some requested parameters were not returned: ${missingParams.join(", ")}`
    );
  }

  // Build daily entries
  const t2mMap = params["T2M"] ?? {};
  const t2mMaxMap = params["T2M_MAX"] ?? {};
  const t2mMinMap = params["T2M_MIN"] ?? {};
  const precipMap = params["PRECTOTCORR"] ?? {};
  const solarMap = params["ALLSKY_SFC_SW_DWN"] ?? {};
  const wetnessMap = params["GWETROOT"] ?? {};

  const allDates = Object.keys(t2mMap).sort();
  const entries: DailyEntry[] = [];

  for (const dateStr of allDates) {
    const year = parseInt(dateStr.slice(0, 4), 10);
    const month = parseInt(dateStr.slice(4, 6), 10);
    const day = parseInt(dateStr.slice(6, 8), 10);

    entries.push({
      date: dateStr,
      year,
      month,
      day,
      t2m: isValidFill(t2mMap[dateStr]),
      t2mMax: isValidFill(t2mMaxMap[dateStr]),
      t2mMin: isValidFill(t2mMinMap[dateStr]),
      precip: isValidFill(precipMap[dateStr]),
      solar: isValidFill(solarMap[dateStr]),
      wetness: isValidFill(wetnessMap[dateStr]),
    });
  }

  // Data quality
  const totalDays = entries.length;
  const validDays: Record<string, number> = {};
  const missingDays: Record<string, number> = {};
  for (const key of ["t2m", "precip", "solar", "wetness"]) {
    const valid = entries.filter((e) => e[key as keyof DailyEntry] !== null).length;
    validDays[key] = valid;
    missingDays[key] = totalDays - valid;
  }

  // Compute aggregations for a period
  function computePeriodStats(
    periodEntries: DailyEntry[]
  ): PeriodStats {
    const years = Array.from(new Set(periodEntries.map((e) => e.year))).sort(
      (a, b) => a - b
    );

    const yearStats: YearlySummary[] = [];
    for (const y of years) {
      const yearEntries = periodEntries.filter((e) => e.year === y);
      const temps = yearEntries
        .map((e) => e.t2m)
        .filter((v): v is number => v !== null);
      const precips = yearEntries
        .map((e) => e.precip)
        .filter((v): v is number => v !== null);
      const solars = yearEntries
        .map((e) => e.solar)
        .filter((v): v is number => v !== null);

      yearStats.push({
        year: y,
        avgTemp: temps.length > 0 ? avg(temps) : null,
        totalPrecip: precips.length > 0 ? sum(precips) : null,
        avgSolar: solars.length > 0 ? avg(solars) : null,
        daysWithData: temps.length,
      });
    }

    const annualPrecipTotals = yearStats.map((ys) => ({
      year: ys.year,
      total: ys.totalPrecip,
    }));

    const validPrecipTotals = yearStats
      .map((ys) => ys.totalPrecip)
      .filter((v): v is number => v !== null);

    const precipCV =
      validPrecipTotals.length > 1 ? cv(validPrecipTotals) : null;

    const validTemps = yearStats
      .map((ys) => ys.avgTemp)
      .filter((v): v is number => v !== null);
    const validSolars = yearStats
      .map((ys) => ys.avgSolar)
      .filter((v): v is number => v !== null);

    const monthlyTemp: (number | null)[] = [];
    const monthlyPrecip: (number | null)[] = [];
    const monthlySolar: (number | null)[] = [];

    for (let m = 1; m <= 12; m++) {
      const monthEntries = periodEntries.filter((e) => e.month === m);

      // Temperature: average of valid daily values
      const mt = monthEntries
        .map((e) => e.t2m)
        .filter((v): v is number => v !== null);
      monthlyTemp.push(mt.length > 0 ? avg(mt) : null);

      // Solar: average of valid daily values (already MJ/m^2/day from NASA POWER)
      const ms = monthEntries
        .map((e) => e.solar)
        .filter((v): v is number => v !== null);
      monthlySolar.push(ms.length > 0 ? avg(ms) : null);

      // Precipitation: sum each year's monthly total, then average across years.
      // This correctly weights each year equally regardless of missing days.
      const precipByYear = new Map<number, number[]>();
      for (const e of monthEntries) {
        if (e.precip !== null) {
          if (!precipByYear.has(e.year)) precipByYear.set(e.year, []);
          precipByYear.get(e.year)!.push(e.precip);
        }
      }
      const yearlyMonthTotals = Array.from(precipByYear.values())
        .map((arr) => sum(arr));
      monthlyPrecip.push(
        yearlyMonthTotals.length > 0 ? avg(yearlyMonthTotals) : null
      );
    }

    return {
      avgAnnualTemp: validTemps.length > 0 ? avg(validTemps) : null,
      avgAnnualPrecip:
        validPrecipTotals.length > 0 ? avg(validPrecipTotals) : null,
      avgDailySolar: validSolars.length > 0 ? avg(validSolars) : null,
      monthlyTemp,
      monthlyPrecip,
      monthlySolar,
      annualPrecipTotals,
      precipCV,
    };
  }

  const fullRecordStats = computePeriodStats(entries);

  const baselineEntries = entries.filter(
    (e) => e.year >= baselineStart && e.year <= baselineEnd
  );
  const recentEntries = entries.filter(
    (e) => e.year >= recentStart && e.year <= recentEnd
  );

  const baselineStats = computePeriodStats(baselineEntries);
  const recentStats = computePeriodStats(recentEntries);

  // Compute stress metrics from daily entries
  function computeStressMetrics(allEntries: DailyEntry[]): StressMetrics {
    const DRY_THRESHOLD_MM = 1.0;
    const HEAT_THRESHOLD_C = 35.0;

    const years = Array.from(new Set(allEntries.map((e) => e.year))).sort((a, b) => a - b);

    // Summer dry spells (Jun-Aug): max consecutive days with precip < DRY_THRESHOLD_MM
    const drySpellMaxByYear: number[] = [];
    for (const y of years) {
      const summerEntries = allEntries.filter((e) => e.year === y && e.month >= 6 && e.month <= 8);
      let maxConsec = 0;
      let currentConsec = 0;
      for (const e of summerEntries) {
        if (e.precip !== null && e.precip < DRY_THRESHOLD_MM) {
          currentConsec++;
          maxConsec = Math.max(maxConsec, currentConsec);
        } else {
          currentConsec = 0;
        }
      }
      if (summerEntries.length > 0) {
        drySpellMaxByYear.push(maxConsec);
      }
    }

    // Summer heat days (Jul-Aug): days with T2M_MAX > HEAT_THRESHOLD_C
    const heatDaysByYear: number[] = [];
    for (const y of years) {
      const heatEntries = allEntries.filter(
        (e) => e.year === y && e.month >= 7 && e.month <= 8 && e.t2mMax !== null && e.t2mMax > HEAT_THRESHOLD_C
      );
      const totalEntries = allEntries.filter((e) => e.year === y && e.month >= 7 && e.month <= 8);
      if (totalEntries.length > 0) {
        heatDaysByYear.push(heatEntries.length);
      }
    }

    // Spring precip (Mar-May)
    const springPrecipByYear: number[] = [];
    for (const y of years) {
      const springEntries = allEntries.filter((e) => e.year === y && e.month >= 3 && e.month <= 5);
      const valid = springEntries.filter((e) => e.precip !== null);
      if (valid.length > 0) {
        springPrecipByYear.push(sum(valid.map((e) => e.precip!)));
      }
    }

    // Growing season precip (May-Aug)
    const gsPrecipByYear: number[] = [];
    for (const y of years) {
      const gsEntries = allEntries.filter((e) => e.year === y && e.month >= 5 && e.month <= 8);
      const valid = gsEntries.filter((e) => e.precip !== null);
      if (valid.length > 0) {
        gsPrecipByYear.push(sum(valid.map((e) => e.precip!)));
      }
    }

    return {
      summerDrySpells: {
        avgMaxConsecutiveDryDays: drySpellMaxByYear.length > 0 ? avg(drySpellMaxByYear) : null,
        thresholdMm: DRY_THRESHOLD_MM,
        monthsDesc: "Jun–Aug",
      },
      summerHeatDays: {
        avgDaysAboveThreshold: heatDaysByYear.length > 0 ? avg(heatDaysByYear) : null,
        thresholdC: HEAT_THRESHOLD_C,
        monthsDesc: "Jul–Aug",
      },
      springPrecip: {
        avgTotalMm: springPrecipByYear.length > 0 ? avg(springPrecipByYear) : null,
        monthsDesc: "Mar–May",
      },
      growingSeasonPrecip: {
        avgTotalMm: gsPrecipByYear.length > 0 ? avg(gsPrecipByYear) : null,
        monthsDesc: "May–Aug",
      },
    };
  }

  const stressMetrics = computeStressMetrics(entries);

  // Elevation from geometry
  let elevation: number | null = null;
  if (
    geo &&
    typeof geo === "object" &&
    "coordinates" in geo &&
    Array.isArray((geo as Record<string, unknown>).coordinates)
  ) {
    const coords = (geo as Record<string, unknown>).coordinates as number[];
    if (coords.length >= 3) elevation = coords[2];
  }

  const response: ClimateResponse = {
    location: { lat, lon, elevation },
    periods: {
      startYear,
      endYear,
      recentStart,
      recentEnd,
      baselineStart,
      baselineEnd,
    },
    fullRecord: fullRecordStats,
    baseline: baselineStats,
    recent: recentStats,
    stressMetrics,
    units: {
      temp: "°C",
      precip: "mm",
      solar: "MJ/m^2/day",
      wetness: "m³/m³",
    },
    source:
      "NASA POWER Daily API (https://power.larc.nasa.gov). Regional climate context, not field-level weather.",
    spatialResolution:
      "0.5° latitude/longitude grid (~55 km). Resolution varies by parameter.",
    dataQuality: {
      totalDays,
      validDays,
      missingDays,
    },
    parameters: returnedParams,
    warnings,
  };

  cache.set(cacheKey, response);
  return NextResponse.json(response);
}

// Math helpers
function sum(arr: number[]): number {
  return arr.reduce((a, b) => a + b, 0);
}

function avg(arr: number[]): number {
  return sum(arr) / arr.length;
}

function std(arr: number[]): number {
  const mean = avg(arr);
  const variance = avg(arr.map((x) => Math.pow(x - mean, 2)));
  return Math.sqrt(variance);
}

function cv(arr: number[]): number {
  const mean = avg(arr);
  if (mean === 0) return 0;
  return (std(arr) / mean) * 100;
}
