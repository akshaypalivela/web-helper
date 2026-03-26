// Content script: ghost mouse + AI tip bubble (idempotent if re-injected)

if (!window.__integrationGuideListeners) {
  window.__integrationGuideListeners = true;

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.type === 'IG_PING') {
      sendResponse({ ok: true });
      return true;
    }

    if (message.type === 'HIGHLIGHT_AT') {
      try {
        clearAllHighlights();
        drawGhostMouse(
          message.xPct,
          message.yPct,
          message.description,
          message.elementLabel,
          message.intentText || ''
        );
        sendResponse({ success: true });
      } catch (e) {
        console.error('[Integration Guide] highlight failed', e);
        sendResponse({ success: false, error: String(e?.message || e) });
      }
      return true;
    }

    if (message.type === 'CLEAR_HIGHLIGHTS') {
      clearAllHighlights();
      sendResponse({ success: true });
    }

    if (message.type === 'GET_PAGE_URL') {
      sendResponse({ url: window.location.href, title: document.title });
    }

    if (message.type === 'GET_PAGE_TEXT') {
      const text = document.body?.innerText?.replace(/\s+/g, ' ').trim().slice(0, 12000) || '';
      sendResponse({ text });
    }
  });

  let lastUrl = window.location.href;
  const urlObserver = new MutationObserver(() => {
    if (window.location.href !== lastUrl) {
      lastUrl = window.location.href;
      chrome.runtime.sendMessage({ type: 'URL_CHANGED', url: lastUrl, title: document.title });
    }
  });
  if (document.body) {
    urlObserver.observe(document.body, { childList: true, subtree: true });
  } else {
    document.addEventListener('DOMContentLoaded', () => {
      urlObserver.observe(document.body, { childList: true, subtree: true });
    });
  }
}

if (window === window.top && !window.__igDomObserver) {
  window.__igDomObserver = true;
  let domTimer = null;
  function mutationIsInteresting(m) {
    let el = m.target;
    if (el && el.nodeType === 3) el = el.parentElement;
    if (!el || el.nodeType !== 1) return true;
    try {
      if (el.closest?.('video, canvas')) return false;
    } catch (_) {}
    return true;
  }
  const domObserver = new MutationObserver((mutations) => {
    if (!mutations.some(mutationIsInteresting)) return;
    clearTimeout(domTimer);
    domTimer = setTimeout(() => {
      try {
        chrome.runtime.sendMessage({ type: 'GUIDANCE_DOM_CHANGED', url: window.location.href });
      } catch (_) {}
    }, 1400);
  });
  const startDomObs = () => {
    if (document.body) {
      domObserver.observe(document.body, { childList: true, subtree: true });
    }
  };
  if (document.body) startDomObs();
  else document.addEventListener('DOMContentLoaded', startDomObs);

  let ptrTimer = null;
  document.addEventListener(
    'pointerup',
    () => {
      clearTimeout(ptrTimer);
      ptrTimer = setTimeout(() => {
        try {
          chrome.runtime.sendMessage({ type: 'GUIDANCE_USER_INTERACTION', url: window.location.href });
        } catch (_) {}
      }, 850);
    },
    true
  );
}

function queryDeepMatchesSelector(rootEl, selector) {
  const out = [];
  const seen = new Set();
  function visit(node) {
    if (!node) return;
    if (node.nodeType === 1) {
      try {
        if (node.matches(selector) && !seen.has(node)) {
          seen.add(node);
          out.push(node);
        }
      } catch {
        return;
      }
      const kids = node.children;
      if (kids) {
        for (let i = 0; i < kids.length; i++) visit(kids[i]);
      }
      if (node.shadowRoot) visit(node.shadowRoot);
    } else if (node.nodeType === 11) {
      let c = node.firstElementChild;
      while (c) {
        visit(c);
        c = c.nextElementSibling;
      }
    }
  }
  visit(rootEl);
  return out;
}

function expandCollapsedAncestors(el) {
  if (!el || !(el instanceof Element)) return;
  const chain = [];
  let n = el;
  for (let i = 0; i < 30 && n; i++) {
    chain.push(n);
    n = n.parentElement;
  }
  for (const node of chain) {
    if (node.tagName === 'DETAILS' && !node.open) {
      try {
        node.open = true;
      } catch (_) {}
    }
  }
  n = el;
  for (let i = 0; i < 24 && n; i++) {
    const par = n.parentElement;
    if (par) {
      const toggles = par.querySelectorAll(
        ':scope > button[aria-expanded="false"], :scope > [role="button"][aria-expanded="false"]'
      );
      toggles.forEach((btn) => {
        try {
          btn.click();
        } catch (_) {}
      });
    }
    if (n.tagName === 'SUMMARY' && n.parentElement?.tagName === 'DETAILS' && !n.parentElement.open) {
      try {
        n.parentElement.open = true;
      } catch (_) {}
    }
    n = par;
  }
}

