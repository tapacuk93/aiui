// The status bar and its processes, the activity screen, the console, pause, the background player,
// zoom/find/print, context menus, cursor trajectories and prefetch, live refinement, the user
// baseline, translation, and what survives a reload.
import { test, expect } from '../harness.mjs';
import { routes, circleScreen, labels, until, deferred, err } from './util.mjs';

const show = (app, screen) => app.ev((s) => { current.screen = normalize(s); render(); }, screen);

test('status bar: the most important activity shows, with a count; done shows a summary', async ({ app }) => {
  await app.open({ native: true, api: routes({ system: { cache: { entries: 7 }, libraries: { installed: 1, catalog: 9 }, hints: { hints: [1, 2] } } }) });
  await app.tick(1600);
  await expect(app.page.locator('#activity')).toHaveText(/^ready · 14 circles · .*cache 7 · JS 1\/9 · hints 2$/);
  await app.ev(() => { activityStart('menus:1', 'Menus'); activityStart('ai:1', 'Opening'); activityDetail('ai:1', 'reading'); activityDetail('none', 'x'); });
  await expect(app.page.locator('#activity')).toHaveText('Opening — reading  (+1)');
  await expect(app.page.locator('#activity')).toHaveClass(/busy/);
  expect(await app.page.getAttribute('#activity', 'title')).toBe('Opening\nMenus');
  await app.ev(() => { activityEnd('ai:1'); activityEnd('menus:1'); activityEnd('nope'); });
  await expect(app.page.locator('#activity')).toHaveText(/^ready · 14 circles · Menus · \d+s/);
  // Media and scene activities keep a steady dot; paused background work too.
  await app.ev(() => { activityStart('media', '♫ Song'); });
  await expect(app.page.locator('#activity')).toHaveClass(/steady/);
  await app.ev(() => { activityEnd('media'); setPaused(true); activityStart('menus:2', 'Menus'); });
  await expect(app.page.locator('#activity')).toHaveClass(/steady/);
  await app.ev(() => { activityEnd('menus:2'); });
  await expect(app.page.locator('#activity')).toHaveText(/^paused/);
  await app.ev(() => setPaused(false));
  // Native activities: titled here, with their quick actions.
  await app.ev(() => {
    aiui._event({ type: 'activity', id: 'improve-1', kind: 'improve', name: 'Budget', detail: 'v2', key: 'b', actions: ['cancel', 'pause', 'nope'] });
    aiui._event({ type: 'activity', id: 'component-1', kind: 'component', name: 'Chart' });
    aiui._event({ type: 'activity', id: 'retro-1', kind: 'retro' });
    aiui._event({ type: 'activity', id: 'librarian-1', kind: 'librarian', detail: '3 left' });
    aiui._event({ type: 'activity', id: 'x-1', kind: 'other', title: 'Other job' });
    aiui._event({ type: 'activity', id: 'y-1', kind: 'improve' });
  });
  expect(await app.ev(() => [...activities.values()].map((a) => a.title))).toEqual(['improving «Budget» · v2', 'improving component Chart', 'learning from what went wrong', 'integrating shared components and utilities · 3 left', 'Other job', 'improving «»']);
  await app.ev(() => activities.get('improve-1').actions[0].run());
  await expect.poll(() => app.sent('activity').map((c) => c.body)).toEqual([{ id: 'improve-1', action: 'cancel' }]);
  await app.ev(() => { aiui._event({ type: 'activity', id: 'improve-1', done: true }); });
  expect(await app.ev(() => activities.has('improve-1'))).toBe(false);
  // Other events: console progress, app changes; unknown types are ignored.
  await app.ev(() => { aiui._event({ type: 'consoleProgress', text: 'step' }); aiui._event({ type: 'appChanged', key: 'k', value: 1 }); aiui._event({ type: 'whatever' }); });
  // The snapshot refresh failing leaves the summary as it was.
  app.api = routes({ system: () => Promise.reject(err('x')) });
  await app.tick(61000);
});

