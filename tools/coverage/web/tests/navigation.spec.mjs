// Circles, pages, focus, keys, touch: moving around without the AI (it only answers).
import { test, expect } from '../harness.mjs';
import { routes, circleScreen, labels, until, deferred, err } from './util.mjs';

const many = (n, prefix = 'Item') => Array.from({ length: n }, (_, i) => ({ id: 'i' + i, label: `${prefix} ${i}` }));
const show = (app, screen) => app.ev((s) => { current.screen = normalize(s); render(); }, screen);
const focused = (app) => app.ev(() => focusedId());

test('pages: circles that do not fit go behind More; Back and More page through; keys too', async ({ app }) => {
  await app.open({ native: true });
  await show(app, { kind: 'circles', title: 'Many', circles: many(60) });
  const first = await labels(app);
  expect(first.length).toBeGreaterThan(4);
  expect(first.length).toBeLessThan(60);
  await expect(app.page.locator('#more')).toHaveClass(/on/);
  await expect(app.page.locator('#prev')).not.toHaveClass(/on/);
  await app.page.click('#more');
  const second = await labels(app);
  expect(second[0]).toBe(`Item ${first.length}`);
  await expect(app.page.locator('#prev')).toHaveClass(/on/);
  await app.page.click('#prev');
  expect(await labels(app)).toEqual(first);
  await app.page.keyboard.press('End');
  const last = await labels(app);
  expect(last[last.length - 1]).toBe('Item 59');
  await expect(app.page.locator('#more')).not.toHaveClass(/on/);
  await app.page.locator('#more').dispatchEvent('click'); // nothing beyond, not expandable
  expect(await labels(app)).toEqual(last);
  await app.page.keyboard.press('Home');
  expect(await labels(app)).toEqual(first);
  await app.page.keyboard.press('PageDown');
  expect(await labels(app)).toEqual(second);
  await app.page.keyboard.press('PageUp');
  expect(await labels(app)).toEqual(first);
  // Backspace pages back first.
  await app.page.keyboard.press('PageDown');
  await app.page.keyboard.press('Backspace');
  expect(await labels(app)).toEqual(first);
  // A resize re-flows; the page with the first shown circle stays.
  await app.page.setViewportSize({ width: 700, height: 600 });
  await until(app, () => pages.length > 3);
  await app.page.setViewportSize({ width: 1280, height: 800 });
  await until(app, () => pages.length < 6);
});

test('expandable screens: More asks the pager; new circles start a page; nothing new waits for a press', async ({ app }) => {
  let page = deferred();
  await app.open({ native: true, api: routes({ more: () => page.promise }) });
  await show(app, { kind: 'circles', title: 'Open', more: true, circles: many(3) });
  // Preloading starts at once (one full page ready beyond the one shown).
  const mine = () => app.sent('more').filter((c) => c.body.screen.title === 'Open');
  await expect.poll(() => mine().length).toBe(1);
  expect(mine()[0].body).toMatchObject({ path: [], screen: { title: 'Open' } });
  await app.page.click('#more');
  await expect(app.page.locator('#more')).toHaveClass(/loading/);
  page.resolve({ circles: [{ id: 'n', label: 'New one' }, { label: 'item 0' }, null, { id: 'x' }] });
  await expect.poll(() => labels(app)).toEqual(['New one']);
  expect(await app.ev(() => current.screen.circles.map((c) => c.id))).toEqual(['i0', 'i1', 'i2', 'n~p1']);
  // Nothing new (and not infinite, pager says no more): More goes away.
  page = deferred();
  await app.ev(() => { paging.failed = false; maybePreload(); });
  page.resolve({ circles: [], more: false });
  await until(app, () => current.screen.more === false);
  await expect(app.page.locator('#more')).not.toHaveClass(/on/);
});

