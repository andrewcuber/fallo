"use client";

import { useState, useRef, useCallback } from "react";
import dynamic from "next/dynamic";
import { useRouter } from "next/navigation";
import { useField } from "@/components/providers";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Search, MapPin, Loader2, XCircle, CheckCircle2 } from "lucide-react";

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
  const [query, setQuery] = useState("");
  const [geoLoading, setGeoLoading] = useState(false);
  const [submitLoading, setSubmitLoading] = useState(false);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const toastIdRef = useRef(0);
  const nameInputRef = useRef<HTMLInputElement>(null);

  // Parsed numeric values (used for map and validation)
  const latNum = parseFloat(latText);
  const lonNum = parseFloat(lonText);
  const latValid = !Number.isNaN(latNum) && latNum >= -90 && latNum <= 90;
  const lonValid = !Number.isNaN(lonNum) && lonNum >= -180 && lonNum <= 180;

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
        const newLat = parseFloat(data[0].lat);
        const newLon = parseFloat(data[0].lon);
        setLatText(String(newLat));
        setLonText(String(newLon));
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

  function validate() {
    if (!name.trim()) {
      addToast("Please enter a field name before saving.", "error");
      nameInputRef.current?.focus();
      return false;
    }
    if (Number.isNaN(latNum)) {
      addToast("Latitude must be a valid number.", "error");
      return false;
    }
    if (latNum < -90 || latNum > 90) {
      addToast("Latitude must be between -90 and 90.", "error");
      return false;
    }
    if (Number.isNaN(lonNum)) {
      addToast("Longitude must be a valid number.", "error");
      return false;
    }
    if (lonNum < -180 || lonNum > 180) {
      addToast("Longitude must be between -180 and 180.", "error");
      return false;
    }
    return true;
  }

  function handleSubmit() {
    if (!validate()) return;
    setSubmitLoading(true);
    // Small delay to show loading state
    setTimeout(() => {
      const field = addField({ name: name.trim(), lat: latNum, lon: lonNum });
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
                    placeholder="e.g., Ames, Iowa"
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
                    const parsed = parseFloat(latText);
                    if (!Number.isNaN(parsed)) {
                      setLatText(String(parsed));
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
                  onChange={(e) => setLonText(e.target.value)}
                  onBlur={() => {
                    const parsed = parseFloat(lonText);
                    if (!Number.isNaN(parsed)) {
                      setLonText(String(parsed));
                    }
                  }}
                  aria-invalid={!lonValid}
                  className={!lonValid && lonText !== "" ? "border-accent-red" : ""}
                />
                {!lonValid && lonText !== "" && (
                  <p className="text-xs text-accent-red">Enter a number between -180 and 180.</p>
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
              Click anywhere on the map to set coordinates, or drag the marker.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <MapPicker
              lat={latNum}
              lon={lonNum}
              onChange={(nlat, nlon) => {
                setLatText(String(Number(nlat.toFixed(6))));
                setLonText(String(Number(nlon.toFixed(6))));
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