function findInteractiveTarget(fromEl) {
  const skip = new Set(['HTML', 'BODY', 'SCRIPT', 'STYLE', 'SVG']);
  let n = fromEl;
  for (let i = 0; i < 20 && n; i++) {
    if (n.nodeType !== 1) {
      n = n.parentElement;
      continue;
    }
    if (skip.has(n.tagName)) {
      n = n.parentElement;
      continue;
    }
    const tag = n.tagName;
    const role = n.getAttribute?.('role') || '';
    if (tag === 'A' && n.getAttribute('href')) return n;
    if (tag === 'BUTTON') return n;
    if (tag === 'INPUT' && /^(button|submit|reset|checkbox|radio|file|image)$/i.test(n.type || '')) return n;
    if (tag === 'SELECT' || tag === 'TEXTAREA') return n;
    if (/^(button|link|menuitem|tab|option|switch|checkbox|radio)$/i.test(role)) return n;
    const tab = n.getAttribute?.('tabindex');
    if (tab === '0' || (tab && !Number.isNaN(Number(tab)) && Number(tab) > 0)) {
      const r = n.getBoundingClientRect();
      if (r.width > 4 && r.height > 4) return n;
    }
    n = n.parentElement;
  }
  return fromEl?.nodeType === 1 ? fromEl : null;
}

function normalizeLabel(s) {
  if (!s || typeof s !== 'string') return '';
  return s
    .toLowerCase()
    .replace(/[‘’'`"]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function collectClickableCandidates(options = {}) {
  const visibleOnly = options.visibleOnly !== false;
  const sel =
    'a[href], button, [role="button"], [role="link"], [role="menuitem"], [role="tab"], [role="treeitem"], [role="switch"], [role="option"], input[type="submit"], input[type="button"], input[type="reset"], label[for], summary';
  const nodes = queryDeepMatchesSelector(document.documentElement, sel);
  const out = [];
  const vw = window.innerWidth;
  const vh = window.innerHeight;

  nodes.forEach((el) => {
    if (!(el instanceof HTMLElement)) return;
    const style = window.getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) return;
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return;
    if (visibleOnly) {
      if (r.bottom < -2 || r.top > vh + 2 || r.right < -2 || r.left > vw + 2) return;
    }
    const lines = (el.innerText || '')
      .split('\n')
      .map((t) => t.trim())
      .filter(Boolean);
    const text = lines.slice(0, 4).join(' ').slice(0, 200) || (el.textContent || '').trim().slice(0, 120);
    const aria = el.getAttribute('aria-label') || '';
    const title = el.getAttribute('title') || '';
    out.push({ el, r, text, aria, title });
  });
  return out;
}

function rectVisibleRatio(r, vw, vh) {
  const iw = Math.max(0, Math.min(r.right, vw) - Math.max(r.left, 0));
  const ih = Math.max(0, Math.min(r.bottom, vh) - Math.max(r.top, 0));
  const area = Math.max(1, r.width * r.height);
  return (iw * ih) / area;
}

function labelMatchScore(labelNorm, cand) {
  if (!labelNorm) return 0;
  const chunks = [cand.aria, cand.title, cand.text].map(normalizeLabel).filter(Boolean);
  let best = 0;
  for (const p of chunks) {
    if (p === labelNorm) best = Math.max(best, 100);
    else if (p.includes(labelNorm) && labelNorm.length >= 3) best = Math.max(best, 94);
    else if (labelNorm.includes(p) && p.length >= 4) best = Math.max(best, 88);
    else {
      const words = labelNorm.split(' ').filter((w) => w.length > 1);
      const hits = words.filter((w) => p.includes(w)).length;
      if (words.length && hits === words.length) best = Math.max(best, 86);
      else if (hits > 0) best = Math.max(best, 45 + hits * 12);
    }
  }
  return best;
}

function findBestElementByLabel(elementLabel, prefX, prefY, minScore = 70) {
  const labelNorm = normalizeLabel(elementLabel);
  if (!labelNorm) return null;

  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const candidates = collectClickableCandidates({ visibleOnly: false });
  const scored = candidates
    .map((c) => {
      const score = labelMatchScore(labelNorm, c);
      const cx = c.r.left + c.r.width / 2;
      const cy = c.r.top + c.r.height / 2;
      const dist = Math.hypot(prefX - cx, prefY - cy);
      const vis = rectVisibleRatio(c.r, vw, vh);
      return { el: c.el, r: c.r, score, dist, vis };
    })
    .filter((x) => x.score >= minScore);

  if (!scored.length) return null;
  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    if (b.vis !== a.vis) return b.vis - a.vis;
    return a.dist - b.dist;
  });
  return scored[0].el;
}

