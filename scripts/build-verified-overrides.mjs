import { readFile, writeFile } from 'node:fs/promises';

const checkOnly = process.argv.includes('--check');
const sourcePath = 'data/ground-truth.json';
const outputPath = 'data/verified-overrides.json';

const raw = JSON.parse(await readFile(sourcePath, 'utf8'));
if (raw.schema_version !== 1 || !Array.isArray(raw.entries)) {
  throw new Error('Invalid ground-truth root');
}

const seenIds = new Set();
const seenObjects = new Set();
const output = {
  schema_version: 1,
  description: 'Generated from data/ground-truth.json. Do not hand-edit.',
  entries: []
};

for (const [i, entry] of raw.entries.entries()) {
  if (!entry || typeof entry !== 'object') throw new Error('ground truth entry ' + i + ' must be an object');
  if (typeof entry.id !== 'string' || !entry.id) throw new Error('entry ' + i + ' needs id');
  if (seenIds.has(entry.id)) throw new Error('duplicate ground truth id ' + entry.id);
  seenIds.add(entry.id);

  if (entry.verification !== 'exact-object') throw new Error('entry ' + i + ' must be exact-object');
  if (typeof entry.osm !== 'string' || !/^(node|way|relation)\/\d+$/.test(entry.osm)) throw new Error('entry ' + i + ' has invalid osm');
  if (typeof entry.source_url !== 'string' || !/^https?:\/\//.test(entry.source_url)) throw new Error('entry ' + i + ' needs source_url');
  if (!entry.claims || typeof entry.claims !== 'object' || Array.isArray(entry.claims)) throw new Error('entry ' + i + ' needs claims object');
  if (!Object.keys(entry.claims).length) throw new Error('entry ' + i + ' claims cannot be empty');

  if (seenObjects.has(entry.osm)) throw new Error('multiple exact overrides for ' + entry.osm + '; merge claims into one reviewed entry');
  seenObjects.add(entry.osm);

  output.entries.push({
    osm: entry.osm,
    verified: true,
    source_url: entry.source_url,
    reference_id: entry.id,
    captured_at: entry.captured_at || null,
    attributes: entry.claims
  });
}

const generated = JSON.stringify(output, null, 2) + '\n';

if (checkOnly) {
  const current = await readFile(outputPath, 'utf8');
  if (current !== generated) {
    throw new Error('verified-overrides.json is out of date. Run node scripts/build-verified-overrides.mjs');
  }
  console.log('ground truth verified:', output.entries.length);
} else {
  await writeFile(outputPath, generated);
  console.log('verified overrides generated:', output.entries.length);
}
