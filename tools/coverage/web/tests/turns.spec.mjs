// AI turns: opening circles, interim screens, time budgets, errors, returning to applets, revising.
import { test, expect } from '../harness.mjs';
import { routes, circleScreen, labels, title, until, deferred, err } from './util.mjs';
import { clickCircle } from './util.mjs';

const click = clickCircle;

test('opening a circle asks the AI and shows its screen; Back returns', async ({ app }) => {
  await app.open({ native: true, api: routes({ ai: (b) => ({ screen: circleScreen('Create what?', ['Doc', 'Image']), key: 'k1' }) }) });
  await click(app, 'Create');
  await expect(app.page.locator('#title')).toHaveText('Create what?');
  expect(await labels(app)).toEqual(['Doc', 'Image']);
  const ai = app.sent('ai')[0].body;
  expect(ai).toMatchObject({ event: 'open', target: { id: 'create', label: 'Create' }, path: [], language: 'en-US' });
  expect(ai.screen.circles.length).toBe(14);
  expect(await app.page.textContent('#path')).toBe('Create');
  await app.page.keyboard.press('Backspace');
  await expect(app.page.locator('#title')).toHaveText('');
  expect((await labels(app))[0]).toBe('Create');
  // Forward (⌘]) goes back to it again.
  await app.page.keyboard.press('Meta+]');
  await expect(app.page.locator('#title')).toHaveText('Create what?');
});

test('cached, published and stale answers: status notes and a background revision', async ({ app }) => {
  let n = 0;
  await app.open({ native: true, api: routes({
    ai: () => (++n === 1 ? { screen: circleScreen('A', ['x']), cached: true, published: 2, stale: true } : { screen: circleScreen('B', ['y']) }),
    revise: (b) => ({ screen: { ...circleScreen('A2', ['x', 'z']), note: 'n', cacheable: true } }),
  }) });
  await click(app, 'Search');
  await expect(app.page.locator('#title')).toHaveText('A2');
  expect(app.sent('revise')[0].body.shown.title).toBe('A');
  expect(await labels(app)).toEqual(['x', 'z']);
  await expect(app.page.locator('#status')).toHaveText('updated');
});

test('a revision that changes nothing, or arrives after leaving, is dropped; a failing one too', async ({ app }) => {
  const rev = deferred();
  let mode = 'same';
  await app.open({ native: true, api: routes({
    ai: () => ({ screen: circleScreen('A', ['x']), stale: true }),
    revise: () => (mode === 'same' ? { screen: circleScreen('A', ['x']) } : mode === 'bad' ? { screen: null } : mode === 'fail' ? Promise.reject(err('x')) : rev.promise),
  }) });
  await click(app, 'Search');
  await expect.poll(() => app.sent('revise').length).toBe(1);
  await app.settle();
  await expect(app.page.locator('#title')).toHaveText('A');
  mode = 'bad';
  await app.ev(() => back());
  await click(app, 'Search');
  await expect.poll(() => app.sent('revise').length).toBe(2);
  mode = 'fail';
  await app.ev(() => back());
  await click(app, 'Search');
  await expect.poll(() => app.sent('revise').length).toBe(3);
  mode = 'late';
  await app.ev(() => back());
  await click(app, 'Search');
  await expect.poll(() => app.sent('revise').length).toBe(4);
  // Paused: no revision at all.
  await app.ev(() => { paused = true; revise(current, {}); paused = false; });
  expect(app.sent('revise').length).toBe(4);
  // Revised while the user moved on: stored in the history entry, shown when going back.
  await app.ev(() => push({ kind: 'circles', local: 'x', circles: [] }, 'L'));
  rev.resolve({ screen: circleScreen('Later', ['q']) });
  await app.settle();
  await expect(app.page.locator('#title')).toHaveText('');
  await app.ev(() => back());
  await expect(app.page.locator('#title')).toHaveText('Later');
});

test('a slow answer shows an interim screen, replaced in place by the full one', async ({ app }) => {
  const full = deferred();
  await app.open({ native: true, api: routes({
    ai: () => full.promise,
    quick: () => ({ ...circleScreen('Quick', ['q1']), note: 'x' }),
  }) });
  await click(app, 'Read');
  await expect(app.page.locator('body')).toHaveClass(/busy/);
  await app.tick(1100);
  await expect(app.page.locator('#status')).toHaveText('thinking');
  await app.tick(1000);
  await expect(app.page.locator('#title')).toHaveText('Quick');
  await expect(app.page.locator('body')).toHaveClass(/updating/);
  expect(await app.ev(() => current.screen.interim)).toBe(true);
  full.resolve({ screen: circleScreen('Full', ['f1', 'f2']), key: 'kk' });
  await expect(app.page.locator('#title')).toHaveText('Full');
  await expect(app.page.locator('body')).not.toHaveClass(/updating/);
  expect(await app.ev(() => current.key)).toBe('kk');
});

