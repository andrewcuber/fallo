"use client";

import { useState, useRef, useCallback } from "react";
import dynamic from "next/dynamic";
import { useRouter } from "next/navigation";
import { useField } from "@/components/providers";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Search, MapPin, Loader2, XCircle, CheckCircle2 } from "lucide-react";
import { normalizeCoordinates, normalizeLongitude } from "@/lib/coordinates";

const MapPicker = dynamic(() => import("@/components/map-picker"), { ssr: false });

interface Toast {
  id: number;
  message: string;
  type: "error" | "success";
}

export default function FieldCreator() {
  const router = useRouter();
  const { addField } = useField();
  const [name, setName] = useState("");
  // Raw text values for coordinate inputs to allow natural typing of negatives, decimals, etc.
  const [latText, setLatText] = useState("41.878");
  const [lonText, setLonText] = useState("-93.0977");
  const [lonNormalizedNote, setLonNormalizedNote] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [geoLoading, setGeoLoading] = useState(false);
  const [submitLoading, setSubmitLoading] = useState(false);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const toastIdRef = useRef(0);
  const nameInputRef = useRef<HTMLInputElement>(null);

  const normalizedCheck = normalizeCoordinates(latText, lonText);
  const latNum = parseFloat(latText);
  const lonNum = parseFloat(lonText);
  const latValid =
    latText.trim() !== "" &&
    /^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/.test(latText.trim()) &&
    Number.isFinite(latNum) &&
    latNum >= -90 &&
    latNum <= 90;
  const lonValid =
    lonText.trim() !== "" &&
    /^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/.test(lonText.trim()) &&
    Number.isFinite(lonNum);
  const canonicalLon = lonValid ? normalizeLongitude(lonNum) : NaN;

  const addToast = useCallback((message: string, type: "error" | "success") => {
    const id = ++toastIdRef.current;
    setToasts((prev) => [...prev, { id, message, type }]);
    setTimeout(() => {
      setToasts((prev) => prev.filter((t) => t.id !== id));
    }, 5000);
  }, []);

  async function geocode() {
    if (!query.trim()) return;
    setGeoLoading(true);
    try {
      const res = await fetch(
        `https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(query)}&limit=1`,
        { headers: { "Accept-Language": "en" } }
      );
      const data = await res.json();
      if (data && data.length > 0) {
        const norm = normalizeCoordinates(data[0].lat, data[0].lon);
        if (!norm.valid) {
          addToast(norm.error, "error");
          return;
        }
        setLatText(String(Number(norm.lat.toFixed(6))));
        setLonText(String(Number(norm.lon.toFixed(6))));
        if (norm.lonWasNormalized) {
          setLonNormalizedNote(
            `Wrapped longitude ${norm.originalLon.toFixed(2)}° normalized to ${norm.lon.toFixed(4)}°.`
          );
        } else {
          setLonNormalizedNote(null);
        }
        addToast(`Location set: ${data[0].display_name.split(",")[0]}`, "success");
      } else {
        addToast("Address not found. Try a broader search like a city name.", "error");
      }
    } catch {
      addToast("Geocoding failed. Please check your connection and try again.", "error");
    } finally {
      setGeoLoading(false);
    }
  }

  function handleSubmit() {
    if (!name.trim()) {
      addToast("Please enter a field name before saving.", "error");
      nameInputRef.current?.focus();
      return;
    }
    if (!normalizedCheck.valid) {
      addToast(normalizedCheck.error, "error");
      return;
    }

    const { lat: finalLat, lon: finalLon, lonWasNormalized, originalLon } = normalizedCheck;
    if (lonWasNormalized) {
      setLonText(String(Number(finalLon.toFixed(6))));
      setLonNormalizedNote(
        `Wrapped longitude ${originalLon.toFixed(2)}° normalized to canonical ${finalLon.toFixed(4)}°.`
      );
    }

    setSubmitLoading(true);
    setTimeout(() => {
      const field = addField({ name: name.trim(), lat: finalLat, lon: finalLon });
      setSubmitLoading(false);
      router.push(`/field/${field.id}/climate`);
    }, 300);
  }

  return (
    <>
      {/* Toast notifications — viewport-fixed, above everything including Leaflet maps */}
      <div
        className="fixed bottom-4 right-4 z-[9999] flex flex-col gap-2 max-w-sm w-full px-4 sm:px-0"
        aria-live="polite"
        aria-atomic="true"
      >
        {toasts.map((toast) => (
          <div
            key={toast.id}
            className={`flex items-start gap-3 rounded-lg px-4 py-3 shadow-lg border text-sm animate-in slide-in-from-bottom-2 fade-in duration-200 ${
              toast.type === "error"
                ? "bg-white border-accent-red/30 text-foreground"
                : "bg-white border-electric/30 text-foreground"
            }`}
          >
            {toast.type === "error" ? (
              <XCircle className="h-5 w-5 text-accent-red shrink-0 mt-0.5" aria-hidden="true" />
            ) : (
              <CheckCircle2 className="h-5 w-5 text-electric shrink-0 mt-0.5" aria-hidden="true" />
            )}
            <span className="flex-1">{toast.message}</span>
          </div>
        ))}
      </div>

      <div className="max-w-2xl mx-auto space-y-8">
        <div>
          <h1 className="text-3xl font-serif font-bold tracking-tight text-foreground">
            Add a Field
          </h1>
          <p className="text-muted-foreground mt-2">
            Name your field and mark its location on the map. You can search by address or click the map directly.
          </p>
        </div>

        <Card>
          <CardHeader>
            <CardTitle>Field Details</CardTitle>
            <CardDescription>
              Choose a descriptive name you will recognize later.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-6">
            <div className="space-y-2">
              <label className="text-sm font-medium text-foreground">Field Name <span className="text-accent-red">*</span></label>
              <Input
                ref={nameInputRef}
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="e.g., North 40, Home Farm, Lower Meadow"
                aria-required="true"
                aria-invalid={!name.trim()}
                onKeyDown={(e) => e.key === "Enter" && handleSubmit()}
              />
            </div>

            <div className="space-y-2">
              <label className="text-sm font-medium text-foreground">Search Location</label>
              <div className="flex gap-2">
                <div className="relative flex-1">
                  <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                  <Input
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    placeholder="e.g., Ames, Iowa or Jinan, China"
                    onKeyDown={(e) => e.key === "Enter" && geocode()}
                    className="pl-9"
                  />
                </div>
                <Button
                  variant="outline"
                  onClick={geocode}
                  disabled={geoLoading || !query.trim()}
                  className="shrink-0"
                >
                  {geoLoading ? (
                    <>
                      <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                      Searching…
                    </>
                  ) : (
                    "Search"
                  )}
                </Button>
              </div>
              <p className="text-xs text-muted-foreground">
                Searches use OpenStreetMap. Results may be approximate.
              </p>
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <label className="text-sm font-medium text-foreground">Latitude</label>
                <Input
                  type="text"
                  inputMode="decimal"
                  value={latText}
                  onChange={(e) => setLatText(e.target.value)}
                  onBlur={() => {
                    if (latValid) {
                      setLatText(String(Number(latNum.toFixed(6))));
                    }
                  }}
                  aria-invalid={!latValid}
                  className={!latValid && latText !== "" ? "border-accent-red" : ""}
                />
                {!latValid && latText !== "" && (
                  <p className="text-xs text-accent-red">Enter a number between -90 and 90.</p>
                )}
              </div>
              <div className="space-y-2">
                <label className="text-sm font-medium text-foreground">Longitude</label>
                <Input
                  type="text"
                  inputMode="decimal"
                  value={lonText}
                  onChange={(e) => {
                    setLonText(e.target.value);
                    setLonNormalizedNote(null);
                  }}
                  onBlur={() => {
                    if (lonValid) {
                      const normLon = normalizeLongitude(lonNum);
                      const wasWrapped = Math.abs(normLon - lonNum) > 1e-9;
                      setLonText(String(Number(normLon.toFixed(6))));
                      if (wasWrapped) {
                        setLonNormalizedNote(
                          `Normalized wrapped longitude ${lonNum.toFixed(2)}° to canonical ${normLon.toFixed(4)}°.`
                        );
                      }
                    }
                  }}
                  aria-invalid={!lonValid}
                  className={!lonValid && lonText !== "" ? "border-accent-red" : ""}
                />
                {!lonValid && lonText !== "" && (
                  <p className="text-xs text-accent-red">Enter a valid finite longitude.</p>
                )}
                {lonNormalizedNote && (
                  <p className="text-xs text-electric">{lonNormalizedNote}</p>
                )}
              </div>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <MapPin className="h-5 w-5 text-electric" />
              Map Location
            </CardTitle>
            <CardDescription>
              Click anywhere on the map to set coordinates, or drag the marker. Wrapped world-map longitudes are normalized automatically.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <MapPicker
              lat={latValid ? latNum : NaN}
              lon={lonValid ? canonicalLon : NaN}
              onChange={(nlat, nlon, meta) => {
                const norm = normalizeCoordinates(nlat, nlon);
                const finalLat = norm.valid ? norm.lat : nlat;
                const finalLon = norm.valid ? norm.lon : nlon;
                setLatText(String(Number(finalLat.toFixed(6))));
                setLonText(String(Number(finalLon.toFixed(6))));
                if (meta?.lonWasNormalized || (norm.valid && norm.lonWasNormalized)) {
                  const orig = meta?.originalLon ?? (norm.valid ? norm.originalLon : nlon);
                  setLonNormalizedNote(
                    `Map longitude ${orig.toFixed(2)}° normalized to canonical ${finalLon.toFixed(4)}°.`
                  );
                } else {
                  setLonNormalizedNote(null);
                }
              }}
            />
          </CardContent>
        </Card>

        <Button
          onClick={handleSubmit}
          size="lg"
          disabled={submitLoading}
          className="w-full bg-electric hover:bg-electric-dark text-white shadow-lg shadow-electric/20"
        >
          {submitLoading ? (
            <>
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              Saving…
            </>
          ) : (
            "Save Field & Analyze"
          )}
        </Button>
      </div>
    </>
  );
}
