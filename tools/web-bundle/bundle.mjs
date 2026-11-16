// Bundles and minifies a copy of web/ for shipping (the website and the Mac app's Resources).
//   node tools/web-bundle/bundle.mjs <dist-dir>
// The <script>s in index.html (classic scripts sharing globals) become one minified file and
// app.css a minified one, both named by content hash so caches - and the compiled code browsers
// keep for cached scripts - stay valid until the content changes. qa.js is fetched as text and
// injected into scenes, so it is minified on its own under its own name. web/ itself is untouched;
// development (AIUI_WEB, ./build.sh run) still serves the readable sources.
import { transform } from 'esbuild';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';

const dist = process.argv[2];
if (!dist) { console.error('usage: bundle.mjs <dist-dir>'); process.exit(2); }
const target = ['chrome110', 'safari15', 'firefox110'];
const hash = (s) => createHash('sha256').update(s).digest('hex').slice(0, 10);
const indexPath = join(dist, 'index.html');
let html = readFileSync(indexPath, 'utf8');

// 1. scripts, in document order
const tags = [...html.matchAll(/^\s*<script src="([^"]+)"><\/script>\n/gm)];
if (!tags.length) throw new Error('no <script src> tags found in index.html');
const names = tags.map((m) => m[1]);
const joined = names.map((n) => `// ${n}\n${readFileSync(join(dist, n), 'utf8')}\n;`).join('\n');
const js = await transform(joined, { loader: 'js', minify: true, target, charset: 'utf8', legalComments: 'none',
  sourcemap: 'external', sourcefile: 'app.bundle.js' });
for (const w of js.warnings) console.warn('esbuild:', w.text);
const jsName = `app.${hash(js.code)}.js`;
writeFileSync(join(dist, jsName), `${js.code}//# sourceMappingURL=${jsName}.map\n`);
writeFileSync(join(dist, `${jsName}.map`), js.map);
for (const n of names) rmSync(join(dist, n));
html = html.replace(tags[0][0], tags[0][0].replace(/src="[^"]+"/, `src="${jsName}"`));
for (const m of tags.slice(1)) html = html.replace(m[0], '');

// 2. styles
const css = await transform(readFileSync(join(dist, 'app.css'), 'utf8'), { loader: 'css', minify: true, target, charset: 'utf8' });
const cssName = `app.${hash(css.code)}.css`;
writeFileSync(join(dist, cssName), css.code);
rmSync(join(dist, 'app.css'));
if (!html.includes('href="app.css"')) throw new Error('app.css <link> not found');
html = html.replace('href="app.css"', `href="${cssName}"`);

// 3. qa.js: same name (fetched by it), minified
const qa = await transform(readFileSync(join(dist, 'qa.js'), 'utf8'), { loader: 'js', minify: true, target, charset: 'utf8', legalComments: 'none' });
writeFileSync(join(dist, 'qa.js'), qa.code);

writeFileSync(indexPath, html);
const kb = (s) => (Buffer.byteLength(s) / 1024).toFixed(0) + ' KB';
console.log(`bundled ${names.join(' + ')} -> ${jsName} (${kb(joined)} -> ${kb(js.code)}), ${cssName} (${kb(css.code)}), qa.js (${kb(qa.code)})`);