test('interim screen: the full answer lands in the history when the user moved on; html swaps seamlessly', async ({ app }) => {
  let full = deferred();
  await app.open({ native: true, api: routes({
    ai: () => full.promise,
    quick: (b) => (b.event === 'open' ? circleScreen('Quick', ['q1']) : { kind: 'html', title: 'QH', html: '<p>quick</p>' }),
  }) });
  await click(app, 'Read');
  await app.tick(2100);
  await expect(app.page.locator('#title')).toHaveText('Quick');
  await app.ev(() => push({ kind: 'circles', local: 'other', title: 'Other', circles: [] }, 'O'));
  full.resolve({ screen: circleScreen('Full', ['f']) });
  await app.settle();
  await expect(app.page.locator('#title')).toHaveText('Other');
  await app.ev(() => back());
  await expect(app.page.locator('#title')).toHaveText('Full');
  // An html interim replaced by an html answer: a seamless update (old frame stays until ready).
  full = deferred();
  await app.ev(() => { ask({ event: 'go' }, { label: 'Go' }); });
  await app.tick(2100);
  await expect(app.page.locator('#title')).toHaveText('QH');
  full.resolve({ screen: { kind: 'html', title: 'FH', html: '<p>full</p>' } });
  await app.settle();
  await app.tick(3000);
  await until(app, () => current.screen.title === 'FH');
});

test('a quick screen repeating this one keeps waiting; a failing quick call changes nothing', async ({ app }) => {
  const full = deferred();
  let q = 'repeat';
  await app.open({ native: true, api: routes({
    ai: () => full.promise,
    quick: () => (q === 'repeat' ? circleScreen('', ['Create', 'Search', 'Read', 'Write']) : Promise.reject(err('nope'))),
  }) });
  await click(app, 'Read');
  await app.tick(2100);
  await expect(app.page.locator('#status')).toHaveText('still working');
  expect(await app.ev(() => busy)).toBe(true);
  full.resolve({ screen: circleScreen('Full', ['f']) });
  await expect(app.page.locator('#title')).toHaveText('Full');
  // Quick failing.
  q = 'fail';
  const f2 = deferred();
  app.api = routes({ ai: () => f2.promise, quick: () => Promise.reject(err('nope')) });
  await app.ev(() => { ask({ event: 'go' }, { label: 'Go' }); });
  await app.tick(2100);
  expect(await app.ev(() => busy)).toBe(true);
  f2.resolve({ screen: circleScreen('Done', ['d']) });
  await expect(app.page.locator('#title')).toHaveText('Done');
});

test('repeatsScreen: same title, the clicked label, or mostly the same circles', async ({ app }) => {
  await app.open({ native: true });
  const r = await app.ev(() => {
    const here = { title: 'Here', circles: [{ label: 'a' }, { label: 'b' }, { label: 'c' }, { label: 'gone', removed: true }] };
    return [
      repeatsScreen(null, here), repeatsScreen({ title: ' here ' }, here), repeatsScreen({ circles: [] }, here),
      repeatsScreen({ circles: [{ label: 'X' }] }, here, { label: 'x' }),
      repeatsScreen({ circles: [{ label: 'a' }, { label: 'b' }, { label: 'c' }, { label: 'd' }] }, here),
      repeatsScreen({ circles: [{ label: 'a' }, { label: 'q' }] }, here),
      repeatsScreen({ circles: [{ label: 'a' }] }, here, {}),
    ];
  });
  expect(r).toEqual([false, true, false, true, true, false, false]);
});

