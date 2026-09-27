import { mkdir, writeFile, stat, access } from 'node:fs/promises';

const API = 'https://api.polyhaven.com/files/';
const OUT = 'assets/quality';
const VERSION = 1;

const assets = [
  {
    id: 'coast_sand_04',
    prefix: 'sand',
    maps: {
      diff: { include: ['diff'], exclude: ['disp'], ext: ['jpg','png'] },
      nor: { include: ['nor_gl'], ext: ['jpg','png'] },
      rough: { include: ['rough'], exclude: ['arm'], ext: ['jpg','png'] }
    }
  },
  {
    id: 'asphalt_01',
    prefix: 'asphalt',
    maps: {
      diff: { include: ['diff'], exclude: ['disp'], ext: ['jpg','png'] },
      nor: { include: ['nor_gl'], ext: ['jpg','png'] },
      rough: { include: ['rough'], exclude: ['arm'], ext: ['jpg','png'] }
    }
  },
  {
    id: 'plastered_wall_03',
    prefix: 'plaster',
    maps: {
      diff: { include: ['diff'], exclude: ['disp'], ext: ['jpg','png'] },
      nor: { include: ['nor_gl'], ext: ['jpg','png'] },
      rough: { include: ['rough'], exclude: ['arm'], ext: ['jpg','png'] }
    }
  },
  {
    id: 'concrete',
    prefix: 'concrete',
    maps: {
      diff: { include: ['diff'], exclude: ['disp'], ext: ['jpg','png'] },
      nor: { include: ['nor_gl'], ext: ['jpg','png'] },
      rough: { include: ['rough'], exclude: ['arm'], ext: ['jpg','png'] }
    }
  }
];

const hdri = { id: 'hausdorf_clear_sky', prefix: 'sky' };

function flatten(node, path = [], out = []) {
  if (!node || typeof node !== 'object') return out;
  if (typeof node.url === 'string') {
    out.push({
      path: path.join('/').toLowerCase(),
      url: node.url,
      size: Number(node.size || 0),
      md5: node.md5 || ''
    });
    return out;
  }
  for (const [key, value] of Object.entries(node)) flatten(value, [...path, key], out);
  return out;
}

function extOf(url) {
  const clean = url.split('?')[0].toLowerCase();
  const m = clean.match(/\.([a-z0-9]+)$/);
  return m ? m[1] : '';
}

function chooseFile(files, spec, resolution = '4k') {
  const candidates = files.filter(f => {
    const p = f.path;
    if (!p.includes(resolution)) return false;
    if (!spec.include.every(k => p.includes(k))) return false;
    if ((spec.exclude || []).some(k => p.includes(k))) return false;
    const ext = extOf(f.url);
    return spec.ext.includes(ext);
  });
  candidates.sort((a, b) => {
    const ae = spec.ext.indexOf(extOf(a.url));
    const be = spec.ext.indexOf(extOf(b.url));
    if (ae !== be) return ae - be;
    return a.size - b.size;
  });
  return candidates[0] || null;
}

async function getJson(url) {
  const r = await fetch(url, {
    headers: { 'User-Agent': 'H_GAME-Saeeda-quality-assets/1.0' },
    signal: AbortSignal.timeout(45000)
  });
  if (!r.ok) throw new Error(url + ' HTTP ' + r.status);
  return r.json();
}

async function download(url, path) {
  const r = await fetch(url, {
    headers: { 'User-Agent': 'H_GAME-Saeeda-quality-assets/1.0' },
    signal: AbortSignal.timeout(180000)
  });
  if (!r.ok) throw new Error(url + ' HTTP ' + r.status);
  const data = Buffer.from(await r.arrayBuffer());
  await writeFile(path, data);
  return data.length;
}

async function exists(path) {
  try { await access(path); return true; } catch { return false; }
}

await mkdir(OUT, { recursive: true });

const expected = [
  'sand_diff','sand_nor','sand_rough',
  'asphalt_diff','asphalt_nor','asphalt_rough',
  'plaster_diff','plaster_nor','plaster_rough',
  'concrete_diff','concrete_nor','concrete_rough',
  'sky'
];

const oldManifestPath = OUT + '/manifest.json';
if (await exists(oldManifestPath)) {
  try {
    const old = JSON.parse(await (await fetch('file://' + oldManifestPath)).text());
    if (old?.version === VERSION) {
      let all = true;
      for (const item of old.files || []) {
        if (!(await exists(OUT + '/' + item.file))) { all = false; break; }
      }
      if (all && expected.every(k => (old.files || []).some(x => x.key === k))) {
        console.log('quality assets already cached:', old.total_bytes);
        process.exit(0);
      }
    }
  } catch {}
}

const manifest = {
  version: VERSION,
  generated_at: new Date().toISOString(),
  source: 'Poly Haven',
  license: 'CC0',
  resolution: '4k',
  files: []
};

for (const asset of assets) {
  const tree = await getJson(API + asset.id);
  const files = flatten(tree);
  for (const [map, spec] of Object.entries(asset.maps)) {
    const chosen = chooseFile(files, spec, '4k');
    if (!chosen) throw new Error('Missing 4k ' + asset.id + ' ' + map);
    const ext = extOf(chosen.url);
    const file = asset.prefix + '_' + map + '.' + ext;
    const path = OUT + '/' + file;
    console.log('downloading', asset.id, map, chosen.url);
    const bytes = await download(chosen.url, path);
    manifest.files.push({
      key: asset.prefix + '_' + map,
      asset: asset.id,
      map,
      file,
      bytes,
      source_url: chosen.url
    });
  }
}

{
  const tree = await getJson(API + hdri.id);
  const files = flatten(tree);
  const candidates = files.filter(f => f.path.includes('hdri') && f.path.includes('4k') && extOf(f.url) === 'hdr');
  candidates.sort((a,b) => a.size - b.size);
  const chosen = candidates[0];
  if (!chosen) throw new Error('Missing 4k HDR for ' + hdri.id);
  const file = 'sky.hdr';
  console.log('downloading', hdri.id, chosen.url);
  const bytes = await download(chosen.url, OUT + '/' + file);
  manifest.files.push({
    key: 'sky',
    asset: hdri.id,
    map: 'hdri',
    file,
    bytes,
    source_url: chosen.url
  });
}

let total = 0;
for (const item of manifest.files) {
  const s = await stat(OUT + '/' + item.file);
  item.bytes = s.size;
  total += s.size;
}
manifest.total_bytes = total;
manifest.total_mib = Number((total / 1024 / 1024).toFixed(2));

await writeFile(oldManifestPath, JSON.stringify(manifest, null, 2) + '\n');
console.log('Poly Haven quality assets:', manifest.total_mib + ' MiB');