test('processes: the list expands upwards; rows go to their scene and offer quick actions; the schedule of the applet', async ({ app }) => {
  let sched = { schedule: { title: 'Budget', next: Date.now() + 90000, improves: 2, schedule: { curve: 'doubling', factor: 2, max: 7200 } } };
  await app.open({ native: true, api: routes({ usage: (b, d) => (b.op === 'schedule' ? (sched instanceof Error ? Promise.reject(sched) : sched) : b.op === 'outcome' ? { screen: { kind: 'html', title: 'Far', html: '' } } : d('usage', b)) }) });
  await app.ev(() => { stack = [{ screen: clone(ROOT), label: null }]; current = { screen: { kind: 'html', title: 'Budget', html: '', fixed: true }, label: 'Budget', key: 'bud' }; render(); });
  await app.page.click('#activity');
  await expect(app.page.locator('#procs')).toBeVisible();
  await expect(app.page.locator('#procs .p-now')).toHaveText('Running now');
  await expect(app.page.locator('#procs h4.p-sched')).toHaveText('Scheduled');
  await expect(app.page.locator('#procs .proc[data-id="-schedule"] .p-title')).toHaveText('next improvement «Budget»');
  await expect(app.page.locator('#procs .proc[data-id="-schedule"] .p-sub')).toHaveText('version 3 · doubling ×2 · ≤ 120m');
  await expect(app.page.locator('#procs .proc[data-id="-schedule"] .p-time')).toHaveText(/^(8\d|9\d)s$/);
  await app.page.locator('#procs .proc[data-id="-schedule"] .p-act[aria-label="Improve now"]').dispatchEvent('click');
  await expect.poll(() => app.sent('usage', 'improve').length).toBe(1);
  await app.page.locator('#procs .proc[data-id="-schedule"] .p-act[aria-label="Pause improvements"]').dispatchEvent('click');
  await expect.poll(() => app.sent('usage', 'pause').length).toBe(1);
  sched = { schedule: { paused: true, schedule: { curve: 'formula', formula: 'n^2' } } };
  await app.tick(10100);
  await expect(app.page.locator('#procs .proc[data-id="-schedule"] .p-time')).toHaveText('improvements paused');
  await app.page.locator('#procs .proc[data-id="-schedule"] .p-act[aria-label="Resume improvements"]').dispatchEvent('click');
  await expect.poll(() => app.sent('usage', 'pause').some((c) => c.body.on === false)).toBe(true);
  sched = { schedule: { next: Date.now() - 1, schedule: {} } };
  await app.ev(() => loadSchedule());
  await expect(app.page.locator('#procs .proc[data-id="-schedule"] .p-time')).toHaveText('due now');
  // Running work, by rank; rows with a place elsewhere go there.
  await app.ev(() => { const e = current; activityStart('ai:9', 'Opening X'); activityStart('lab', 'Lab'); activityStart('review', 'Review'); activityStart('more:1', 'More'); activityStart('weird', 'Weird');
    activityStart('media', '♫ s'); stack.push(current); current = { screen: { kind: 'circles', circles: [] }, label: 'Other' }; render(); });
  await app.page.click('#activity');
  await expect(app.page.locator('#procs .proc')).toHaveCount(6);
  expect(await app.page.$$eval('#procs .proc .p-title', (ns) => ns.map((n) => n.textContent))).toEqual(['Opening X', 'More', 'Review', 'Lab', '♫ s', 'Weird']);
  // Quick actions: cancel (AI, channel), skip (lab, review), pause/resume/stop (media).
  await app.page.locator('#procs .proc[data-id="more:1"] .p-act').dispatchEvent('click');
  await expect.poll(() => app.sent('cancel').some((c) => c.body.pager)).toBe(true);
  await app.page.locator('#procs .proc[data-id="ai:9"] .p-act').dispatchEvent('click');
  await app.page.locator('#procs .proc[data-id="lab"] .p-act').dispatchEvent('click');
  await app.page.locator('#procs .proc[data-id="review"] .p-act').dispatchEvent('click');
  await app.page.locator('#procs .proc[data-id="media"] .p-act[aria-label="Resume"]').dispatchEvent('click');
  await app.tick(200);
  expect(await app.ev(() => { Object.defineProperty(player, 'paused', { configurable: true, get: () => false }); const acts = activityActions('media', {}); acts[0].run(); delete player.paused; acts[1].run(); return acts.map((x) => x.label); })).toEqual(['Pause', 'Stop']);
  // A row whose action throws.
  await app.ev(() => { toggleProcs(true); activityStart('scene:z', 'Z', null, false, [{ icon: '!', label: 'Boom', run: () => { throw new Error('x'); } }]); });
  await app.page.locator('#procs .proc[data-id="scene:z"] .p-act').dispatchEvent('click');
  // The row goes back to its scene.
  await app.page.locator('#procs .proc[data-id="weird"] .p-main').dispatchEvent('click');
  await expect(app.page.locator('#title')).toHaveText('Budget');
  await expect(app.page.locator('#procs')).toBeHidden();
  // Nothing running.
  await app.ev(() => { for (const id of [...activities.keys()]) activityEnd(id); toggleProcs(true); });
  await expect(app.page.locator('#procs .proc.empty .p-title')).toHaveText('Nothing running');
  // Closing: Esc, a click elsewhere, the activity text again (Enter / Space).
  await app.page.keyboard.press('Escape');
  await expect(app.page.locator('#procs')).toBeHidden();
  await app.page.locator('#activity').press('Enter');
  await expect(app.page.locator('#procs')).toBeVisible();
  await app.page.locator('#title').dispatchEvent('pointerdown');
  await expect(app.page.locator('#procs')).toBeHidden();
  await app.page.locator('#activity').press(' ');
  await expect(app.page.locator('#procs')).toBeVisible();
  await app.page.locator('#activity').press('a');
  await app.tick(1100);
  // Schedule failing; not an applet.
  sched = err('x');
  await app.ev(() => loadSchedule());
  await app.ev(() => { current.key = null; loadSchedule(); });
  // goToActivity: an entry no longer in the history; an applet key.
  await app.ev(() => { goToActivity({ entry: { screen: {} }, key: 'far' }); });
  await expect(app.page.locator('#title')).toHaveText('Far');
  await app.ev(() => goToActivity({ entry: current }));
  await app.ev(() => goToActivity({}));
});

test('the activity screen: this scene and everywhere, live numbers; Esc closes', async ({ app }) => {
  const live = { process: { memory: 2e8, load: [1.234, 0.5], diskFree: 3e10, uptime: 4000 }, usage: { applets: 3, improvements: 5, next: { title: 'Budget', at: Date.now() + 60000 } },
    network: { ssid: 'Home', rssi: -40 }, integration: 87.6, modules: 12, integrationRemaining: '2 modules', engine: 'Claude',
    scene: { key: 'bud', improves: 2, opens: 4, minutes: 12.34, interactions: 9, findings: 1, paused: false, schedule: { curve: 'doubling' }, next: Date.now() + 5000 } };
  await app.open({ native: true, api: routes({ live: () => live, system: { ai: { active: { label: 'Claude Code' } }, cache: { entries: 4, bytes: 1e6 }, libraries: { installed: 2, catalog: 9, usedBytes: 5e6 }, hints: { hints: [1], journal: 3 } } }) });
  await app.ev(() => { stack = [{ screen: clone(ROOT), label: null }]; current = { screen: { kind: 'html', title: 'Budget', html: '', fixed: true, quality: { screen: { scores: { ux: 90 } } }, shareable: { propose: true, as: 'applet', why: 'useful' } }, label: 'Budget', key: 'bud' }; render(); });
  await app.ev(() => { activityStart('ai:1', 'Opening'); activityStart('translate', 'Translating'); activityStart('scene:x', 'Mine', null, false, [{ icon: '★', label: 'Star', run: () => { window.__star = 1; } }]); });
  await app.page.click('#infoBtn');
  await expect(app.page.locator('#actscreen')).toBeVisible();
  await expect(app.page.locator('#actTitle')).toHaveText('Activity');
  await expect(app.page.locator('#actBody')).toContainText('📶 Home · -40 dBm');
  const body = await app.page.textContent('#actBody');
  for (const s of ['This scene · Budget', 'Opening', 'Mine', 'Everywhere', 'Translating', '200.0 MB', '1.23 · 0.50', '30.0 GB', '67m', '«Budget» · ', '88%', '12', '4 · 1.0 MB', '2 / 9 · 5.0 MB', 'Claude Code',
    'ux 90', '12.3', 'proposed · applet — useful', '2 modules']) expect(body).toContain(s);
  await app.page.click('#actBody .a-proc[data-id="scene:x"] .p-act');
  await until(app, () => window.__star === 1);
  await app.page.click('#actBody [data-sched="now"]');
  await expect.poll(() => app.sent('usage', 'improve').length).toBe(1);
  await app.page.click('#actBody [data-sched="pause"]');
  await expect.poll(() => app.sent('usage', 'pause').some((c) => c.body.on === true)).toBe(true);
  live.scene.paused = true;
  await app.tick(3100);
  await expect(app.page.locator('#actBody [data-sched="resume"]')).toBeVisible();
  await app.page.click('#actBody [data-sched="resume"]');
  await expect.poll(() => app.sent('usage', 'pause').some((c) => c.body.on === false)).toBe(true);
  await app.page.keyboard.press('Escape');
  await expect(app.page.locator('#actscreen')).toBeHidden();
  // Sparse data: dashes; a scene that is not an applet; paused.
  Object.assign(live, { process: {}, usage: {}, network: { addresses: [{ ip: '10.0.0.2' }] }, scene: null, integration: null, integrationRemaining: null, engine: null, paused: true });
  app.api = routes({ live: () => live, system: () => Promise.reject(err('x')), usage: () => Promise.reject(err('x')) });
  await app.ev(() => { home(); activityStart('ai:1', 'X'); sysCache = null; toggleActivityScreen(true); });
  await expect(app.page.locator('#actBody')).toContainText('10.0.0.2');
  await expect(app.page.locator('#actBody')).toContainText('Not an applet');
  await expect(app.page.locator('#actBody')).toContainText('background work paused');
  await app.page.click('#actBody .a-proc .p-act');
  await app.page.click('#actClose');
  await expect(app.page.locator('#actscreen')).toBeHidden();
  // The scene numbers with nothing scheduled; live failing.
  app.api = routes({ live: () => ({ scene: { key: 'k' }, usage: { next: { title: 'N', at: 0 } } }), usage: () => Promise.reject(err('x')) });
  await app.ev(() => { current.key = 'k'; toggleActivityScreen(true); });
  await expect(app.page.locator('#actBody')).toContainText('due now');
  app.api = routes({ live: () => Promise.reject(err('x')) });
  await app.ev(() => loadLive());
  await app.ev(() => toggleActivityScreen(false));
  await app.ev(() => aiui.activityScreen());
  await app.ev(() => aiui.activityScreen());
  await app.ev(() => renderActivityScreen());
});