test('time budgets: a circle that says "wait" keeps waiting; "cancel" gives up; the hard limit ends it', async ({ app }) => {
  const never = new Promise(() => {});
  await app.open({ native: true, api: routes({ ai: () => never }) });
  await app.ev(() => {
    current.screen = { kind: 'circles', title: 'T', timeouts: { default: { seconds: 1, then: 'cancel', label: 'Render' }, go: { seconds: 30 } },
      go: 'Do it', circles: [{ id: 'w', label: 'Wait', expect: { seconds: 10, then: 'wait', label: 'Long' } }, { id: 'n', label: 'Now' }, { id: 'v', label: 'Plain', expect: { seconds: 9 } }] };
    render();
  });
  // Go shows the go budget; a long circle shows its expected time.
  await expect(app.page.locator('#go')).toHaveText('Do it · ⏱ 30s');
  await expect(app.page.locator('.circle[data-id="w"] .expect')).toHaveText('⏱ 10s');
  await click(app, 'Wait');
  await app.tick(1000);
  await expect(app.page.locator('#status')).toHaveText(/^Long · \d+s$/);
  await app.tick(9500);
  await expect(app.page.locator('#status')).toHaveText('Long · still working');
  // The countdown reaches zero.
  await app.tick(1000);
  await expect(app.page.locator('#status')).toHaveText(/Long · …|still working/);
  // The hard limit (150 s): cancelled with a toast and a journal entry.
  await app.tick(150000);
  await expect(app.page.locator('#toast')).toHaveText(/took too long/);
  expect(app.sent('cancel').length).toBeGreaterThan(0);
  expect(app.sent('journal').some((c) => c.body.kind === 'timeout')).toBe(true);
  // "cancel" policy (screen default).
  await click(app, 'Now');
  await app.tick(1100);
  await expect(app.page.locator('#toast')).toHaveText('Render: This took too long — try again, or ask differently.');
  expect(await app.ev(() => busy)).toBe(false);
  // A cancel policy without a label.
  await app.ev(() => { current.screen.timeouts.default = { seconds: 1, then: 'cancel' }; });
  await click(app, 'Now');
  await app.tick(1100);
  await expect(app.page.locator('#toast')).toHaveText('This took too long — try again, or ask differently.');
  // A wait policy without a label.
  await app.ev(() => { current.screen.timeouts.default = { seconds: 1, then: 'wait' }; });
  await click(app, 'Now');
  await app.tick(1100);
  await expect(app.page.locator('#status')).toHaveText('still working');
  await app.ev(() => cancel());
});

test('hard limit after an interim screen: no toast', async ({ app }) => {
  await app.open({ native: true, api: routes({ ai: () => new Promise(() => {}), quick: () => circleScreen('Q', ['q']) }) });
  await click(app, 'Read');
  await app.tick(2100);
  await expect(app.page.locator('#title')).toHaveText('Q');
  await app.tick(150000);
  await expect(app.page.locator('#toast')).not.toHaveClass(/on/);
  expect(await app.ev(() => document.body.classList.contains('updating'))).toBe(false);
});

test('errors: no AI opens the setup; "cancelled" retries once; others toast and go to the journal', async ({ app }) => {
  let n = 0, mode = 'no-ai';
  await app.open({ native: true, api: routes({
    ai: () => {
      n++;
      if (mode === 'no-ai') return Promise.reject(err('no-ai'));
      if (mode === 'cancel-once') { if (n === 2) return Promise.reject(err('cancelled')); return { screen: circleScreen('Retried', ['r']) }; }
      if (mode === 'cancel-always') return Promise.reject(err('cancelled'));
      return Promise.reject(err('Boom'));
    },
  }) });
  await click(app, 'Write');
  await expect(app.page.locator('#title')).toHaveText('AI');
  mode = 'cancel-once';
  await app.ev(() => home());
  await click(app, 'Write');
  await expect(app.page.locator('#title')).toHaveText('Retried');
  expect(n).toBe(3);
  mode = 'cancel-always';
  await app.ev(() => home());
  await click(app, 'Write');
  await expect(app.page.locator('#toast')).toHaveText('cancelled');
  expect(app.sent('journal').filter((c) => c.body.kind === 'error').length).toBe(0);
  mode = 'boom';
  await click(app, 'Write');
  await expect(app.page.locator('#toast')).toHaveText('Boom');
  await expect.poll(() => app.sent('journal').filter((c) => c.body.kind === 'error').length).toBe(1);
  expect(app.sent('journal').find((c) => c.body.kind === 'error').body.detail).toBe('open: Boom');
});

test('an answer for a superseded turn is ignored; a new turn cancels the running one', async ({ app }) => {
  const first = deferred();
  let n = 0;
  await app.open({ native: true, api: routes({ ai: () => (++n === 1 ? first.promise : { screen: circleScreen('Second', ['s']) }) }) });
  await click(app, 'Plan');
  // While busy, other circles are locked; the pending one cancels on click.
  await app.page.locator('.circle[data-id="learn"] .face').dispatchEvent('click');
  expect(app.sent('ai').length).toBe(1);
  await app.ev(() => { ask({ event: 'go' }, { label: 'Go' }); });
  await expect(app.page.locator('#title')).toHaveText('Second');
  expect(app.sent('cancel').length).toBeGreaterThan(0);
  first.resolve({ screen: circleScreen('First', ['f']) });
  await app.settle();
  await expect(app.page.locator('#title')).toHaveText('Second');
  // A failure for a superseded turn is silent too.
  const third = deferred();
  app.api = routes({ ai: () => third.promise });
  await app.ev(() => { ask({ event: 'go' }, { label: 'Go' }); });
  await app.ev(() => cancel());
  third.reject(err('late'));
  await app.settle();
  await expect(app.page.locator('#toast')).not.toHaveClass(/on/);
});

