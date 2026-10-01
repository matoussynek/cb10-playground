import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, readdirSync } from 'node:fs';

const root = new URL('../', import.meta.url);
const read = p => readFileSync(new URL(p, root), 'utf8');
const shell = JSON.parse(read('sw.js').match(/const SHELL = (\[[\s\S]*?\]);/)[1].replace(/'/g, '"').replace(/,\s*\]/, ']'));

test('every precached file exists', () => {
  for (const f of shell.filter(f => f !== './')) assert.ok(existsSync(new URL(f, root)), `missing ${f}`);
});

test('everything the site loads is precached, so it opens offline', () => {
  const needed = ['index.html', 'manifest.webmanifest', 'css/style.css', ...readdirSync(new URL('js/', root)).map(f => `js/${f}`)];
  const html = read('index.html');
  for (const [, ref] of html.matchAll(/(?:href|src)="([^"#?:]+)"/g)) needed.push(ref);
  for (const [, ref] of read('css/style.css').matchAll(/url\('\.\.\/([^')]+)'\)/g)) needed.push(ref);
  for (const f of new Set(needed)) assert.ok(shell.includes(f), `${f} is not in sw.js SHELL`);
});

test('manifest is installable', () => {
  const m = JSON.parse(read('manifest.webmanifest'));
  assert.equal(m.display, 'standalone');
  assert.equal(m.start_url, './');
  for (const icon of m.icons) assert.ok(existsSync(new URL(icon.src, root)), `missing ${icon.src}`);
  const pngSize = f => { const b = readFileSync(new URL(f, root)); return [b.readUInt32BE(16), b.readUInt32BE(20)]; };
  for (const icon of m.icons.filter(i => i.type === 'image/png')) {
    const [w, h] = pngSize(icon.src);
    assert.equal(`${w}x${h}`, icon.sizes, icon.src);
  }
  assert.ok(m.icons.some(i => i.sizes === '512x512' && i.purpose === 'maskable'));
});
