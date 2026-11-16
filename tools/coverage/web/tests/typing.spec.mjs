// Typing: the input over the circles, live matches, AI suggestions, known circles, autocomplete.
import { test, expect } from '../harness.mjs';
import { routes, circleScreen, labels, until, deferred, err } from './util.mjs';

const show = (app, screen) => app.ev((s) => { current.screen = normalize(s); render(); }, screen);
const typeText = async (app, text) => { await app.page.keyboard.type(text); };

test('typing shows the typed circle, matching circles of the screen and known ones; Enter sends', async ({ app }) => {
  await app.open({ native: true, api: routes({
    ai: (b) => ({ screen: circleScreen('Answer to ' + b.text, ['a']) }),
    suggest: () => ({ circles: [{ id: 'm', label: 'Mail Bob' }, { label: 'Search mail' }, {}], focus: 'm' }),
    usage: (b, d) => (b.op === 'applets' ? { applets: [{ key: 'mailapp', title: 'Mail sorter', opens: 3 }, { key: 'x', title: 'Other' }] } : d('usage', b)),
  }) });
  await show(app, { kind: 'circles', title: 'Root', circles: [
    { id: 'a', label: 'Send mail' }, { id: 'b', label: 'Mailbox', hint: 'inbox' }, { id: 'c', label: 'Remail' }, { id: 'd', label: 'Notes', hint: 'mail notes' }, { id: 'e', label: 'Zed' }, { id: 'r', label: 'gone mail', removed: true }] });
  await typeText(app, 'mail');
  await expect(app.page.locator('#write')).toHaveValue('mail');
  const l = await labels(app);
  expect(l.slice(0, 5)).toEqual(['mail', 'Mailbox', 'Send mail', 'Remail', 'Notes']);
  expect(l).toContain('Mail sorter'); // a known applet
  await expect(app.page.locator('.circle[data-id="__typed"]')).toHaveClass(/focused/);
  await expect(app.page.locator('.circle[data-id="__typed"] .hint')).toHaveText('as typed');
  // Suggestions after a pause.
  await app.tick(700);
  await expect.poll(() => labels(app)).toContain('Mail Bob');
  expect(app.sent('suggest')[0].body).toMatchObject({ input: 'mail', path: [], screen: { title: 'Root' } });
  await expect(app.page.locator('.circle[data-id="s~m"]')).toHaveClass(/heading/);
  await expect(app.page.locator('body')).not.toHaveClass(/suggesting/);
  // Enter sends the text.
  await app.page.keyboard.press('Enter');
  await expect(app.page.locator('#title')).toHaveText('Answer to mail');
  expect(app.sent('ai')[0].body).toMatchObject({ event: 'text', text: 'mail', direct: true });
  expect(await app.ev(() => JSON.parse(localStorage.getItem('aiui.typed')))).toEqual(['mail']);
});

test('the AI\'s understanding replaces the raw text; a long text is shortened; Enter on another circle opens it with the text', async ({ app }) => {
  await app.open({ native: true, api: routes({
    ai: (b) => ({ screen: circleScreen('Done', ['d']) }),
    suggest: (b) => ({ understood: { label: 'Write an email', icon: '📧' }, circles: [] }),
  }) });
  await show(app, { kind: 'circles', title: 'R', circles: [{ id: 'a', label: 'Alpha' }] });
  await typeText(app, 'write mail to bob please about the long meeting tomorrow');
  await expect(app.page.locator('.circle[data-id="__typed"] .label')).toHaveText('write mail to bob please about the long …');
  await app.tick(700);
  await expect(app.page.locator('.circle[data-id="__typed"] .label')).toHaveText('Write an email');
  await expect(app.page.locator('.circle[data-id="__typed"] .hint')).toHaveText('as understood');
  await app.page.keyboard.press('Enter');
  await expect(app.page.locator('#title')).toHaveText('Done');
  const b = app.sent('ai')[0].body;
  expect(b.understood).toBe('Write an email');
  expect(app.sent('ai').length).toBe(1);
  // Typing then opening another circle sends the text as context.
  await show(app, { kind: 'circles', title: 'R2', circles: [{ id: 'a', label: 'Alpha' }] });
  await typeText(app, 'al');
  await app.page.keyboard.press('ArrowRight');
  await app.page.keyboard.press('Enter');
  await expect.poll(() => app.sent('ai').length).toBe(2);
  expect(app.sent('ai')[1].body).toMatchObject({ event: 'open', target: { id: 'a' }, text: 'al' });
  // A long text sent raw gets a short label.
  await show(app, { kind: 'circles', title: 'R3', circles: [] });
  await app.ev(() => { startWriting('a very long sentence that goes on and on'); submitText(); });
  await expect.poll(() => app.sent('ai').length).toBe(3);
  expect(await app.ev(() => current.label)).toBe('a very long sentence that …');
});

