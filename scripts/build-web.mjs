import { build } from 'esbuild';
import { mkdir, rm, cp, readFile, writeFile } from 'node:fs/promises';

const out = 'dist/site';
await rm(out, { recursive: true, force: true });
await mkdir(out + '/data', { recursive: true });

await build({
  entryPoints: ['main.js'],
  bundle: true,
  format: 'esm',
  minify: true,
  sourcemap: false,
  outfile: out + '/app.js',
  target: ['es2020']
});

const index = (await readFile('index.html', 'utf8'))
  .replace('<script type="module" src="./main.js"></script>', '<script type="module" src="./app.js"></script>');
await writeFile(out + '/index.html', index);

const sw = (await readFile('sw.js', 'utf8')).replace("'./main.js'", "'./app.js'");
await writeFile(out + '/sw.js', sw);

for (const file of ['styles.css','manifest.webmanifest','icon.svg']) {
  await cp(file, out + '/' + file);
}
await cp('data', out + '/data', { recursive: true });
await cp('assets', out + '/assets', { recursive: true });

console.log('built self-contained web app:', out);
