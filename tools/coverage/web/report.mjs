// Merges the V8 coverage the tests wrote (.out/v8/*.json) into an Istanbul map of web/*.js,
// prints a per-file table and every uncovered line range, writes an HTML report to .out/html,
// and exits non-zero when line coverage is below the threshold (default 100%).
//   node report.mjs [--min-lines 100]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import v8toIstanbul from 'v8-to-istanbul';
import libCoverage from 'istanbul-lib-coverage';
import libReport from 'istanbul-lib-report';
import reports from 'istanbul-reports';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WEB = path.resolve(HERE, '../../../web');
const OUT = path.join(HERE, '.out');
const FILES = ['app.js', 'backend.js', 'shared.js', 'qa.js', 'native.js'];
const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? Number(process.argv[i + 1]) : d; };
const MIN_LINES = arg('--min-lines', 100);

// Per file: merge the raw V8 function ranges of all runs first (cheap), convert once per run.
const map = libCoverage.createCoverageMap({});
for (const f of FILES) map.merge(await convert(f, []));
const dir = path.join(OUT, 'v8');
const runs = fs.existsSync(dir) ? fs.readdirSync(dir).filter((x) => x.endsWith('.json')) : [];
for (const name of runs) {
  const entries = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'));
  for (const e of entries) {
    const f = FILES.find((x) => e.url.endsWith('/' + x));
    if (f) map.merge(await convert(f, e.functions));
  }
}

async function convert(file, functions) {
  const abs = path.join(WEB, file);
  const conv = v8toIstanbul(abs, 0, { source: fs.readFileSync(abs, 'utf8') });
  await conv.load();
  conv.applyCoverage(functions.length ? functions : [{ functionName: '', isBlockCoverage: true, ranges: [{ startOffset: 0, endOffset: fs.statSync(abs).size, count: 0 }] }]);
  return conv.toIstanbul();
}

const ranges = (nums) => {
  const out = [];
  for (const n of nums.sort((a, b) => a - b)) {
    const last = out[out.length - 1];
    if (last && n === last[1] + 1) last[1] = n; else out.push([n, n]);
  }
  return out.map(([a, b]) => (a === b ? String(a) : `${a}-${b}`));
};

const pct = (s) => (s.total ? (100 * s.covered / s.total) : 100).toFixed(2).padStart(7);
let failed = false;
const total = libCoverage.createCoverageSummary();
console.log(`\n${'file'.padEnd(12)} ${'lines'.padStart(7)} ${'branches'.padStart(9)} ${'funcs'.padStart(7)}   uncovered lines`);
for (const f of map.files().sort()) {
  const fc = map.fileCoverageFor(f);
  const s = fc.toSummary();
  total.merge(s);
  const lines = fc.getLineCoverage();
  const missed = Object.entries(lines).filter(([, n]) => !n).map(([l]) => Number(l));
  if (s.lines.pct < MIN_LINES) failed = true;
  console.log(`${path.basename(f).padEnd(12)} ${pct(s.lines)} ${pct(s.branches).padStart(9)} ${pct(s.functions)}   ${ranges(missed).join(', ')}`);
}
console.log(`${'all'.padEnd(12)} ${pct(total.lines)} ${pct(total.branches).padStart(9)} ${pct(total.functions)}   (${total.lines.covered}/${total.lines.total} lines, ${total.branches.covered}/${total.branches.total} branches, ${total.functions.covered}/${total.functions.total} functions; ${runs.length} runs)`);

if (process.env.COVERAGE_DETAIL) {
  for (const f of map.files().sort()) {
    const fc = map.fileCoverageFor(f);
    const fns = Object.entries(fc.f).filter(([, n]) => !n).map(([k]) => `${fc.fnMap[k].name}@${fc.fnMap[k].loc.start.line}`);
    const brs = [];
    for (const [k, counts] of Object.entries(fc.b)) counts.forEach((n, i) => { if (!n) brs.push(`${(fc.branchMap[k].locations[i] || fc.branchMap[k].loc).start.line}`); });
    console.log(`\n${path.basename(f)} uncovered functions: ${fns.join(', ') || '—'}\n${path.basename(f)} uncovered branches at lines: ${[...new Set(brs)].join(', ') || '—'}`);
  }
}

const context = libReport.createContext({ dir: path.join(OUT, 'html'), coverageMap: map, defaultSummarizer: 'flat' });
reports.create('html').execute(context);
reports.create('json-summary').execute(libReport.createContext({ dir: OUT, coverageMap: map }));

if (failed) { console.error(`\nFAIL: line coverage of the web client is below ${MIN_LINES}% (uncovered lines above).`); process.exit(1); }
console.log(`\nOK: line coverage ≥ ${MIN_LINES}% in every file.`);