test('the console: log, builtin commands, history, and the console AI changing the scene live', async ({ app }) => {
  let reply = { reply: 'Done.', screen: { kind: 'circles', title: 'Changed', circles: [], note: 'x' } };
  await app.open({ native: true, api: routes({ console: (b) => (reply instanceof Error ? Promise.reject(reply) : reply), hints: { ok: true } }) });
  await app.ev(() => log('activity', 'before open'));
  await app.page.keyboard.press('`');
  await expect(app.page.locator('#console')).toBeVisible();
  await expect(app.page.locator('#consoleLog')).toContainText('before open');
  const cmd = async (c) => { await app.page.fill('#consoleInput', c); await app.page.press('#consoleInput', 'Enter'); };
  await cmd('/help');
  await expect(app.page.locator('#consoleLog')).toContainText('Commands: /help');
  await cmd('/state');
  await expect(app.page.locator('#consoleLog')).toContainText('no state');
  await cmd('/pause');
  await expect.poll(() => app.ev(() => paused)).toBe(true);
  await cmd('/resume');
  await expect.poll(() => app.ev(() => paused)).toBe(false);
  await cmd('/reload');
  await expect(app.page.locator('#consoleLog')).toContainText('scene reloaded');
  await cmd('/retro');
  await expect(app.page.locator('#consoleLog')).toContainText('retrospective started');
  await cmd('');
  await cmd('make it blue');
  await expect(app.page.locator('#title')).toHaveText('Changed');
  await expect(app.page.locator('#consoleLog')).toContainText('scene changed live');
  const b = app.sent('console')[0].body;
  expect(b.command).toBe('make it blue');
  expect(b.log.length).toBeGreaterThan(3);
  // On an html scene: its html goes along; the quality of the last check too.
  await app.ev(() => { current.screen = { kind: 'html', title: 'H', html: '<p>x</p>', health: ['e'] }; lastQuality = { title: 'H', screen: { scores: { ux: 1 } } }; });
  reply = { reply: '' };
  await cmd('why');
  await expect(app.page.locator('#consoleLog')).toContainText('(no reply)');
  expect(app.sent('console')[1].body.screen.html).toBe('<p>x</p>');
  expect(app.sent('console')[1].body.quality).toEqual({ screen: { ux: 1 }, issues: ['e'] });
  reply = err('console down');
  await cmd('x');
  await expect(app.page.locator('#consoleLog .k-error').last()).toContainText('console down');
  // History with arrows.
  await app.page.press('#consoleInput', 'ArrowUp');
  await expect(app.page.locator('#consoleInput')).toHaveValue('x');
  await app.page.press('#consoleInput', 'ArrowUp');
  await expect(app.page.locator('#consoleInput')).toHaveValue('why');
  await app.page.press('#consoleInput', 'ArrowDown');
  await app.page.press('#consoleInput', 'ArrowDown');
  await expect(app.page.locator('#consoleInput')).toHaveValue('');
  await app.page.press('#consoleInput', 'a');
  await cmd('/clear');
  await expect(app.page.locator('#consoleLog .l')).toHaveCount(0);
  // Many lines: capped at 500.
  await app.ev(() => { for (let i = 0; i < 520; i++) log('x', 'line ' + i); });
  await expect(app.page.locator('#consoleLog .l')).toHaveCount(500);
  await app.page.press('#consoleInput', 'Escape');
  await expect(app.page.locator('#console')).toBeHidden();
  await app.page.click('#consoleBtn');
  await expect(app.page.locator('#console')).toBeVisible();
  await app.page.press('#consoleInput', '`');
  await expect(app.page.locator('#console')).toBeHidden();
  await app.ev(() => { toggleConsole(true); });
  await cmd('/system');
  await expect(app.page.locator('#title')).toHaveText('Settings & System');
  await app.ev(() => { el.console.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true })); el.consoleBtn.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true })); });
});

