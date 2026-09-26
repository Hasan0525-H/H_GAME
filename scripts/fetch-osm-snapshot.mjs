import { writeFile, mkdir } from 'node:fs/promises';
import { XMLParser } from 'fast-xml-parser';

const CENTER = { lat: 18.58979, lon: 41.4123419 };
const RADIUS_M = 3500;
const required = process.argv.includes('--required');

const coreQuery =
  '[out:json][timeout:45];(' +
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
  ');(._;>;);out meta;';

const overpassEndpoints = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://overpass.private.coffee/api/interpreter'
];

const headers = {
  'User-Agent': 'H_GAME-Saeeda/1.0 (+https://github.com/Hasan0525-H/H_GAME)',
  'Accept': 'application/json,text/plain,*/*'
};

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function fetchOverpass(endpoint) {
  const url = endpoint + '?data=' + encodeURIComponent(coreQuery);
  const response = await fetch(url, { headers, signal: AbortSignal.timeout(45000) });
  if (!response.ok) throw new Error('HTTP ' + response.status);
  const json = await response.json();
  if (!Array.isArray(json.elements) || json.elements.length < 10) throw new Error('empty/too-small result');
  return json.elements;
}

function asArray(value) {
  if (value == null) return [];
  return Array.isArray(value) ? value : [value];
}

function tagsFromXml(item) {
  const tags = {};
  for (const t of asArray(item?.tag)) {
    if (t?.k != null && t?.v != null) tags[String(t.k)] = String(t.v);
  }
  return tags;
}

async function fetchOsmApiFallback() {
  const latDelta = RADIUS_M / 111320;
  const lonDelta = RADIUS_M / (111320 * Math.cos(CENTER.lat * Math.PI / 180));
  const minLat = CENTER.lat - latDelta;
  const maxLat = CENTER.lat + latDelta;
  const minLon = CENTER.lon - lonDelta;
  const maxLon = CENTER.lon + lonDelta;
  const url =
    'https://api.openstreetmap.org/api/0.6/map?bbox=' +
    [minLon, minLat, maxLon, maxLat].map(v => v.toFixed(7)).join(',');

  const response = await fetch(url, {
    headers: {
      'User-Agent': headers['User-Agent'],
      'Accept': 'application/xml,text/xml,*/*'
    },
    signal: AbortSignal.timeout(90000)
  });
  if (!response.ok) throw new Error('OSM API HTTP ' + response.status);

  const xml = await response.text();
  if (!xml.includes('<osm')) throw new Error('OSM API returned non-OSM payload');

  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: '',
    parseAttributeValue: true
  });
  const parsed = parser.parse(xml);
  const osm = parsed?.osm || {};
  const elements = [];

  for (const n of asArray(osm.node)) {
    if (!Number.isFinite(Number(n.id)) || !Number.isFinite(Number(n.lat)) || !Number.isFinite(Number(n.lon))) continue;
    const tags = tagsFromXml(n);
    const node = {
      type: 'node',
      id: Number(n.id),
      lat: Number(n.lat),
      lon: Number(n.lon)
    };
    if (Object.keys(tags).length) node.tags = tags;
    if (n.timestamp) node.timestamp = String(n.timestamp);
    elements.push(node);
  }

  for (const w of asArray(osm.way)) {
    if (!Number.isFinite(Number(w.id))) continue;
    const refs = asArray(w.nd).map(x => Number(x?.ref)).filter(Number.isFinite);
    if (refs.length < 2) continue;
    const tags = tagsFromXml(w);
    const way = {
      type: 'way',
      id: Number(w.id),
      nodes: refs,
      tags
    };
    if (w.timestamp) way.timestamp = String(w.timestamp);
    elements.push(way);
  }

  if (elements.length < 10) throw new Error('OSM API fallback returned too few elements');
  return elements;
}

let elements = null;
let usedEndpoint = '';

for (const endpoint of overpassEndpoints) {
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      elements = await fetchOverpass(endpoint);
      usedEndpoint = endpoint;
      break;
    } catch (err) {
      console.warn('Overpass failed:', endpoint, 'attempt', attempt, err.message);
      if (attempt < 2) await sleep(1500 * attempt);
    }
  }
  if (elements) break;
}

if (!elements) {
  try {
    console.log('Trying OpenStreetMap map API fallback...');
    elements = await fetchOsmApiFallback();
    usedEndpoint = 'https://api.openstreetmap.org/api/0.6/map';
  } catch (err) {
    console.warn('OSM API fallback failed:', err.message);
  }
}

if (!elements) {
  const message = 'No bundled OSM snapshot produced from Overpass or OSM API.';
  if (required) throw new Error(message);
  console.warn(message);
  process.exit(0);
}

await mkdir('data', { recursive: true });
await writeFile('data/osm-snapshot.json', JSON.stringify({
  schema_version: 1,
  center: CENTER,
  radius_m: RADIUS_M,
  fetched_at: new Date().toISOString(),
  source: 'OpenStreetMap',
  endpoint: usedEndpoint,
  elements
}));

console.log('bundled OSM snapshot elements:', elements.length, 'source:', usedEndpoint);
