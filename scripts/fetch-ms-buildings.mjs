import { mkdir, writeFile } from 'node:fs/promises';
import { gunzipSync } from 'node:zlib';

const CENTER = { lat: 18.58979, lon: 41.4123419 };
const BBOX = { minLon: 41.3791703, minLat: 18.5583491, maxLon: 41.4455135, maxLat: 18.6212309 };
const LINKS = 'https://bfppub.blob.core.windows.net/$web/2026-08-13/dataset-links.csv';

function tileXY(lat, lon, level = 9) {
  const sinLat = Math.sin(lat * Math.PI / 180);
  const n = 1 << level;
  const x = Math.floor(((lon + 180) / 360) * n);
  const y = Math.floor((0.5 - Math.log((1 + sinLat) / (1 - sinLat)) / (4 * Math.PI)) * n);
  return [Math.max(0, Math.min(n - 1, x)), Math.max(0, Math.min(n - 1, y))];
}

function quadkey(lat, lon, level = 9) {
  const [x, y] = tileXY(lat, lon, level);
  let q = '';
  for (let i = level; i > 0; i--) {
    let d = 0;
    const mask = 1 << (i - 1);
    if (x & mask) d++;
    if (y & mask) d += 2;
    q += d;
  }
  return q;
}

function parseCsvLine(line) {
  const out = [];
  let cur = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (quoted && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else {
        quoted = !quoted;
      }
    } else if (ch === ',' && !quoted) {
      out.push(cur);
      cur = '';
    } else {
      cur += ch;
    }
  }
  out.push(cur);
  return out;
}

function featureBounds(feature) {
  const g = feature?.geometry;
  if (!g?.coordinates) return null;
  let minLon = Infinity, minLat = Infinity, maxLon = -Infinity, maxLat = -Infinity;
  const visit = v => {
    if (!Array.isArray(v)) return;
    if (v.length >= 2 && typeof v[0] !== 'object' && Number.isFinite(Number(v[0])) && Number.isFinite(Number(v[1]))) {
      const lon = Number(v[0]), lat = Number(v[1]);
      minLon = Math.min(minLon, lon);
      minLat = Math.min(minLat, lat);
      maxLon = Math.max(maxLon, lon);
      maxLat = Math.max(maxLat, lat);
    } else {
      for (const x of v) visit(x);
    }
  };
  visit(g.coordinates);
  return Number.isFinite(minLon) ? { minLon, minLat, maxLon, maxLat } : null;
}

function intersects(a, b) {
  return !(a.maxLon < b.minLon || a.minLon > b.maxLon || a.maxLat < b.minLat || a.minLat > b.maxLat);
}

function normalizeFeature(obj) {
  if (obj?.type === 'Feature') return obj;
  if (obj?.geometry) return { type: 'Feature', geometry: obj.geometry, properties: obj.properties || {} };
  return null;
}

const wanted = new Set([
  quadkey(CENTER.lat, CENTER.lon),
  quadkey(BBOX.minLat, BBOX.minLon),
  quadkey(BBOX.minLat, BBOX.maxLon),
  quadkey(BBOX.maxLat, BBOX.minLon),
  quadkey(BBOX.maxLat, BBOX.maxLon)
]);

const resp = await fetch(LINKS, { headers: { 'User-Agent': 'H_GAME-Saeeda/quality-first' } });
if (!resp.ok) throw new Error('dataset-links HTTP ' + resp.status);

const csv = await resp.text();
const lines = csv.trim().split(/\r?\n/);
const headers = parseCsvLine(lines.shift());
const ix = Object.fromEntries(headers.map((h, i) => [h.trim(), i]));
const rows = lines.map(parseCsvLine);

const matches = rows.filter(r => {
  const loc = String(r[ix.Location] || '').toLowerCase();
  const q = String(r[ix.QuadKey] || '');
  return loc.includes('saudi') && wanted.has(q);
});

if (!matches.length) throw new Error('No Saudi Microsoft building tile matched the target area');

const features = [];
for (const r of matches) {
  const url = r[ix.Url];
  if (!/^https?:\/\//.test(url)) continue;

  const rr = await fetch(url, { headers: { 'User-Agent': 'H_GAME-Saeeda/quality-first' } });
  if (!rr.ok) throw new Error('tile HTTP ' + rr.status);

  const buf = Buffer.from(await rr.arrayBuffer());
  const text = gunzipSync(buf).toString('utf8');

  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let obj;
    try { obj = JSON.parse(line); } catch { continue; }
    const f = normalizeFeature(obj);
    if (!f) continue;
    const b = featureBounds(f);
    if (b && intersects(b, BBOX)) {
      f.properties = { ...(f.properties || {}), __source: 'Microsoft Global ML Building Footprints' };
      features.push(f);
    }
  }
}

if (features.length < 10) throw new Error('Too few local building footprints: ' + features.length);

await mkdir('data', { recursive: true });
await writeFile('data/ms-buildings.geojson', JSON.stringify({
  type: 'FeatureCollection',
  name: 'Saeeda Al-Sawalha Microsoft building footprints',
  source: 'Microsoft Global ML Building Footprints',
  license: 'CDLA-Permissive-2.0',
  fetched_at: new Date().toISOString(),
  features
}));

console.log('Local Saeeda building footprints:', features.length);
