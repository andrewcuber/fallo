import { NextRequest, NextResponse } from "next/server";
import { LRUCache } from "lru-cache";
import { normalizeCoordinates } from "@/lib/coordinates";
import { fetchSoilGridsWcsProfile } from "@/lib/soilgrids-wcs";
import {
  isUsableCachedSoilResponse,
  resolveSoilProfileForCoordinate,
  type SoilApiResponsePayload,
} from "@/lib/soil-profile-utils";

export const runtime = "nodejs";
export const maxDuration = 60;

const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours for authoritative primary provider responses
const FALLBACK_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes for unmapped/international fallback responses
const US_OUTAGE_FALLBACK_CACHE_TTL_MS = 60 * 1000; // 1 minute when live SoilGrids is used during a transient USDA SSURGO outage or partial optional enrichment
const SDA_TIMEOUT_MS = 10000; // 10 seconds per USDA SDA query

const cache = new LRUCache<string, SoilApiResponsePayload>({
  max: 500,
  ttl: CACHE_TTL_MS,
});

function buildSoilCacheKey(lat: number, lon: number): string {
  return `v3_${lat.toFixed(4)}_${lon.toFixed(4)}`;
}

export async function GET(request: NextRequest) {
  const searchParams = request.nextUrl.searchParams;
  const latStr = searchParams.get("lat");
  const lonStr = searchParams.get("lon");
  const refreshParam = searchParams.get("refresh");
  const forceRefresh =
    refreshParam === "1" ||
    refreshParam?.toLowerCase() === "true" ||
    refreshParam?.toLowerCase() === "yes";

  if (!latStr || !lonStr) {
    return NextResponse.json(
      { error: "Missing lat or lon parameter" },
      { status: 400 }
    );
  }

  const norm = normalizeCoordinates(latStr, lonStr);
  if (!norm.ok) {
    return NextResponse.json(
      { error: norm.error },
      { status: 400 }
    );
  }

  const lat = norm.lat;
  const lon = norm.lon;
  const locationMeta = {
    lat,
    lon,
    ...(norm.lonWasNormalized
      ? { lonWasNormalized: true, originalLon: norm.originalLon }
      : {}),
  };

  const cacheKey = buildSoilCacheKey(lat, lon);
  if (!forceRefresh) {
    const cached = cache.get(cacheKey);
    if (cached) {
      if (isUsableCachedSoilResponse(lat, lon, cached)) {
        return NextResponse.json(
          { ...cached, location: locationMeta, cached: true },
          {
            headers: {
              "Cache-Control": "no-store",
            },
          }
        );
      }
      // Evict stale or disallowed cached fallback entry (e.g. regional_reference_fallback for a U.S. coordinate)
      cache.delete(cacheKey);
    }
  } else {
    cache.delete(cacheKey);
  }

  try {
    const result = await resolveSoilProfileForCoordinate(lat, lon, {
      soilGridsWcsFetcher: fetchSoilGridsWcsProfile,
      bypassCache: forceRefresh,
      sdaTimeoutMs: SDA_TIMEOUT_MS,
    });

    if (!result.ok) {
      return NextResponse.json(
        {
          error: result.error,
          detail: result.detail,
          usSsurgoStatus: result.usSsurgoStatus,
        },
        {
          status: result.httpStatus,
          headers: {
            "Cache-Control": "no-store",
          },
        }
      );
    }

    const response: SoilApiResponsePayload = {
      ...result.response,
      location: locationMeta,
    };

    if (
      result.cachePolicy === "ssurgo_primary" ||
      (result.cachePolicy === "soilgrids_primary" &&
        response.enrichmentStatus !== "partial_optional")
    ) {
      cache.set(cacheKey, response, { ttl: CACHE_TTL_MS });
      return NextResponse.json(response, {
        headers: {
          "Cache-Control": "private, max-age=300, stale-while-revalidate=3600",
        },
      });
    }

    if (
      result.cachePolicy === "us_outage_soilgrids_fallback" ||
      response.enrichmentStatus === "partial_optional"
    ) {
      cache.set(cacheKey, response, { ttl: US_OUTAGE_FALLBACK_CACHE_TTL_MS });
      return NextResponse.json(response, {
        headers: {
          "Cache-Control": "no-store",
        },
      });
    }

    cache.set(cacheKey, response, { ttl: FALLBACK_CACHE_TTL_MS });
    return NextResponse.json(response, {
      headers: {
        "Cache-Control": "no-store",
      },
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json(
      { error: "Failed to fetch soil data", detail: message },
      {
        status: 504,
        headers: {
          "Cache-Control": "no-store",
        },
      }
    );
  }
}
