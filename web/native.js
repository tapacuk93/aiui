// Native libraries (Mac): command-line tools the app installs for the AI and its scenes
// (Sources/App/NativeLibraries.swift). View › Native Libraries… and a section of Settings & System.
// Loaded after app.js; uses its push, t, esc, fmtBytes, callRaw, toast.

// The page: installed and available tools, the download policy and why it blocks, actions.
// It renders itself from the native store's status and refreshes while something installs.
async function showNativeLibraries() {
  let st;
  try { st = await callRaw('native', { op: 'status' }); } catch (e) { return toast(e.message); }
  const html = `<style>
    body{font:13px/1.5 -apple-system,system-ui,sans-serif}
    section{margin:0 0 16px;padding:14px 18px;border-radius:14px;background:var(--surface)}
    h2{margin:0 0 8px;font-size:13px;text-transform:uppercase;letter-spacing:.06em;color:var(--muted)}
    .pol{display:flex;flex-wrap:wrap;gap:6px 18px;align-items:center}
    .state{font-weight:600} .state.no{color:var(--danger,#d33)} .state.ok{color:var(--accent)}
    .m{color:var(--muted)} table{border-collapse:collapse;width:100%}
    th{text-align:left;font-weight:500;color:var(--muted);padding:4px 10px 4px 0;font-size:12px}
    td{padding:6px 10px 6px 0;vertical-align:top;border-top:1px solid var(--line)}
    td small{display:block;color:var(--muted)} .err{color:var(--danger,#d33)}
    button{min-height:30px;padding:3px 12px;border-radius:15px;border:1px solid var(--line);background:var(--chip);color:var(--fg);cursor:pointer;margin:0 4px 4px 0}
    button:hover{border-color:var(--accent);color:var(--accent)}
    label{display:flex;gap:8px;align-items:center;min-height:30px}
  </style>
  <section><h2>Downloads</h2><div class="pol" id="policy"></div></section>
  <section><h2 id="sum"></h2><table><thead><tr><th>Tool</th><th>Version</th><th>Size</th><th>Commands</th><th></th></tr></thead>
  <tbody id="rows"></tbody></table></section>
  <script>
  const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const mb = (n) => { n = Number(n) || 0; return n >= 1e6 ? (n / 1e6).toFixed(n >= 1e8 ? 0 : 1) + ' MB' : Math.max(1, Math.round(n / 1e3)) + ' KB'; };
  const native = (o) => aiui.sys({ op: 'native', ...o });
  let timer = null;
  function render(st) {
    const p = st.policy || {};
    const admin = p.managed === null || p.managed === undefined ? 'not set' : p.managed ? 'allowed' : 'denied';
    document.getElementById('policy').innerHTML =
      '<span class="state ' + (p.allowed ? 'ok">Allowed' : 'no">Blocked: ' + esc(p.reason)) + '</span>' +
      '<label><input type="checkbox" id="setting" ' + (p.setting ? 'checked' : '') + '> Download native libraries</label>' +
      '<span class="m">Admin policy: ' + admin + ' · Network: ' + esc(p.network) + (p.paused ? ' · background work paused' : '') + '</span>' +
      '<button data-op="update">Check for updates</button>' +
      (st.pack ? '<span class="m">Offline pack bundled</span>' : '');
    document.getElementById('setting').onchange = (e) => act({ op: 'setting', on: e.target.checked });
    const tools = st.tools || [];
    const n = tools.filter((x) => x.installed).length;
    document.getElementById('sum').textContent = n + ' installed · ' + mb(st.used) + ' of ' + mb(st.budget) + ' budget · catalog ' + (st.catalogVersion || '—');
    const order = (x) => (x.installed ? 0 : 2) + (x.default ? 0 : 1);
    document.getElementById('rows').innerHTML = tools.slice().sort((a, b) => order(a) - order(b) || a.id.localeCompare(b.id)).map((x) => {
      const ver = x.installed ? esc(x.installedVersion) + (x.installedVersion !== x.version ? ' <small>→ ' + esc(x.version) + ' available</small>' : '') : '<span class="m">' + esc(x.version) + '</span>';
      const size = x.installed ? mb(x.diskBytes) : '<span class="m">' + mb(x.bytes) + ' download</span>';
      const status = x.installing ? '<span class="m">installing…</span> <button data-op="cancel" data-id="' + esc(x.id) + '">Cancel</button>'
        : x.installed ? '<button data-op="remove" data-id="' + esc(x.id) + '">Remove</button>' + (x.previous ? '<button data-op="rollback" data-id="' + esc(x.id) + '">Back to ' + esc(x.previous) + '</button>' : '')
        : '<button data-op="ensure" data-id="' + esc(x.id) + '">Install</button>';
      return '<tr><td><b>' + esc(x.id) + '</b>' + (x.default ? ' <span class="m">· default</span>' : '') + '<small>' + esc(x.description) + '</small>' +
        '<small>' + esc(x.license) + ' · ' + esc(x.source) + '</small>' + (x.error ? '<small class="err">' + esc(x.error) + '</small>' : '') + '</td>' +
        '<td>' + ver + '</td><td>' + size + '</td><td>' + esc((x.executables || []).join(' ')) + '</td><td>' + status + '</td></tr>';
    }).join('');
    for (const b of document.querySelectorAll('button[data-op]')) b.onclick = () => act({ op: b.dataset.op, ids: b.dataset.id ? [b.dataset.id] : undefined, id: b.dataset.id, wait: 1 });
    clearTimeout(timer);
    if ((st.installing || []).length) timer = setTimeout(refresh, 1500);
  }
  async function act(o) { try { render(await native(o)); } catch (e) { alert(e.message); } refresh(); }
  async function refresh() { try { render(await native({ op: 'status' })); } catch {} }
  render(${JSON.stringify(st).replace(/</g, '\\u003c')});
  aiui.ready();
  <\/script>`;
  push({ kind: 'html', local: 'native', title: t('nativeLibs'), back: true, html }, t('nativeLibs'));
}

// Settings & System: the setting and a summary section (only where there is a native store).
function nativeSettingHtml(n) {
  if (!n || !n.policy) return '';
  return `<label class="opt"><input type="checkbox" data-a="nativeDownloads" ${n.policy.setting ? 'checked' : ''}> ${esc(t('setNative'))}</label>`;
}
function nativeSection(n, sec, row) {
  if (!n || !n.tools) return '';
  const inst = n.tools.filter((x) => x.installed);
  const p = n.policy || {};
  return sec(t('nativeLibs'), [
    row('Installed', esc(`${inst.length} of ${n.tools.length}: ${inst.map((x) => x.id + ' ' + x.installedVersion).join(', ') || '—'}`)),
    row('Disk', esc(fmtBytes(n.used) + ' of ' + fmtBytes(n.budget))),
    row('Downloads', esc(p.allowed ? 'allowed' : 'blocked: ' + p.reason)),
    row('On the PATH', esc(n.path || '—')),
  ]);
}