test('pager: an infinite screen keeps More when nothing came; failures toast only after a press', async ({ app }) => {
  let mode = 'empty';
  await app.open({ native: true, api: routes({ more: () => (mode === 'empty' ? { circles: [], more: false } : mode === 'cancel' ? (mode = 'hang', Promise.reject(err('cancelled'))) : mode === 'hang' ? new Promise(() => {}) : Promise.reject(err('pager down'))) }) });
  await show(app, { kind: 'circles', title: 'Inf', more: true, infinite: true, circles: many(2) });
  await until(app, () => paging.failed);
  await expect(app.page.locator('#more')).toHaveClass(/on/);
  mode = 'fail';
  await app.page.click('#more');
  await expect(app.page.locator('#toast')).toHaveText('pager down');
  // Failed in the background: no toast.
  await app.ev(() => { el.toast.textContent = ''; paging.failed = false; wantNext = false; loadMore(); });
  await until(app, () => paging.failed);
  expect(await app.page.textContent('#toast')).toBe('');
  // Cancelled (the main turn took the AI): not a failure, preloading starts again.
  mode = 'cancel';
  await app.ev(() => { paging.failed = false; loadMore(); });
  await expect.poll(() => app.sent('more').length).toBeGreaterThan(4);
  expect(await app.ev(() => [paging.failed, paging.loading])).toEqual([false, true]);
  // A pager answer for a screen already left is dropped.
  const d = deferred();
  let once = 0;
  app.api = routes({ more: () => (once++ ? new Promise(() => {}) : d.promise) });
  await app.ev(() => { paging.failed = false; loadMore(); });
  await app.ev(() => home());
  d.resolve({ circles: [{ label: 'Late' }] });
  await app.settle();
  expect(await app.ev(() => current.screen.circles.some((c) => c.label === 'Late'))).toBe(false);
  // More pressed while loading only marks the wish.
  const d2 = deferred();
  app.api = routes({ more: () => d2.promise });
  await show(app, { kind: 'circles', title: 'Inf2', more: true, circles: many(1) });
  await expect.poll(() => app.sent('more').length).toBeGreaterThan(3);
  await app.page.click('#more');
  await app.page.click('#more');
  expect(await app.ev(() => wantNext)).toBe(true);
  // Paused or typing: no preloading.
  expect(await app.ev(() => { paused = true; paging.loading = false; const n = paging.token; maybePreload(); paused = false; return paging.token === n; })).toBe(true);
});

test('More and Back on non-circle screens: the AI or the scene extends it', async ({ app }) => {
  await app.open({ native: true, api: routes({ ai: () => ({ screen: { kind: 'text', title: 'More text', text: '' } }) }) });
  await show(app, { kind: 'text', title: 'Text', more: true, text: 'abc' });
  await app.page.click('#more');
  await expect.poll(() => app.sent('ai').length).toBe(1);
  expect(app.sent('ai')[0].body.event).toBe('more');
  await show(app, { kind: 'text', title: 'Plain', text: '' });
  await app.ev(() => nextPage());
  expect(app.sent('ai').length).toBe(1);
  expect(await app.ev(() => prevPage())).toBe(false);
});