function isInLikelyNav(el) {
  if (!el || !(el instanceof Element)) return false;
  return Boolean(
    el.closest(
      'nav, aside, [role="navigation"], [data-testid*="nav" i], [data-testid*="sidebar" i], [class*="sidebar" i], [class*="SideNav" i], [class*="sidenav" i]'
    )
  );
}

/** When the user asks in one language but the UI is localized, add nav keywords to match visible text. */
const INTENT_SEMANTIC_KEYS = [
  {
    test: /\b(careers?|jobs?|hiring|recruit|join\s+us|work\s+with|employment)\b/i,
    keys: [
      'karriere',
      'karrieren',
      'stellen',
      'stellenangebote',
      'offene',
      'bewerbung',
      'jobs',
      'empleo',
      'carrera',
      'carreiras',
      'carrière',
      'carrières',
      'recrutement',
      'lavoro',
      'werken',
      'vacancies',
      'vacature',
    ],
  },
  {
    test: /\b(contact|support|help)\b/i,
    keys: ['kontakt', 'hilfe', 'support', 'ayuda', 'contacto', 'aide'],
  },
  {
    test: /\b(settings?|preferences?|account)\b/i,
    keys: ['einstellungen', 'konto', 'paramètres', 'configuración', 'preferencias'],
  },
];

function intentKeywordSet(intentText) {
  const keys = new Set();
  const raw = intentText || '';
  const n = normalizeLabel(raw);
  if (!n) return keys;
  n.split(/\s+/).forEach((w) => {
    if (w.length >= 4) keys.add(w);
  });
  for (const { test, keys: extra } of INTENT_SEMANTIC_KEYS) {
    if (test.test(raw)) {
      extra.forEach((k) => keys.add(k));
    }
  }
  if (/\bintegrat/i.test(raw)) keys.add('integrat');
  if (/\bhris\b/i.test(raw)) keys.add('hris');
  if (/\bapi\b/i.test(raw)) keys.add('api');
  if (/\bapp\b/i.test(raw)) keys.add('app');
  if (/\bsearch\b/i.test(raw)) keys.add('search');
  if (/\bhome\b/i.test(raw)) keys.add('home');
  if (/\busage\b/i.test(raw)) keys.add('usage');
  if (/\banalytics\b/i.test(raw)) keys.add('analytics');
  return keys;
}

function findElementByIntentKeywords(intentText, prefX, prefY) {
  const keys = intentKeywordSet(intentText);
  if (!keys.size) return null;

  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const candidates = collectClickableCandidates({ visibleOnly: false });
  const scored = [];

  for (const c of candidates) {
    const hay = normalizeLabel([c.text, c.aria, c.title].filter(Boolean).join(' '));
    if (!hay) continue;
    let s = 0;
    for (const k of keys) {
      if (hay.includes(k)) s += 42;
    }
    if (isInLikelyNav(c.el)) s += 22;
    if (s < 40) continue;
    const cx = c.r.left + c.r.width / 2;
    const cy = c.r.top + c.r.height / 2;
    const dist = Math.hypot(prefX - cx, prefY - cy);
    const vis = rectVisibleRatio(c.r, vw, vh);
    scored.push({ el: c.el, score: s, dist, vis });
  }

  if (!scored.length) return null;
  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    if (b.vis !== a.vis) return b.vis - a.vis;
    return a.dist - b.dist;
  });
  return scored[0].el;
}

function resolveHighlightTarget(elementLabel, intentText, prefX, prefY) {
  let target = findBestElementByLabel(elementLabel, prefX, prefY, 70);
  let matchedForScroll = Boolean(target && normalizeLabel(elementLabel));
  if (!target) {
    target = findBestElementByLabel(elementLabel, prefX, prefY, 52);
    matchedForScroll = Boolean(target && normalizeLabel(elementLabel));
  }
  if (!target) {
    target = findBestElementByLabel(elementLabel, prefX, prefY, 40);
    matchedForScroll = Boolean(target && normalizeLabel(elementLabel));
  }
  let fromIntent = false;
  if (!target && intentText) {
    target = findElementByIntentKeywords(intentText, prefX, prefY);
    fromIntent = Boolean(target);
  }
  matchedForScroll = matchedForScroll || fromIntent;
  return { target, matchedForScroll };
}

