// Global shared code and people (docs/shared-and-users.md; Sources/App/SharedRegistry.swift,
// People.swift, AppIdentity.swift). Loaded after app.js; uses its pushPath, push, render, t, esc,
// call, callRaw, toast, flashStatus, log, activityStart/End, openApplet, current, stack.
//
// Two levels of shared code: Local — the Utility Library on this device — and Global — "Shared by
// others", the synced registry index. Global code never runs: adopting downloads it, checks its
// sha256, has the AI review it, and copies it into the local library only when the user confirms.
// People: this installation's app id, an opt-in profile, find and add, contacts and the router inbox.

Object.assign(STR, {
  people: 'People', sharedByOthers: 'Shared by others', globalWord: 'global', localWord: 'local',
  copy: 'Copy', copied: 'Copied', appIdTitle: 'App identity', appId: 'App id',
  appIdNote: 'This installation’s own key, kept in the Keychain on this device. It signs what you share and how others find you.',
  sharedSync: 'Sync now', sharedUpdated: 'updated', sharedNever: 'not synced yet', sharedSyncing: 'syncing the shared index…',
  sharedSynced: 'Shared index updated', sharedSearch: 'Search', sharedSearchHint: 'name, purpose, category',
  sharedSearchMsg: 'Search what others shared — by name, what it does, or its category.',
  sharedUpdates: 'Updates', sharedUpdatesFor: 'Updates for what you adopted', sharedUpdatesN: 'updates for adopted items',
  sharedShare: 'Share globally…', sharedShareHint: 'a module or an applet of yours',
  sharedShareTitle: 'Share globally', sharedShareMsg: 'Pick one of your own modules or applets. You see exactly what is published before anything is sent.',
  sharedShareEmpty: 'Nothing of your own to share yet.', sharedMine: 'Shared by me',
  'sharedKind.component': 'Components', 'sharedKind.util': 'Utilities', 'sharedKind.applet': 'Applets',
  'kind.component': 'component', 'kind.util': 'utility', 'kind.applet': 'applet',
  sharedMsg: 'Global — shared by other AI UI users. Nothing here runs until you adopt it: it is downloaded, checked, reviewed by the AI and copied into your library only when you confirm.',
  sharedEmpty: 'Nobody has shared anything yet.', sharedNotSynced: 'Fetching the shared index…', sharedNoResults: 'Nothing found.',
  sharedAdopted: 'adopted', sharedUpdate: 'update', sharedYours: 'yours', sharedAdoptions: 'adoptions',
  sharedBy: 'Shared by', sharedVersion: 'Version', sharedKindLabel: 'Kind', sharedCategory: 'Category', sharedSize: 'Size',
  sharedUsage: 'Usage', sharedLibs: 'JS libraries', sharedUses: 'Builds on', sharedUpdatedAt: 'Updated', sharedHash: 'sha256',
  sharedReviewAdopt: 'Review and adopt', sharedReviewUpdate: 'Review the update to', sharedAdoptedV: 'Adopted, version',
  sharedWorking: 'Downloading, checking sha256, and asking the AI to review it…',
  sharedReviewTitle: 'AI review', sharedVerified: 'sha256 verified', sharedVerdict: 'Verdict',
  'verdict.safe': 'Looks safe', 'verdict.caution': 'Use with care', 'verdict.unsafe': 'Unsafe — don’t adopt',
  sharedWhat: 'What it does', sharedNetwork: 'Network', sharedSystem: 'System access', sharedSuspicious: 'Suspicious',
  sharedStatic: 'Pattern checks', sharedNone: 'none', sharedCode: 'The code',
  sharedConfirm: 'Adopt into my library', sharedConfirmAnyway: 'Adopt anyway', sharedCancel: 'Cancel',
  sharedAdoptNote: 'Adopting copies it into your local library, marked with where it came from. From then on it is local code; updates are offered, never applied by themselves.',
  sharedAdoptedDone: 'Adopted into your local library.', sharedOpen: 'Open it', sharedReport: 'Report',
  sharedReportWhy: 'What is wrong with it? (malicious, broken, …)', sharedReportSend: 'Send report', sharedReported: 'Reported. Thank you.',
  sharedWithdraw: 'Withdraw', sharedWithdrawSure: 'Withdraw — sure?', sharedWithdrawn: 'Withdrawn: it left the index.',
  sharedPreviewTitle: 'Share globally:', sharedPreviewNote: 'Exactly this is published, signed with your app id. Nothing of your state is included. Anyone can find, review and adopt it, and it is mirrored to a public GitHub repository.',
  sharedPublish: 'Share globally', sharedSharedDone: 'Shared globally as version', sharedSignedAs: 'Signed as',
  sharedReviewing: 'reviewing shared code', sharedLocalBadge: 'Local — on this device', sharedGlobalBadge: 'Global — shared by others',
  sharedFromGlobal: 'Adopted from the global registry, version', sharedShareModule: 'Share globally…', sharedSharedAs: 'Shared globally',
  peopleMsg: 'Nobody finds you unless you list a profile and make it findable. Adding someone by id works anyway.',
  peopleOffline: 'Can’t reach users.aiui.oeaio.com right now — showing what is saved.',
  peopleYourId: 'your app id · copy', peopleProfile: 'Your profile', peopleNotListed: 'not listed', peopleListed: 'findable',
  peopleHidden: 'listed, not findable', peopleFind: 'Find people', peopleFindHint: 'name or handle',
  peopleFindMsg: 'Type a name or a @handle. Only people who made their profile findable show up.',
  peopleAdd: 'Add by id', peopleAddHint: 'typed or pasted', peopleAddMsg: 'Paste or type their app id (64 characters, 0–9 and a–f). They see that you added them; once they add you back, you both see each other’s verified id.',
  peopleCheck: 'Check now', peopleChecked: 'checked', peopleVerified: 'verified', peopleMutual: 'mutual',
  peoplePending: 'waiting for them to add you', peopleIncoming: 'added you — open to add back',
  peopleAddedYou: 'added you', peopleMutualNow: 'you added each other: id verified', peopleRemovedYou: 'removed you',
  peopleNoneFound: 'Nobody found. They may not be findable — add them by id instead.', peopleAddThisId: 'Add this id',
  peopleAddedMsg: 'Added — waiting for them to add you back.', peopleAddBack: 'Add back', peopleRemove: 'Remove',
  peopleRemoved: 'Removed', peopleName: 'Name', peopleHandle: 'Handle', peopleAbout: 'About', peopleFindable: 'Findable by name or handle',
  peopleSave: 'Save profile', peopleSaved: 'Profile saved', peopleDeleteProfile: 'Remove my profile', peopleDeleted: 'Profile removed',
  peopleProfileNote: 'Opt-in. The profile goes to users.aiui.oeaio.com with your app id. Mutual contacts see it even when it isn’t findable.',
  peopleHandleHint: '3–30 characters: a–z, 0–9, _ and -', peopleState: 'State', peopleIdVerified: 'Verified: you added each other, and the router passed you this id.',
  peopleOpen: 'Open People',
  instShareApplet: 'Share this applet globally', instShareScene: 'Share this scene globally', instShareModule: 'Share this module globally',
  instSharedByOthers: 'Shared by others (global)', instSharedSearch: 'Search shared by others', instSharedSync: 'Sync the shared index',
  instSharedUpdates: 'Updates for adopted items', instShareList: 'Share something globally…', instSharedMine: 'What I shared',
  instWithdraw: 'Withdraw this from the registry', instReport: 'Report this shared item', instAdopt: 'Review and adopt this',
  instPeople: 'People', instFindPeople: 'Find people', instAddPerson: 'Add a person by id', instCopyId: 'Copy my app id',
  instEditProfile: 'Edit my people profile', instCheckInbox: 'Check for new contacts',
  sharedAdoptionsLabel: 'Adoptions', sharedStripNote: 'The applet says these must never be shared', sharedStripCheck: 'Its state is left out; check the content below for them.',
  offerShareApplet: 'Share this applet with others?', offerShareComponent: 'Share its component with others?', offerNotNow: 'Not now',
  offerNote: 'Worth sharing with other AI UI users', actShareable: 'Shareable', actShareableYes: 'proposed', actShareableNo: 'not proposed',
});
DEADLINES.shared = 240000;   // adopting includes an AI review
DEADLINES.people = 30000;

