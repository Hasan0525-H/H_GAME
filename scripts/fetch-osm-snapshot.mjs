import { writeFile, mkdir } from 'node:fs/promises';

const CENTER = { lat: 18.58979, lon: 41.4123419 };
const RADIUS_M = 3500;
const endpoints = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://overpass.nchc.org.tw/api/interpreter'
];

const q =
  '[out:json][timeout:60];(' +
  'way["highway"](around:' + RADIUS_M + ',' + CENTER.lat + ',' + CENTER.lon + ');' +
  'way["building"](around:' + RADIUS_M + ',' + CENTER.lat + ',' + CENTER.lon + ');' +
  'way["barrier"](around:' + RADIUS_M + ',' + CENTER.lat + ',' + CENTER.lon + ');' +
  'way["landuse"](around:' + RADIUS_M + ',' + CENTER.lat + ',' + CENTER.lon + ');' +
  'way["leisure"](around:' + RADIUS_M + ',' + CENTER.lat + ',' + CENTER.lon + ');' +
  'way["natural"](around:' + RADIUS_M + ',' + CENTER.lat + ',' + CENTER.lon + ');' +
  'way["waterway"](around:' + RADIUS_M + ',' + CENTER.lat + ',' + CENTER.lon + ');' +
  'way["power"="line"](around:' + RADIUS_M + ',' + CENTER.lat + ',' + CENTER.lon + ');' +
  'node["natural"="tree"](around:' + RADIUS_M + ',' + CENTER.lat + ',' + CENTER.lon + ');' +
  'node["power"~"pole|tower"](around:' + RADIUS_M + ',' + CENTER.lat + ',' + CENTER.lon + ');' +
  'node["highway"="street_lamp"](around:' + RADIUS_M + ',' + CENTER.lat + ',' + CENTER.lon + ');' +
  'node["barrier"](around:' + RADIUS_M + ',' + CENTER.lat + ',' + CENTER.lon + ');' +
  'node["name"](around:' + RADIUS_M + ',' + CENTER.lat + ',' + CENTER.lon + ');' +
  'node["addr:housenumber"](around:' + RADIUS_M + ',' + CENTER.lat + ',' + CENTER.lon + ');' +
  'node["entrance"](around:' + RADIUS_M + ',' + CENTER.lat + ',' + CENTER.lon + ');' +
  'node["amenity"](around:' + RADIUS_M + ',' + CENTER.lat + ',' + CENTER.lon + ');' +
  'node["shop"](around:' + RADIUS_M + ',' + CENTER.lat + ',' + CENTER.lon + ');' +
  'node["tourism"](around:' + RADIUS_M + ',' + CENTER.lat + ',' + CENTER.lon + ');' +
  'node["place"](around:' + RADIUS_M + ',' + CENTER.lat + ',' + CENTER.lon + ');' +
  'way["amenity"](around:' + RADIUS_M + ',' + CENTER.lat + ',' + CENTER.lon + ');' +
  'way["shop"](around:' + RADIUS_M + ',' + CENTER.lat + ',' + CENTER.lon + ');' +
  'way["tourism"](around:' + RADIUS_M + ',' + CENTER.lat + ',' + CENTER.lon + ');' +
  'way["place"](around:' + RADIUS_M + ',' + CENTER.lat + ',' + CENTER.lon + ');' +
  ');(._;>;);out meta;';

let data = null;
let usedEndpoint = '';
for (const endpoint of endpoints) {
  try {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {'content-type':'application/x-www-form-urlencoded;charset=UTF-8'},
      body: 'data=' + encodeURIComponent(q)
    });
    if (!response.ok) throw new Error('HTTP ' + response.status);
    const json = await response.json();
    if (!Array.isArray(json.elements) || !json.elements.length) throw new Error('empty result');
    data = json;
    usedEndpoint = endpoint;
    break;
  } catch (err) {
    console.warn('snapshot endpoint failed:', endpoint, err.message);
  }
}

if (!data) {
  console.warn('No bundled OSM snapshot produced; package remains usable with live OSM.');
  process.exit(0);
}

await mkdir('data', { recursive: true });
await writeFile('data/osm-snapshot.json', JSON.stringify({
  schema_version: 1,
  center: CENTER,
  radius_m: RADIUS_M,
  fetched_at: new Date().toISOString(),
  source: 'OpenStreetMap via Overpass',
  endpoint: usedEndpoint,
  elements: data.elements
}));

console.log('bundled OSM snapshot elements:', data.elements.length);
