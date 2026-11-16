// window.aiui: the API scenes and the native side use (Mac app: the scene shares it directly).
import { test, expect } from '../harness.mjs';
import { routes, until, err } from './util.mjs';

test('aiui: navigation, app screens, state, memory, settings, the screen on display', async ({ app }) => {
  await app.open({ native: true, api: routes({
    cache: (b) => (b.op === 'search' ? { results: [{ key: 'k' }] } : b.op === 'stats' ? { entries: 2 } : { label: null }),
    utilities: { categories: [], utilities: [], total: 0 },
    engine: { options: [], active: { id: 'x', label: 'X' } },
  }) });
  expect(await app.ev(() => aiui.screen.circles.length)).toBe(14);
  expect(await app.ev(() => aiui.memory.search('q'))).toEqual([{ key: 'k' }]);
  expect(await app.ev(() => aiui.memory.stats())).toEqual({ entries: 2 });
  expect(await app.ev(() => aiui.call('cache', { op: 'stats' }))).toEqual({ entries: 2 });
  await app.ev(() => aiui.state.save({ a: 1 }));
  expect(await app.ev(() => aiui.state.load())).toEqual({ a: 1 });
  // Too big to keep: not saved; broken state reads as none.
  await app.ev(() => aiui.state.save({ big: 'x'.repeat(200001) }));
  expect(await app.ev(() => aiui.state.load())).toEqual({ a: 1 });
  await app.ev(() => { saveSceneState({ toJSON() { throw new Error('x'); } }); localStorage.setItem(stateKey(), '{bad'); });
  expect(await app.ev(() => aiui.state.load())).toBe(null);
  expect(await app.ev(() => aiui.settings())).toMatchObject({ prefetch: true, paused: false });
  await app.ev(() => aiui.setting('qaMin', 50));
  expect(await app.ev(() => QA_MIN)).toBe(50);
  await app.ev(() => aiui.action('zoom', '-1'));
  expect(await app.ev(() => zoomLevel)).toBe(0.9);
  await app.ev(() => aiui.setup());
  await expect(app.page.locator('#title')).toHaveText('AI');
  await app.ev(() => aiui.library());
  await expect(app.page.locator('#title')).toHaveText('Utility library');
  await app.ev(() => aiui.switchPath(0));
  await expect(app.page.locator('#title')).toHaveText('AI');
  await app.ev(() => aiui.closePath(0));
  await app.ev(() => aiui.goTo(0));
  await expect(app.page.locator('#title')).toHaveText('');
  await app.ev(() => aiui.home());
  await app.ev(() => aiui.back());
  // Scene activities with actions; titles cleared end them.
  await app.ev(() => aiui.activity('job', 'Working', [{ icon: '★', label: 'Do', run: () => { window.__ran = 1; } }, { icon: 'x', label: 'Not a function' }]));
  expect(await app.ev(() => activities.get('scene:job').actions.length)).toBe(1);
  await app.ev(() => aiui.activity('job2', 'W2'));
  await app.ev(() => aiui.activity('job'));
  expect(await app.ev(() => activities.has('scene:job'))).toBe(false);
  // A scene activity ends when its scene leaves the history.
  await app.ev(() => { stack.push(current); current = { screen: { kind: 'circles', title: 'S', circles: [] }, label: 'S' }; render(); sceneActivity('mine', 'Mine', []); });
  await app.ev(() => back());
  expect(await app.ev(() => activities.has('scene:mine'))).toBe(false);
  // The state key falls back to the title, then "scene".
  expect(await app.ev(() => { const c = current; current = { screen: { title: 'T' } }; const a = stateKey(); current = { screen: null }; const b = stateKey(); current = c; return [a, b]; })).toEqual(['aiui.state.T', 'aiui.state.scene']);
});

test('usage: opened, dwell, interactions; local screens and keyless ones are not recorded', async ({ app }) => {
  await app.open({ native: true });
  await app.ev(() => { usageNote(null, {}); usageNote({ screen: {} }, {}); usageNote({ key: 'k', screen: { local: 'x' } }, {}); usageOpened(null); usageOpened({ key: 'k', screen: { kind: 'circles' } }); usageLeft({}); });
  expect(app.sent('usage').length).toBe(0);
  await app.ev(() => { const e = { key: 'k', label: 'L', screen: { kind: 'html', html: '' } }; usageOpened(e); usageLeft(e); });
  await expect.poll(() => app.sent('usage').length).toBe(2);
  expect(app.sent('usage')[0].body).toMatchObject({ key: 'k', title: 'L', opened: true });
  // The screenshot timer finds the user gone.
  await app.tick(4100);
  // Component feedback only with uses and issues.
  await app.ev(() => { componentFeedback({}, {}); componentFeedback({ uses: ['a'] }, null); componentFeedback({ uses: ['a'] }, { issues: [] }); componentFeedback({ uses: ['a'] }, { issues: ['x'] }); });
  await expect.poll(() => app.sent('utilities', 'feedback').length).toBe(1);
  expect(app.sent('utilities', 'feedback')[0].body.scores).toEqual({});
  // Failures are recorded in batches.
  await app.ev(() => { reportFailure('https://a/', 'x'); reportFailure('https://b/', 'y'); });
  await app.tick(900);
  await expect.poll(() => app.sent('avoid', 'record').length).toBe(1);
  expect(app.sent('avoid', 'record')[0].body.items.length).toBe(2);
  app.api = routes({ avoid: () => Promise.reject(err('x')), journal: () => Promise.reject(err('x')) });
  await app.ev(() => { reportFailure('https://c/', 'z'); journal('k', null, null); });
  await app.tick(900);
  await app.ev(() => { failQueue = []; reportFailure('https://d/', 'z'); failQueue.length = 0; });
  await app.tick(900);
});

