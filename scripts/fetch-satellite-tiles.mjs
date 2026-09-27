import { mkdir, writeFile, stat } from 'node:fs/promises';

const CENTER = { lat: 18.58979, lon: 41.4123419 };
const ZOOM = 16;
const RADIUS = 3;
const OUT = 'assets/satellite';
const BASE = 'https://tiles.maps.eox.at/wmts/1.0.0/s2cloudless-2024_3857/default/GoogleMapsCompatible';

function lonLatToTile(lon, lat, zoom) {
  const n = 2 ** zoom;
  const x = Math.floor((lon + 180) / 360 * n);
  const latRad = lat * Math.PI / 180;
  const y = Math.floor((1 - Math.asinh(Math.tan(latRad)) / Math.PI) / 2 * n);
  return { x, y };
}

async function download(url, path) {
  const r = await fetch(url, {
    headers: { 'User-Agent': 'H_GAME-Saeeda-offline-satellite/1.0 (+https://github.com/Hasan0525-H/H_GAME)' },
    signal: AbortSignal.timeout(60000)
  });
  if (!r.ok) throw new Error(url + ' HTTP ' + r.status);
  const data = Buffer.from(await r.arrayBuffer());
  if (data.length < 1000) throw new Error('Satellite tile too small: ' + url);
  await writeFile(path, data);
  return data.length;
}

await mkdir(OUT, { recursive: true });
const center = lonLatToTile(CENTER.lon, CENTER.lat, ZOOM);
const files = [];
let total = 0;

for (let dy = -RADIUS; dy <= RADIUS; dy++) {
  for (let dx = -RADIUS; dx <= RADIUS; dx++) {
    const x = center.x + dx;
    const y = center.y + dy;
    const file = `${ZOOM}_${y}_${x}.jpg`;
    const url = `${BASE}/${ZOOM}/${y}/${x}.jpg`;
    const path = `${OUT}/${file}`;
    console.log('downloading satellite tile', x, y);
    const bytes = await download(url, path);
    total += bytes;
    files.push({ x, y, zoom: ZOOM, file, bytes, source_url: url });
  }
}

for (const item of files) {
  const s = await stat(`${OUT}/${item.file}`);
  item.bytes = s.size;
}

const manifest = {
  schema_version: 1,
  center: CENTER,
  zoom: ZOOM,
  radius_tiles: RADIUS,
  source: 'Sentinel-2 cloudless 2024 / EOX',
  generated_at: new Date().toISOString(),
  files,
  total_bytes: files.reduce((sum, x) => sum + x.bytes, 0)
};

await writeFile(OUT + '/manifest.json', JSON.stringify(manifest, null, 2) + '\n');
console.log('offline satellite tiles:', files.length, 'bytes:', manifest.total_bytes);