test('Back: long press goes back to the circles; a press within 3 s of a new AI screen is a bounce', async ({ app }) => {
  await app.open({ native: true, api: routes({ ai: () => ({ screen: { kind: 'text', title: 'Deep', text: 'x' } }) }) });
  await app.ev(() => {
    stack = [{ screen: clone(ROOT), label: null }, { screen: { kind: 'circles', title: 'Mid', circles: [{ id: 'a', label: 'A' }] }, label: 'Mid' }];
    current = { screen: { kind: 'html', title: 'Scene', html: '<p>x</p>', back: true }, label: 'Scene' };
    render();
  });
  await expect(app.page.locator('#prev')).toHaveClass(/on/);
  await app.page.locator('#prev').dispatchEvent('pointerdown');
  await app.tick(600);
  await expect(app.page.locator('#title')).toHaveText('Mid');
  await expect(app.page.locator('#status')).toHaveText('⟲');
  // The click that ends the long press does nothing more.
  await app.page.locator('#prev').dispatchEvent('click');
  await expect(app.page.locator('#title')).toHaveText('Mid');
  // A short press: pointerup cancels the long press; the click goes back (a bounce: under 3 s).
  await app.ev(() => { stack.push(current); current = { screen: { kind: 'text', title: 'New', text: '', back: true, shownAt: Date.now() }, label: 'New' }; render(); });
  await app.page.locator('#prev').dispatchEvent('pointerdown');
  await app.page.locator('#prev').dispatchEvent('pointerup');
  await app.page.locator('#prev').dispatchEvent('click');
  await expect(app.page.locator('#title')).toHaveText('Mid');
  await expect.poll(() => app.sent('journal').filter((c) => c.body.kind === 'bounce').length).toBe(1);
  // Back on the root does nothing; Back while busy cancels.
  await app.ev(() => { home(); back(); });
  expect(await app.ev(() => stack.length)).toBe(0);
  const d = deferred();
  app.api = routes({ ai: () => d.promise });
  await app.ev(() => { ask({ event: 'go' }, {}); });
  await app.ev(() => back());
  expect(await app.ev(() => busy)).toBe(false);
  // backToCircles while busy cancels too.
  await app.ev(() => { ask({ event: 'go' }, {}); });
  await app.ev(() => backToCircles());
  expect(await app.ev(() => busy)).toBe(false);
});