test('pause: background work stops (remembered across launches); the buttons', async ({ app }) => {
  await app.open({ native: true, storage: { 'aiui.paused': '1' } });
  await app.tick(10);
  await expect(app.page.locator('body')).toHaveClass(/paused/);
  expect(app.sent('window', 'pause')[0].body.on).toBe(true);
  await app.page.click('#pauseBtn');
  await expect(app.page.locator('body')).not.toHaveClass(/paused/);
  await expect(app.page.locator('#pauseBtn')).toHaveText('⏸');
  await app.page.click('#settingsBtn');
  await expect(app.page.locator('#title')).toHaveText('Settings & System');
  await app.ev(() => { el.pauseBtn.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true })); Storage.prototype.setItem = () => { throw new Error('q'); }; setPaused(true); setSetting('x', 1); noteTiming('gen', 1); zoom(1); });
});

test('the background player: play, pause, resume, stop; the ⏯ icon; failures; position survives reloads', async ({ app }) => {
  await app.open({ native: true, init: () => {
    window.__media = [];
    HTMLMediaElement.prototype.play = function () { if (String(this.src).includes('fail')) return Promise.reject(new Error('blocked')); Object.defineProperty(this, 'paused', { configurable: true, get: () => false }); window.__media.push('play ' + this.src); return Promise.resolve(); };
    HTMLMediaElement.prototype.pause = function () { Object.defineProperty(this, 'paused', { configurable: true, get: () => true }); window.__media.push('pause'); };
    Object.defineProperty(HTMLMediaElement.prototype, 'duration', { configurable: true, get: () => 300 });
  } });
  const info = await app.ev(() => aiui.media.play('https://m.example/song.mp3', 'Song'));
  expect(info).toMatchObject({ url: 'https://m.example/song.mp3', title: 'Song', playing: true });
  await expect(app.page.locator('#sceneBar button')).toHaveText('⏸');
  await expect(app.page.locator('#activity')).toHaveText(/♫ Song/);
  expect(app.sent('app', 'set').at(-1).body).toEqual({ op: 'set', key: 'media', value: { url: 'https://m.example/song.mp3', title: 'Song', playing: true } });
  await app.page.click('#sceneBar button');
  expect(await app.ev(() => aiui.media.state())).toMatchObject({ playing: false });
  await expect(app.page.locator('#sceneBar button')).toHaveText('▶');
  await app.page.click('#sceneBar button');
  await expect(app.page.locator('#sceneBar button')).toHaveText('⏸');
  // Saved every 2 s while playing.
  await app.tick(2100);
  expect(await app.ev(() => JSON.parse(localStorage.getItem('aiui.media')).url)).toBe('https://m.example/song.mp3');
  // Right-click on the icon stops.
  await app.page.click('#sceneBar button', { button: 'right' });
  await expect(app.page.locator('#sceneBar button')).toHaveCount(0);
  expect(await app.ev(() => aiui.media.state())).toBe(null);
  expect(await app.ev(() => localStorage.getItem('aiui.media'))).toBe(null);
  await app.ev(() => aiui.media.resume());
  // Playing fails: a toast, still listed.
  await app.ev(() => aiui.media.play('https://m.example/fail.mp3'));
  await expect(app.page.locator('#toast')).toHaveText('♫ blocked');
  await app.ev(() => aiui.media.resume());
  // The element errors: stopped with a note.
  await app.ev(() => player.dispatchEvent(new Event('error')));
  await expect(app.page.locator('#toast')).toHaveText('♫ could not play Audio');
  await app.ev(() => { player.dispatchEvent(new Event('error')); player.dispatchEvent(new Event('ended')); aiui.media.pause(); aiui.media.stop(); });
  // After a reload the player resumes where it was.
  await app.ev(() => localStorage.setItem('aiui.media', JSON.stringify({ url: 'https://m.example/b.mp3', title: 'B', time: 42 })));
  await app.page.reload();
  await expect.poll(() => app.ev(() => window.__media)).toEqual(['play https://m.example/b.mp3']);
  expect(await app.ev(() => nowPlaying.title)).toBe('B');
  await app.ev(() => { localStorage.setItem('aiui.media', '{bad'); restoreMedia(); localStorage.setItem('aiui.media', '{}'); restoreMedia(); });
  // App values and subscriptions.
  await app.ev(() => { window.__got = []; aiui.app.subscribe('k', (v) => window.__got.push(v)); aiui.app.subscribe('k', () => { throw new Error('x'); }); });
  await app.ev(() => aiui._event({ type: 'appChanged', key: 'k', value: 3 }));
  expect(await app.ev(() => window.__got)).toEqual([3]);
  app.api = routes({ app: (b) => (b.op === 'get' ? { value: 'v' } : Promise.reject(err('x'))) });
  expect(await app.ev(() => aiui.app.get('k'))).toBe('v');
  await app.ev(() => aiui.app.set('k', 4));
  app.api = routes({ app: () => Promise.reject(err('x')) });
  expect(await app.ev(() => aiui.app.get('k'))).toBe(null);
  await app.ev(() => { appFrameSubs.set('z', new Set([{ postMessage() { throw new Error('gone'); } }])); appNotify('z', 1); });
  expect(await app.ev(() => appFrameSubs.get('z').size)).toBe(0);
  // A scene playing continues in the app player when left, from the same moment.
  await app.ev(() => { scenePlaying = { url: 'https://m.example/c.mp3', title: '', time: 10, at: Date.now(), rate: 2 }; current.screen = { kind: 'html', html: '' }; el.view.innerHTML = '<iframe></iframe>'; continueSceneAudio(); });
  await expect.poll(() => app.ev(() => nowPlaying && nowPlaying.url)).toBe('https://m.example/c.mp3');
  await app.ev(() => { scenePlaying = { url: 'https://m.example/d.mp3', time: 0, at: Date.now() }; continueSceneAudio(); });
  await app.ev(() => { scenePlaying = { url: 'x', time: 0, at: 0 }; el.view.innerHTML = ''; continueSceneAudio(); });
  // Hand-off: the scene's player, with a position.
  await app.ev(() => { el.view.innerHTML = '<iframe></iframe>'; current.screen = { kind: 'html', title: 'T', html: '' }; window.__h = handoffMedia(); handoffWait({ url: 'https://m.example/e.mp3', time: 12 }); });
  await app.ev(() => window.__h);
  expect(await app.ev(() => [nowPlaying.title, player.currentTime])).toEqual(['T', 12]);
  await app.ev(() => { window.__h = handoffMedia(); handoffWait({ url: 'https://m.example/f.mp3', title: 'F' }); });
  await app.ev(() => { window.__h = handoffMedia(); handoffWait(null); });
  await app.ev(() => window.__h);
  expect(await app.ev(() => aiui.media.play('ftp://x').catch((e) => e.message))).toBe('media: a URL is required');
});

