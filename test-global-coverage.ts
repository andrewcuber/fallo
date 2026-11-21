import { resolveCachedSoilProfileForCoordinate } from './lib/soil-profile-utils';

const COORDS = [
  { name: "Durham, NC (Failing US Urban/Unmapped)", lat: 35.9967, lon: -78.9018 },
  { name: "Central Park, NYC (US Urban)", lat: 40.7812, lon: -73.9665 },
  { name: "Iowa Farm (US Ag)", lat: 41.9779, lon: -93.6358 },
  { name: "Paris, France (Europe Urban)", lat: 48.8566, lon: 2.3522 },
  { name: "Ukraine Farm (Europe Ag)", lat: 49.0, lon: 31.0 },
  { name: "Tokyo, Japan (Asia Urban)", lat: 35.6762, lon: 139.6503 },
  { name: "Punjab Farm, India (Asia Ag)", lat: 30.9, lon: 75.8 },
  { name: "Nairobi, Kenya (Africa)", lat: -1.2921, lon: 36.8219 },
  { name: "Mato Grosso, Brazil (South America)", lat: -12.5, lon: -55.5 }
];

async function main() {
  for (const c of COORDS) {
    console.log(`\n=========================================`);
    console.log(`Testing: ${c.name} [${c.lat}, ${c.lon}]`);
    try {
      const result = await resolveCachedSoilProfileForCoordinate(c.lat, c.lon);
      if (result.ok) {
        console.log(`Provider Tier:  ${result.response.dataTier}`);
        console.log(`Limitations:    ${JSON.stringify(result.response.limitations)}`);
        if (result.response.aggregated?.depth0_30cm) {
          const depth = result.response.aggregated.depth0_30cm;
          console.log(`Sand/Silt/Clay: ${depth.sand}% / ${depth.silt}% / ${depth.clay}%`);
          console.log(`OM / pH:        ${depth.om}% / ${depth.ph}`);
        }
      } else {
        console.log(`Failed to resolve profile.`);
      }
    } catch (err) {
      console.error(`Error:`, err);
    }
  }
}

main();