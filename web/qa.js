// AI UI scene QA — injected into every AI-made view (and into its hidden lab clone).
// Measures layout, readability, accessibility and UX quality as 0–100 scores with issues, and in
// the lab clone exercises every interaction with aiui mocked. Reports to the app by postMessage:
//   real view : { aiuiReview:   { issues, scores, report, width, height } }  after ready() / 4 s
//   lab clone : { aiuiInteract: { issues, scores, report, tested, listens, width, height } }
// window.__qaMode ('review' | 'lab') is set before this script.
(() => {
  const mode = window.__qaMode || 'review';
  const lab = mode === 'lab';
  const testsMode = mode === 'tests';
  // Keep the real timer: the lab counts scheduling done by the view as activity, not ours.
  const wait = (ms) => new Promise((r) => (window.__realSetTimeout || setTimeout)(r, ms));
  const errors = [];
  addEventListener('error', (e) => errors.push(e.message || 'error'));
  addEventListener('unhandledrejection', (e) => errors.push('unhandled: ' + ((e.reason && e.reason.message) || e.reason)));
  const t0 = performance.now();
  let readyAt = 0;

  const desc = (el) => el.tagName.toLowerCase() + (el.id ? '#' + el.id : '') + ' "' +
    (el.innerText || el.value || el.alt || el.title || el.getAttribute('aria-label') || '').trim().replace(/\s+/g, ' ').slice(0, 32) + '"';
  const visible = (el) => {
    const r = el.getBoundingClientRect(), cs = getComputedStyle(el);
    return r.width > 1 && r.height > 1 && cs.visibility !== 'hidden' && cs.display !== 'none' && +cs.opacity > 0.05;
  };

  // ---- colour and contrast (WCAG)
  const rgba = (c) => { const m = String(c).match(/[\d.]+/g); return m ? m.map(Number) : null; };
  const lum = ([r, g, b]) => { const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b); };
  const pageBg = () => {
    try { const c = rgba(getComputedStyle(parent.document.body).backgroundColor); if (c) return c; } catch {}
    const hex = getComputedStyle(document.documentElement).getPropertyValue('--bg').trim().match(/^#?([\da-f]{6})$/i);
    if (!hex) return [255, 255, 255];
    const n = parseInt(hex[1], 16);
    return [n >> 16, (n >> 8) & 255, n & 255];
  };
  const bgOf = (el) => {
    for (let e = el; e; e = e.parentElement) {
      const cs = getComputedStyle(e);
      if (cs.backgroundImage !== 'none') return null;           // over an image/gradient: can't judge
      const c = rgba(cs.backgroundColor);
      if (c && (c[3] == null || c[3] > 0.5)) return c;
    }
    return pageBg();
  };
  const contrast = (a, b) => { const x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };

  const textEls = () => [...document.body.querySelectorAll('*')].filter((el) => visible(el) &&
    [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim().length > 1)).slice(0, 250);

  // ---- layout
  function layout(issues) {
    const W = innerWidth, doc = document.documentElement;
    if (doc.scrollWidth > W + 4) issues.push(['layout', `content wider than the screen (${doc.scrollWidth}px > ${W}px)`]);
    const texts = textEls();
    for (const el of texts) {
      const r = el.getBoundingClientRect(), cs = getComputedStyle(el);
      if (r.right > W + 4 || r.left < -4) issues.push(['layout', `${desc(el)} is cut off at the ${r.left < -4 ? 'left' : 'right'} edge`]);
      if ((el.scrollWidth > el.clientWidth + 2 || el.scrollHeight > el.clientHeight + 2) && /hidden|clip/.test(cs.overflow + cs.overflowX + cs.overflowY)
          && cs.textOverflow !== 'ellipsis' && !/\d/.test(cs.webkitLineClamp || '')) issues.push(['layout', `${desc(el)} text is cropped by its box`]);
    }
    let overlaps = 0;
    for (let i = 0; i < texts.length && overlaps < 6; i++) for (let j = i + 1; j < texts.length && overlaps < 6; j++) {
      const a = texts[i], b = texts[j]; if (a.contains(b) || b.contains(a)) continue;
      const r1 = a.getBoundingClientRect(), r2 = b.getBoundingClientRect();
      const ix = Math.max(0, Math.min(r1.right, r2.right) - Math.max(r1.left, r2.left));
      const iy = Math.max(0, Math.min(r1.bottom, r2.bottom) - Math.max(r1.top, r2.top));
      if (ix * iy > 0.3 * Math.min(r1.width * r1.height, r2.width * r2.height)) { overlaps++; issues.push(['layout', `${desc(a)} overlaps ${desc(b)}`]); }
    }
    for (const img of document.images) if (img.complete && img.naturalWidth === 0 && img.src) issues.push(['layout', `broken image ${img.src.slice(0, 120)}`]);
    if (!document.body.innerText.trim() && !document.querySelector('canvas,svg,img,video,iframe')) issues.push(['layout', 'the screen looks empty']);
    if (/loading|завантаж|загруж|cargando|chargement|\.\.\.$|…$/i.test(document.body.innerText.trim().split('\n').filter(Boolean).slice(-1)[0] || '') &&
        document.body.innerText.trim().length < 60) issues.push(['layout', 'still showing only a loading message']);
    return texts;
  }

  // ---- readability
  function readability(issues, texts) {
    const metrics = { smallText: 0, longLines: 0, texts: texts.length };
    for (const el of texts) {
      const cs = getComputedStyle(el), size = parseFloat(cs.fontSize), r = el.getBoundingClientRect();
      if (size < 12) metrics.smallText++;
      const chars = r.width / (size * 0.5);
      if (chars > 95 && el.innerText.length > 120) metrics.longLines++;
    }
    if (metrics.smallText) issues.push(['readability', `${metrics.smallText} text element(s) smaller than 12px`]);
    if (metrics.longLines) issues.push(['readability', `${metrics.longLines} paragraph(s) with lines over ~95 characters`]);
    return metrics;
  }

  // ---- accessibility
  function accessibility(issues, texts) {
    const m = { lowContrast: 0, noAlt: 0, unnamed: 0, unlabeled: 0, smallTargets: 0 };
    for (const el of texts) {
      const fg = rgba(getComputedStyle(el).color), bg = bgOf(el);
      if (!fg || !bg || (fg[3] != null && fg[3] < 0.5)) continue;
      const size = parseFloat(getComputedStyle(el).fontSize), bold = +getComputedStyle(el).fontWeight >= 600;
      const need = size >= 24 || (size >= 18.66 && bold) ? 3 : 4.5;
      const c = contrast(fg, bg);
      if (c < need) { m.lowContrast++; if (m.lowContrast <= 4) issues.push(['accessibility', `${desc(el)} contrast ${c.toFixed(1)}:1 (needs ${need}:1)`]); }
    }
    for (const img of document.images) if (visible(img) && !img.hasAttribute('alt')) m.noAlt++;
    if (m.noAlt) issues.push(['accessibility', `${m.noAlt} image(s) without alt text`]);
    const controls = [...document.querySelectorAll('button, a[href], [role=button]')].filter(visible);
    for (const c of controls) if (!(c.innerText || c.getAttribute('aria-label') || c.title || (c.querySelector('img[alt]') || {}).alt || '').trim()) m.unnamed++;
    if (m.unnamed) issues.push(['accessibility', `${m.unnamed} button(s)/link(s) without an accessible name`]);
    for (const i of document.querySelectorAll('input:not([type=hidden]), select, textarea')) {
      if (!visible(i)) continue;
      const labelled = i.getAttribute('aria-label') || i.placeholder || i.title || (i.id && document.querySelector(`label[for="${i.id}"]`)) || i.closest('label');
      if (!labelled) m.unlabeled++;
    }
    if (m.unlabeled) issues.push(['accessibility', `${m.unlabeled} input(s) without a label`]);
    if (innerWidth <= 500) {
      for (const c of [...controls, ...document.querySelectorAll('input, select')]) {
        const r = c.getBoundingClientRect();
        if (visible(c) && (r.width < 40 || r.height < 40) && !(c.tagName === 'A' && c.closest('p'))) m.smallTargets++;
      }
      if (m.smallTargets) issues.push(['accessibility', `${m.smallTargets} touch target(s) smaller than 44px on a phone`]);
    }
    return m;
  }

  // ---- interactions (lab only)
  async function interactions(issues) {
    const controls = [...document.querySelectorAll('button, a[href], input, select, textarea, summary, [onclick], [role=button], [tabindex]:not([tabindex="-1"])')];
    const pointers = [...document.body.querySelectorAll('*')].filter((e) => !controls.includes(e) && getComputedStyle(e).cursor === 'pointer'
      && !(e.parentElement && getComputedStyle(e.parentElement).cursor === 'pointer')).slice(0, 15);
    const els = [...controls, ...pointers].filter((el) => visible(el) && !el.disabled).slice(0, 40);
    let dead = 0, covered = 0, thrown = 0;
    for (const el of els) {
      if (!el.isConnected) continue;
      el.scrollIntoView({ block: 'center', inline: 'center' });
      const r = el.getBoundingClientRect();
      const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      if (hit && hit !== el && !el.contains(hit) && !hit.contains(el)) { covered++; issues.push(['ux', `${desc(el)} cannot be clicked: covered by ${desc(hit)}`]); continue; }
      let mutations = 0;
      const mo = new MutationObserver((ms) => { mutations += ms.length; });
      mo.observe(document.documentElement, { subtree: true, childList: true, attributes: true, characterData: true });
      const before = errors.length, calls = window.__mockCalls, act = window.__activity;
      try {
        if (el.matches('input:not([type=button]):not([type=submit]):not([type=checkbox]):not([type=radio]):not([type=range]), textarea')) {
          el.focus(); el.value = el.type === 'number' ? '3' : 'test';
          el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true }));
          el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
        } else if (el.tagName === 'SELECT') {
          if (el.options.length > 1) { el.selectedIndex = (el.selectedIndex + 1) % el.options.length; el.dispatchEvent(new Event('change', { bubbles: true })); }
        } else el.click();
      } catch (err) { errors.push(err.message); }
      await wait(200);
      mo.disconnect();
      if (errors.length > before) { thrown++; issues.push(['ux', `using ${desc(el)} throws: ${errors.slice(before).join('; ').slice(0, 160)}`]); }
      else if (!mutations && window.__mockCalls === calls && window.__activity === act && !el.matches('input, textarea, select, summary')) {
        dead++; issues.push(['ux', `${desc(el)} does nothing when used`]);
      }
    }
    for (const k of ['back', 'more']) {
      const fn = (window.__handlers || {})[k]; if (!fn) continue;
      const before = errors.length;
      try { await fn(); } catch (err) { errors.push(err.message); }
      if (errors.length > before) { thrown++; issues.push(['ux', `the scene's ${k} listener throws: ${errors.slice(before).join('; ').slice(0, 160)}`]); }
    }
    return { tested: els.length, dead, covered, thrown };
  }

  // ---- corner cases of interaction × UI (lab only): each recorded as {case, ok, note}
  async function cornerCases(issues) {
    const results = [];
    const record = (name, ok, note, area = 'ux') => { results.push({ case: name, ok, note }); if (!ok) issues.push([area, `${name}: ${note}`]); };
    const errs = () => errors.length;
    const controls = () => [...document.querySelectorAll('button, [role=button], a[href], summary')].filter((el) => visible(el) && !el.disabled).slice(0, 15);
    const inputs = () => [...document.querySelectorAll('input:not([type=hidden]):not([type=button]):not([type=submit]):not([type=checkbox]):not([type=radio]):not([type=range]):not([type=file]), textarea')].filter(visible).slice(0, 6);
    const overflowNote = () => {
      const W = document.documentElement.clientWidth;
      if (document.documentElement.scrollWidth > W + 4) return `content ${document.documentElement.scrollWidth}px wide in ${W}px`;
      const cut = textEls().find((el) => { const r = el.getBoundingClientRect(); return r.right > W + 4 || r.left < -4; });
      return cut ? `${desc(cut)} cut off` : '';
    };

    // rapid double click
    { const before = errs(); for (const el of controls()) { try { el.click(); el.click(); } catch (e) { errors.push(e.message); } } await wait(250);
      record('rapid double click', errs() === before, errs() === before ? 'no errors' : errors.slice(before).join('; ').slice(0, 140)); }

    // keyboard only: Tab reaches controls, focus is visible, Enter/Space activate, Escape is safe
    { const focusables = [...document.querySelectorAll('button, a[href], input, select, textarea, [tabindex]:not([tabindex="-1"])')].filter(visible);
      const unreachable = focusables.filter((el) => el.tabIndex < 0).length;
      let invisibleFocus = 0;
      for (const el of focusables.slice(0, 10)) {
        const b = getComputedStyle(el); const before = b.outlineStyle + b.outlineWidth + b.boxShadow + b.borderColor + b.backgroundColor;
        el.focus(); const a = getComputedStyle(el); const after = a.outlineStyle + a.outlineWidth + a.boxShadow + a.borderColor + a.backgroundColor;
        if (document.activeElement === el && before === after && a.outlineStyle === 'none') invisibleFocus++;
      }
      const before = errs();
      for (const el of controls().slice(0, 6)) { el.focus(); for (const key of ['Enter', ' ']) el.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true })); }
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); await wait(200);
      record('keyboard: tab order', !unreachable, unreachable ? `${unreachable} control(s) removed from the tab order` : 'all reachable', 'accessibility');
      record('keyboard: visible focus', !invisibleFocus, invisibleFocus ? `${invisibleFocus} control(s) show no focus indicator` : 'focus visible', 'accessibility');
      record('keyboard: Enter / Space / Escape', errs() === before, errs() === before ? 'no errors' : errors.slice(before).join('; ').slice(0, 140)); }

    // inputs: empty + Enter, very long text, special text (emoji, RTL, quotes, tags) without HTML injection
    for (const [name, value] of [['empty input + Enter', ''], ['very long input', 'x'.repeat(5000)],
        ['special text', 'Ünïcødé 👩‍👩‍👧 שלום "quotes" & <b>bold</b><img src=x data-aiui-injected=1>']]) {
      const ins = inputs(); if (!ins.length) break;
      const before = errs();
      for (const i of ins) { i.focus(); i.value = value; i.dispatchEvent(new Event('input', { bubbles: true })); i.dispatchEvent(new Event('change', { bubbles: true }));
        i.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); (i.form || {}).requestSubmit && i.form.requestSubmit(); }
      await wait(300);
      const injected = !!document.querySelector('img[data-aiui-injected]');
      const ov = name === 'very long input' ? overflowNote() : '';
      const ok = errs() === before && !injected && !ov;
      record(name, ok, injected ? 'typed HTML was rendered as markup (injection)' : ov || (ok ? 'handled' : errors.slice(before).join('; ').slice(0, 140)),
        injected ? 'security' : 'ux');
    }

    // offline: every fetch fails; the screen must not throw unhandled errors or go blank
    { const realFetch = window.fetch; window.fetch = () => Promise.reject(new TypeError('offline (test)'));
      const before = errs();
      for (const el of controls().slice(0, 6)) { try { el.click(); } catch (e) { errors.push(e.message); } }
      await wait(400);
      window.fetch = realFetch;
      const unhandled = errors.slice(before).filter((e) => /unhandled|offline/.test(e));
      const blank = !document.body.innerText.trim() && !document.querySelector('canvas,svg,img,video');
      record('offline', !unhandled.length && !blank, blank ? 'screen goes blank' : unhandled.length ? 'unhandled network error' : 'degrades gracefully'); }

    // narrow screen (320px) and large text (200%)
    { const html = document.documentElement, prevW = html.style.width, prevZ = document.body.style.zoom;
      html.style.width = '320px'; html.style.overflowX = 'auto'; await wait(100);
      // The content's real right edge (the frame itself stays wider than 320px).
      const n1 = (() => { const W = 320;
        const widest = [...document.body.querySelectorAll('*')].filter(visible).reduce((m, el) => Math.max(m, el.getBoundingClientRect().right), 0);
        if (widest > W + 4) { const cut = textEls().find((el) => el.getBoundingClientRect().right > W + 4);
          return cut ? `${desc(cut)} reaches ${Math.round(widest)}px at 320px` : `content reaches ${Math.round(widest)}px at 320px`; }
        return ''; })();
      html.style.width = prevW; html.style.overflowX = '';
      record('narrow screen (320px)', !n1, n1 || 'fits');
      document.body.style.zoom = '2'; await wait(100);
      const crop = textEls().filter((el) => { const cs = getComputedStyle(el); return (el.scrollWidth > el.clientWidth + 2 || el.scrollHeight > el.clientHeight + 2)
        && /hidden|clip/.test(cs.overflow + cs.overflowX + cs.overflowY) && cs.textOverflow !== 'ellipsis'; }).length;
      document.body.style.zoom = prevZ;
      record('large text (200%)', !crop, crop ? `${crop} text element(s) cropped` : 'readable', 'accessibility'); }

    // Back / More listeners twice in a row
    for (const k of ['back', 'more']) {
      const fn = (window.__handlers || {})[k]; if (!fn) continue;
      const before = errs();
      try { await fn(); await fn(); } catch (e) { errors.push(e.message); }
      record(`${k} twice`, errs() === before, errs() === before ? 'no errors' : errors.slice(before).join('; ').slice(0, 140));
    }
    return results;
  }

  // ---- scores: 100 minus weighted problems per area
  function scores(issues, m) {
    const count = (area) => issues.filter(([a]) => a === area).length;
    const clamp = (x) => Math.max(0, Math.min(100, Math.round(x)));
    const readyMs = readyAt ? readyAt - t0 : performance.now() - t0;
    return {
      ux: clamp(100 - count('layout') * 15 - (m.dead || 0) * 15 - (m.covered || 0) * 15 - (m.thrown || 0) * 25
        - (m.cornerFails || 0) * 10
        - errors.length * 10 - Math.max(0, readyMs - 3000) / 200),
      readability: clamp(100 - (m.smallText || 0) * 4 - (m.longLines || 0) * 6 - count('layout') * 5),
      accessibility: clamp(100 - (m.lowContrast || 0) * 8 - (m.noAlt || 0) * 5 - (m.unnamed || 0) * 8
        - (m.unlabeled || 0) * 8 - (m.smallTargets || 0) * 4 - count('accessibility') * 4),
      security: clamp(100 - count('security') * 60),
    };
  }

  // ---- the classes of objects on the scene (for context menus)
  function classesPresent() {
    const found = new Set();
    for (const el of document.body.querySelectorAll('*')) {
      if (!visible(el)) continue;
      const c = window.__aiuiClassify ? window.__aiuiClassify(el) : null;
      if (c && c !== 'empty-space') found.add(c);
      if (found.size > 12) break;
    }
    found.add('empty-space');
    return [...found];
  }

  // ---- AI-written tests for this scene (tests mode)
  async function aiTests() {
    const results = [];
    const T = {
      click: async (sel) => { const el = document.querySelector(sel); if (!el) throw new Error('no element ' + sel); el.click(); await wait(150); },
      type: async (sel, text) => { const el = document.querySelector(sel); if (!el) throw new Error('no element ' + sel); el.focus(); el.value = text;
        el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); await wait(150); },
      key: async (key, sel) => { const el = sel ? document.querySelector(sel) : (document.activeElement || document.body);
        el.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true })); el.dispatchEvent(new KeyboardEvent('keyup', { key, bubbles: true })); await wait(150); },
      wait: (ms) => wait(Math.min(ms, 2000)),
      text: (sel) => { const el = document.querySelector(sel); return el ? (el.innerText || el.value || '').trim() : ''; },
      count: (sel) => document.querySelectorAll(sel).length,
      exists: (sel) => !!document.querySelector(sel),
      expect: (cond, msg) => { if (!cond) throw new Error(msg || 'expectation failed'); },
    };
    for (const test of (window.__aiTests || []).slice(0, 8)) {
      const before = errors.length;
      try {
        const fn = new Function('t', 'aiui', `return (async () => { ${test.code} })();`);
        await Promise.race([fn(T, window.aiui), wait(3000).then(() => { throw new Error('timed out after 3 s'); })]);
        const err = errors.slice(before);
        results.push({ name: test.name, ok: !err.length, note: err.length ? err.join('; ').slice(0, 160) : 'passed' });
      } catch (e) {
        results.push({ name: test.name, ok: false, note: String(e && e.message || e).slice(0, 160) });
      }
    }
    return results;
  }

  let started = false;
  async function run() {
    if (started) return; started = true;
    if (testsMode) {
      let results = [];
      try { results = await aiTests(); } catch (e) { results = [{ name: 'tests', ok: false, note: String(e).slice(0, 160) }]; }
      parent.postMessage({ aiuiTests: { results } }, '*');
      return;
    }
    // Always report, even if a check itself breaks (with what broke).
    try { await runChecks(); } catch (err) {
      parent.postMessage({ [lab ? 'aiuiInteract' : 'aiuiReview']: { issues: [], scores: {}, qaError: String(err && err.stack || err).slice(0, 400),
        width: innerWidth, height: innerHeight } }, '*');
    }
  }
  async function runChecks() {
    const issues = [];
    const texts = layout(issues);
    const rd = readability(issues, texts);
    const ax = accessibility(issues, texts);
    const ix = lab ? await interactions(issues) : {};
    const corners = lab ? await cornerCases(issues) : [];
    ix.cornerFails = corners.filter((c) => !c.ok).length;
    for (const e of errors.slice(0, 3)) issues.push(['ux', `script error: ${String(e).slice(0, 140)}`]);
    const sc = scores(issues, { ...rd, ...ax, ...ix });
    const payload = {
      issues: [...new Set(issues.map(([a, t]) => `${a}: ${t}`))].slice(0, 16), scores: sc,
      report: { ...rd, ...ax, ...ix, errors: errors.length, readyMs: Math.round((readyAt || performance.now()) - t0) },
      corners, classes: lab ? [] : classesPresent(), tested: ix.tested || 0, listens: Object.keys(window.__handlers || {}), width: innerWidth, height: innerHeight,
    };
    parent.postMessage(lab ? { aiuiInteract: payload } : { aiuiReview: payload }, '*');
  }
  addEventListener('message', (e) => { if (e.data && e.data.aiuiReadySignal) { readyAt = performance.now(); wait(300).then(run); } });
  addEventListener('load', () => wait(lab || testsMode ? 4500 : 4000).then(run));
})();
