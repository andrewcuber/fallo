import { NextRequest, NextResponse } from "next/server";
import { normalizeCoordinates } from "@/lib/coordinates";
import { fetchSoilGridsWcsProfile } from "@/lib/soilgrids-wcs";
import { resolveCachedSoilProfileForCoordinate } from "@/lib/soil-profile-utils";

export const runtime = "nodejs";
export const maxDuration = 60;

const SDA_TIMEOUT_MS = 10000; // 10 seconds per USDA SDA query

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

  try {
    const result = await resolveCachedSoilProfileForCoordinate(lat, lon, {
      forceRefresh,
      soilGridsWcsFetcher: fetchSoilGridsWcsProfile,
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
            "Cache-Control": result.cacheControl,
          },
        }
      );
    }

    return NextResponse.json(
      {
        ...result.response,
        location: locationMeta,
      },
      {
        headers: {
          "Cache-Control": result.cacheControl,
        },
      }
    );
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