test('activity titles: every kind of call says what it is; trivial calls stay silent', async ({ app }) => {
  await app.open({ native: true });
  const titles = await app.ev(() => [
    activityTitle('ai', { event: 'open', target: { label: 'X' } }), activityTitle('ai', { event: 'open' }), activityTitle('ai', { event: 'text', text: 'hello' }), activityTitle('ai', { event: 'text' }),
    activityTitle('ai', { event: 'fix' }), activityTitle('ai', { event: 'context', action: { label: 'Explain' } }), activityTitle('ai', { event: 'context' }), activityTitle('ai', { event: 'go' }),
    activityTitle('quick'), activityTitle('more'), activityTitle('suggest', { input: 'ab' }), activityTitle('suggest', {}), activityTitle('prefetch', { target: { label: 'P' } }),
    activityTitle('refine'), activityTitle('revise', { shown: { title: 'S' } }), activityTitle('revise', { target: { label: 'T' } }), activityTitle('tests'), activityTitle('menus'),
    activityTitle('translate'), activityTitle('profile', { op: 'learn' }), activityTitle('profile', { op: 'get' }), activityTitle('libraries', { op: 'ensure' }), activityTitle('libraries', {}), activityTitle('cache'),
  ]);
  expect(titles).toEqual(['opening «X»', 'opening «»', 'asking «hello»', 'asking «»', 'repairing the screen', 'Explain', '', 'thinking: go', 'quick preview', 'loading more circles',
    'suggestions for «ab»', 'suggestions for «»', 'preparing «P»', 'refreshing live data', 'updating from memory «S»', 'updating from memory «T»', 'writing the Definition of Done and its tests',
    'preparing context menus', 'translating the interface', 'learning about you', null, 'loading JS libraries', null, null]);
  // Stale background requests are cancelled when their screen is left.
  await app.ev(() => { running.suggest = { screen: current.screen, seq: 1 }; running.quick = { screen: current.screen, seq: 2 }; running.pager = { screen: {}, seq: 3 }; running.scout = { screen: current.screen, seq: 4 }; dropStale(); });
  await expect.poll(() => app.sent('cancel').map((c) => Object.keys(c.body)[0]).sort()).toEqual(['pager', 'quick', 'suggest']);
  expect(await app.ev(() => Object.keys(running))).toEqual(['scout']);
  await app.ev(() => { startWriting('x'); running.suggest = { screen: current.screen, seq: 5 }; dropStale(); });
  expect(await app.ev(() => Object.keys(running).sort())).toEqual(['scout', 'suggest']);
});

test('aiui wrappers and summaries: media, reload, find, forward, zoom, print; the idle status line', async ({ app }) => {
  await app.open({ native: true, init: () => { window.print = () => { window.__printed = 1; }; HTMLMediaElement.prototype.play = function () { return Promise.resolve(); }; } });
  await app.ev(() => aiui.media.play('https://m.example/a.mp3', 'A'));
  expect(await app.ev(() => aiui.media.state())).toMatchObject({ url: 'https://m.example/a.mp3', title: 'A' });
  await app.ev(() => { aiui.media.pause(); aiui.media.resume(); aiui.media.stop(); });
  expect(await app.ev(() => aiui.media.state())).toBe(null);
  await app.ev(() => { aiui.zoom(1); aiui.forward(); aiui.find(); });
  await expect(app.page.locator('body')).toHaveClass(/typing/);
  await app.ev(() => { stopWriting(true); aiui.print(); aiui.reloadScene(); });
  expect(await app.ev(() => window.__printed)).toBe(1);
  // The idle status line: a scene's title (or kind), and a sparse snapshot.
  await app.ev(() => { current.screen = { kind: 'text' }; snapshot = { hints: 0 }; renderActivity(); });
  await expect(app.page.locator('#activity')).toHaveText(/^ready · text · .*cache 0 · JS 0\/0 · hints 0$/);
  await app.ev(() => { current.screen = { kind: 'html', title: 'Scene' }; renderActivity(); });
  await expect(app.page.locator('#activity')).toHaveText(/^ready · Scene/);
  // The player resumes at the start when no position was saved.
  await app.ev(() => { localStorage.setItem('aiui.media', JSON.stringify({ url: 'https://m.example/b.mp3', title: 'B', time: 0 })); return restoreMedia(); });
  expect(await app.ev(() => nowPlaying.title)).toBe('B');
});
