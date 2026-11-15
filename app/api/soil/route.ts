import { NextRequest, NextResponse } from "next/server";
import { LRUCache } from "lru-cache";

const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
const SDA_TIMEOUT_MS = 20000; // 20 seconds per query

interface ComponentHorizon {
  depthTop: number;
  depthBottom: number;
  sand: number | null;
  silt: number | null;
  clay: number | null;
  om: number | null;
  ph: number | null;
  awc: number | null;
}

interface SoilComponent {
  cokey: string;
  name: string;
  percent: number; // comppct_r
  kind: string;
  majcompflag: string | null; // 'Yes' | 'No' | null
  drainage: string | null;
  slope: number | null; // percent
  horizons: ComponentHorizon[];
}

interface AggregatedProperties {
  depth0_30cm: {
    sand: number | null; // %
    silt: number | null; // %
    clay: number | null; // %
    om: number | null; // %
    ph: number | null; // 1:1 H2O
    awc: number | null; // cm/cm
  };
  drainage: string | null;
  slope: number | null; // %
}

interface DataCoverage {
  depth0_30cm: {
    sand: number | null;
    silt: number | null;
    clay: number | null;
    om: number | null;
    ph: number | null;
    awc: number | null;
  };
  drainage: number | null;
  slope: number | null;
}

interface SoilResponse {
  location: {
    lat: number;
    lon: number;
  };
  source: string;
  coverage: string;
  mapUnit: {
    mukey: string;
    name: string;
  } | null;
  totalComponentPercent: number;
  components: SoilComponent[];
  aggregated: AggregatedProperties;
  dataCoverage: DataCoverage;
  limitations: string[];
  cached?: boolean;
}

const cache = new LRUCache<string, SoilResponse>({
  max: 500,
  ttl: CACHE_TTL_MS,
});

function parseNumber(val: unknown): number | null {
  if (val === null || val === undefined) return null;
  const n = typeof val === "string" ? parseFloat(val) : Number(val);
  return Number.isFinite(n) ? n : null;
}

function parseString(val: unknown): string | null {
  if (val === null || val === undefined) return null;
  const s = String(val).trim();
  return s.length > 0 ? s : null;
}

async function querySDA<T>(query: string): Promise<T[][]> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), SDA_TIMEOUT_MS);

  try {
    const res = await fetch(
      "https://SDMDataAccess.sc.egov.usda.gov/Tabular/post.rest",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query, format: "JSON" }),
        signal: controller.signal,
      }
    );
    clearTimeout(timeout);

    if (!res.ok) {
      const text = await res.text().catch(() => "Unknown error");
      throw new Error(`SDA returned ${res.status}: ${text.slice(0, 200)}`);
    }

    const json = await res.json();
    if (json && typeof json === "object") {
      if ("Table" in json && Array.isArray(json.Table)) {
        return json.Table as T[][];
      }
      // SDA returns {} when there is no spatial intersection
      return [];
    }
    throw new Error("Unexpected SDA response format");
  } catch (err) {
    clearTimeout(timeout);
    throw err;
  }
}

function depthWeightedAverage(
  horizons: ComponentHorizon[],
  property: keyof Omit<ComponentHorizon, "depthTop" | "depthBottom">
): number | null {
  let weightedSum = 0;
  let totalDepth = 0;
  let hasValue = false;

  for (const h of horizons) {
    const top = h.depthTop;
    const bottom = Math.min(h.depthBottom, 30);
    if (top >= 30 || bottom <= top) continue;

    const val = h[property];
    if (val === null || Number.isNaN(val)) continue;

    const depth = bottom - top;
    weightedSum += val * depth;
    totalDepth += depth;
    hasValue = true;
  }

  if (!hasValue || totalDepth === 0) return null;
  return weightedSum / totalDepth;
}