const shortId = (id) => (id && id.length > 12 ? id.slice(0, 6) + '…' + id.slice(-6) : id || '');
function ago(iso) {
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  if (!isFinite(s)) return '';
  if (s < 90) return Math.max(1, Math.round(s)) + ' s';
  if (s < 5400) return Math.round(s / 60) + ' min';
  if (s < 129600) return Math.round(s / 3600) + ' h';
  return Math.round(s / 86400) + ' d';
}
async function copyText(text) {
  if (NATIVE) await callRaw('sys', { op: 'clipboard', text });
  else await navigator.clipboard.writeText(text);
  flashStatus('📋 ' + t('copied'));
}
const strings = (keys) => Object.fromEntries(keys.map((k) => [k, t(k)]));
const jsonForScript = (o) => JSON.stringify(o).replace(/</g, '\\u003c');

// The theme's --muted moved 22% toward --fg (both hex), for small text on a surface.
function mutedStrong() {
  const cs = getComputedStyle(document.documentElement);
  const hex = (v) => { const m = String(v).trim().match(/^#([0-9a-f]{6})$/i); return m ? [0, 2, 4].map((i) => parseInt(m[1].slice(i, i + 2), 16)) : null; };
  const a = hex(cs.getPropertyValue('--muted')), b = hex(cs.getPropertyValue('--fg'));
  if (!a || !b) return 'var(--muted)';
  return '#' + a.map((x, i) => Math.round(x * 0.78 + b[i] * 0.22).toString(16).padStart(2, '0')).join('');
}

// An app-owned html screen: theme variables, the app's look, strings for its script.
function appHtml(body, script, data) {
  // --muted on a section's surface is just under 4.5:1 in the light theme: a slightly stronger one.
  return `<style>
    :root{--muted2:${mutedStrong()}}
    body{font:14px/1.55 -apple-system,system-ui,sans-serif}
    section{margin:0 0 16px;padding:14px 18px;border-radius:14px;background:var(--surface)}
    h2{margin:0 0 8px;font-size:13px;text-transform:uppercase;letter-spacing:.06em;color:var(--muted2)}
    h3{margin:12px 0 4px;font-size:14px}
    p{margin:6px 0} .m{color:var(--muted2)} .err{color:var(--danger)}
    table{border-collapse:collapse;width:100%} th{text-align:left;font-weight:500;color:var(--muted2);width:30%;padding:3px 10px 3px 0;vertical-align:top}
    td{padding:3px 0;word-break:break-word}
    code,pre{font:12px/1.45 ui-monospace,SFMono-Regular,Menlo,monospace}
    pre{margin:6px 0 0;padding:10px 12px;border-radius:10px;background:var(--chip);border:1px solid var(--line);max-height:46vh;overflow:auto;white-space:pre-wrap;word-break:break-word}
    .badge{display:inline-block;padding:2px 10px;border-radius:11px;font-size:12px;font-weight:600;background:var(--accent-soft);color:var(--fg);border:1px solid var(--line-strong)}
    .badge.local{background:transparent}
    .btns{display:flex;flex-wrap:wrap;gap:8px;margin-top:12px}
    button{min-height:34px;padding:4px 14px;border-radius:17px;border:1px solid var(--line-strong);background:var(--chip);color:var(--fg);cursor:pointer;font:inherit}
    button:hover,button:focus-visible{border-color:var(--accent);outline:none;box-shadow:0 0 0 2px var(--accent-glow)}
    button.primary{background:var(--accent);color:var(--on-accent);border-color:var(--accent)}
    button.danger{color:var(--danger);border-color:var(--danger)}
    button:disabled{opacity:.6;cursor:default}
    .verdict{padding:10px 14px;border-radius:10px;border:2px solid var(--line-strong);font-weight:600}
    .verdict.safe{border-color:var(--accent)} .verdict.unsafe{border-color:var(--danger);color:var(--danger)} .verdict.caution{border-style:dashed}
    label.f{display:block;margin:10px 0 4px;color:var(--muted2);font-size:13px}
    input[type=text],textarea{width:100%;box-sizing:border-box;padding:8px 10px;border-radius:8px;border:1px solid var(--line-strong);background:var(--chip);color:var(--fg);font:inherit}
    input[type=text]:focus,textarea:focus{outline:none;border-color:var(--accent);box-shadow:0 0 0 2px var(--accent-glow)}
    .check{display:flex;gap:8px;align-items:center;margin:12px 0;min-height:30px}
    .idline{display:flex;flex-wrap:wrap;gap:8px;align-items:center}
    .busy{animation:pulse 1.2s ease-in-out infinite} @keyframes pulse{50%{opacity:.55}}
    ul{margin:4px 0;padding-left:20px}
  </style>${body}<script>
  const S = ${jsonForScript(data.S || {})};
  const DATA = ${jsonForScript(data)};
  const $ = (s) => document.querySelector(s);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  for (const b of document.querySelectorAll('[data-copy]')) b.addEventListener('click', () => aiui.copyText(b.dataset.copy).then(() => { b.textContent = S.copied || '✓'; }).catch(() => {}));
  ${script}
  aiui.ready();
  <\/script>`;
}
aiui.copyText = (text) => copyText(text);

// ---------------------------------------------------------------- events

{
  const base = aiui._event;
  aiui._event = function (e) {
    if (e && e.type === 'shared') return onSharedEvent(e);
    if (e && e.type === 'people') return onPeopleEvent(e);
    if (e && e.type === 'activity' && e.kind === 'sharedReview' && !e.done) e = { ...e, title: t('sharedReviewing') + (e.name ? ` «${e.name}»` : '') };
    return base.call(this, e);
  };
}
// The AI proposes adopting from a scene; the review screen does the rest (the user decides).
aiui.adoptShared = (id) => showSharedItem(String(id || ''), { review: true });
aiui.sharedByOthers = () => showShared();
aiui.people = () => showPeople();
aiui.sharePreview = (ref) => showSharePreview(ref);
aiui.openAdopted = (key, title) => openApplet(key, title);

function onSharedEvent(e) {
  if (e.what === 'synced') {
    log('activity', `🌐 ${t('sharedSynced')}: ${e.count} (+${e.added || 0} −${e.removed || 0})`);
    if (e.updates) flashStatus(`🌐 ${e.updates} ${t('sharedUpdatesN')}`);
    sharedStatus = { ...sharedStatus, updates: Array(e.updates || 0).fill(0) };
    if (current.screen.local === 'shared' && current.screen.sharedTop) showShared(true);
  }
}

function onPeopleEvent(e) {
  const who = e.name || e.short || shortId(e.id);
  const text = e.what === 'incoming' ? `${who} ${t('peopleAddedYou')}${e.note ? ': ' + e.note : ''}`
    : e.what === 'mutual' ? `${who} — ${t('peopleMutualNow')}`
    : e.what === 'removed' ? `${who} ${t('peopleRemovedYou')}` : null;
  if (!text) return;
  flashStatus('👥 ' + text);
  const aid = `people:${e.what}:${e.id}`;
  activityStart(aid, '👥 ' + text, null, true, [{ icon: '👥', label: t('peopleOpen'), run: () => showPeople() }]);
  setTimeout(() => activityEnd(aid), 60000);
  if (NATIVE && !document.hasFocus()) callRaw('sys', { op: 'notify', title: t('people'), text }).catch(() => {});
  if (current.screen.local === 'people' && current.screen.peopleTop) showPeople(true);
}

// ---------------------------------------------------------------- Settings & System

function identitySection(id, sec, row) {
  if (!id || !id.id) return '';
  return sec(t('appIdTitle'), [
    row(t('appId'), `<span class="idline"><code title="${esc(id.id)}">${esc(id.short || shortId(id.id))}</code>
      <button type="button" class="cp" data-cp="${esc(id.id)}">${esc(t('copy'))}</button></span>
      <script>for (const b of document.querySelectorAll('[data-cp]')) b.onclick = () => aiui.copyText(b.dataset.cp).then(() => { b.textContent = ${jsonForScript(t('copied'))}; });<\/script>`),
    row('', `<span class="m">${esc(t('appIdNote'))}</span>`),
  ]);
}

// ---------------------------------------------------------------- Shared by others (global)

function sharedLibraryCircle() {
  return { id: 'sh:open', icon: '🌐', label: t('sharedByOthers'), hint: t('globalWord'), size: 1.1 };
}

function kindName(k) { return t('kind.' + k); }
function itemCircle(it) {
  const state = it.updateAvailable ? `${t('sharedUpdate')} v${it.version}` : it.adoptedVersion ? t('sharedAdopted') : it.mine ? t('sharedYours') : '';
  return {
    id: 'item:' + it.id, item: it.id, icon: it.updateAvailable ? '⬆️' : it.adoptedVersion ? '✅' : '🌐',
    label: it.title || it.name,
    hint: [kindName(it.kind), 'v' + it.version, `${it.adoptions || 0} ↓`, state].filter(Boolean).join(' · '),
    title: `${t('globalWord')} · ${(it.path || []).concat(it.name).join(' › ')} — ${it.description || ''}`,
  };
}

let sharedStatus = {};
async function showShared(inPlace) {
  let r;
  try { r = await call('shared', { op: 'list' }); } catch (e) { return toast(e.message); }
  const st = r.status || {}, kinds = st.kinds || {};
  sharedStatus = st;
  const circles = [
    { id: 'sh:sync', icon: '🔄', label: t('sharedSync'), hint: st.syncedAt ? `${t('sharedUpdated')} ${ago(st.syncedAt)}` : t('sharedNever'), size: 0.85 },
    { id: 'sh:search', icon: '🔍', label: t('sharedSearch'), hint: t('sharedSearchHint') },
    ...((st.updates || []).length ? [{ id: 'sh:updates', icon: '⬆️', label: t('sharedUpdates'), hint: String(st.updates.length), size: 1.1 }] : []),
    { id: 'sh:share', icon: '📤', label: t('sharedShare'), hint: t('sharedShareHint'), size: 0.95 },
    ...(st.mine ? [{ id: 'sh:mine', icon: '🙋', label: t('sharedMine'), hint: String(st.mine), size: 0.9 }] : []),
    ...[['component', '🧩'], ['util', '🔧'], ['applet', '🪟']].filter(([k]) => kinds[k])
      .map(([k, icon]) => ({ id: 'sh:kind:' + k, kindList: k, icon, label: t('sharedKind.' + k), hint: `${kinds[k]} · ${t('globalWord')}` })),
    ...(r.items || []).slice(0, 12).map(itemCircle),
  ];
  const screen = { kind: 'circles', local: 'shared', sharedTop: true, more: false, back: true, title: t('sharedByOthers'),
    message: st.count ? t('sharedMsg') : st.syncedAt ? t('sharedEmpty') + ' ' + t('sharedMsg') : t('sharedNotSynced'), circles };
  if (inPlace) {
    // Refresh where it is shown (now or in the history), without moving the user.
    const entry = [current, ...stack].find((x) => x.screen.local === 'shared' && x.screen.sharedTop);
    if (!entry) return;
    entry.screen = screen;
    if (entry === current) render();
    return;
  }
  pushPath(screen, t('sharedByOthers'));
  if (!st.syncedAt) syncShared();
}

async function syncShared() {
  flashStatus('🌐 ' + t('sharedSyncing'));
  try { await call('shared', { op: 'sync' }); } catch (e) { toast(e.message); }
  showShared(true);
}

function sharedList(title, items, message) {
  push({ kind: 'circles', local: 'shared', more: false, back: true, title,
    message: items.length ? message || '' : t('sharedNoResults'), circles: items.map(itemCircle) }, title);
}

async function sharedOpen(c) {
  if (c.id === 'sh:open') return showShared();
  if (c.id === 'sh:sync') return syncShared();
  if (c.id === 'sh:search') {
    return push({ kind: 'text', local: 'sharedSearch', go: t('sharedSearch'), title: t('sharedSearch'), message: t('sharedSearchMsg'), text: '' }, t('sharedSearch'));
  }
  try {
    if (c.id === 'sh:updates') return sharedList(t('sharedUpdatesFor'), (await call('shared', { op: 'updates' })).items || []);
    if (c.id === 'sh:mine') return sharedList(t('sharedMine'), (await call('shared', { op: 'mine' })).items || []);
    if (c.kindList) return sharedList(t('sharedKind.' + c.kindList), (await call('shared', { op: 'list', kind: c.kindList })).items || [], t('sharedMsg'));
    if (c.id === 'sh:share') return showShareList();
    if (c.shareRef) return showSharePreview(c.shareRef);
    if (c.item) return showSharedItem(c.item);
  } catch (e) { toast(e.message); }
  return false;
}

async function searchShared(q) {
  let r;
  try { r = await call('shared', { op: 'search', q }); } catch (e) { return toast(e.message); }
  if (current.screen.local === 'sharedSearch') { stopWriting(true); current = stack.pop(); }
  sharedList(`${t('sharedSearch')}: ${q}`, r.items || [], t('sharedMsg'));
}

async function showShareList() {
  const r = await call('shared', { op: 'shareable' });
  const circles = [
    ...(r.modules || []).map((m) => ({ id: 'shm:' + m.id, shareRef: { module: m.id }, icon: m.role === 'component' ? '🧩' : '🔧', label: m.name,
      hint: [kindName(m.role === 'component' ? 'component' : 'util'), (m.path || []).join(' › '), 'v' + m.version].join(' · '), title: m.description })),
    ...(r.applets || []).map((a) => ({ id: 'sha:' + a.key, shareRef: { applet: a.key }, icon: '🪟', label: a.title, hint: `${kindName('applet')} · ${a.opens || 0} ×` })),
  ];
  push({ kind: 'circles', local: 'shared', more: false, back: true, title: t('sharedShareTitle'),
    message: circles.length ? t('sharedShareMsg') : t('sharedShareEmpty'), circles }, t('sharedShareTitle'));
}

// Exactly what will be published, then the signed post on the user's click.
async function showSharePreview(ref) {
  let p;
  try { p = await call('shared', { op: 'preview', ...ref }); } catch (e) { return toast(e.message); }
  const name = p.body.title || p.body.name;
  const S = strings(['sharedPreviewNote', 'sharedPublish', 'sharedCancel', 'sharedSharedDone', 'sharedSignedAs', 'copied', 'sharedWorking']);
  const body = `<section><span class="badge">🌐 ${esc(t('sharedGlobalBadge'))}</span>
    <p>${esc(t('sharedPreviewNote'))}</p>
    <p class="m">${esc(t('sharedSignedAs'))} <code title="${esc(p.author)}">${esc(shortId(p.author))}</code> · ${esc(fmtBytes(p.payloadBytes))}</p>
    ${(p.warnings || []).map((w) => `<p class="err">⚠ ${esc(w)}</p>`).join('')}
    ${(p.strip || []).length ? `<p class="err">⚠ ${esc(t('sharedStripNote'))}: ${esc(p.strip.join('; '))}. ${esc(t('sharedStripCheck'))}</p>` : ''}
    <pre id="json"></pre>
    <div class="btns"><button type="button" class="primary" id="share">${esc(t('sharedPublish'))}</button><button type="button" id="cancel">${esc(t('sharedCancel'))}</button></div>
    <p id="out" role="status" aria-live="polite"></p></section>`;
  const script = `
    $('#json').textContent = DATA.json;
    $('#cancel').onclick = () => aiui.back();
    $('#share').onclick = async () => {
      $('#share').disabled = true; $('#out').className = 'm busy'; $('#out').textContent = '…';
      try {
        const it = await aiui.call('shared', Object.assign({ op: 'share', digest: DATA.digest }, DATA.ref));
        $('#out').className = ''; $('#out').textContent = '✓ ' + S.sharedSharedDone + ' ' + it.version + ' · ' + it.id;
        $('#cancel').textContent = '‹';
      } catch (e) { $('#out').className = 'err'; $('#out').textContent = e.message; $('#share').disabled = false; }
    };`;
  pushPath({ kind: 'html', local: 'shared', title: `${t('sharedPreviewTitle')} ${name}`, back: true,
    html: appHtml(body, script, { S, json: p.json, digest: p.digest, ref }) }, name);
}

// One global item: what it is, and adopting it (review first), reporting, withdrawing.
async function showSharedItem(id, opts = {}) {
  let r;
  try { r = await call('shared', { op: 'item', id }); } catch (e) { return toast(e.message); }
  const it = r.item;
  const S = strings(['sharedReviewAdopt', 'sharedReviewUpdate', 'sharedAdoptedV', 'sharedWorking', 'sharedReviewTitle', 'sharedVerified',
    'verdict.safe', 'verdict.caution', 'verdict.unsafe', 'sharedWhat', 'sharedNetwork', 'sharedSystem', 'sharedSuspicious', 'sharedStatic',
    'sharedNone', 'sharedCode', 'sharedConfirm', 'sharedConfirmAnyway', 'sharedCancel', 'sharedAdoptNote', 'sharedAdoptedDone', 'sharedOpen',
    'sharedReportWhy', 'sharedReportSend', 'sharedReported', 'sharedWithdrawSure', 'sharedWithdrawn', 'copied', 'sharedVerdict']);
  const row = (k, v) => (v ? `<tr><th>${esc(k)}</th><td>${v}</td></tr>` : '');
  const body = `<section><span class="badge">🌐 ${esc(t('sharedGlobalBadge'))}</span>
    <p>${esc(it.description || '')}</p>
    <table>
      ${row(t('sharedKindLabel'), esc(kindName(it.kind)))}
      ${row(t('sharedCategory'), esc((it.path || []).join(' › ')))}
      ${row(t('sharedBy'), `<code title="${esc(it.author)}">${esc(shortId(it.author))}</code>${it.authorName ? ' · ' + esc(it.authorName) : ''}${it.mine ? ' · ' + esc(t('sharedYours')) : ''}`)}
      ${row(t('sharedVersion'), esc('v' + it.version) + (it.adoptedVersion ? ` · ${esc(t('sharedAdoptedV'))} ${esc(it.adoptedVersion)}` : ''))}
      ${row(t('sharedAdoptionsLabel'), esc(String(it.adoptions || 0)))}
      ${row(t('sharedUsage'), it.usage ? `<code>${esc(it.usage)}</code>` : '')}
      ${row(t('sharedLibs'), esc((it.libs || []).join(', ')))}
      ${row(t('sharedUses'), (it.uses || []).map((u) => `<button type="button" data-item="${esc(u)}">${esc(u)}</button>`).join(' '))}
      ${row(t('sharedSize'), esc(fmtBytes(it.size)))}
      ${row(t('sharedUpdatedAt'), esc(it.updated ? new Date(it.updated).toLocaleString() : ''))}
      ${row(t('sharedHash'), `<code>${esc(it.sha256 || '')}</code>`)}
    </table>
    <div class="btns">
      <button type="button" class="primary" id="adopt"></button>
      <button type="button" id="report">${esc(t('sharedReport'))}</button>
      ${it.mine ? `<button type="button" class="danger" id="withdraw">${esc(t('sharedWithdraw'))}</button>` : ''}
    </div>
    <div id="reportBox" hidden><label class="f" for="why">${esc(t('sharedReportWhy'))}</label><textarea id="why" rows="2"></textarea>
      <div class="btns"><button type="button" id="sendReport">${esc(t('sharedReportSend'))}</button></div></div>
    <p id="out" role="status" aria-live="polite"></p></section>
    <section id="review" hidden aria-live="polite"></section>`;
  const script = `
    const it = DATA.item;
    const adopt = $('#adopt'), out = $('#out'), rev = $('#review');
    adopt.textContent = it.updateAvailable ? S.sharedReviewUpdate + ' v' + it.version : it.adoptedVersion ? '✓ ' + S.sharedAdoptedV + ' ' + it.adoptedVersion : S.sharedReviewAdopt;
    if (it.adoptedVersion && !it.updateAvailable) adopt.disabled = true;
    for (const b of document.querySelectorAll('[data-item]')) b.onclick = () => aiui.adoptShared(b.dataset.item);
    const list = (a) => a && a.length ? '<ul>' + a.map((x) => '<li>' + esc(x) + '</li>').join('') + '</ul>' : '<span class="m">' + esc(S.sharedNone) + '</span>';
    async function review() {
      adopt.disabled = true; rev.hidden = true;
      out.className = 'm busy'; out.textContent = S.sharedWorking;
      let p;
      try { p = await aiui.call('shared', { op: 'prepare', id: it.id }); }
      catch (e) { out.className = 'err'; out.textContent = '✗ ' + e.message; adopt.disabled = false; return; }
      out.className = 'm'; out.textContent = '✓ ' + S.sharedVerified + ' · ' + p.sha256.slice(0, 16) + '…';
      const r = p.review || {}, v = ['safe', 'caution', 'unsafe'].includes(r.verdict) ? r.verdict : 'caution';
      rev.hidden = false;
      rev.innerHTML = '<h2>' + esc(S.sharedReviewTitle) + '</h2>' +
        '<div class="verdict ' + v + '">' + esc(S.sharedVerdict) + ': ' + esc(S['verdict.' + v]) + '</div>' +
        '<h3>' + esc(S.sharedWhat) + '</h3><p>' + esc(r.summary || '') + '</p>' +
        '<h3>' + esc(S.sharedNetwork) + '</h3><p>' + esc(r.network || '') + '</p>' +
        '<h3>' + esc(S.sharedSystem) + '</h3><p>' + esc(r.system || '') + '</p>' +
        '<h3>' + esc(S.sharedSuspicious) + '</h3>' + list(r.suspicious) +
        '<h3>' + esc(S.sharedStatic) + '</h3>' + list(p.staticFindings) +
        '<details><summary>' + esc(S.sharedCode) + '</summary><pre id="code"></pre></details>' +
        '<p class="m">' + esc(S.sharedAdoptNote) + '</p>' +
        '<div class="btns"><button type="button" class="' + (v === 'unsafe' ? 'danger' : 'primary') + '" id="confirm">' +
        esc(v === 'unsafe' ? S.sharedConfirmAnyway : S.sharedConfirm) + '</button><button type="button" id="cancelAdopt">' + esc(S.sharedCancel) + '</button></div>' +
        '<p id="done" role="status"></p>';
      $('#code').textContent = p.code || '';
      $('#cancelAdopt').onclick = () => { rev.hidden = true; adopt.disabled = false; out.textContent = ''; };
      $('#confirm').onclick = async () => {
        $('#confirm').disabled = true;
        try {
          const a = await aiui.call('shared', { op: 'adopt', id: it.id, sha256: p.sha256 });
          $('#done').innerHTML = '✓ ' + esc(S.sharedAdoptedDone) + (a.key ? ' <button type="button" class="primary" id="openIt">' + esc(S.sharedOpen) + '</button>' : '');
          if (a.key) $('#openIt').onclick = () => aiui.openAdopted(a.key, a.title);
          adopt.textContent = '✓ ' + S.sharedAdoptedV + ' ' + a.version;
          $('#cancelAdopt').hidden = true;
        } catch (e) { $('#done').className = 'err'; $('#done').textContent = '✗ ' + e.message; $('#confirm').disabled = false; }
      };
    }
    adopt.onclick = review;
    $('#report').onclick = () => { $('#reportBox').hidden = false; $('#why').focus(); };
    $('#sendReport').onclick = async () => {
      try { await aiui.call('shared', { op: 'report', id: it.id, reason: $('#why').value }); $('#reportBox').hidden = true; out.className = 'm'; out.textContent = '✓ ' + S.sharedReported; }
      catch (e) { out.className = 'err'; out.textContent = e.message; }
    };
    const w = $('#withdraw');
    if (w) w.onclick = async () => {
      if (!w.dataset.sure) { w.dataset.sure = '1'; w.textContent = S.sharedWithdrawSure; return; }
      w.disabled = true;
      try { await aiui.call('shared', { op: 'withdraw', id: it.id }); out.className = 'm'; out.textContent = '✓ ' + S.sharedWithdrawn; adopt.disabled = true; }
      catch (e) { out.className = 'err'; out.textContent = e.message; w.disabled = false; }
    };
    if (DATA.review && !adopt.disabled) review();`;
  pushPath({ kind: 'html', local: 'shared', title: it.title || it.name, back: true, sharedItem: it.id, sharedMine: !!it.mine,
    sharedAdoptable: !it.adoptedVersion || !!it.updateAvailable, html: appHtml(body, script, { S, item: it, review: !!opts.review }) }, it.title || it.name);
}

// A local module's card (from the Utility Library): marked local, with "Share globally…".
async function showModuleCard(id) {
  let m;
  try { m = await call('shared', { op: 'module', id }); } catch (e) { return toast(e.message); }
  const row = (k, v) => (v ? `<tr><th>${esc(k)}</th><td>${v}</td></tr>` : '');
  const body = `<section><span class="badge local">📍 ${esc(t('sharedLocalBadge'))}</span>
    <p>${esc(m.description || '')}</p>
    <table>
      ${row(t('sharedKindLabel'), esc(kindName(m.role === 'component' ? 'component' : 'util') + ' · ' + m.kind))}
      ${row(t('sharedCategory'), esc((m.path || []).join(' › ')))}
      ${row(t('sharedVersion'), esc('v' + m.version))}
      ${row(t('sharedUsage'), m.usage ? `<code>${esc(m.usage)}</code>` : '')}
      ${row('🌐', m.origin ? esc(`${t('sharedFromGlobal')} ${m.originVersion}`) + ` · <button type="button" id="origin">${esc((m.originItem && m.originItem.title) || m.origin)}</button>` : '')}
      ${row('🌐', m.sharedAs ? `${esc(t('sharedSharedAs'))} · <button type="button" id="mine">${esc(m.sharedAs)}</button>` : '')}
    </table>
    <details><summary>${esc(t('sharedCode'))}</summary><pre id="code"></pre></details>
    ${m.origin ? '' : `<div class="btns"><button type="button" class="primary" id="share">${esc(t('sharedShareModule'))}</button></div>`}
  </section>`;
  const script = `
    $('#code').textContent = DATA.m.code;
    const s = $('#share'); if (s) s.onclick = () => aiui.sharePreview({ module: DATA.m.id });
    const o = $('#origin'); if (o) o.onclick = () => aiui.adoptShared(DATA.m.origin);
    const mi = $('#mine'); if (mi) mi.onclick = () => aiui.adoptShared(DATA.m.sharedAs);`;
  pushPath({ kind: 'html', local: 'library', title: m.name, back: true, moduleId: m.id, moduleOwn: !m.origin, html: appHtml(body, script, { m }) }, m.name);
}

// ---------------------------------------------------------------- People

const stateIcon = { mutual: '✅', incoming: '📨', pending: '⏳' };
let peopleState = null;

function contactCircle(c) {
  const who = c.name || shortId(c.id);
  return {
    id: 'c:' + c.id, contact: c.id, person: c, state: c.state, icon: stateIcon[c.state] || '👤', label: who,
    hint: c.state === 'mutual' ? `✓ ${t('peopleVerified')} · ${shortId(c.id)}` : c.state === 'incoming' ? t('peopleIncoming') : t('peoplePending'),
    title: c.id,
  };
}

function peopleScreen(st) {
  const p = st.profile;
  const order = { incoming: 0, mutual: 1, pending: 2 };
  const contacts = (st.contacts || []).slice().sort((a, b) => (order[a.state] ?? 3) - (order[b.state] ?? 3));
  return {
    kind: 'circles', local: 'people', peopleTop: true, more: false, back: true, title: t('people'),
    message: st.offline ? t('peopleOffline') : t('peopleMsg'),
    circles: [
      { id: 'p:id', icon: '🆔', label: st.short || shortId(st.id), hint: t('peopleYourId'), title: st.id, size: 1.05 },
      { id: 'p:profile', icon: '👤', label: t('peopleProfile'),
        hint: p ? [p.name, p.handle ? '@' + p.handle : '', p.findable ? t('peopleListed') : t('peopleHidden')].filter(Boolean).join(' · ') : t('peopleNotListed') },
      { id: 'p:find', icon: '🔍', label: t('peopleFind'), hint: t('peopleFindHint') },
      { id: 'p:add', icon: '➕', label: t('peopleAdd'), hint: t('peopleAddHint') },
      { id: 'p:check', icon: '🔄', label: t('peopleCheck'), hint: st.lastCheck ? `${t('peopleChecked')} ${ago(st.lastCheck)}` : '', size: 0.8 },
      ...contacts.map(contactCircle),
    ],
  };
}

async function showPeople(inPlace) {
  let st;
  try { st = await call('people', { op: 'status' }); } catch (e) { return toast(e.message); }
  if (st.error) return toast(st.error);
  peopleState = st;
  const place = (fresh) => {
    const entry = [current, ...stack].find((x) => x.screen.local === 'people' && x.screen.peopleTop);
    if (!entry) return false;
    entry.screen = peopleScreen(fresh);
    if (entry === current) render();
    return true;
  };
  if (inPlace) return place(st);
  pushPath(peopleScreen(st), t('people'));
  // Opening People turns on the inbox (polled every few minutes while the app is open).
  call('people', { op: 'open' }).then((fresh) => { peopleState = fresh; place(fresh); }).catch(() => {});
}

function popTextScreen(local) {
  if (current.screen.local === local) { stopWriting(true); current = stack.pop(); }
}

async function addPerson(id, note) {
  try {
    const st = await call('people', { op: 'add', id, note });
    peopleState = st;
    flashStatus('👥 ' + t('peopleAddedMsg'));
    return st;
  } catch (e) { toast(e.message); return null; }
}

async function findPeople(q) {
  let r;
  try { r = await call('people', { op: 'find', q }); } catch (e) { return toast(e.message); }
  popTextScreen('peopleFind');
  const found = r.profiles || [];
  const circles = found.filter((p) => !p.self).map((p) => ({
    id: 'f:' + p.id, person: p, icon: stateIcon[p.state] || '👤', label: p.name || shortId(p.id),
    hint: [p.handle ? '@' + p.handle : '', p.state ? (p.state === 'mutual' ? '✓ ' + t('peopleVerified') : p.state === 'incoming' ? t('peopleIncoming') : t('peoplePending')) : shortId(p.id)].filter(Boolean).join(' · '),
    title: p.id,
  }));
  if (!circles.length && r.id) circles.push({ id: 'p:addid', addId: r.id, icon: '➕', label: t('peopleAddThisId'), hint: shortId(r.id), title: r.id });
  push({ kind: 'circles', local: 'people', more: false, back: true, title: `${t('peopleFind')}: ${q}`,
    message: circles.length ? '' : t('peopleNoneFound'), circles }, q);
}

async function peopleOpen(c) {
  if (c.id === 'p:id') return copyText(peopleState ? peopleState.id : '');
  if (c.id === 'p:profile') return showProfileForm();
  if (c.id === 'p:find') return push({ kind: 'text', local: 'peopleFind', go: t('peopleFind'), title: t('peopleFind'), message: t('peopleFindMsg'), text: '' }, t('peopleFind'));
  if (c.id === 'p:add') return push({ kind: 'text', local: 'peopleAdd', go: t('peopleAdd'), title: t('peopleAdd'), message: t('peopleAddMsg'), text: '' }, t('peopleAdd'));
  if (c.id === 'p:check') {
    try { await call('people', { op: 'inbox' }); } catch (e) { toast(e.message); }
    return showPeople(true);
  }
  if (c.addId) { if (await addPerson(c.addId)) { back(); showPeople(true); } return; }
  if (c.contact && c.state === 'incoming') { if (await addPerson(c.contact)) showPeople(true); return; }
  if (c.person) return showPersonCard(c.person);
  return false;
}

function peopleMinus(c) {
  if (!c.contact) return false;
  call('people', { op: 'remove', id: c.contact }).then((st) => { peopleState = st; flashStatus('👥 ' + t('peopleRemoved')); }).catch((e) => toast(e.message));
  return true;
}

function showPersonCard(p) {
  const S = strings(['copied', 'peopleAdd', 'peopleAddBack', 'peopleRemove', 'peopleRemoved', 'peopleAddedMsg']);
  const verified = p.state === 'mutual';
  const body = `<section>
    <h2>${esc(p.name || shortId(p.id))}${p.handle ? ' · @' + esc(p.handle) : ''}</h2>
    ${p.about ? `<p>${esc(p.about)}</p>` : ''}
    <p class="idline"><code title="${esc(p.id)}">${esc(shortId(p.id))}</code><button type="button" data-copy="${esc(p.id)}">${esc(t('copy'))}</button>
      ${verified ? `<span class="badge">✓ ${esc(t('peopleVerified'))}</span>` : ''}</p>
    <pre>${esc(p.id)}</pre>
    ${verified ? `<p class="m">${esc(t('peopleIdVerified'))}</p>` : ''}
    ${p.state ? `<p class="m">${esc(t('peopleState'))}: ${esc(p.state === 'mutual' ? t('peopleMutual') : p.state === 'incoming' ? t('peopleIncoming') : t('peoplePending'))}</p>` : ''}
    <div class="btns">
      ${!p.state || p.state === 'incoming' ? `<button type="button" class="primary" id="add">${esc(p.state === 'incoming' ? t('peopleAddBack') : t('peopleAdd'))}</button>` : ''}
      ${p.state ? `<button type="button" class="danger" id="remove">${esc(t('peopleRemove'))}</button>` : ''}
    </div><p id="out" role="status" aria-live="polite"></p></section>`;
  const script = `
    const out = $('#out');
    const act = async (op, msg) => {
      try { await aiui.call('people', { op, id: DATA.p.id }); out.className = 'm'; out.textContent = '✓ ' + msg; aiui.peopleRefresh(); for (const b of document.querySelectorAll('.btns button')) b.disabled = true; }
      catch (e) { out.className = 'err'; out.textContent = e.message; }
    };
    const a = $('#add'); if (a) a.onclick = () => act('add', S.peopleAddedMsg);
    const r = $('#remove'); if (r) r.onclick = () => act('remove', S.peopleRemoved);`;
  push({ kind: 'html', local: 'people', title: p.name || shortId(p.id), back: true, html: appHtml(body, script, { S, p }) }, p.name || shortId(p.id));
}
aiui.peopleRefresh = () => showPeople(true);

function showProfileForm() {
  const p = (peopleState && peopleState.profile) || {};
  const S = strings(['peopleSaved', 'peopleDeleted', 'copied']);
  const body = `<section><p class="m">${esc(t('peopleProfileNote'))}</p>
    <form id="f" autocomplete="off">
      <label class="f" for="name">${esc(t('peopleName'))}</label><input type="text" id="name" maxlength="60" required>
      <label class="f" for="handle">${esc(t('peopleHandle'))} <span class="m">(${esc(t('peopleHandleHint'))})</span></label><input type="text" id="handle" maxlength="30" pattern="[a-z0-9_-]{3,30}">
      <label class="f" for="about">${esc(t('peopleAbout'))}</label><textarea id="about" rows="3" maxlength="280"></textarea>
      <label class="check"><input type="checkbox" id="findable"> ${esc(t('peopleFindable'))}</label>
      <div class="btns"><button type="submit" class="primary">${esc(t('peopleSave'))}</button>
        ${p.name ? `<button type="button" class="danger" id="del">${esc(t('peopleDeleteProfile'))}</button>` : ''}</div>
    </form><p id="out" role="status" aria-live="polite"></p></section>`;
  const script = `
    const p = DATA.p, out = $('#out');
    $('#name').value = p.name || ''; $('#handle').value = p.handle || ''; $('#about').value = p.about || ''; $('#findable').checked = !!p.findable;
    $('#f').onsubmit = async (e) => {
      e.preventDefault();
      const profile = { name: $('#name').value, handle: $('#handle').value.replace(/^@/, '').toLowerCase(), about: $('#about').value, findable: $('#findable').checked };
      try { await aiui.call('people', { op: 'profile', profile }); out.className = 'm'; out.textContent = '✓ ' + S.peopleSaved; aiui.peopleRefresh(); }
      catch (err) { out.className = 'err'; out.textContent = err.message; }
    };
    const d = $('#del'); if (d) d.onclick = async () => {
      try { await aiui.call('people', { op: 'deleteProfile' }); out.className = 'm'; out.textContent = '✓ ' + S.peopleDeleted; d.disabled = true; aiui.peopleRefresh(); }
      catch (err) { out.className = 'err'; out.textContent = err.message; }
    };
    $('#name').focus();`;
  push({ kind: 'html', local: 'people', title: t('peopleProfile'), back: true, html: appHtml(body, script, { S, p }) }, t('peopleProfile'));
}

// ---------------------------------------------------------------- app screens (hooks in app.js)

const LOCAL_SCREENS = {
  shared: { open: (c) => { sharedOpen(c); } },
  sharedSearch: { submit: (q) => searchShared(q) },
  library: { open: (c) => (c.id === 'sh:open' ? (showShared(), undefined) : c.util ? (showModuleCard(c.util), undefined) : false) },
  people: { open: (c) => { peopleOpen(c); }, minus: (c) => peopleMinus(c) },
  peopleFind: { submit: (q) => findPeople(q) },
  peopleAdd: {
    submit: async (text) => {
      if (await addPerson(text.trim())) { popTextScreen('peopleAdd'); render(); showPeople(true); }
    },
  },
};

// ---------------------------------------------------------------- instant circles (no AI)
// Registered in app.js's registry: proposed while typing and listed on the Actions screen (⌘K).

// The scene on display as it would be shared (an html scene that isn't stored as an applet).
const sceneForShare = (s) => ({ kind: 'html', title: s.title || '', message: s.message || '', html: s.html || '',
  uses: s.uses || [], libs: s.libs || [], ...(s.improve ? { improve: s.improve } : {}), ...(s.fullscreen ? { fullscreen: true } : {}) });

async function withdrawShared(id) {
  try { await call('shared', { op: 'withdraw', id }); } catch (e) { return toast(e.message); }
  flashStatus('🌐 ' + t('sharedWithdrawn'));
  back();
}

LOCAL_SCREENS.sharedReport = {
  submit: async (reason) => {
    const id = current.screen.sharedItem;
    try { await call('shared', { op: 'report', id, reason }); } catch (e) { return toast(e.message); }
    popTextScreen('sharedReport'); render();
    flashStatus('🌐 ' + t('sharedReported'));
  },
};

if (typeof registerInstant === 'function') [
  // This scene
  { id: 'shareApplet', scene: true, icon: '📤', label: () => t('instShareApplet'), when: (c) => NATIVE && !!c.applet,
    run: (c) => showSharePreview({ applet: c.applet }) },
  { id: 'shareScene', scene: true, icon: '📤', label: () => t('instShareScene'), when: (c) => NATIVE && c.html && !c.applet && !!c.s.html,
    run: (c) => showSharePreview({ scene: sceneForShare(c.s) }) },
  { id: 'shareModule', scene: true, icon: '📤', label: () => t('instShareModule'), when: (c) => NATIVE && c.local === 'library' && !!c.s.moduleId && c.s.moduleOwn,
    run: (c) => showSharePreview({ module: c.s.moduleId }) },
  { id: 'sharedAdopt', scene: true, icon: '⬇️', label: () => t('instAdopt'), when: (c) => c.local === 'shared' && !!c.s.sharedItem && c.s.sharedAdoptable,
    run: (c) => showSharedItem(c.s.sharedItem, { review: true }) },
  { id: 'sharedWithdraw', scene: true, icon: '🗑', label: () => t('instWithdraw'), when: (c) => c.local === 'shared' && !!c.s.sharedItem && c.s.sharedMine,
    run: (c) => withdrawShared(c.s.sharedItem) },
  { id: 'sharedReport', scene: true, icon: '⚑', label: () => t('instReport'), when: (c) => c.local === 'shared' && !!c.s.sharedItem && !c.s.sharedMine,
    run: (c) => push({ kind: 'text', local: 'sharedReport', sharedItem: c.s.sharedItem, go: t('sharedReportSend'), title: t('instReport'), message: t('sharedReportWhy'), text: '' }, t('sharedReport')) },
  // The app
  { id: 'sharedByOthers', icon: '🌐', label: () => t('instSharedByOthers'), when: () => NATIVE, run: () => showShared() },
  { id: 'sharedSearch', icon: '🔍', label: () => t('instSharedSearch'), when: () => NATIVE,
    run: () => push({ kind: 'text', local: 'sharedSearch', go: t('sharedSearch'), title: t('sharedSearch'), message: t('sharedSearchMsg'), text: '' }, t('sharedSearch')) },
  { id: 'sharedSync', icon: '🔄', label: () => t('instSharedSync'), when: () => NATIVE, run: () => syncShared() },
  { id: 'sharedUpdates', icon: '⬆️', label: () => t('instSharedUpdates'), when: () => NATIVE && (sharedStatus.updates || []).length > 0,
    run: async () => sharedList(t('sharedUpdatesFor'), (await call('shared', { op: 'updates' })).items || []) },
  { id: 'shareList', icon: '📤', label: () => t('instShareList'), when: () => NATIVE, run: () => showShareList() },
  { id: 'sharedMine', icon: '🙋', label: () => t('instSharedMine'), when: () => NATIVE && sharedStatus.mine > 0,
    run: async () => sharedList(t('sharedMine'), (await call('shared', { op: 'mine' })).items || []) },
  { id: 'people', icon: '👥', label: () => t('instPeople'), when: () => NATIVE, run: () => showPeople() },
  { id: 'findPeople', icon: '🔍', label: () => t('instFindPeople'), when: () => NATIVE,
    run: () => push({ kind: 'text', local: 'peopleFind', go: t('peopleFind'), title: t('peopleFind'), message: t('peopleFindMsg'), text: '' }, t('peopleFind')) },
  { id: 'addPerson', icon: '➕', label: () => t('instAddPerson'), when: () => NATIVE,
    run: () => push({ kind: 'text', local: 'peopleAdd', go: t('peopleAdd'), title: t('peopleAdd'), message: t('peopleAddMsg'), text: '' }, t('peopleAdd')) },
  { id: 'peopleProfile', icon: '👤', label: () => t('instEditProfile'), when: () => NATIVE,
    run: async () => { try { peopleState = await call('people', { op: 'status' }); } catch {} showProfileForm(); } },
  { id: 'peopleInbox', icon: '📨', label: () => t('instCheckInbox'), when: () => NATIVE,
    run: async () => { try { await call('people', { op: 'inbox' }); flashStatus('👥 ' + t('peopleChecked')); } catch (e) { toast(e.message); } showPeople(true); } },
  { id: 'copyAppId', icon: '🆔', label: () => t('instCopyId'), when: () => NATIVE,
    run: async () => { const r = await call('people', { op: 'identity' }); await copyText(r.id); } },
].forEach(registerInstant);
// What the shared index holds (for the conditions above), once at start.
if (NATIVE) callRaw('shared', { op: 'status' }).then((st) => { sharedStatus = st; }).catch(() => {});

// ---------------------------------------------------------------- proposing to share (the applet's own `shareable`)
// An applet says whether it is worth sharing (`shareable`: propose, as, ids, why, strip). Once the
// user has used it a while (≥ 3 opens or ≥ 10 minutes) and hasn't said "Not now" to this version,
// it is offered once, quietly: a status note and an instant circle on top of the proposals and
// the Actions screen. Choosing it opens the share preview — nothing is published without the
// confirmation there.
const DECLINED = 'aiui.shareDeclined';
const declined = () => { try { return JSON.parse(localStorage.getItem(DECLINED)) || {}; } catch { return {}; } };
let shareOffer = null;                 // { key, version, as, ids, why }
const offerChecked = new Map();        // key → time last checked
const offerNoted = new Set();          // key@version noted in the status bar this session

async function checkShareOffer() {
  const s = current.screen, key = current.key;
  if (!NATIVE || s.kind !== 'html' || s.local || !key || !s.shareable || !s.shareable.propose) return;
  if (shareOffer && shareOffer.key === key) return;
  if (Date.now() - (offerChecked.get(key) || 0) < 120000) return;
  offerChecked.set(key, Date.now());
  let live;
  try { live = await callRaw('live', { key }); } catch { return; }
  const sc = live && live.scene;
  if (!sc || current.key !== key) return;
  const version = sc.improves || 0;
  if (!((sc.opens || 0) >= 3 || (sc.minutes || 0) >= 10)) return;
  if (declined()[key] === version) return;
  const sh = s.shareable;
  shareOffer = { key, version, as: sh.as || 'applet', ids: sh.ids || [], why: sh.why || '' };
  if (!offerNoted.has(key + '@' + version)) {
    offerNoted.add(key + '@' + version);
    flashStatus(`📤 ${t('offerNote')}${shareOffer.why ? ': ' + shareOffer.why : ''}`);
  }
}
setInterval(checkShareOffer, 5000);

function runShareOffer(o) {
  if (o.as === 'applet' || !o.ids.length) return showSharePreview({ applet: o.key });
  if (o.ids.length === 1) return showSharePreview({ module: o.ids[0] });
  push({ kind: 'circles', local: 'shared', more: false, back: true, title: t('sharedShareTitle'), message: t('sharedShareMsg'),
    circles: o.ids.map((id) => ({ id: 'shm:' + id, shareRef: { module: id }, icon: '🧩', label: id })) }, t('sharedShareTitle'));
}

function shareableRow(s) {
  const sh = s && s.shareable;
  if (!sh) return [];
  return [[t('actShareable'), (sh.propose ? t('actShareableYes') : t('actShareableNo')) + (sh.as ? ` · ${sh.as}` : '') + (sh.why ? ` — ${sh.why}` : '')]];
}

if (typeof registerInstant === 'function') {
  const offerFor = (c) => shareOffer && c.applet && shareOffer.key === c.applet && declined()[c.applet] !== shareOffer.version ? shareOffer : null;
  registerInstant({ id: 'shareOffer', scene: true, icon: '📤',
    label: () => (shareOffer && shareOffer.as !== 'applet' ? t('offerShareComponent') : t('offerShareApplet')),
    when: (c) => !!offerFor(c), run: (c) => runShareOffer(offerFor(c)) });
  registerInstant({ id: 'shareOfferDecline', scene: true, icon: '✕', label: () => t('offerNotNow'),
    when: (c) => !!offerFor(c),
    run: (c) => { const d = declined(); d[c.applet] = shareOffer.version; localStorage.setItem(DECLINED, JSON.stringify(d)); shareOffer = null; flashStatus('✕ ' + t('offerNotNow')); } });
  // On top of the proposals and the Actions screen.
  if (typeof INSTANT !== 'undefined') {
    for (const id of ['shareOfferDecline', 'shareOffer']) { const i = INSTANT.findIndex((a) => a.id === id); if (i > 0) INSTANT.unshift(...INSTANT.splice(i, 1)); }
  }
}