test('suggestions: stale answers dropped; errors flash; paused or local screens do not ask', async ({ app }) => {
  let mode = 'fail', slow = 0;
  const d = deferred();
  await app.open({ native: true, api: routes({ suggest: () => (mode === 'fail' ? Promise.reject(err('x')) : mode === 'noai' ? Promise.reject(err('no-ai')) : mode === 'cancel' ? Promise.reject(err('cancelled')) : ++slow === 1 ? d.promise : { circles: [{ label: 'fresh' }] }) }) });
  await show(app, { kind: 'circles', title: 'R', circles: [] });
  await typeText(app, 'abc');
  await app.tick(700);
  await expect(app.page.locator('#status')).toHaveText('no suggestions');
  mode = 'noai';
  await typeText(app, 'd');
  await app.tick(700);
  await expect(app.page.locator('#status')).toHaveText('no AI connected');
  mode = 'cancel';
  await typeText(app, 'e');
  await app.tick(700);
  await app.settle();
  await expect(app.page.locator('#status')).toHaveText(/thinking about/);
  mode = 'slow';
  await typeText(app, 'f');
  await app.tick(700);
  await typeText(app, 'g');
  await app.tick(700); // a newer request: the older answer is stale
  d.resolve({ circles: [{ label: 'late' }] });
  await app.settle();
  expect(await labels(app)).toContain('fresh');
  expect(await labels(app)).not.toContain('late');
  // A long query in the status line.
  await app.ev(() => { suggestFor('x'.repeat(40)); });
  await expect(app.page.locator('#status')).toHaveText('thinking about “' + 'x'.repeat(28) + '…”');
  // Clearing the input clears the suggestions.
  await app.ev(() => { el.write.value = ''; onInput(); });
  expect(await app.ev(() => live.circles.length)).toBe(0);
  // Paused: no suggestion timer.
  const n = app.sent('suggest').length;
  await app.ev(() => { paused = true; el.write.value = 'zz'; onInput(); paused = false; });
  await app.tick(700);
  expect(app.sent('suggest').length).toBe(n);
  // On a non-circle screen typing doesn't re-render circles.
  await app.ev(() => stopWriting(true));
  await show(app, { kind: 'text', title: 'T', text: '' });
  await app.ev(() => { el.write.value = 'x'; onInput(); });
});