test('Backspace held down goes back to the circles; ⌘[ goes back', async ({ app }) => {
  await app.open({ native: true });
  await app.ev(() => {
    stack = [{ screen: clone(ROOT), label: null }, { screen: { kind: 'text', title: 'T1', text: '' }, label: 'T1' }];
    current = { screen: { kind: 'html', local: 'x', title: 'H', html: '' }, label: 'H' };
    render();
  });
  await app.page.keyboard.press('Meta+[');
  await expect(app.page.locator('#title')).toHaveText('T1');
  await app.ev(() => { stack.push(current); current = { screen: { kind: 'html', local: 'x', title: 'H2', html: '' }, label: 'H2' }; render(); });
  const held = (repeat) => app.ev((r) => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Backspace', repeat: r, bubbles: true })), repeat);
  await held(true);
  await app.tick(500);
  await held(true);
  await expect(app.page.locator('#title')).toHaveText('');
  await held(true); // done once per hold
  await app.ev(() => document.dispatchEvent(new KeyboardEvent('keyup', { key: 'Backspace' })));
  await app.ev(() => document.dispatchEvent(new KeyboardEvent('keyup', { key: 'a' })));
});

test('circles: icons, hints, values, sizes, selection with Shift/⌘-click and Space; Go', async ({ app }) => {
  await app.open({ native: true, api: routes({ ai: () => ({ screen: circleScreen('Went', ['w']) }) }) });
  await show(app, { kind: 'circles', title: 'C', circles: [
    { id: 'a', label: 'Alpha', icon: '🅰️', hint: 'first', value: 3, size: 9 },
    { id: 'b', label: 'Beta', hint: 'small one', size: 0.5, value: 1, plus: 'increment' },
    { id: 'c', label: 'Gamma', value: 1, title: 'Tooltip' },
    { id: 'd', label: 'Delta', selected: true },
  ] });
  const a = app.page.locator('.circle[data-id="a"]');
  await expect(a.locator('.icon')).toHaveText('🅰️');
  await expect(a.locator('.hint')).toHaveText('first');
  await expect(a.locator('.value')).toHaveText('3');
  expect(await a.evaluate((n) => n.style.getPropertyValue('--s'))).toBe('1.5');
  await expect(app.page.locator('.circle[data-id="b"] .hint')).toHaveCount(0);
  await expect(app.page.locator('.circle[data-id="b"] .value')).toHaveText('1');
  await expect(app.page.locator('.circle[data-id="c"] .value')).toHaveCount(0);
  expect(await app.page.getAttribute('.circle[data-id="c"]', 'title')).toBe('Tooltip');
  await expect(app.page.locator('.circle[data-id="d"]')).toHaveClass(/selected/);
  await expect(app.page.locator('#go')).toHaveText('Go');
  await expect(app.page.locator('body')).toHaveClass(/show-go/);
  await app.page.locator('.circle[data-id="a"] .face').click({ modifiers: ['Shift'] });
  await expect(app.page.locator('.circle[data-id="a"]')).toHaveClass(/selected/);
  await app.page.locator('.circle[data-id="d"] .face').click({ modifiers: ['Meta'] });
  await expect(app.page.locator('.circle[data-id="d"]')).not.toHaveClass(/selected/);
  // Space toggles the focused circle.
  await app.page.keyboard.press('Space');
  expect(await app.ev(() => current.screen.circles.find((c) => c.id === 'd').selected)).toBe(true);
  // ⌘Enter is Go with a selection.
  await app.page.keyboard.press('Meta+Enter');
  await expect(app.page.locator('#title')).toHaveText('Went');
  const b = app.sent('ai')[0].body;
  expect(b.event).toBe('go');
  expect(b.screen.circles.filter((c) => c.selected).map((c) => c.id)).toEqual(['a', 'd']);
  expect(b.screen.circles.find((c) => c.id === 'a').value).toBe(3);
});

test('Go: the screen\'s own go; Enter opens the focused circle or presses Go; local screens have no AI Go', async ({ app }) => {
  await app.open({ native: true, api: routes({ ai: (bd) => ({ screen: circleScreen('After ' + bd.event, ['x']) }) }) });
  await show(app, { kind: 'circles', title: 'G', go: 'Start', circles: [] });
  await expect(app.page.locator('#go')).toHaveText('Start');
  await app.page.keyboard.press('Enter');
  await expect(app.page.locator('#title')).toHaveText('After go');
  expect(app.sent('ai')[0].body.event).toBe('go');
  await show(app, { kind: 'circles', title: 'G2', go: 'Start', circles: [] });
  await app.page.keyboard.press('Meta+Enter');
  await expect(app.page.locator('#title')).toHaveText('After go');
  await show(app, { kind: 'text', title: 'No go', text: '' });
  await app.page.keyboard.press('Enter');
  await app.ev(() => stopWriting(true));
  await show(app, { kind: 'html', title: 'H', go: 'Run', html: '' });
  await app.ev(() => el.view.innerHTML = '');
  await app.ev(() => onKey(new KeyboardEvent('keydown', { key: 'Enter' })));
  await expect(app.page.locator('#title')).toHaveText('After go');
  await show(app, { kind: 'circles', local: 'x', title: 'Local', go: 'Nope', circles: [] });
  await app.page.click('#go');
  expect(app.sent('ai').length).toBe(3);
  // Enter on a circle screen with no circles and nothing selected does nothing.
  await show(app, { kind: 'circles', title: 'Empty', circles: [] });
  await app.ev(() => onKey(new KeyboardEvent('keydown', { key: 'Enter' })));
  expect(app.sent('ai').length).toBe(3);
});

test('focus: arrows move spatially, Tab in order, past the edge to the next page; Enter opens', async ({ app }) => {
  await app.open({ native: true, api: routes({ ai: (b) => ({ screen: circleScreen('Opened ' + b.target.label, ['x']) }) }) });
  await show(app, { kind: 'circles', title: 'F', circles: many(40), focus: 'i1' });
  expect(await focused(app)).toBe('i1');
  await app.page.keyboard.press('ArrowRight');
  expect(await focused(app)).toBe('i2');
  await app.page.keyboard.press('ArrowLeft');
  expect(await focused(app)).toBe('i1');
  await app.page.keyboard.press('ArrowDown');
  const down = await focused(app);
  expect(down).not.toBe('i1');
  await app.page.keyboard.press('ArrowUp');
  expect(await focused(app)).toBe('i1');
  await app.page.keyboard.press('Tab');
  expect(await focused(app)).toBe('i2');
  await app.page.keyboard.press('Shift+Tab');
  expect(await focused(app)).toBe('i1');
  await app.page.keyboard.press('Shift+Tab');
  expect(await focused(app)).toBe('i0');
  // Past the first circle: nothing before.
  await app.page.keyboard.press('Shift+Tab');
  await app.page.keyboard.press('ArrowLeft');
  expect(await focused(app)).toBe('i0');
  // Past the last circle of the page: the next page, focus on its first.
  const perPage = (await labels(app)).length;
  await app.ev((n) => setFocus('i' + (n - 1)), perPage);
  await app.page.keyboard.press('Tab');
  expect(await focused(app)).toBe('i' + perPage);
  // Back past the first: the previous page, focus on its last.
  await app.page.keyboard.press('Shift+Tab');
  expect(await focused(app)).toBe('i' + (perPage - 1));
  await app.page.keyboard.press('ArrowDown');
  await app.page.keyboard.press('ArrowDown');
  await app.page.keyboard.press('ArrowDown');
  await app.page.keyboard.press('ArrowDown');
  await app.page.keyboard.press('ArrowRight');
  await app.page.keyboard.press('ArrowRight');
  await app.page.keyboard.press('ArrowRight');
  await app.page.keyboard.press('ArrowRight');
  await app.page.keyboard.press('ArrowRight');
  await app.page.keyboard.press('ArrowRight');
  await app.page.keyboard.press('ArrowRight');
  await app.page.keyboard.press('ArrowRight');
  // Enter opens the focused circle.
  const f = await focused(app);
  await app.page.keyboard.press('Enter');
  await expect(app.page.locator('#title')).toHaveText(/^Opened Item/);
  expect(app.sent('ai')[0].body.target.id).toBe(f);
  // No circles: arrows do nothing; a focus lost (hidden node) is put back on the first.
  await show(app, { kind: 'circles', title: 'Empty', circles: [] });
  await app.ev(() => moveFocus('next'));
  await show(app, { kind: 'circles', title: 'Two', circles: many(2) });
  await app.ev(() => { current.screen.focusId = 'zzz'; moveFocus('right'); });
  expect(await focused(app)).toBe('i0');
});

test('focus: the AI\'s focus, the remembered one, and the user\'s habit from the cache', async ({ app }) => {
  let likely = { label: 'Item 2' };
  await app.open({ native: true, api: routes({ cache: (b) => (b.op === 'likely' ? (likely === 'fail' ? Promise.reject(err('x')) : likely) : { results: [] }) }) });
  await show(app, { kind: 'circles', title: 'H', circles: many(5) });
  await until(app, () => focusedId() === 'i2');
  expect(app.sent('cache', 'likely').at(-1).body.path).toEqual([]);
  // Too late, or the user moved: the first stays.
  likely = new Promise((r) => setTimeout(() => r({ label: 'Item 3' }), 500));
  await show(app, { kind: 'circles', title: 'H2', circles: many(5) });
  await app.tick(600);
  await app.settle();
  expect(await focused(app)).toBe('i0');
  likely = { label: 'Nope' };
  await show(app, { kind: 'circles', title: 'H3', circles: many(5) });
  await app.settle();
  expect(await focused(app)).toBe('i0');
  likely = { label: null };
  await show(app, { kind: 'circles', title: 'H4', circles: many(5) });
  likely = 'fail';
  await show(app, { kind: 'circles', title: 'H5', circles: many(5) });
  // Remembered focus wins when coming back.
  await app.ev(() => setFocus('i4', true));
  await app.ev(() => { push({ kind: 'circles', local: 'x', title: 'Other', circles: [] }, 'O'); back(); });
  expect(await focused(app)).toBe('i4');
  // The AI's focus for a fresh screen.
  await show(app, { kind: 'circles', title: 'H6', focus: 'i3', circles: many(5) });
  expect(await focused(app)).toBe('i3');
});

test('labels shrink to fit their circle; hints go first when space is short', async ({ app }) => {
  await app.open({ native: true });
  await show(app, { kind: 'circles', title: 'Fit', circles: [
    { id: 'w', label: 'Supercalifragilisticexpialidocious', hint: 'a word too wide for any circle at all' },
    { id: 't', label: 'many short words that together make a very tall label in this circle indeed', hint: 'and a hint that wraps too' },
    { id: 's', label: 'Ok' },
  ] });
  const w = await app.page.$eval('.circle[data-id="w"] .label', (n) => parseFloat(n.style.fontSize));
  expect(w).toBeLessThan(15);
  await expect(app.page.locator('.circle[data-id="t"]')).toHaveClass(/long/);
  expect(await app.page.$eval('.circle[data-id="s"] .label', (n) => n.style.fontSize)).toBe('');
  // A circle not laid out yet is fitted when its page shows.
  expect(await app.ev(() => { const n = circleEl({ id: 'z', label: 'x' }, 0); fitText(n); fitText(document.createElement('div')); return n.className; })).toBe('circle');
});

test('the theme follows the system appearance into AI views', async ({ app }) => {
  await app.open({ native: true });
  await app.page.emulateMedia({ colorScheme: 'light' });
  await show(app, { kind: 'html', local: 'x', title: 'H', html: '<p>hi</p>' });
  await app.page.locator('#view iframe').waitFor();
  await until(app, () => !!el.view.querySelector('iframe').contentDocument.body);
  await app.page.emulateMedia({ colorScheme: 'dark' });
  await until(app, () => el.view.querySelector('iframe').contentDocument.documentElement.style.cssText.includes('--bg'));
  const r = await app.ev(() => [themeVars(true).includes('--bg:#0b0b0f'), themeVars(false).includes('--bg:#f5f5f8')]);
  expect(r).toEqual([true, true]);
  // A frame without a document (removed) is skipped.
  await app.ev(() => { const f = document.createElement('iframe'); f.srcdoc = 'x'; el.view.appendChild(f); });
  await app.page.emulateMedia({ colorScheme: 'light' });
});

test('touch: swipe up/down pages and goes back; a tap on empty space starts typing; long press opens the menu', async ({ app }) => {
  await app.open({ native: true, api: routes({ menus: () => ({ classes: [{ class: 'circle', enabled: true, actions: [{ id: 'x', label: 'Do' }] }] }) }) });
  await show(app, { kind: 'circles', title: 'T', circles: many(60) });
  const touch = (type, x, y, target = 'body', n = 1) => app.ev(([type, x, y, target, n]) => {
    const t = document.querySelector(target);
    const mk = () => new Touch({ identifier: 1, target: t, clientX: x, clientY: y });
    const list = type === 'touchend' ? [] : Array.from({ length: n }, mk);
    t.dispatchEvent(new TouchEvent(type, { touches: list, changedTouches: [mk()], bubbles: true, cancelable: true }));
  }, [type, x, y, target, n]);
  await touch('touchstart', 600, 600);
  await touch('touchend', 600, 400);
  expect(await app.ev(() => current.screen.page)).toBe(1);
  await touch('touchstart', 600, 400);
  await touch('touchend', 600, 600);
  expect(await app.ev(() => current.screen.page)).toBe(0);
  // Down on the first page: back a screen.
  await app.ev(() => { stack.push({ screen: clone(ROOT), label: null }); });
  await touch('touchstart', 600, 400);
  await touch('touchend', 600, 600);
  await expect(app.page.locator('#title')).toHaveText('');
  // A tap on empty space starts typing; on the input or a circle it doesn't.
  await touch('touchstart', 600, 700, '#stage');
  await touch('touchend', 602, 701, '#stage');
  await expect(app.page.locator('body')).toHaveClass(/typing/);
  // While typing, swipes do nothing.
  await touch('touchstart', 600, 400, '#stage');
  await touch('touchend', 600, 600, '#stage');
  await app.ev(() => stopWriting(true));
  await touch('touchstart', 10, 10, '#write');
  await touch('touchend', 10, 10, '#write');
  await expect(app.page.locator('body')).not.toHaveClass(/typing/);
  // Two fingers: no gesture; pinch is blocked.
  await touch('touchstart', 600, 600, 'body', 2);
  await touch('touchend', 600, 300);
  await touch('touchend', 600, 300);
  expect(await app.ev(() => { const e = new TouchEvent('touchmove', { touches: [new Touch({ identifier: 1, target: document.body }), new Touch({ identifier: 2, target: document.body })], cancelable: true }); document.dispatchEvent(e); return e.defaultPrevented; })).toBe(true);
  expect(await app.ev(() => { const e = new Event('gesturestart', { cancelable: true }); document.dispatchEvent(e); return e.defaultPrevented; })).toBe(true);
  expect(await app.ev(() => { const e = new TouchEvent('touchmove', { touches: [new Touch({ identifier: 1, target: document.body })], cancelable: true }); document.dispatchEvent(e); return e.defaultPrevented; })).toBe(false);
  // Long press on a circle: its context menu; the tap that ends it is swallowed.
  await show(app, { kind: 'circles', title: 'T2', circles: many(6) });
  await touch('touchstart', 100, 300, '.circle[data-id="i0"] .label');
  await app.tick(600);
  await expect(app.page.locator('#ctx')).toBeVisible();
  const swallowed = await app.ev(() => { const e = new MouseEvent('click', { bubbles: true, cancelable: true }); document.body.dispatchEvent(e); return e.defaultPrevented; });
  expect(swallowed).toBe(true);
  await touch('touchend', 100, 300, '.circle[data-id="i0"] .label');
  // Long press on an empty place or another screen kind: nothing.
  await touch('touchstart', 600, 700, '#stage');
  await touch('touchcancel', 600, 700, '#stage');
  // A swipe on an html scene is the scene's.
  await show(app, { kind: 'html', local: 'x', title: 'H', html: '' });
  await touch('touchstart', 600, 600);
  await touch('touchend', 600, 300);
});

test('a click on empty space starts typing; not on controls, scenes or with other buttons', async ({ app }) => {
  await app.open({ native: true });
  await app.page.mouse.click(640, 760);
  await expect(app.page.locator('body')).toHaveClass(/typing/);
  await app.page.keyboard.press('Escape');
  await expect(app.page.locator('body')).not.toHaveClass(/typing/);
  await app.page.mouse.click(640, 760, { button: 'right' });
  await expect(app.page.locator('body')).not.toHaveClass(/typing/);
  await app.page.keyboard.press('Escape');
  await show(app, { kind: 'html', local: 'x', title: 'H', html: '' });
  await app.page.locator('#view').dispatchEvent('pointerdown', { button: 0, pointerType: 'mouse' });
  await expect(app.page.locator('body')).not.toHaveClass(/typing/);
  await app.page.locator('#toast').dispatchEvent('pointerdown', { button: 0, pointerType: 'mouse' });
  await app.page.locator('#write').dispatchEvent('pointerdown', { button: 0, pointerType: 'mouse' });
  await app.page.locator('body').dispatchEvent('pointerdown', { button: 0, pointerType: 'touch' });
  await expect(app.page.locator('body')).not.toHaveClass(/typing/);
});

test('keys: a typed character opens the input; modifiers and editable targets are left alone', async ({ app }) => {
  await app.open({ native: true });
  await app.page.keyboard.press('h');
  await expect(app.page.locator('body')).toHaveClass(/typing/);
  await expect(app.page.locator('#write')).toHaveValue('h');
  await app.page.keyboard.press('Escape');
  await app.ev(() => { const i = document.createElement('input'); i.id = 'tmp'; document.body.appendChild(i); i.focus(); });
  await app.page.keyboard.press('x');
  await app.page.keyboard.press('Escape');
  await app.page.keyboard.press('Backspace');
  await app.ev(() => document.getElementById('tmp').remove());
  await expect(app.page.locator('body')).not.toHaveClass(/typing/);
  await app.ev(() => onKey(new KeyboardEvent('keydown', { key: 'x', altKey: true })));
  await app.ev(() => onKey(new KeyboardEvent('keydown', { key: 'F5' })));
  await expect(app.page.locator('body')).not.toHaveClass(/typing/);
  // Escape while busy cancels.
  const d = deferred();
  app.api = routes({ ai: () => d.promise });
  await app.ev(() => { ask({ event: 'go' }, {}); });
  await app.ev(() => onKey(new KeyboardEvent('keydown', { key: 'Escape' })));
  expect(await app.ev(() => busy)).toBe(false);
  await app.ev(() => onKey(new KeyboardEvent('keydown', { key: 'Escape' })));
});

test('home and the address: other paths keep their place; switching and closing them', async ({ app }) => {
  await app.open({ native: true, api: routes({ window: (b) => (b.op === 'address' ? { native: true } : { ok: true }) }) });
  await app.ev(() => { stack = [{ screen: clone(ROOT), label: null }]; current = { screen: { kind: 'circles', title: 'Work', circles: [{ id: 'a', label: 'A' }] }, label: 'Work' }; render(); });
  await app.ev(() => showWhoScreen());
  await expect(app.page.locator('#title')).toHaveText('Is it still you?');
  const addr = app.sent('window', 'address').at(-1).body;
  expect(addr.items).toEqual(['AI UI', '👤']);
  expect(addr.others).toEqual([{ title: 'Work', full: 'AI UI › Work' }]);
  await expect(app.page.locator('html')).toHaveClass(/native-address/);
  await expect(app.page.locator('#paths .path-tab')).toHaveCount(1);
  await app.page.locator('#paths .path-tab button').first().dispatchEvent('click');
  await expect(app.page.locator('#title')).toHaveText('Work');
  await expect(app.page.locator('#paths .path-tab button').first()).toHaveText('👤');
  await app.page.locator('#paths .path-x').dispatchEvent('click');
  await expect(app.page.locator('#paths .path-tab')).toHaveCount(0);
  // Opening an app screen again returns to its path.
  await app.ev(() => showWhoScreen());
  await app.ev(() => switchPath(0));
  await app.ev(() => showWhoScreen());
  expect(await app.ev(() => paths.length)).toBe(1);
  // Deeper in its own path: pushed.
  await app.ev(() => pushPath({ kind: 'circles', local: 'who', title: 'Deeper', circles: [] }, 'D'));
  expect(await app.ev(() => stack.length)).toBe(2);
  // goTo levels; switchPath to nothing.
  await app.ev(() => { switchPath(9); goTo(1); });
  await expect(app.page.locator('#title')).toHaveText('Is it still you?');
  await app.ev(() => goTo(0));
  await expect(app.page.locator('#title')).toHaveText('');
  // From the bare root: nothing kept when switching away.
  const n = await app.ev(() => paths.length);
  await app.ev(() => showWhoScreen());
  expect(await app.ev(() => paths.length)).toBe(n);
  // Switching while busy cancels; goTo while busy too.
  const d = deferred();
  app.api = routes({ ai: () => d.promise });
  await app.ev(() => { ask({ event: 'go' }, {}); switchPath(0); });
  expect(await app.ev(() => busy)).toBe(false);
  await app.ev(() => { ask({ event: 'go' }, {}); goTo(5); });
  expect(await app.ev(() => busy)).toBe(false);
  // The address bar of a path whose entries have no labels: their titles.
  expect(await app.ev(() => pathLabels({ stack: [{}, { screen: { title: 'T' } }, {}], current: { screen: {} } }))).toEqual(['T', '', '']);
  expect(await app.ev(() => pathLabels({ stack: [], current: { label: 'x' } }))).toEqual([]);
});