function rectsOverlap(a, b, margin = 8) {
  return !(
    a.right + margin < b.left ||
    a.left - margin > b.right ||
    a.bottom + margin < b.top ||
    a.top - margin > b.bottom
  );
}

function scrollTargetComfortably(el, vh) {
  if (!el || !(el instanceof Element)) return;
  const r = el.getBoundingClientRect();
  const pad = 80;
  if (r.top < pad || r.bottom > vh - pad) {
    try {
      el.scrollIntoView({ block: 'center', behavior: 'instant' });
    } catch {
      el.scrollIntoView(true);
    }
  }
}

function scrollLabelTargetIntoView(el) {
  if (!el || !(el instanceof Element)) return;
  const vh = window.innerHeight;
  const vw = window.innerWidth;
  for (let pass = 0; pass < 8; pass++) {
    try {
      el.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' });
    } catch {
      el.scrollIntoView(true);
    }
    let p = el.parentElement;
    for (let i = 0; i < 22 && p; i++) {
      const st = window.getComputedStyle(p);
      const ox = st.overflowX;
      const oy = st.overflowY;
      const scrollY = (oy === 'auto' || oy === 'scroll') && p.scrollHeight > p.clientHeight + 2;
      const scrollX = (ox === 'auto' || ox === 'scroll') && p.scrollWidth > p.clientWidth + 2;
      const pr = p.getBoundingClientRect();
      const er = el.getBoundingClientRect();
      if (scrollY && (er.bottom > pr.bottom - 4 || er.top < pr.top + 4)) {
        p.scrollTop += er.top + er.height / 2 - (pr.top + pr.height / 2);
      }
      if (scrollX && (er.right > pr.right - 4 || er.left < pr.left + 4)) {
        p.scrollLeft += er.left + er.width / 2 - (pr.left + pr.width / 2);
      }
      p = p.parentElement;
    }
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) break;
    if (r.top >= -48 && r.bottom <= vh + 48 && r.left >= -48 && r.right <= vw + 48) break;
  }
}

/** Keep pulse on/near the control; tiny bias toward vision (vx,vy) so it does not jump into empty canvas. */
function pulseOnTarget(rect, vx, vy) {
  const cx = rect.left + rect.width / 2;
  const cy = rect.top + rect.height / 2;
  const dx = vx - cx;
  const dy = vy - cy;
  const len = Math.hypot(dx, dy) || 1;
  const maxNudge = Math.min(12, Math.min(rect.width, rect.height) * 0.35);
  const nx = cx + (dx / len) * maxNudge;
  const ny = cy + (dy / len) * maxNudge;
  return {
    x: Math.max(rect.left + 3, Math.min(rect.right - 3, nx)),
    y: Math.max(rect.top + 3, Math.min(rect.bottom - 3, ny)),
  };
}

/** Fixed overlay so highlights sit above app chrome (e.g. YouTube Music). */
function getOverlayHost() {
  let el = document.getElementById('__ig_overlay_host');
  if (!el) {
    el = document.createElement('div');
    el.id = '__ig_overlay_host';
    el.setAttribute('data-integration-guide', 'overlay');
    el.style.cssText =
      'position:fixed;inset:0;width:100%;height:100%;pointer-events:none;z-index:2147483646;isolation:isolate;';
    (document.body || document.documentElement).appendChild(el);
  }
  return el;
}

