// Shared helpers for the specs.
import { expect } from '../harness.mjs';

// A native backend from a map: name → value, or (body, calls) => value; anything else → default.
export const routes = (map) => async (name, body, dflt) => {
  if (!(name in map)) return undefined;
  const v = map[name];
  return typeof v === 'function' ? v(body, dflt) : v;
};

export const circles = (...labels) => labels.map((l, i) => (typeof l === 'string' ? { id: 'c' + i, label: l } : l));
export const circleScreen = (title, list, extra = {}) => ({ kind: 'circles', title, circles: circles(...list), ...extra });

// The labels of the circles on display (visible page only).
export const labels = (app) => app.page.$$eval('#circles .circle:not([hidden]) .label', (ns) => ns.map((n) => n.textContent));
export const title = (app) => app.page.textContent('#title');

// Waits until a predicate evaluated in the page holds.
export async function until(app, fn, arg, timeout = 5000) {
  await expect.poll(() => app.ev(fn, arg), { timeout }).toBeTruthy();
}

// Deferred: a promise resolved by hand (to hold a fake backend's answer).
export function deferred() {
  let resolve, reject;
  const promise = new Promise((a, b) => { resolve = a; reject = b; });
  promise.catch(() => {}); // rejected before anyone listens: not an unhandled rejection in the test
  return { promise, resolve, reject };
}

export const err = (message, status) => Object.assign(new Error(message), status ? { status } : {});

// Clicks the circle whose label starts with `label` (hints don't count).
const reEsc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
export const clickCircle = (app, label) => app.page.locator('#circles .circle:not([hidden])', { has: app.page.locator('.label', { hasText: new RegExp('^' + reEsc(label)) }) })
  .first().locator('.face').click();

// The first child frame holding `sel` (for app-owned scenes; AI scenes also have lab clones).
export async function frameWith(app, sel, timeout = 10000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    for (const f of app.page.frames()) {
      if (f === app.page.mainFrame()) continue;
      try { if (await f.$(sel)) return f; } catch {}
    }
    await app.page.waitForTimeout(50);
  }
  throw new Error('no frame with ' + sel);
}
