import { mkdir, writeFile, rm, appendFile } from 'node:fs/promises';
import { gunzipSync } from 'node:zlib';

const CENTER = { lat: 18.58979, lon: 41.4123419 };
const LOCAL_BBOX = { minLon: 41.3791703, minLat: 18.5583491, maxLon: 41.4455135, maxLat: 18.6212309 };
const LINKS = 'https://bfppub.blob.core.windows.net/$web/2026-08-13/dataset-links.csv';
const SECTOR_DEG = 0.01;
const TARGET_PACK_BYTES = 378 * 1024 * 1024;
const MIN_PACK_BYTES = 370 * 1024 * 1024;

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

function quadkeyCenter(q) {
  let x = 0, y = 0;
  for (let i = q.length; i > 0; i--) {
    const mask = 1 << (i - 1);
    const d = Number(q[q.length - i]);
    if (d === 1 || d === 3) x |= mask;
    if (d === 2 || d === 3) y |= mask;
  }
  const n = 1 << q.length;
  const xf = (x + 0.5) / n;
  const yf = (y + 0.5) / n;
  const lon = xf * 360 - 180;
  const lat = Math.atan(Math.sinh(Math.PI * (1 - 2 * yf))) * 180 / Math.PI;
  return { lat, lon };
}

function haversine(a, b) {
  const R = 6371000;
  const p1 = a.lat * Math.PI / 180;
  const p2 = b.lat * Math.PI / 180;
  const dp = (b.lat - a.lat) * Math.PI / 180;
  const dl = (b.lon - a.lon) * Math.PI / 180;
  const h = Math.sin(dp / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
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

function normalizeFeature(obj) {
  if (obj?.type === 'Feature' && obj.geometry) return obj;
  if (obj?.geometry) return { type: 'Feature', geometry: obj.geometry, properties: obj.properties || {} };
  return null;
}

function geometryCenter(feature) {
  const coords = feature?.geometry?.coordinates;
  if (!coords) return null;
  let sx = 0, sy = 0, n = 0;
  const visit = value => {
    if (!Array.isArray(value)) return;
    if (
      value.length >= 2 &&
      typeof value[0] !== 'object' &&
      Number.isFinite(Number(value[0])) &&
      Number.isFinite(Number(value[1]))
    ) {
      sx += Number(value[0]);
      sy += Number(value[1]);
      n++;
    } else {
      for (const item of value) visit(item);
    }
  };
  visit(coords);
  return n ? { lon: sx / n, lat: sy / n } : null;
}

function featureBounds(feature) {
  const coords = feature?.geometry?.coordinates;
  if (!coords) return null;
  let minLon = Infinity, minLat = Infinity, maxLon = -Infinity, maxLat = -Infinity;
  const visit = value => {
    if (!Array.isArray(value)) return;
    if (
      value.length >= 2 &&
      typeof value[0] !== 'object' &&
      Number.isFinite(Number(value[0])) &&
      Number.isFinite(Number(value[1]))
    ) {
      const lon = Number(value[0]), lat = Number(value[1]);
      minLon = Math.min(minLon, lon);
      minLat = Math.min(minLat, lat);
      maxLon = Math.max(maxLon, lon);
      maxLat = Math.max(maxLat, lat);
    } else {
      for (const item of value) visit(item);
    }
  };
  visit(coords);
  return Number.isFinite(minLon) ? { minLon, minLat, maxLon, maxLat } : null;
}

function intersects(a, b) {
  return !(a.maxLon < b.minLon || a.minLon > b.maxLon || a.maxLat < b.minLat || a.minLat > b.maxLat);
}

function sectorKey(lat, lon) {
  const iy = Math.floor(lat / SECTOR_DEG);
  const ix = Math.floor(lon / SECTOR_DEG);
  return iy + '_' + ix;
}

function sectorMetaFromKey(key) {
  const [iy, ix] = key.split('_').map(Number);
  return {
    minLat: iy * SECTOR_DEG,
    minLon: ix * SECTOR_DEG,
    maxLat: (iy + 1) * SECTOR_DEG,
    maxLon: (ix + 1) * SECTOR_DEG
  };
}

await rm('data/building-sectors', { recursive: true, force: true });
await mkdir('data/building-sectors', { recursive: true });

const linksResp = await fetch(LINKS, { headers: { 'User-Agent': 'H_GAME-Saeeda/2.0' } });
if (!linksResp.ok) throw new Error('dataset-links HTTP ' + linksResp.status);

const csv = await linksResp.text();
const rowsText = csv.trim().split(/\r?\n/);
const headers = parseCsvLine(rowsText.shift());
const ix = Object.fromEntries(headers.map((h, i) => [h.trim(), i]));
const rows = rowsText.map(parseCsvLine)
  .filter(r => String(r[ix.Location] || '').toLowerCase().includes('saudi'))
  .filter(r => /^\d+$/.test(String(r[ix.QuadKey] || '')))
  .map(r => {
    const q = String(r[ix.QuadKey]);
    const center = quadkeyCenter(q);
    return {
      quadkey: q,
      url: r[ix.Url],
      distance: haversine(CENTER, center)
    };
  })
  .filter(r => /^https?:\/\//.test(r.url))
  .sort((a, b) => a.distance - b.distance);

if (!rows.length) throw new Error('No Microsoft Saudi building tiles found');

const localFeatures = [];
const sectors = new Map();
let totalPackBytes = 0;
let totalFeatures = 0;
let tileCount = 0;
let reachedTarget = false;

for (const row of rows) {
  if (reachedTarget) break;

  console.log(
    'Downloading Microsoft buildings tile',
    row.quadkey,
    'distance_km=' + (row.distance / 1000).toFixed(1)
  );

  const response = await fetch(row.url, { headers: { 'User-Agent': 'H_GAME-Saeeda/2.0' } });
  if (!response.ok) {
    console.warn('Skipping tile HTTP', response.status, row.url);
    continue;
  }

  const compressed = Buffer.from(await response.arrayBuffer());
  const text = gunzipSync(compressed).toString('utf8');
  const sectorBatches = new Map();

  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;

    let raw;
    try { raw = JSON.parse(line); } catch { continue; }

    const feature = normalizeFeature(raw);
    if (!feature) continue;

    const center = geometryCenter(feature);
    if (!center) continue;

    feature.properties = {
      ...(feature.properties || {}),
      __source: 'Microsoft Global ML Building Footprints'
    };

    const bounds = featureBounds(feature);
    if (bounds && intersects(bounds, LOCAL_BBOX)) {
      localFeatures.push(feature);
    }

    const key = sectorKey(center.lat, center.lon);
    const serialized = JSON.stringify(feature) + '\n';
    const bytes = Buffer.byteLength(serialized);

    if (totalPackBytes + bytes > TARGET_PACK_BYTES && totalPackBytes >= MIN_PACK_BYTES) {
      reachedTarget = true;
      break;
    }

    if (!sectorBatches.has(key)) sectorBatches.set(key, []);
    sectorBatches.get(key).push(serialized);

    const meta = sectors.get(key) || {
      file: key + '.pack',
      ...sectorMetaFromKey(key),
      bytes: 0,
      features: 0
    };
    meta.bytes += bytes;
    meta.features++;
    sectors.set(key, meta);

    totalPackBytes += bytes;
    totalFeatures++;
  }

  for (const [key, batch] of sectorBatches) {
    if (!batch.length) continue;
    await appendFile('data/building-sectors/' + key + '.pack', batch.join(''), 'utf8');
  }

  tileCount++;
  console.log(
    'offline footprint pack:',
    (totalPackBytes / 1024 / 1024).toFixed(1) + ' MiB',
    'features=' + totalFeatures,
    'tiles=' + tileCount
  );
}

if (localFeatures.length < 10) {
  throw new Error('Only ' + localFeatures.length + ' Microsoft footprints found in Saeeda local bbox');
}
if (totalPackBytes < MIN_PACK_BYTES) {
  throw new Error(
    'Offline footprint pack too small: ' +
    (totalPackBytes / 1024 / 1024).toFixed(1) +
    ' MiB; required at least ' +
    (MIN_PACK_BYTES / 1024 / 1024).toFixed(1) +
    ' MiB'
  );
}

await writeFile('data/ms-buildings.geojson', JSON.stringify({
  type: 'FeatureCollection',
  name: 'Saeeda Al-Sawalha Microsoft building footprints',
  source: 'Microsoft Global ML Building Footprints',
  license: 'CDLA-Permissive-2.0',
  fetched_at: new Date().toISOString(),
  features: localFeatures
}));

const sectorObject = {};
for (const [key, value] of [...sectors.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
  sectorObject[key] = value;
}

await writeFile('data/building-sectors/index.json', JSON.stringify({
  schema_version: 1,
  source: 'Microsoft Global ML Building Footprints',
  license: 'CDLA-Permissive-2.0',
  center: CENTER,
  sector_deg: SECTOR_DEG,
  target_pack_bytes: TARGET_PACK_BYTES,
  total_pack_bytes: totalPackBytes,
  total_features: totalFeatures,
  source_tiles: tileCount,
  generated_at: new Date().toISOString(),
  sectors: sectorObject
}));

console.log('Local Saeeda building footprints:', localFeatures.length);
console.log('Offline building pack bytes:', totalPackBytes);
console.log('Offline building pack MiB:', (totalPackBytes / 1024 / 1024).toFixed(2));
console.log('Offline building sectors:', sectors.size);
console.log('Microsoft source tiles used:', tileCount);