function aggregateComponents(
  components: SoilComponent[]
): { aggregated: AggregatedProperties; dataCoverage: DataCoverage } {
  const properties: (keyof Omit<
    ComponentHorizon,
    "depthTop" | "depthBottom"
  >)[] = ["sand", "silt", "clay", "om", "ph", "awc"];

  const depth0_30cm = {
    sand: null as number | null,
    silt: null as number | null,
    clay: null as number | null,
    om: null as number | null,
    ph: null as number | null,
    awc: null as number | null,
  };

  const coverage0_30cm = {
    sand: null as number | null,
    silt: null as number | null,
    clay: null as number | null,
    om: null as number | null,
    ph: null as number | null,
    awc: null as number | null,
  };

  for (const prop of properties) {
    let weightedSum = 0;
    let totalPercent = 0;
    let hasValue = false;

    for (const comp of components) {
      const compVal = depthWeightedAverage(comp.horizons, prop);
      if (compVal === null || Number.isNaN(compVal)) continue;

      weightedSum += compVal * comp.percent;
      totalPercent += comp.percent;
      hasValue = true;
    }

    if (hasValue && totalPercent > 0) {
      depth0_30cm[prop] = weightedSum / totalPercent;
      (coverage0_30cm as Record<string, number | null>)[prop] = totalPercent;
    }
  }

  // Drainage: weighted dominant class among components with valid drainage
  const drainageCounts = new Map<string, number>();
  let drainageTotalPercent = 0;
  for (const comp of components) {
    if (comp.drainage) {
      drainageCounts.set(
        comp.drainage,
        (drainageCounts.get(comp.drainage) ?? 0) + comp.percent
      );
      drainageTotalPercent += comp.percent;
    }
  }
  let drainage: string | null = null;
  let maxDrainagePercent = 0;
  for (const [d, p] of drainageCounts) {
    if (p > maxDrainagePercent) {
      maxDrainagePercent = p;
      drainage = d;
    }
  }

  // Slope: weighted average among components with valid slope
  let slopeSum = 0;
  let slopePercent = 0;
  let hasSlope = false;
  for (const comp of components) {
    if (comp.slope !== null && !Number.isNaN(comp.slope)) {
      slopeSum += comp.slope * comp.percent;
      slopePercent += comp.percent;
      hasSlope = true;
    }
  }
  const slope = hasSlope && slopePercent > 0 ? slopeSum / slopePercent : null;

  return {
    aggregated: { depth0_30cm, drainage, slope },
    dataCoverage: {
      depth0_30cm: coverage0_30cm,
      drainage: drainageTotalPercent > 0 ? drainageTotalPercent : null,
      slope: hasSlope && slopePercent > 0 ? slopePercent : null,
    },
  };
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

  const cacheKey = `${lat.toFixed(2)}_${lon.toFixed(2)}`;
  const cached = cache.get(cacheKey);
  if (cached) {
    return NextResponse.json({ ...cached, cached: true });
  }

  const limitations: string[] = [];

  let mukeyRows: string[][] = [];

  try {
    // Step 1: Resolve map unit key from WKT point
    const wkt = `POINT(${lon} ${lat})`;
    mukeyRows = await querySDA<string>(
      `SELECT mukey FROM SDA_Get_Mukey_from_intersection_with_WktWgs84('${wkt}')`
    );
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    // Timeouts on the spatial query usually indicate the point is far outside
    // SSURGO coverage (non-US). Return an honest unavailable state.
    const response: SoilResponse = {
      location: { lat, lon },
      source:
        "USDA NRCS Soil Data Access (SSURGO). Query timed out or failed.",
      coverage:
        "SSURGO covers the United States and its territories. Global fallback (ISRIC SoilGrids) is currently unavailable.",
      mapUnit: null,
      totalComponentPercent: 0,
      components: [],
      aggregated: {
        depth0_30cm: { sand: null, silt: null, clay: null, om: null, ph: null, awc: null },
        drainage: null,
        slope: null,
      },
      dataCoverage: {
        depth0_30cm: { sand: null, silt: null, clay: null, om: null, ph: null, awc: null },
        drainage: null,
        slope: null,
      },
      limitations: [
        `SSURGO spatial query did not complete: ${message}. This often means the point is outside the United States.`,
        "ISRIC SoilGrids REST API v2.0 is temporarily paused. WCS and WebDAV are documented alternative access methods.",
        "Soil data for this location is not currently available.",
      ],
    };
    cache.set(cacheKey, response);
    return NextResponse.json(response);
  }

  try {
    if (!mukeyRows || mukeyRows.length === 0) {
      // Outside SSURGO coverage (usually non-US)
      const response: SoilResponse = {
        location: { lat, lon },
        source:
          "USDA NRCS Soil Data Access (SSURGO). No map unit found at this location.",
        coverage:
          "SSURGO covers the United States and its territories. Global fallback (ISRIC SoilGrids) is currently unavailable.",
        mapUnit: null,
        totalComponentPercent: 0,
        components: [],
        aggregated: {
          depth0_30cm: { sand: null, silt: null, clay: null, om: null, ph: null, awc: null },
          drainage: null,
          slope: null,
        },
        dataCoverage: {
          depth0_30cm: { sand: null, silt: null, clay: null, om: null, ph: null, awc: null },
          drainage: null,
          slope: null,
        },
        limitations: [
          "No SSURGO map unit found at this coordinate. This usually means the point is outside the United States.",
          "ISRIC SoilGrids REST API v2.0 is temporarily paused. WCS and WebDAV are documented alternative access methods.",
          "Soil data for this location is not currently available.",
        ],
      };
      cache.set(cacheKey, response);
      return NextResponse.json(response);
    }

    const mukey = mukeyRows[0][0];
    if (!mukey) {
      return NextResponse.json(
        { error: "SSURGO query returned empty map unit key" },
        { status: 502 }
      );
    }

    // Step 2: Fetch mapunit name
    const muRows = await querySDA<string>(
      `SELECT muname FROM mapunit WHERE mukey = '${mukey}'`
    );
    const mapUnitName = muRows.length > 0 ? parseString(muRows[0][0]) : null;

    // Step 3: Fetch components and horizons (0-30 cm)
    // Columns (in order):
    // 0:co.cokey 1:co.comppct_r 2:co.compname 3:co.drainagecl 4:co.slope_r 5:co.compkind 6:co.majcompflag
    // 7:hz.hzdept_r 8:hz.hzdepb_r 9:hz.sandtotal_r 10:hz.silttotal_r 11:hz.claytotal_r 12:hz.om_r 13:hz.ph1to1h2o_r 14:hz.awc_r
    const rows = await querySDA<string | null>(
      `SELECT co.cokey, co.comppct_r, co.compname, co.drainagecl, co.slope_r, co.compkind, co.majcompflag,
        hz.hzdept_r, hz.hzdepb_r, hz.sandtotal_r, hz.silttotal_r, hz.claytotal_r, hz.om_r, hz.ph1to1h2o_r, hz.awc_r
       FROM component co
       LEFT JOIN chorizon hz ON co.cokey = hz.cokey AND hz.hzdept_r < 30
       WHERE co.mukey = '${mukey}'
       ORDER BY co.comppct_r DESC, co.cokey, hz.hzdept_r`
    );

    // Group rows by component
    const compMap = new Map<string, SoilComponent>();
    for (const row of rows) {
      const cokey = parseString(row[0]);
      if (!cokey) continue;

      if (!compMap.has(cokey)) {
        compMap.set(cokey, {
          cokey,
          name: parseString(row[2]) ?? "Unknown",
          percent: parseNumber(row[1]) ?? 0,
          kind: parseString(row[5]) ?? "Unknown",
          majcompflag: parseString(row[6]),
          drainage: parseString(row[3]),
          slope: parseNumber(row[4]),
          horizons: [],
        });
      }

      const comp = compMap.get(cokey)!;

      const hzdept = parseNumber(row[7]);
      const hzdepb = parseNumber(row[8]);
      if (hzdept === null || hzdepb === null) continue;

      comp.horizons.push({
        depthTop: hzdept,
        depthBottom: hzdepb,
        sand: parseNumber(row[9]),
        silt: parseNumber(row[10]),
        clay: parseNumber(row[11]),
        om: parseNumber(row[12]),
        ph: parseNumber(row[13]),
        awc: parseNumber(row[14]),
      });
    }

    const components = Array.from(compMap.values());

    if (components.length === 0) {
      return NextResponse.json(
        { error: `No components found for map unit ${mukey}` },
        { status: 502 }
      );
    }

    const totalComponentPercent = components.reduce((s, c) => s + c.percent, 0);
    const unaccountedPercent = Math.max(0, 100 - totalComponentPercent);
    if (unaccountedPercent > 0) {
      limitations.push(
        `Components account for ${totalComponentPercent}% of the map unit. The remaining ${unaccountedPercent}% is unaccounted for in the component records. SSURGO map units may include areas not represented as named components.`
      );
    } else {
      limitations.push(
        `Components account for ${totalComponentPercent}% of the map unit.`
      );
    }

    const { aggregated, dataCoverage } = aggregateComponents(components);

    // Identify which components have horizon data
    const compsWithHorizons = components.filter((c) => c.horizons.length > 0);
    const compsWithoutHorizons = components.filter((c) => c.horizons.length === 0);

    if (compsWithoutHorizons.length > 0) {
      limitations.push(
        `Components without usable horizon data: ${compsWithoutHorizons.map((c) => `${c.name} (${c.percent}%)`).join(", ")}. Depth-weighted averages exclude these.`
      );
    }

    // Coverage-aware depth property notes
    const depthCoverage = dataCoverage.depth0_30cm;
    for (const prop of ["sand", "silt", "clay", "om", "ph", "awc"] as const) {
      const cov = depthCoverage[prop];
      if (cov !== null && cov < totalComponentPercent) {
        limitations.push(
          `0-30 cm ${prop.toUpperCase()} is averaged from components covering ${cov}% of the map unit (missing values excluded, not treated as zero).`
        );
      }
    }

    if (dataCoverage.drainage !== null && dataCoverage.drainage < totalComponentPercent) {
      limitations.push(
        `Drainage class is drawn from components covering ${dataCoverage.drainage}% of the map unit.`
      );
    }

    if (dataCoverage.slope !== null && dataCoverage.slope < totalComponentPercent) {
      limitations.push(
        `Slope is averaged from components covering ${dataCoverage.slope}% of the map unit.`
      );
    }

    // Add texture-class limitation if sand+silt+clay does not sum to ~100
    const { sand, silt, clay } = aggregated.depth0_30cm;
    if (sand !== null && silt !== null && clay !== null) {
      const textureSum = sand + silt + clay;
      if (Math.abs(textureSum - 100) > 5) {
        limitations.push(
          `Depth-weighted texture fractions sum to ${textureSum.toFixed(1)}%. This may indicate incomplete horizon data or rounding differences.`
        );
      }
    }

    // General SSURGO limitations
    limitations.push(
      "SSURGO data represent the best-available survey mapping. Properties vary within a map unit. On-site testing is recommended for field-level decisions."
    );
    limitations.push(
      "Aggregated 0-30 cm values are depth-weighted averages of named soil components, weighted by component percentage. Missing values are excluded, not treated as zero."
    );

    const response: SoilResponse = {
      location: { lat, lon },
      source:
        "USDA NRCS Soil Survey Geographic Database (SSURGO). https://sdmdataaccess.sc.egov.usda.gov",
      coverage: "US-only (SSURGO).",
      mapUnit: {
        mukey,
        name: mapUnitName ?? "Unknown map unit",
      },
      totalComponentPercent,
      components,
      aggregated,
      dataCoverage,
      limitations,
    };

    cache.set(cacheKey, response);
    return NextResponse.json(response);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json(
      { error: "Failed to fetch soil data", detail: message },
      { status: 504 }
    );
  }
}
