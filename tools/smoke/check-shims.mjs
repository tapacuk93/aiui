// Compiles every script the app injects into scenes (the *_SHIM / LAB_MOCK template literals in
// web/app.js) exactly as the browser will see them, so escaping mistakes fail here, not in a scene.
import fs from 'fs';
const src = fs.readFileSync(new URL('../../web/app.js', import.meta.url), 'utf8');
let bad = 0, n = 0;
for (const m of src.matchAll(/const (\w*(?:SHIM|MOCK)) = `/g)) {
  const start = m.index + m[0].length;
  const end = src.indexOf('<\\/script>`;', start);
  let text;
  try { text = eval('`' + src.slice(start, end) + '`'); } catch (e) { console.log(`✗ ${m[1]}: template: ${e.message}`); bad++; continue; }
  for (const part of text.split(/<\/?script>/).filter((x) => x.trim())) {
    try { new Function(part); } catch (e) { console.log(`✗ ${m[1]}: ${e.message}`); bad++; }
    for (const re of part.matchAll(/(?<![\w)\]])\/((?:\\.|\[(?:\\.|[^\]])*\]|[^/\n\\[])+)\/([gimsuy]*)/g)) {
      try { new RegExp(re[1], re[2]); } catch (e) { console.log(`✗ ${m[1]}: regex ${re[0]}: ${e.message}`); bad++; }
    }
  }
  n++;
}
console.log(bad ? `shim check: ${bad} problem(s)` : `shim check: ${n} injected scripts compile`);
process.exit(bad ? 1 : 0);