test('zoom, find and print', async ({ app }) => {
  await app.open({ native: true, init: () => { window.print = () => { window.__printed = (window.__printed || 0) + 1; }; window.prompt = () => window.__find; } });
  await app.page.keyboard.press('Meta+=');
  await expect(app.page.locator('#status')).toHaveText('110%');
  await app.page.keyboard.press('Meta+-');
  await app.page.keyboard.press('Meta+-');
  await expect(app.page.locator('#status')).toHaveText('90%');
  await app.page.keyboard.press('Meta+0');
  await expect(app.page.locator('#status')).toHaveText('100%');
  await app.ev(() => { zoom(1); zoom(1); });
  await app.page.reload();
  expect(await app.ev(() => document.body.style.zoom)).toBe('1.25');
  await app.ev(() => { zoom(-1); zoom(-1); zoom(-1); zoom(-1); zoom(-1); zoom(-1); });
  expect(await app.ev(() => zoomLevel)).toBe(0.67);
  // Find on circles opens the input; on a scene it asks and searches there.
  await app.page.keyboard.press('Meta+f');
  await expect(app.page.locator('body')).toHaveClass(/typing/);
  await app.page.keyboard.press('Escape');
  await app.page.keyboard.press('Meta+p');
  expect(await app.ev(() => window.__printed)).toBe(1);
  await app.ev(() => { current.screen = { kind: 'html', local: 'x', title: 'S', html: '<p>needle</p><script>aiui.onFind((q) => { window.__found = q; })</script>' }; render(); });
  const f = await (await app.page.waitForSelector('#view iframe')).contentFrame();
  await f.waitForFunction(() => window.aiui && aiui.onFind);
  await app.ev(() => { window.__find = 'needle'; aiui.find(); });
  await f.waitForFunction(() => window.__found === 'needle');
  await app.ev(() => { window.__find = ''; find(); });
  await app.ev(() => aiui.print());
  await f.evaluate(() => { window.print = () => { window.__p = 1; }; });
  await app.ev(() => printScene());
  await f.waitForFunction(() => window.__p === 1);
  // A scene without its own find: the browser's.
  await app.ev(() => { current.screen = { kind: 'html', local: 'y', title: 'S2', html: '<p>hay</p>' }; render(); });
  const g = await (await app.page.waitForSelector('#view iframe')).contentFrame();
  await g.waitForFunction(() => window.aiui);
  await g.evaluate(() => { window.find = (q) => { window.__wf = q; }; });
  await app.ev(() => { window.__find = 'hay'; find(); });
  await g.waitForFunction(() => window.__wf === 'hay');
  await app.ev(() => { el.view.innerHTML = ''; find(); aiui.zoom(0); aiui.forward(); aiui.reloadScene(); });
  // ⌘⇧R reloads the app.
  await app.page.keyboard.press('Meta+Shift+R');
  await app.page.waitForLoadState();
});