test('the pending circle shows progress and cancels when clicked again', async ({ app }) => {
  const never = deferred();
  await app.open({ native: true, api: routes({ ai: () => never.promise }) });
  await click(app, 'Plan');
  const node = app.page.locator('.circle[data-id="plan"]');
  await expect(node).toHaveClass(/pending/);
  await expect(node.locator('.progress')).toHaveText('thinking');
  await app.ev(() => aiui._event({ type: 'progress', text: 'reading mail' }));
  await expect(node.locator('.progress')).toHaveText('reading mail');
  await expect(app.page.locator('#status')).toHaveText('reading mail');
  await node.locator('.face').click();
  await expect(node).not.toHaveClass(/pending/);
  expect(app.sent('journal').some((c) => c.body.kind === 'cancel')).toBe(true);
});

test('an applet already in the history is returned to instead of opened twice', async ({ app }) => {
  let n = 0;
  await app.open({ native: true, api: routes({
    ai: () => (++n === 1 ? { screen: { kind: 'html', title: 'App', html: '<p>a</p>' }, key: 'ap' }
      : n === 2 ? { screen: circleScreen('Mid', ['m']), key: 'mid' }
        : { screen: { kind: 'html', title: 'App v2', html: '<p>b</p>' }, key: 'ap', returned: true }),
  }) });
  await click(app, 'Build');
  await expect(app.page.locator('#title')).toHaveText('App');
  await app.ev(() => { ask({ event: 'go' }, { label: 'Go' }); });
  await expect(app.page.locator('#title')).toHaveText('Mid');
  await app.ev(() => { ask({ event: 'go' }, { label: 'Go' }); });
  await expect(app.page.locator('#title')).toHaveText('App v2');
  await expect(app.page.locator('#status')).toHaveText('↩︎ back to «App v2»');
  expect(await app.ev(() => stack.length)).toBe(1);
  // The same applet asked again from itself: stays.
  n = 2;
  await app.ev(() => { ask({ event: 'go' }, { label: 'Go' }); });
  expect(await app.ev(() => [stack.length, current.key])).toEqual([1, 'ap']);
  // returnTo for a key nowhere in the history.
  expect(await app.ev(() => returnTo('nope'))).toBe(false);
});

test('payload carries attention, guest mode and the user check', async ({ app }) => {
  await app.open({ native: true, api: routes({ ai: () => ({ screen: circleScreen('X', ['x']) }) }) });
  await app.ev(() => {
    current.screen.attention = { create: { ms: 1200, passes: 2 }, search: { ms: 400, passes: 1, opened: true }, read: { ms: 10, passes: 1 }, ghost: { ms: 300, passes: 1 } };
    who.guest = true; who.suspect = ['typing faster than usual'];
  });
  await app.ev(() => { ask({ event: 'go' }, { label: 'Go' }); });
  await expect.poll(() => app.sent('ai').length).toBe(1);
  const b = app.sent('ai')[0].body;
  expect(b.attention).toEqual([
    { circle: 'Create', dwellMs: 1200, passes: 2, hesitated: true },
    { circle: 'Search', dwellMs: 400, passes: 1 },
    { circle: 'ghost', dwellMs: 300, passes: 1 },
  ]);
  expect(b.guest).toBe(true);
  expect(b.userCheck).toEqual({ suspect: true, reasons: ['typing faster than usual'] });
});

test('normalize: kinds, unique ids and the declared bar', async ({ app }) => {
  await app.open({ native: true });
  const r = await app.ev(() => [normalize(null), normalize({ html: '<p>' }).kind, normalize({ circles: [] }).kind, normalize({}).kind,
    normalize({ bar: [{ id: 'b' }], circles: [{ id: 'a' }, { id: 'a' }, { label: 'x' }] })]);
  expect(r[0]).toEqual({ kind: 'text' });
  expect(r.slice(1, 4)).toEqual(['html', 'circles', 'text']);
  expect(r[4].declaredBar).toEqual([{ id: 'b' }]);
  expect(r[4].circles.map((c) => c.id)).toEqual(['a', 'a_', 'c2']);
});
