import { queryUsdaSda } from './lib/soil-profile-utils';

async function testPolygon() {
  const lat = 35.9963;
  const lon = -78.9112;
  const distanceMeters = 100;
  const latOffset = distanceMeters / 111320;
  const lonOffset = distanceMeters / (111320 * Math.cos(lat * Math.PI / 180));
  const minLon = (lon - lonOffset).toFixed(6);
  const maxLon = (lon + lonOffset).toFixed(6);
  const minLat = (lat - latOffset).toFixed(6);
  const maxLat = (lat + latOffset).toFixed(6);
  
  const wkt = `POLYGON((${minLon} ${minLat}, ${maxLon} ${minLat}, ${maxLon} ${maxLat}, ${minLon} ${maxLat}, ${minLon} ${minLat}))`;
  console.log('WKT:', wkt);
  
  try {
    const rows = await queryUsdaSda(`SELECT mukey FROM SDA_Get_Mukey_from_intersection_with_WktWgs84('${wkt}')`);
    console.log(rows);
  } catch(e) {
    console.error(e);
  }
}

testPolygon();
