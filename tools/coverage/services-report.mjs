// Reads an lcov file and prints each file's coverage and every uncovered line, branch and function
// as file:line. Exits 1 when anything is uncovered, or when one of the expected files (the further
// arguments, relative to services/) was never loaded by a test and so is missing from the report.
//   node services-report.mjs <lcov.info> [expected file...]
import { readFileSync } from 'node:fs';

const [lcov, ...expected] = process.argv.slice(2);
const text = (() => { try { return readFileSync(lcov, 'utf8'); } catch { return ''; } })();
const files = [];
let f = null;
for (const line of text.split('\n')) {
  const [tag, rest = ''] = line.split(/:(.*)/s);
  if (tag === 'SF') files.push(f = { file: rest, lines: [0, 0], branches: [0, 0], funcs: [0, 0], fnLine: new Map(), missed: [] });
  else if (!f) continue;
  else if (tag === 'FN') { const [ln, name] = rest.split(','); f.fnLine.set(name, ln); }
  else if (tag === 'FNDA') { const [n, name] = rest.split(','); f.funcs[1]++; if (n !== '0') f.funcs[0]++; else f.missed.push([+f.fnLine.get(name), `function ${name}`]); }
  else if (tag === 'DA') { const [ln, n] = rest.split(','); f.lines[1]++; if (n !== '0') f.lines[0]++; else f.missed.push([+ln, 'line']); }
  else if (tag === 'BRDA') { const [ln, , , n] = rest.split(','); f.branches[1]++; if (n !== '0' && n !== '-') f.branches[0]++; else f.missed.push([+ln, 'branch']); }
}
if (!files.length) { console.error('coverage: no coverage data'); process.exit(1); }
const pct = ([hit, all]) => (all ? (100 * hit / all).toFixed(2) : '100.00');
const sum = (k) => files.reduce((a, x) => [a[0] + x[k][0], a[1] + x[k][1]], [0, 0]);
console.log('\nfile                              lines  branches  functions');
for (const x of files) console.log(`${x.file.padEnd(32)} ${pct(x.lines).padStart(7)} ${pct(x.branches).padStart(9)} ${pct(x.funcs).padStart(10)}`);
console.log(`${'all files'.padEnd(32)} ${pct(sum('lines')).padStart(7)} ${pct(sum('branches')).padStart(9)} ${pct(sum('funcs')).padStart(10)}`);
const missed = files.flatMap((x) => x.missed.sort((a, b) => a[0] - b[0]).map(([ln, what]) => `services/${x.file}:${ln} ${what}`));
for (const f of expected) if (!files.some((x) => x.file === f)) missed.push(`services/${f}:1 never loaded by a test`);
if (missed.length) {
  console.log(`\nuncovered (${missed.length}):`);
  for (const m of missed) console.log(`  ${m}`);
  process.exit(1);
}
console.log('\ncoverage: 100% lines, branches and functions');