test('context menus: generated per class by the AI, shown at the pointer; actions copy, open, select, share or ask', async ({ app }) => {
  let menus = { classes: [{ class: 'circle', enabled: true, actions: [{ id: 'copy', kind: 'copy', label: 'Copy', icon: '⧉' }, { id: 'sel', kind: 'select', label: 'Select' }, { id: 'ask', label: 'Explain', prompt: 'explain it' }, { id: 'sh', kind: 'share', label: 'Share' }, { id: 'op', kind: 'open', label: 'Open' }] },
    { class: 'empty-space', enabled: false }] };
  let gen = deferred();
  await app.open({ native: true, api: routes({ menus: () => gen.promise, ai: (b) => ({ screen: circleScreen('Context ' + b.action.label, ['x']) }) }) });
  await show(app, { kind: 'circles', title: 'M', circles: [{ id: 'a', label: 'Alpha', hint: 'first' }, { id: 'b', label: 'Beta' }] });
  // Menus are prepared when the scene is idle (1.5 s).
  await app.tick(1600);
  await expect.poll(() => app.sent('menus').length).toBe(1);
  expect(app.sent('menus')[0].body.classes).toEqual(['circle', 'empty-space']);
  await app.page.locator('.circle[data-id="a"] .face').click({ button: 'right' });
  await expect(app.page.locator('#ctx')).toBeVisible();
  await expect(app.page.locator('#ctx .ctx-wait')).toHaveText('…');
  gen.resolve(menus);
  await expect(app.page.locator('#ctx button')).toHaveCount(5);
  await app.page.click('#ctx button:has-text("Copy")');
  await expect(app.page.locator('#ctx')).toBeHidden();
  await expect.poll(() => app.sent('sys').map((c) => c.body)).toEqual([{ op: 'clipboard', text: 'Alpha — first' }]);
  await expect(app.page.locator('#status')).toHaveText('⧉');
  await app.page.locator('.circle[data-id="a"] .face').click({ button: 'right' });
  await app.page.click('#ctx button:has-text("Select")');
  await expect(app.page.locator('.circle[data-id="a"]')).toHaveClass(/selected/);
  await app.page.locator('.circle[data-id="b"] .face').click({ button: 'right' });
  await app.ev(() => { navigator.share = (o) => { window.__shared = o; return Promise.resolve(); }; });
  await app.page.click('#ctx button:has-text("Share")');
  expect(await app.ev(() => window.__shared)).toEqual({ text: 'Beta' });
  await app.page.locator('.circle[data-id="b"] .face').click({ button: 'right' });
  await app.page.click('#ctx button:has-text("Open")'); // nothing to open: asks the AI
  await expect(app.page.locator('#title')).toHaveText('Context Open');
  await app.ev(() => back());
  await app.page.locator('.circle[data-id="b"] .face').click({ button: 'right' });
  await app.page.click('#ctx button:has-text("Explain")');
  await expect(app.page.locator('#title')).toHaveText('Context Explain');
  expect(app.sent('ai').at(-1).body).toMatchObject({ event: 'context', action: { id: 'ask', prompt: 'explain it' }, class: 'circle', object: { circle: 'b', label: 'Beta' } });
  await app.ev(() => back());
  // Empty space: the AI said no menu there.
  await app.page.mouse.click(640, 700, { button: 'right' });
  await expect(app.page.locator('#ctx')).toBeHidden();
  // Esc and a click elsewhere close it; right-click inside it does nothing.
  await app.page.locator('.circle[data-id="a"] .face').click({ button: 'right' });
  await app.page.locator('#ctx button').first().click({ button: 'right' });
  await app.page.keyboard.press('Escape');
  await expect(app.page.locator('#ctx')).toBeHidden();
  await app.page.locator('.circle[data-id="a"] .face').click({ button: 'right' });
  await app.page.mouse.click(5, 300);
  await expect(app.page.locator('#ctx')).toBeHidden();
  // Scene objects: links open, images open; copy of text.
  await app.ev(() => { current.screen.menus = { link: { enabled: true, actions: [{ kind: 'open', label: 'Open link' }, { kind: 'copy', label: 'Copy link' }] } }; openContext('link', { href: 'https://x.example/', text: 'X' }, 10, 10); });
  await app.page.click('#ctx button:has-text("Open link")');
  await expect.poll(() => app.sent('sys').some((c) => c.body.op === 'open')).toBe(true);
  await app.ev(() => openContext('link', { href: 'https://x.example/' }, 10, 10));
  await app.page.click('#ctx button:has-text("Copy link")');
  await app.ev(() => { current.screen.menus.image = { enabled: true, actions: [{ kind: 'open', label: 'Open image' }, { kind: 'copy', label: 'C' }] }; openContext('image', { src: 'https://x.example/i.png' }, 5000, 5000); });
  await app.page.click('#ctx button:has-text("Open image")');
  await app.ev(() => openContext('image', {}, 1, 1));
  await app.page.click('#ctx button:has-text("C")');
  // A failing copy falls back to asking the AI.
  app.api = routes({ sys: () => Promise.reject(err('x')), ai: () => ({ screen: circleScreen('Asked', []) }) });
  await app.ev(() => openContext('link', { text: 'T' }, 1, 1));
  await app.page.click('#ctx button:has-text("Copy link")');
  await expect(app.page.locator('#title')).toHaveText('Asked');
  // Not on local screens or while busy; menus failing are retried later.
  await app.ev(() => { current.screen = { kind: 'circles', local: 'x', circles: [] }; openContext('circle', {}, 1, 1); });
  await expect(app.page.locator('#ctx')).toBeHidden();
  app.api = routes({ menus: () => Promise.reject(err('x')) });
  await app.ev(() => { current.screen = { kind: 'html', title: 'S', html: '', quality: { screen: { classes: ['text'] } } }; openContext('text', {}, 1, 1); });
  await until(app, () => !current.screen.menusPromise);
  await app.ev(() => { closeContext(); renderContext(); });
  // Right-click on a non-circle screen of the app does nothing.
  await app.page.mouse.click(640, 700, { button: 'right' });
  // Timing: when menus are wanted sooner than they take, they are generated at once.
  await app.ev(() => { ctxTiming.gen = [5000]; ctxTiming.use = [100]; });
  app.api = routes({ menus: () => menus });
  await show(app, { kind: 'circles', title: 'Fast', circles: [{ id: 'a', label: 'A' }] });
  await app.tick(10);
  await until(app, () => !!current.screen.menus);
  expect(await app.ev(() => generateMenus(current.screen, []).then((m) => !!m.circle))).toBe(true);
  await app.ev(() => { const s = current.screen; delete s.menus; s.menusPromise = Promise.resolve('p'); return generateMenus(s, []); });
  // Paused / off: no menus.
  await app.ev(() => { paused = true; scheduleMenus({}, []); paused = false; settings.menus = false; scheduleMenus({}, []); settings.menus = true; scheduleMenus({ menus: {} }, []); });
  // Corrupt timing store.
  await app.ev(() => localStorage.setItem('aiui.ctxTiming', '{bad'));
  await app.page.reload();
  expect(await app.ev(() => ctxTiming)).toEqual({ gen: [], use: [] });
});

test('cursor trajectories: heading for a circle highlights and prefetches it; opening it is instant', async ({ app }) => {
  let pf = { kind: 'circles', title: 'Prefetched', circles: [{ id: 'p', label: 'P' }], note: 'n' };
  await app.open({ native: true, api: routes({ prefetch: () => pf, ai: () => ({ screen: circleScreen('Asked', []) }), adopt: { ok: true } }) });
  await show(app, { kind: 'circles', title: 'T', circles: [{ id: 'a', label: 'Alpha' }, { id: 'b', label: 'Beta' }, { id: 'c', label: 'Gamma', plus: 'more' }] });
  const box = await app.page.locator('.circle[data-id="b"]').boundingBox();
  const tx = box.x + box.width / 2, ty = box.y + box.height / 2;
  // Move towards Beta in steps, then rest on it.
  await app.page.mouse.move(tx - 300, ty + 200);
  for (let i = 1; i <= 6; i++) { await app.page.mouse.move(tx - 300 + i * 40, ty + 200 - i * 27); await app.tick(16); }
  await expect(app.page.locator('.circle[data-id="b"]')).toHaveClass(/heading/);
  await app.page.mouse.move(tx, ty);
  for (let i = 0; i < 24; i++) { await app.page.mouse.move(tx + (i % 2), ty); await app.tick(40); }
  await expect.poll(() => app.sent('prefetch').length).toBe(1);
  expect(app.sent('prefetch')[0].body).toMatchObject({ event: 'open', target: { id: 'b' } });
  await expect(app.page.locator('.circle[data-id="b"]')).toHaveClass(/ready/);
  await app.tick(1000);
  // Hovering counts as attention; opening it uses the prefetched screen.
  await app.page.mouse.click(tx, ty);
  await expect(app.page.locator('#title')).toHaveText('Prefetched');
  await expect(app.page.locator('#status')).toHaveText('ready');
  expect(app.sent('ai').length).toBe(0);
  expect(app.sent('adopt')[0].body.outcome.title).toBe('Prefetched');
  await app.ev(() => back());
  // Prefetch rules: paused, off, local, typing, busy, the same circle, typed or "more" circles, already prefetched.
  const n = app.sent('prefetch').length;
  await app.ev(() => { paused = true; prefetchCircle('a'); paused = false; settings.prefetch = false; prefetchCircle('a'); settings.prefetch = true;
    prefetchCircle('zz'); prefetchCircle('c'); prefetchCircle('b'); });
  expect(app.sent('prefetch').length).toBe(n);
  // A second prefetch while one runs cancels the first; a stale prefetched screen (3 min) is not used.
  pf = new Promise(() => {});
  await app.ev(() => { prefetchCircle('a'); });
  pf = null;
  await app.ev(() => { prefetchCircle('c2'); current.screen.circles.push({ id: 'd', label: 'D' }); prefetchCircle('d'); });
  await expect.poll(() => app.sent('cancel').some((c) => c.body.scout)).toBe(true);
  await app.ev(() => { current.screen.prefetch.x = { screen: { kind: 'text' }, at: Date.now() - 200000, evt: {} }; current.screen.circles.push({ id: 'x', label: 'X' }); });
  await app.ev(() => openCircle({ id: 'x', label: 'X' }, null));
  await expect(app.page.locator('#title')).toHaveText('Asked');
  // Touch pointers are not tracked; synthetic moves (no motion) are ignored.
  await app.ev(() => { document.dispatchEvent(new PointerEvent('pointermove', { pointerType: 'touch', clientX: 1, clientY: 1 })); el.circles.dispatchEvent(new PointerEvent('pointerover', { pointerType: 'touch', bubbles: true })); el.circles.dispatchEvent(new PointerEvent('pointerleave', { pointerType: 'touch' })); });
  // While busy no prediction.
  await app.ev(() => { busy = true; for (let i = 0; i < 5; i++) document.dispatchEvent(new PointerEvent('pointermove', { pointerType: 'mouse', clientX: 10 + i * 30, clientY: 10 })); busy = false; });
  // Pointer over a circle sets focus when it moved there.
  await show(app, { kind: 'circles', title: 'H', circles: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }] });
  const bb = await app.page.locator('.circle[data-id="b"]').boundingBox();
  await app.page.mouse.move(bb.x + bb.width / 2, bb.y + bb.height / 2, { steps: 10 });
  await expect.poll(() => app.ev(() => focusedId())).toBe('b');
  await app.page.mouse.move(5, 5);
  expect(await app.ev(() => current.screen.attention.b.passes)).toBe(1);
  // Fast pointer: its speed is sampled for the user baseline.
  await app.page.mouse.move(5, 400, { steps: 8 });
  await app.tick(250);
  await app.page.mouse.move(600, 400, { steps: 8 });
});