function layoutTipBubble(tip, description, rect, vw, vh) {
  tip.className = 'ig-tip-bubble';
  if (tip.replaceChildren) tip.replaceChildren();
  else {
    while (tip.firstChild) tip.removeChild(tip.firstChild);
  }
  const inner = document.createElement('div');
  inner.className = 'ig-tip-inner';
  const textSpan = document.createElement('span');
  textSpan.className = 'ig-tip-text';
  textSpan.textContent = description || 'Click here to continue your integration.';
  const closeBtn = document.createElement('button');
  closeBtn.type = 'button';
  closeBtn.className = 'ig-tip-close';
  closeBtn.setAttribute('aria-label', 'Dismiss hint');
  closeBtn.textContent = '×';
  closeBtn.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    clearAllHighlights();
  });
  inner.appendChild(textSpan);
  inner.appendChild(closeBtn);
  tip.appendChild(inner);
  tip.style.visibility = 'hidden';
  tip.style.left = '-9999px';
  tip.style.top = '0';
  getOverlayHost().appendChild(tip);

  const tw = tip.offsetWidth;
  const th = tip.offsetHeight;
  const pad = 10;
  const gap = 14;
  const targetBox = { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom };
  const cx = rect.left + rect.width / 2;
  const cy = rect.top + rect.height / 2;

  const tryPlace = (place, left, top) => {
    const l = Math.min(vw - tw - pad, Math.max(pad, left));
    const t = Math.min(vh - th - pad, Math.max(pad, top));
    const box = { left: l, top: t, right: l + tw, bottom: t + th };
    if (rectsOverlap(box, targetBox, 8)) return null;
    return { place, l, t };
  };

  const attempts = [
    tryPlace('top', cx - tw / 2, rect.top - th - gap),
    tryPlace('bottom', cx - tw / 2, rect.bottom + gap),
    tryPlace('right', rect.right + gap, cy - th / 2),
    tryPlace('left', rect.left - tw - gap, cy - th / 2),
  ];

  let chosen = attempts.find(Boolean);
  if (!chosen) {
    const l = Math.min(vw - tw - pad, Math.max(pad, cx - tw / 2));
    const t = Math.min(vh - th - pad, Math.max(pad, vh - th - pad - 8));
    chosen = { place: 'bottom', l, t };
  }

  tip.dataset.igPlace = chosen.place;
  if (chosen.place === 'top' || chosen.place === 'bottom') {
    const ax = Math.max(18, Math.min(tw - 18, cx - chosen.l));
    tip.style.setProperty('--ig-arrow-x', `${ax}px`);
  } else {
    const ay = Math.max(18, Math.min(th - 18, cy - chosen.t));
    tip.style.setProperty('--ig-arrow-y', `${ay}px`);
  }
  tip.style.left = `${chosen.l}px`;
  tip.style.top = `${chosen.t}px`;
  tip.style.visibility = '';
}

function clampPct(v, fallback) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(0, Math.min(100, n));
}

function drawGhostMouse(xPct, yPct, description, elementLabel, intentText) {
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const xp = clampPct(xPct, 8);
  const yp = clampPct(yPct, 22);
  const vx = (xp / 100) * vw;
  const vy = (yp / 100) * vh;

  const { target: resolved, matchedForScroll } = resolveHighlightTarget(
    elementLabel,
    intentText,
    vx,
    vy
  );
  let target = resolved;
  if (!target) {
    const rawHit = document.elementFromPoint(
      Math.max(0, Math.min(vw - 1, vx)),
      Math.max(0, Math.min(vh - 1, vy))
    );
    target = rawHit ? findInteractiveTarget(rawHit) : null;
  }

  if (target) {
    expandCollapsedAncestors(target);
  }

  if (matchedForScroll && target) {
    scrollLabelTargetIntoView(target);
  } else {
    scrollTargetComfortably(target, vh);
  }

  requestAnimationFrame(() => {
    let ringRect = { left: vx - 4, top: vy - 4, right: vx + 4, bottom: vy + 4, width: 8, height: 8 };
    let pulse = { x: vx, y: vy };

    if (target) {
      const r = target.getBoundingClientRect();
      ringRect = { left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height };
      pulse = pulseOnTarget(r, vx, vy);
      const ring = document.createElement('div');
      ring.className = 'ig-target-ring';
      ring.style.left = `${r.left}px`;
      ring.style.top = `${r.top}px`;
      ring.style.width = `${r.width}px`;
      ring.style.height = `${r.height}px`;
      getOverlayHost().appendChild(ring);
    }

    const circle = document.createElement('div');
    circle.className = 'ig-ghost-mouse';
    circle.style.left = `${pulse.x}px`;
    circle.style.top = `${pulse.y}px`;
    getOverlayHost().appendChild(circle);

    const tip = document.createElement('div');
    layoutTipBubble(tip, description, ringRect, vw, vh);
  });
}

function clearAllHighlights() {
  document.querySelectorAll('.ig-ghost-mouse').forEach(el => el.remove());
  document.querySelectorAll('.ig-tip-bubble').forEach(el => el.remove());
  document.querySelectorAll('.ig-target-ring').forEach(el => el.remove());
  const h = document.getElementById('__ig_overlay_host');
  if (h) h.remove();
}

window.__integrationGuideDraw = function igDraw(payload) {
  try {
    clearAllHighlights();
    drawGhostMouse(
      payload.xPct,
      payload.yPct,
      payload.description || '',
      payload.elementLabel || '',
      payload.intentText || ''
    );
  } catch (e) {
    console.error('[Integration Guide] __integrationGuideDraw', e);
  }
};
