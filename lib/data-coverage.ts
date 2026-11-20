export type FeatureAvailabilityStatus =
  | "available"
  | "partially_available"
  | "unavailable"
  | "temporarily_unavailable";

export interface FeatureDataCoverage {
  status: FeatureAvailabilityStatus;
  missingProperties: string[];
  reasons: string[];
}

import { RawClimateApiResponse, RawSoilApiResponse } from "@/components/providers";
import { resolveSoilDataTier, classifySoilPropertyStatus, buildSoilProfileDisplayModel } from "./soil-profile-utils";

export interface FieldDataCoverage {
  climate: FeatureDataCoverage;
  soil: FeatureDataCoverage;
  rotations: FeatureDataCoverage;
  simulator: FeatureDataCoverage;
  calendar: FeatureDataCoverage;
  analogues: FeatureDataCoverage;
}

export function computeFieldDataCoverage(
  climateRaw: RawClimateApiResponse | null,
  soilRaw: RawSoilApiResponse | null
): FieldDataCoverage {
  // Default to available until data loads
  const defaultCoverage: FeatureDataCoverage = { status: "available", missingProperties: [], reasons: [] };
  
  if (!climateRaw || !soilRaw) {
    return {
      climate: defaultCoverage,
      soil: defaultCoverage,
      rotations: defaultCoverage,
      simulator: defaultCoverage,
      calendar: defaultCoverage,
      analogues: defaultCoverage,
    };
  }

  // 1. Soil Coverage
  const soilCoverage: FeatureDataCoverage = { status: "available", missingProperties: [], reasons: [] };
  
  if ("error" in soilRaw && (soilRaw as any).error) {
    soilCoverage.status = "temporarily_unavailable";
    soilCoverage.reasons.push(`Soil API failed: ${(soilRaw as any).error}`);
  } else {
    // We check missing properties
    const displayModel = buildSoilProfileDisplayModel(soilRaw);
    const missingProps: string[] = [];
    let isTemporarilyUnavailable = false;
    
    if (soilRaw.usSsurgoFallback && soilRaw.usSsurgoFallback.reason === "request_error") {
      isTemporarilyUnavailable = true;
      soilCoverage.reasons.push("USDA SSURGO service is temporarily unavailable. Displaying fallback data.");
    }
    
    if (displayModel.dataTier === "regional_reference_fallback") {
      soilCoverage.reasons.push("Coordinate-specific soil data unavailable; showing regional topsoil reference estimate.");
    }

    const checkProp = (key: keyof typeof displayModel.propertyStatuses, label: string) => {
      const stat = displayModel.propertyStatuses[key];
      if (stat === "missing_at_location") {
        missingProps.push(`${label} (No data at this location)`);
      } else if (stat === "provider_unsupported" && displayModel.dataTier === "regional_reference_fallback") {
        missingProps.push(`${label} (Not available in regional fallback)`);
      } else if (stat === "provider_unsupported") {
        missingProps.push(`${label} (Not supported by provider)`);
      }
    };

    checkProp("texture", "Texture");
    checkProp("om", "Organic Matter");
    checkProp("ph", "pH");
    checkProp("awc", "AWC");
    checkProp("slope", "Slope");
    checkProp("drainage", "Drainage");

    if (missingProps.length > 0) {
      soilCoverage.missingProperties = missingProps;
      // if ALL are missing, it's unavailable. But we at least have 'slope' usually or fallback.
      // If we fall back to regional reference, it's partially_available.
      if (displayModel.availableMetrics.length === 0 && !displayModel.texture.valid) {
        soilCoverage.status = "unavailable";
      } else {
        soilCoverage.status = "partially_available";
      }
    }
    
    if (isTemporarilyUnavailable) {
      soilCoverage.status = "temporarily_unavailable";
    }
  }

  // 2. Climate Coverage
  const climateCoverage: FeatureDataCoverage = { status: "available", missingProperties: [], reasons: [] };
  if ("error" in climateRaw && (climateRaw as any).error) {
    climateCoverage.status = "temporarily_unavailable";
    climateCoverage.reasons.push(`Climate API failed: ${(climateRaw as any).error}`);
  }

  // Other features depend on Climate and Soil
  const aggregateCoverage = (features: FeatureDataCoverage[]): FeatureDataCoverage => {
    const statuses = features.map(f => f.status);
    let status: FeatureAvailabilityStatus = "available";
    if (statuses.includes("unavailable")) status = "unavailable";
    else if (statuses.includes("temporarily_unavailable")) status = "temporarily_unavailable";
    else if (statuses.includes("partially_available")) status = "partially_available";

    return {
      status,
      missingProperties: Array.from(new Set(features.flatMap(f => f.missingProperties))),
      reasons: Array.from(new Set(features.flatMap(f => f.reasons)))
    };
  };

  const downstream = aggregateCoverage([climateCoverage, soilCoverage]);

  return {
    climate: climateCoverage,
    soil: soilCoverage,
    rotations: downstream,
    simulator: downstream,
    calendar: climateCoverage, // only depends on climate? Wait, calendar depends on climate.
    analogues: climateCoverage,
  };
}