test('autocomplete from earlier texts; Tab or End accepts; Shift/⌥+Enter add a line; Backspace on empty closes', async ({ app }) => {
  await app.open({ native: true, storage: { 'aiui.typed': ['weather in Paris', 'what now'] } });
  await typeText(app, 'wea');
  await expect(app.page.locator('#write')).toHaveValue('weather in Paris');
  expect(await app.ev(() => [el.write.selectionStart, el.write.selectionEnd, typedText()])).toEqual([3, 16, 'wea']);
  await app.page.keyboard.press('Tab');
  expect(await app.ev(() => [el.write.selectionStart, typedText()])).toEqual([16, 'weather in Paris']);
  await app.page.keyboard.press('Shift+Enter');
  await app.page.keyboard.press('Alt+Enter');
  expect(await app.ev(() => el.write.value)).toBe('weather in Paris\n\n');
  await app.ev(() => { el.write.value = ''; });
  await app.page.keyboard.press('Backspace');
  await expect(app.page.locator('body')).not.toHaveClass(/typing/);
  // One character: no autocomplete; no match: nothing.
  await typeText(app, 'w');
  await expect(app.page.locator('#write')).toHaveValue('w');
  await typeText(app, 'zz');
  await expect(app.page.locator('#write')).toHaveValue('wzz');
  await app.page.keyboard.press('End');
  // Arrows with modifiers edit the text.
  await app.page.keyboard.press('Shift+ArrowLeft');
  await app.page.keyboard.press('ArrowDown');
  await app.page.keyboard.press('Escape');
  // Corrupt history.
  await app.ev(() => localStorage.setItem('aiui.typed', '{bad'));
  expect(await app.ev(() => typedHistory())).toEqual([]);
  await app.ev(() => { Storage.prototype.setItem = () => { throw new Error('quota'); }; rememberTyped('x'); });
});

test('typing on text screens: Go becomes Send; Enter sends; Esc leaves the screen', async ({ app }) => {
  await app.open({ native: true, api: routes({ ai: (b) => ({ screen: circleScreen('Got ' + b.text, ['x']) }) }) });
  await app.ev(() => push({ kind: 'text', title: 'Draft', text: 'hello' }, 'Draft'));
  await expect(app.page.locator('body')).toHaveClass(/typing-text/);
  await expect(app.page.locator('#write')).toHaveAttribute('placeholder', '');
  await expect(app.page.locator('#go')).toHaveText('Send');
  await app.page.click('#go');
  await expect(app.page.locator('#title')).toHaveText('Got hello');
  await app.ev(() => push({ kind: 'text', title: 'Draft2', go: 'Post', text: 'x' }, 'D2'));
  await expect(app.page.locator('#go')).toHaveText('Post');
  await app.page.keyboard.press('Enter');
  await expect(app.page.locator('#title')).toHaveText('Got x');
  await app.ev(() => push({ kind: 'text', title: 'Draft3', text: '' }, 'D3'));
  await app.page.keyboard.press('Enter'); // empty: nothing
  await app.page.keyboard.press('Escape');
  await expect(app.page.locator('#title')).toHaveText('Got x');
  // The × button closes the input.
  await app.ev(() => startWriting('abc'));
  await app.page.locator('#close').dispatchEvent('mousedown');
  await expect(app.page.locator('body')).not.toHaveClass(/typing/);
  // Esc while busy cancels the send and clears.
  const d = deferred();
  app.api = routes({ ai: () => d.promise });
  await app.ev(() => { startWriting('q'); ask({ event: 'go' }, {}); escapeWriting(); });
  expect(await app.ev(() => busy)).toBe(false);
  // Placeholder on scenes.
  await show(app, { kind: 'html', local: 'x', title: 'S', html: '' });
  await app.ev(() => startWriting(''));
  await expect(app.page.locator('#write')).toHaveAttribute('placeholder', /Type about this scene/);
  await app.page.keyboard.press('Enter');
});

test('keys typed on a scene open the input; a lone ⌘ too; ⌘T anywhere', async ({ app }) => {
  await app.open({ native: true });
  await app.ev(() => typeFromScene('a'));
  await expect(app.page.locator('#write')).toHaveValue('a');
  await app.ev(() => typeFromScene('b'));
  await expect(app.page.locator('#write')).toHaveValue('ab');
  await app.ev(() => { typeFromScene(''); stopWriting(true); });
  // A lone ⌘ press.
  await app.page.keyboard.down('Meta');
  await app.page.keyboard.up('Meta');
  await expect(app.page.locator('body')).toHaveClass(/typing/);
  await app.page.keyboard.press('Escape');
  // ⌘ held too long, or used with a key the menu took: no input.
  await app.page.keyboard.down('Meta');
  await app.tick(700);
  await app.page.keyboard.up('Meta');
  await app.page.keyboard.down('Meta');
  await app.ev(() => aiui.menuUsed());
  await app.page.keyboard.up('Meta');
  await app.page.keyboard.down('Meta');
  await app.ev(() => { document.dispatchEvent(new MouseEvent('mousedown')); window.dispatchEvent(new Event('blur')); });
  await app.page.keyboard.up('Meta');
  await expect(app.page.locator('body')).not.toHaveClass(/typing/);
  await app.page.keyboard.press('Meta+t');
  await expect(app.page.locator('body')).toHaveClass(/typing/);
  await app.page.keyboard.press('Escape');
  // While busy, a lone ⌘ does nothing.
  const d = deferred();
  app.api = routes({ ai: () => d.promise });
  await app.ev(() => { ask({ event: 'go' }, {}); typeFromScene(''); });
  await expect(app.page.locator('body')).not.toHaveClass(/typing/);
});