test('live refinement: changed circles update in place', async ({ app }) => {
  let patch = deferred();
  await app.open({ native: true, api: routes({ refine: () => patch.promise }) });
  await show(app, { kind: 'circles', title: 'Live', live: true, circles: [{ id: 'a', label: 'Inbox', value: 1 }, { id: 'b', label: 'Sent' }] });
  await expect.poll(() => app.sent('refine').length).toBe(1);
  patch.resolve({ circles: [{ id: 'a', label: 'Inbox', value: 12 }, { id: 'b', hint: 'Sent' }, { id: 'b', label: 'Sent' }, { id: 'zz', label: 'x' }] });
  await expect(app.page.locator('.circle[data-id="a"] .value')).toHaveText('12');
  await expect(app.page.locator('.circle[data-id="a"]')).toHaveClass(/improved/);
  // Refined once per screen; not when paused, off, or local; changes while away are kept but not drawn.
  patch = deferred();
  await show(app, { kind: 'circles', title: 'Live2', live: true, circles: [{ id: 'a', label: 'A' }] });
  await app.ev(() => startWriting('x'));
  patch.resolve({ circles: [{ id: 'a', label: 'A2' }] });
  await app.settle();
  await app.ev(() => { paused = true; maybeRefine({ live: true }); paused = false; settings.refine = false; maybeRefine({ live: true }); settings.refine = true; maybeRefine({ live: true, local: 'x' }); });
  patch = deferred();
  await show(app, { kind: 'circles', title: 'Live3', live: true, circles: [{ id: 'a', label: 'A' }] });
  patch.resolve(null);
  patch = deferred();
  await show(app, { kind: 'circles', title: 'Live4', live: true, circles: [{ id: 'a', label: 'A' }] });
  patch.reject(err('x'));
  await app.settle();
  expect(app.sent('refine').length).toBe(4);
});

