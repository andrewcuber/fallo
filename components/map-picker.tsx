"use client";

import { useEffect } from "react";
import { MapContainer, TileLayer, Marker, useMap, useMapEvents } from "react-leaflet";
import L from "leaflet";
import "leaflet/dist/leaflet.css";

// Fix default Leaflet icon paths in Next.js
import icon from "leaflet/dist/images/marker-icon.png";
import iconShadow from "leaflet/dist/images/marker-shadow.png";

const DefaultIcon = L.icon({
  iconUrl: typeof icon === "string" ? icon : icon.src,
  shadowUrl: typeof iconShadow === "string" ? iconShadow : iconShadow.src,
  iconSize: [25, 41],
  iconAnchor: [12, 41],
});

L.Marker.prototype.options.icon = DefaultIcon;

interface MapPickerProps {
  lat: number;
  lon: number;
  onChange: (lat: number, lon: number) => void;
}

function MapEvents({ onChange }: { onChange: (lat: number, lon: number) => void }) {
  useMapEvents({
    click(e) {
      onChange(e.latlng.lat, e.latlng.lng);
    },
  });
  return null;
}

function ChangeView({ lat, lon }: { lat: number; lon: number }) {
  const map = useMap();
  useEffect(() => {
    map.setView([lat, lon], map.getZoom());
  }, [lat, lon, map]);
  return null;
}

function isValidCoord(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v) && !Number.isNaN(v);
}

export default function MapPicker({ lat, lon, onChange }: MapPickerProps) {
  const safeLat = isValidCoord(lat) ? lat : 41.878;
  const safeLon = isValidCoord(lon) ? lon : -93.0977;
  const coordsValid = isValidCoord(lat) && isValidCoord(lon);

  return (
    <div className="relative w-full h-80 sm:h-96 rounded-lg border border-border overflow-hidden">
      <MapContainer
        center={[safeLat, safeLon]}
        zoom={10}
        scrollWheelZoom={false}
        className="w-full h-full"
      >
        <TileLayer
          attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
          url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
        />
        {coordsValid && (
          <Marker
            position={[lat, lon]}
            draggable
            eventHandlers={{
              dragend(e) {
                const marker = e.target;
                const pos = marker.getLatLng();
                onChange(pos.lat, pos.lng);
              },
            }}
          />
        )}
        <MapEvents onChange={onChange} />
        <ChangeView lat={safeLat} lon={safeLon} />
      </MapContainer>

      {!coordsValid && (
        <div className="absolute inset-0 flex items-center justify-center bg-muted/80 backdrop-blur-sm z-[500]">
          <p className="text-sm text-muted-foreground text-center px-4">
            Enter valid latitude and longitude to display the map.
          </p>
        </div>
      )}
    </div>
  );
}