test('known circles: actions, root circles from deeper screens, other levels and paths, applets; they open where they live', async ({ app }) => {
  await app.open({ native: true, api: routes({
    ai: (b) => ({ screen: circleScreen('Opened ' + b.target.label, ['x']) }),
    usage: (b, d) => (b.op === 'applets' ? { applets: [{ key: 'ap1', title: 'Budget planner', opens: 2 }, { key: 'cur', title: 'Current one' }] } : b.op === 'outcome' ? { screen: { kind: 'html', title: 'Budget planner', html: '' } } : d('usage', b)),
  }) });
  await app.ev(() => {
    paths = [{ stack: [{ screen: clone(ROOT), label: null }], current: { screen: { kind: 'circles', title: 'Trips', circles: [{ id: 't1', label: 'Paris trip' }] }, label: 'Trips' }, forwardStack: [] }];
    stack = [{ screen: clone(ROOT), label: null }, { screen: { kind: 'circles', title: 'L1', circles: [{ id: 'l1', label: 'Packing list' }, { id: 'ty', label: 'typed', typed: true }] }, label: 'L1' }];
    current = { screen: { kind: 'circles', title: 'L2', circles: [{ id: 'z', label: 'Zz' }] }, label: 'L2', key: 'cur' };
    render();
  });
  await typeText(app, 'pa');
  await expect.poll(() => labels(app)).toEqual(expect.arrayContaining(['Paris trip', 'Packing list']));
  const hints = await app.page.$$eval('#circles .circle .hint', (ns) => ns.map((n) => n.textContent));
  expect(hints).toContain('L1');
  expect(hints).toContain('Trips');
  // Open the circle of the other path: switches there, opens it.
  await app.page.locator('.circle', { hasText: 'Paris trip' }).locator('.face').click();
  await expect(app.page.locator('#title')).toHaveText('Opened Paris trip');
  expect(await app.ev(() => paths.length)).toBe(1);
  // A level of this path.
  await app.ev(() => switchPath(0));
  await typeText(app, 'pack');
  await app.page.locator('.circle', { hasText: 'Packing list' }).locator('.face').click();
  await expect(app.page.locator('#title')).toHaveText('Opened Packing list');
  // A root circle from deep.
  await typeText(app, 'creat');
  await app.page.locator('.circle', { hasText: 'Create' }).first().locator('.face').click();
  await expect(app.page.locator('#title')).toHaveText('Opened Create');
  // An applet (after the 60 s throttle the list is fetched again).
  await app.tick(61000);
  await typeText(app, 'budg');
  await expect.poll(() => labels(app)).toContain('Budget planner');
  await app.page.locator('.circle', { hasText: 'Budget planner' }).locator('.face').click();
  await expect(app.page.locator('#title')).toHaveText('Budget planner');
  // An instant action.
  await app.ev(() => home());
  await typeText(app, 'console');
  await app.page.locator('.circle', { has: app.page.locator('.label', { hasText: /^Console$/ }) }).locator('.face').click();
  await expect(app.page.locator('#console')).toBeVisible();
  // The applets list failing.
  app.api = routes({ usage: () => Promise.reject(err('x')) });
  await app.tick(61000);
  await app.ev(() => { toggleConsole(false); startWriting('q'); onInput(); });
  await app.settle();
});