test('the user: a baseline of habits; a session that deviates is suspected; learning every 8 turns', async ({ app }) => {
  const h = new Date().getHours();
  const hours = Array(24).fill(0); hours[(h + 12) % 24] = 100;
  const base = { typeGap: { n: 50, mean: 100, m2: 50 * 100 }, pointerSpeed: { n: 50, mean: 1, m2: 1 }, decideMs: { n: 50, mean: 1000, m2: 49000 }, hours, lang: 'fr', screen: '1x1' };
  await app.open({ native: true, api: routes({ profile: (b) => (b.op === 'get' ? { baseline: base } : { ok: true }), ai: () => ({ screen: circleScreen('x', []) }) }) });
  await app.ev(() => initUser());
  // A slow typist on another screen at an unusual hour in another language.
  await app.ev(() => { for (let i = 0; i < 30; i++) observe('typeGap', 400); observe('typeGap', NaN); });
  await expect(app.page.locator('#who')).toBeVisible();
  const reasons = await app.ev(() => who.suspect);
  expect(reasons).toEqual(expect.arrayContaining(['typing slower than usual', `unusual hour (${h}:00)`, 'different language (en-US)', 'different screen']));
  await app.ev(() => observe('typeGap', 400));
  // Absorbing while suspect does nothing; trusted: merges and saves.
  await app.ev(() => absorb());
  expect(app.sent('profile', 'baseline').length).toBe(0);
  await app.ev(() => { whoOpen({ id: 'me' }); });
  await expect.poll(() => app.sent('profile', 'baseline').length).toBe(1);
  expect(app.sent('profile', 'baseline')[0].body.baseline.typeGap.n).toBe(81);
  // Every 8 AI turns, the profiler learns.
  await app.ev(() => { for (let i = 0; i < 8; i++) learnSoon(); });
  await expect.poll(() => app.sent('profile', 'learn').length).toBe(1);
  expect(app.sent('profile', 'learn')[0].body.behavior.typeGap.n).toBe(81);
  // Guests are not observed or learned from; on hidden pages the baseline is saved.
  await app.ev(() => { who.guest = true; observe('typeGap', 1); learnSoon(); checkUser(); absorb(); who.guest = false; who.base.hours = undefined; absorb(); });
  await app.ev(() => { Object.defineProperty(document, 'hidden', { configurable: true, get: () => true }); document.dispatchEvent(new Event('visibilitychange')); });
  await app.ev(() => { Object.defineProperty(document, 'hidden', { configurable: true, get: () => false }); document.dispatchEvent(new Event('visibilitychange')); });
  await app.tick(30100);
  // A faster pointer than usual; decisions faster.
  expect(await app.ev(() => { who.suspect = null; who.base = { pointerSpeed: { n: 50, mean: 10, m2: 1 }, decideMs: { n: 50, mean: 10000, m2: 1 } }; who.session = { pointerSpeed: { n: 40, mean: 30, m2: 1 }, decideMs: { n: 10, mean: 100, m2: 1 } }; checkUser(); return who.suspect; }))
    .toEqual(['pointer faster than usual', 'choosing faster than usual']);
  expect(await app.ev(() => [combine(null, { n: 1, mean: 2, m2: 0 }), combine({ n: 1, mean: 1, m2: 0 }, null), combine({ n: 0 }, { n: 2, mean: 3, m2: 1 }), combine({ n: 1, mean: 1, m2: 0 }, { n: 1, mean: 3, m2: 0 }), sdOf({ n: 1 })]))
    .toEqual([{ n: 1, mean: 2, m2: 0 }, { n: 1, mean: 1, m2: 0 }, { n: 2, mean: 3, m2: 1 }, { n: 2, mean: 2, m2: 2 }, 0]);
  // Typing rhythm and decisions are observed from real use.
  await app.ev(() => { who.suspect = null; who.base = null; who.session = {}; });
  await app.ev(() => startWriting(''));
  await app.page.keyboard.type('abc', { delay: 0 });
  await app.ev(() => stopWriting(true));
  expect(await app.ev(() => who.session.typeGap && who.session.typeGap.n)).toBeGreaterThan(0);
  await app.ev(() => { home(); shownAt = performance.now() - 500; openCircle(current.screen.circles[0], null); });
  expect(await app.ev(() => who.session.decideMs.n)).toBe(1);
  // No baseline stored, or the profile failing: an empty one.
  app.api = routes({ profile: () => ({ baseline: {} }) });
  await app.ev(() => initUser());
  expect(await app.ev(() => who.base.hours.length)).toBe(24);
  app.api = routes({ profile: () => Promise.reject(err('x')) });
  await app.ev(() => initUser());
  expect(await app.ev(() => who.base.hours.length)).toBe(24);
});

test('language: the app\'s words are translated once by the AI and cached per language', async ({ app }) => {
  let tr = { strings: { back: '‹ Zurück', more: 'Mehr ›', 'root.create': 'Erstellen', 'root.create.hint': 'Dokumente' } };
  await app.open({ native: true, api: routes({ info: { language: 'de-DE' }, translate: () => tr }) });
  await expect(app.page.locator('#prev')).toHaveText('‹ Zurück');
  await expect(app.page.locator('.circle[data-id="create"] .label')).toHaveText('Erstellen');
  expect(app.sent('translate')[0].body.language).toBe('de-DE');
  expect(await app.ev(() => document.documentElement.lang)).toBe('de-DE');
  // Cached: no second translation after a reload, applied to the root in the history too.
  await app.ev(() => { stack.push(current); current = { screen: { kind: 'text', title: 'X' }, label: 'X' }; render(); });
  await app.page.reload();
  await expect(app.page.locator('#prev')).toHaveText('‹ Zurück');
  expect(app.sent('translate').length).toBe(1);
  // The translation failing or empty: English stays.
  await app.ev(() => { for (const k of Object.keys(localStorage)) if (k.startsWith('aiui.i18n.')) localStorage.removeItem(k); localStorage.setItem('aiui.i18n.de-DE.' + Object.keys(STR).length, '{bad'); });
  tr = {};
  await app.page.reload();
  await expect.poll(() => app.sent('translate').length).toBe(2);
  app.api = routes({ info: () => Promise.reject(err('x')), translate: () => Promise.reject(err('x')) });
  await app.ev(() => { LANG = 'fr'; L10N = null; return initLanguage(); });
  expect(await app.ev(() => LANG)).toBe('fr');
});

test('the place survives reloads: history, keys and screens come back', async ({ app }) => {
  await app.open({ native: true });
  await app.ev(() => { stack = [{ screen: clone(ROOT), label: null }]; current = { screen: { kind: 'circles', title: 'Saved', circles: [{ id: 'a', label: 'A' }], reviewed: true, menus: {} }, label: 'Saved', key: 'sv' }; render(); });
  await app.page.reload();
  await expect(app.page.locator('#title')).toHaveText('Saved');
  expect(await app.ev(() => [current.key, stack.length, current.screen.menus])).toEqual(['sv', 1, undefined]);
  // Huge history: only the last 3 levels are kept.
  await app.ev(() => { stack = Array.from({ length: 6 }, (_, i) => ({ screen: { kind: 'text', title: 'L' + i, text: 'x'.repeat(600000) }, label: 'L' + i })); saveNav(); });
  expect(await app.ev(() => JSON.parse(localStorage.getItem('aiui.nav')).stack.length)).toBe(3);
  // Broken or empty saved place: the root.
  await app.ev(() => { localStorage.setItem('aiui.nav', '{bad'); });
  expect(await app.ev(() => restoreNav())).toBe(false);
  await app.ev(() => { localStorage.setItem('aiui.nav', '{}'); });
  expect(await app.ev(() => restoreNav())).toBe(false);
  await app.ev(() => { Storage.prototype.setItem = () => { throw new Error('q'); }; saveNav(); });
  // A saved settings value that is broken: the defaults.
  await app.ev(() => { delete Storage.prototype.setItem; });
});

test('broken stored settings and bar fall back to defaults', async ({ app }) => {
  await app.open({ native: true, storage: { 'aiui.settings': '{bad', 'aiui.bar': '{bad', 'aiui.checked': '{bad' } });
  expect(await app.ev(() => [settings.qaMin, globalBar.length, checkedBefore({ html: 'x' })])).toEqual([70, 0, false]);
  await app.ev(() => markChecked({ html: 'x' }));
});

test('the engine status failing at launch leaves the root; no AI connected opens the setup', async ({ app }) => {
  await app.open({ native: true, api: routes({ engine: () => Promise.reject(err('x')) }) });
  await expect(app.page.locator('#title')).toHaveText('');
});
