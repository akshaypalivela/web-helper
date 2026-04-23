// State
const state = {
  messages: [],
  journey: [],
  currentUrl: '',
  currentDomain: '',
  lastGoal: '',
  guidanceGoal: '',
  guidanceStepsDone: [],
  lastGuidanceUrl: '',
  guidanceTabId: null,
  guidanceDomain: '',
  pauseAutoAnalysis: false,
  awaitingContextChoice: false,
  stickyManualPause: false,
  lastGuidanceAnalyzeAt: 0,
  /** Number of in-flight analyze runs (new goals can start while an older epoch finishes). */
  analyzeInFlight: 0,
  deepGuidanceOptIn: false,
  completionPromptShown: false,
  taskCompletionPaused: false,
  /** Bumped on each new chat goal — stale analyses and timers ignore old epochs. */
  guidanceEpoch: 0,
  /** Last analyze run tied to guidanceEpoch — blocks duplicate same-epoch calls while allowing a new goal to supersede. */
  activeAnalyzeEpoch: 0,
  firecrawlKey: '',
  geminiKey: '',
  anthropicKey: '',
  openaiKey: '',
  mistralKey: '',
  /** @type {'gemini'|'anthropic'|'openai'|'mistral'} */
  llmProvider: 'gemini',
  /** Tracks when each cacheKey was last served from Stage 1 — used to bust stale cache hits on retry. */
  lastCachePick: Object.create(null),
  /** Cache keys the user has explicitly asked to skip (set on Next step). */
  cacheBustedKeys: new Set(),
  /** Per-goal recent picks for loop guards (keyed by cacheKey). */
  goalPickHistory: Object.create(null),
};

function getApiKeyForProvider(provider) {
  const p = provider || state.llmProvider || 'gemini';
  switch (p) {
    case 'anthropic':
      return state.anthropicKey || '';
    case 'openai':
      return state.openaiKey || '';
    case 'mistral':
      return state.mistralKey || '';
    case 'gemini':
    default:
      return state.geminiKey || '';
  }
}

function hasActiveLlmKey() {
  return Boolean(String(getApiKeyForProvider(state.llmProvider) || '').trim());
}

let navigateDebounce = null;
/** Tab IDs where we already injected highlight CSS (avoid repeat insertCSS). */
const tabCssInjected = new Set();

function cancelPendingNavigation() {
  if (navigateDebounce) {
    clearTimeout(navigateDebounce);
    navigateDebounce = null;
  }
}

function syncGuidanceEpochToStorage() {
  try {
    const v = { ig_guidance_epoch: state.guidanceEpoch };
    if (chrome.storage.session) {
      chrome.storage.session.set(v);
    }
    chrome.storage.local.set(v);
  } catch (_) {}
}

function igLog(label, data) {
  console.info('[IntegrationGuide]', label, data);
}

/** Resize wide viewports only; higher quality preserves small text for vision accuracy. */
function downscaleDataUrlForGemini(dataUrl, maxWidth = 1536, quality = 0.88) {
  if (!dataUrl || typeof dataUrl !== 'string' || !dataUrl.startsWith('data:image')) {
    return Promise.resolve(dataUrl);
  }
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      try {
        let w = img.naturalWidth;
        let h = img.naturalHeight;
        if (!w || !h) {
          resolve(dataUrl);
          return;
        }
        if (w <= maxWidth) {
          resolve(dataUrl);
          return;
        }
        const scale = maxWidth / w;
        w = Math.round(maxWidth);
        h = Math.round(h * scale);
        const c = document.createElement('canvas');
        c.width = w;
        c.height = h;
        const ctx = c.getContext('2d');
        if (!ctx) {
          resolve(dataUrl);
          return;
        }
        ctx.drawImage(img, 0, 0, w, h);
        resolve(c.toDataURL('image/jpeg', quality));
      } catch {
        resolve(dataUrl);
      }
    };
    img.onerror = () => resolve(dataUrl);
    img.src = dataUrl;
  });
}

/** Crop a data URL image by a rectangle expressed in percentages (0–100) of the source image. */
function cropDataUrlByRect(dataUrl, rectPct) {
  if (!dataUrl || typeof dataUrl !== 'string' || !dataUrl.startsWith('data:image')) {
    return Promise.resolve(dataUrl);
  }
  const x = Math.max(0, Math.min(100, Number(rectPct?.x) || 0));
  const y = Math.max(0, Math.min(100, Number(rectPct?.y) || 0));
  const w = Math.max(1, Math.min(100 - x, Number(rectPct?.w) || (100 - x)));
  const h = Math.max(1, Math.min(100 - y, Number(rectPct?.h) || (100 - y)));

  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      try {
        const W = img.naturalWidth;
        const H = img.naturalHeight;
        if (!W || !H) {
          resolve(dataUrl);
          return;
        }
        const sx = Math.round((x / 100) * W);
        const sy = Math.round((y / 100) * H);
        const sw = Math.max(1, Math.round((w / 100) * W));
        const sh = Math.max(1, Math.round((h / 100) * H));
        const c = document.createElement('canvas');
        c.width = sw;
        c.height = sh;
        const ctx = c.getContext('2d');
        if (!ctx) {
          resolve(dataUrl);
          return;
        }
        ctx.drawImage(img, sx, sy, sw, sh, 0, 0, sw, sh);
        resolve(c.toDataURL('image/jpeg', 0.82));
      } catch {
        resolve(dataUrl);
      }
    };
    img.onerror = () => resolve(dataUrl);
    img.src = dataUrl;
  });
}

/**
 * Draw numbered Set-of-Mark boxes on top of a cropped screenshot.
 *   croppedDataUrl — the cropped image.
 *   cropRect       — { x, y, w, h } viewport percentages the crop covers.
 *   boxes          — [{ number, xPct, yPct, wPct, hPct }] in VIEWPORT percentages.
 * Returns a JPEG data URL with the overlay baked in.
 */
function drawSomOverlay(croppedDataUrl, cropRect, boxes) {
  if (!croppedDataUrl || typeof croppedDataUrl !== 'string' || !croppedDataUrl.startsWith('data:image')) {
    return Promise.resolve(croppedDataUrl);
  }
  const cx = Math.max(0, Math.min(100, Number(cropRect?.x) || 0));
  const cy = Math.max(0, Math.min(100, Number(cropRect?.y) || 0));
  const cw = Math.max(1, Math.min(100, Number(cropRect?.w) || 100));
  const ch = Math.max(1, Math.min(100, Number(cropRect?.h) || 100));

  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      try {
        const W = img.naturalWidth;
        const H = img.naturalHeight;
        if (!W || !H) {
          resolve(croppedDataUrl);
          return;
        }
        const c = document.createElement('canvas');
        c.width = W;
        c.height = H;
        const ctx = c.getContext('2d');
        if (!ctx) {
          resolve(croppedDataUrl);
          return;
        }
        ctx.drawImage(img, 0, 0, W, H);

        for (const b of Array.isArray(boxes) ? boxes : []) {
          const boxX = (((Number(b.xPct) || 0) - cx) / cw) * W;
          const boxY = (((Number(b.yPct) || 0) - cy) / ch) * H;
          const boxW = ((Number(b.wPct) || 0) / cw) * W;
          const boxH = ((Number(b.hPct) || 0) / ch) * H;
          if (boxW < 2 || boxH < 2) continue;

          ctx.lineWidth = Math.max(2, Math.round(W / 360));
          ctx.strokeStyle = 'rgba(255, 88, 0, 0.95)';
          ctx.strokeRect(boxX, boxY, boxW, boxH);

          const num = String(b.number ?? '?');
          const fontSize = Math.max(14, Math.round(Math.min(boxW, boxH) * 0.55));
          ctx.font = `bold ${fontSize}px system-ui, -apple-system, Segoe UI, sans-serif`;
          const tm = ctx.measureText(num);
          const pad = Math.max(3, fontSize * 0.25);
          const labelW = tm.width + pad * 2;
          const labelH = fontSize + pad * 1.2;
          const lx = Math.max(0, boxX);
          const ly = Math.max(0, boxY);
          ctx.fillStyle = 'rgba(255, 88, 0, 0.95)';
          ctx.fillRect(lx, ly, labelW, labelH);
          ctx.fillStyle = '#ffffff';
          ctx.textBaseline = 'top';
          ctx.fillText(num, lx + pad, ly + pad * 0.4);
        }

        resolve(c.toDataURL('image/jpeg', 0.82));
      } catch {
        resolve(croppedDataUrl);
      }
    };
    img.onerror = () => resolve(croppedDataUrl);
    img.src = croppedDataUrl;
  });
}

function setAnalyzeStatus(typingRowEl, text) {
  const el = typingRowEl?.querySelector?.('.analyze-status');
  if (el) el.textContent = text;
}

function getClickableCandidatesFromTab(tabId) {
  return new Promise((resolve) => {
    if (!tabId) {
      resolve({ text: '', rows: [], domSig: '' });
      return;
    }
    chrome.tabs.sendMessage(tabId, { type: 'GET_CLICKABLE_CANDIDATES' }, (res) => {
      if (chrome.runtime.lastError) resolve({ text: '', rows: [], domSig: '' });
      else resolve(res || { text: '', rows: [], domSig: '' });
    });
  });
}

function computeCropHullFromTab(tabId, indices) {
  return new Promise((resolve) => {
    if (!tabId) {
      resolve({ x: 0, y: 0, w: 100, h: 100, fullViewport: true });
      return;
    }
    chrome.tabs.sendMessage(tabId, { type: 'COMPUTE_CROP_HULL', indices }, (res) => {
      if (chrome.runtime.lastError) resolve({ x: 0, y: 0, w: 100, h: 100, fullViewport: true });
      else resolve(res || { x: 0, y: 0, w: 100, h: 100, fullViewport: true });
    });
  });
}

function captureVisibleTabDataUrl(windowId) {
  return new Promise((resolve, reject) => {
    chrome.tabs.captureVisibleTab(windowId, { format: 'png' }, (du) => {
      if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
      else resolve(du);
    });
  });
}

const IG_CACHE_KEY = 'ig_cache_v1';
const IG_CACHE_MAX_ENTRIES = 200;

function loadIgCache() {
  return new Promise((resolve) => {
    chrome.storage.local.get(IG_CACHE_KEY, (obj) => {
      resolve(obj?.[IG_CACHE_KEY] || {});
    });
  });
}

function writeIgCache(cacheKey, entry) {
  return new Promise((resolve) => {
    loadIgCache().then((map) => {
      const next = { ...map, [cacheKey]: entry };
      const keys = Object.keys(next);
      if (keys.length > IG_CACHE_MAX_ENTRIES) {
        keys
          .map((k) => ({ k, ts: Number(next[k]?.ts) || 0 }))
          .sort((a, b) => a.ts - b.ts)
          .slice(0, keys.length - IG_CACHE_MAX_ENTRIES)
          .forEach(({ k }) => {
            delete next[k];
          });
      }
      chrome.storage.local.set({ [IG_CACHE_KEY]: next }, () => resolve());
    });
  });
}

function deleteIgCache(cacheKey) {
  return new Promise((resolve) => {
    loadIgCache().then((map) => {
      if (!map || !(cacheKey in map)) {
        resolve();
        return;
      }
      const next = { ...map };
      delete next[cacheKey];
      chrome.storage.local.set({ [IG_CACHE_KEY]: next }, () => resolve());
    });
  });
}

/** Called on Next step / reset so the next analyze skips a recently-served cache entry. */
function getCurrentGoalCacheKey() {
  const engine = typeof window !== 'undefined' ? window.IG_DECISION : null;
  if (!engine) return null;
  const goal = state.guidanceGoal || state.lastGoal || '';
  const domain = state.guidanceDomain || state.currentDomain || '';
  if (!goal || !domain) return null;
  return engine.makeCacheKey(domain, goal);
}

/** Called on Next step / reset so the next analyze skips a recently-served cache entry. */
function markCurrentGoalCacheBusted(_reason) {
  const key = getCurrentGoalCacheKey();
  if (!key) return;
  state.cacheBustedKeys.add(key);
  deleteIgCache(key).catch(() => {});
}

/** User-facing reset for the current goal on this site: cache + per-goal memories + steps. */
async function forgetCurrentGoalMemory() {
  const key = getCurrentGoalCacheKey();
  if (key) {
    await deleteIgCache(key).catch(() => {});
    if (state.lastCachePick) delete state.lastCachePick[key];
    state.cacheBustedKeys?.delete(key);
    if (state.goalPickHistory) delete state.goalPickHistory[key];
  }
  state.guidanceStepsDone = [];
  state.lastGuidanceUrl = '';
  state.taskCompletionPaused = false;
  state.pauseAutoAnalysis = false;
  state.awaitingContextChoice = false;
  state.stickyManualPause = false;
  hideContextStrip();
  updateGuidanceBar();
}

function providerDisplayName(p) {
  switch (String(p || '').toLowerCase()) {
    case 'anthropic': return 'Claude';
    case 'openai': return 'GPT-4o';
    case 'mistral': return 'Mistral';
    case 'gemini':
    default: return 'Gemini';
  }
}

/** Tokenize a string into lowercased alphanumeric words ≥ 3 chars. */
function tokenizeForMatch(text) {
  const s = String(text || '').toLowerCase();
  if (!s) return [];
  const raw = s.match(/[a-z0-9]+/g) || [];
  return raw.filter((t) => t.length >= 3);
}

const GOAL_STOPWORDS = new Set([
  'the', 'and', 'for', 'with', 'this', 'that', 'please', 'help', 'want',
  'need', 'how', 'get', 'can', 'you', 'your', 'about', 'from', 'into', 'onto',
  'add', 'set', 'let', 'use', 'tab', 'button', 'link', 'click', 'open', 'goto',
  'next', 'step', 'page', 'here', 'show', 'make', 'take', 'give', 'put',
]);

/** Does row.label share at least one meaningful token with the user's goal? */
function rowAlignsWithGoal(rowLabel, goal) {
  const rowTokens = new Set(tokenizeForMatch(rowLabel));
  if (!rowTokens.size) return false;
  const goalTokens = tokenizeForMatch(goal).filter((t) => !GOAL_STOPWORDS.has(t));
  if (!goalTokens.length) return true;
  for (const t of goalTokens) {
    if (rowTokens.has(t)) return true;
    for (const rt of rowTokens) {
      if (rt.length >= 4 && (rt.startsWith(t) || t.startsWith(rt))) return true;
    }
  }
  return false;
}

/** Does a free-form text (model label or description) reference the row's label? */
function rowLabelMatchesText(rowLabel, text) {
  const rowTokens = tokenizeForMatch(rowLabel);
  if (!rowTokens.length) return false;
  const textTokens = new Set(tokenizeForMatch(text));
  if (!textTokens.size) return false;
  let hits = 0;
  for (const t of rowTokens) if (textTokens.has(t)) hits += 1;
  if (rowTokens.length === 1) return hits >= 1;
  return hits >= Math.min(2, Math.ceil(rowTokens.length / 2));
}

function labelFamily(label) {
  const n = String(label || '').toLowerCase();
  if (/\bsponsors?\b/.test(n)) return 'sponsors';
  if (/\bstars?\b|\bstarred\b/.test(n)) return 'stars';
  if (/\bcontribution/.test(n)) return 'contribution';
  if (/\bprofile\b|\baccount\b|\bavatar\b/.test(n)) return 'profile';
  if (/\bsettings?\b|\bpreferences?\b/.test(n)) return 'settings';
  const t = tokenizeForMatch(n)[0];
  return t || 'other';
}

function getBlockedFamilies(cacheKey, goal) {
  if (!cacheKey) return [];
  const hist = Array.isArray(state.goalPickHistory?.[cacheKey]) ? state.goalPickHistory[cacheKey] : [];
  if (!hist.length) return [];
  const now = Date.now();
  const recent = hist.filter((h) => now - Number(h?.ts || 0) <= 10 * 60 * 1000);
  const bad = recent.filter((h) => !h.aligned);
  const counts = Object.create(null);
  bad.forEach((h) => {
    const fam = h.family || 'other';
    counts[fam] = (counts[fam] || 0) + 1;
  });
  const blocked = Object.keys(counts).filter((fam) => counts[fam] >= 2);
  if (!blocked.length) return [];
  // Never block families that clearly align with the current goal intent.
  return blocked.filter((fam) => !rowAlignsWithGoal(fam, goal));
}

function recordGoalPick(cacheKey, response, goal) {
  if (!cacheKey || !response || !response.elementLabel) return;
  const entry = {
    label: String(response.elementLabel).slice(0, 80),
    family: labelFamily(response.elementLabel),
    aligned: rowAlignsWithGoal(response.elementLabel, goal),
    confidence: Math.max(0, Math.min(1, Number(response.confidence) || 0)),
    ts: Date.now(),
  };
  const prev = Array.isArray(state.goalPickHistory?.[cacheKey]) ? state.goalPickHistory[cacheKey] : [];
  const next = [...prev, entry].slice(-8);
  state.goalPickHistory[cacheKey] = next;
}

/**
 * If the model returns a narrative low-confidence answer (no candidate index),
 * recover a concrete clickable next step from DOM rows for known flows.
 */
function recoverActionableStepFromRows({
  response,
  intentGoal,
  rows,
  pageUrl,
  uiState,
  blockedFamilies,
  pageTitle,
}) {
  const conf = Number(response?.confidence);
  const ci = Number(response?.candidateIndex);
  if (!Array.isArray(rows) || !rows.length) return null;
  if (Number.isFinite(ci) && ci >= 0) return null;
  if (Number.isFinite(conf) && conf > 0.25) return null;
  if (!/\b(sponsor|sponsors)\b/i.test(String(intentGoal || '').toLowerCase())) return null;

  const engine = typeof window !== 'undefined' ? window.IG_DECISION : null;
  if (!engine?.rankCandidatesForGoal || !engine?.normalizeLabel) return null;

  const ranked = engine.rankCandidatesForGoal({
    goal: intentGoal,
    candidates: rows,
    pageUrl: pageUrl || '',
    uiState: uiState || null,
    blockedFamilies: Array.isArray(blockedFamilies) ? blockedFamilies : [],
    max: 12,
  });
  if (!ranked.length) return null;

  const norm = (s) => engine.normalizeLabel(String(s || ''));
  const isBad = (label) =>
    /\b(edit profile|contribution settings|contribution activity|stars?|starred)\b/.test(norm(label));
  const has = (label, re) => re.test(norm(label));

  let pick = ranked.find((r) => has(r?.row?.label, /\bsponsors?\b/));
  let mode = 'direct_sponsors';
  if (!pick) {
    pick = ranked.find(
      (r) =>
        !isBad(r?.row?.label) &&
        has(r?.row?.label, /\b(profile|account|avatar|settings|user menu)\b/)
    );
    mode = 'route_menu';
  }
  if (!pick || !pick.row) return null;

  if (mode === 'direct_sponsors') {
    return buildResponseFromCandidate(pick.row, {
      source: 'policy_recovery',
      description: `Click **${pick.row.label}**.`,
      confidence: 0.9,
      stepSummary: `Opened ${pick.row.label}`,
      isMultiStep: true,
      overallPlan:
        'Open Sponsors first. If onboarding prompts appear, continue through the setup screens, then confirm your sponsors settings.',
      elementLabel: pick.row.label,
      pageTitle: pageTitle || '',
    });
  }

  return buildResponseFromCandidate(pick.row, {
    source: 'policy_recovery',
    description: `Open **${pick.row.label}**, then choose **Sponsors** from that menu.`,
    confidence: 0.62,
    stepSummary: `Opened ${pick.row.label} menu`,
    isMultiStep: true,
    overallPlan:
      'Open the account/profile menu first. Then select Sponsors. If Sponsors is still missing, use the direct sponsors accounts URL.',
    elementLabel: pick.row.label,
    pageTitle: pageTitle || '',
  });
}

function applyCriticalIntentGuards(response, rows, intentGoal) {
  if (!response || !Array.isArray(rows)) return response;
  const goal = String(intentGoal || '').toLowerCase();
  const ci = Number(response.candidateIndex);
  const row =
    Number.isFinite(ci) && ci >= 0
      ? rows.find((r) => Number(r.idx) === Math.round(ci))
      : null;
  const rowLabel = String(row?.label || '').toLowerCase();
  const desc = String(response.description || '').toLowerCase();
  const el = String(response.elementLabel || '').toLowerCase();

  const wantsSponsors = /\b(sponsor|sponsors)\b/.test(goal);
  if (wantsSponsors && row) {
    const rowIsSponsors = /\b(sponsor|sponsors)\b/.test(rowLabel);
    const textClaimsSponsors = /\b(sponsor|sponsors)\b/.test(desc) || /\b(sponsor|sponsors)\b/.test(el);
    if (textClaimsSponsors && !rowIsSponsors) {
      return {
        ...response,
        candidateIndex: -1,
        x: Number(response.x),
        y: Number(response.y),
        confidence: Math.min(Number(response.confidence) || 0, 0.35),
        elementLabel: response.elementLabel || 'Profile menu',
        description:
          'Open your profile/avatar menu first, then choose **Sponsors**. If it is still missing, use the direct sponsors URL fallback.',
      };
    }
  }

  const wantsIntegrations = /\b(integrat|connected app|plugin|marketplace)\b/.test(goal);
  if (wantsIntegrations && row) {
    const rowLooksWeak = /\b(admin|application)\b/.test(rowLabel) && !/\bintegrat|connected app|plugin|marketplace\b/.test(rowLabel);
    if (rowLooksWeak) {
      return {
        ...response,
        candidateIndex: -1,
        confidence: Math.min(Number(response.confidence) || 0, 0.45),
      };
    }
  }
  return response;
}

/** Build a guide-response shape from a DOM candidate row for cache / heuristic / triage / SoM hits. */
function buildResponseFromCandidate(row, overrides = {}) {
  const elementLabel = overrides.elementLabel || row?.label || 'Element';
  const description = overrides.description || `Click **${elementLabel}**.`;
  return {
    success: true,
    x: Number.isFinite(overrides.x) ? overrides.x : row?.xPct ?? 50,
    y: Number.isFinite(overrides.y) ? overrides.y : row?.yPct ?? 44,
    description,
    confidence:
      Number.isFinite(Number(overrides.confidence))
        ? Math.max(0, Math.min(1, Number(overrides.confidence)))
        : 0.95,
    elementLabel,
    isMultiStep: Boolean(overrides.isMultiStep),
    overallPlan: overrides.overallPlan || '',
    stepSummary: overrides.stepSummary || `Clicked ${elementLabel}`,
    candidateIndex: Number.isFinite(row?.idx) ? row.idx : -1,
    usedFallback: false,
    pageTitle: overrides.pageTitle || '',
    usedRemoteScrape: false,
    timings: overrides.llmTimings || { stage: overrides.source || 'local', llmMs: 0 },
    _source: overrides.source || 'local',
  };
}

function requestTextTriage(payload) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage({ type: 'ANALYZE_TEXT_TRIAGE', payload }, (res) => {
      if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
      if (!res) return reject(new Error('No response from background'));
      if (res.error && !res.success) return reject(new Error(res.error));
      resolve(res);
    });
  });
}

function requestSomVision(payload) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage({ type: 'ANALYZE_SOM_VISION', payload }, (res) => {
      if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
      if (!res) return reject(new Error('No response from background'));
      if (res.error && !res.success) return reject(new Error(res.error));
      resolve(res);
    });
  });
}

function requestServerAnalyze(payload) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage({ type: 'ANALYZE_PAGE', payload }, (res) => {
      if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
      if (!res) return reject(new Error('No response from background'));
      if (res.error && !res.success) return reject(new Error(res.error));
      resolve(res);
    });
  });
}

/**
 * Pick up to K candidate indices for the SoM overlay:
 *   1) Stage-2 pick if any
 *   2) Any rows whose label matches intent shortcut aliases
 *   3) Fill up with the first N in reading order
 */
function computeSomTopKIndices(rows, userMessage, triage, k = 10, opts = {}) {
  const picks = [];
  const seen = new Set();
  const push = (idx) => {
    if (!Number.isFinite(idx) || idx < 0) return;
    if (seen.has(idx)) return;
    seen.add(idx);
    picks.push(idx);
  };
  if (triage && Number.isFinite(Number(triage.candidateIndex))) {
    push(Number(triage.candidateIndex));
  }
  const engine = typeof window !== 'undefined' ? window.IG_DECISION : null;
  if (engine?.rankCandidatesForGoal) {
    const ranked = engine.rankCandidatesForGoal({
      goal: userMessage,
      candidates: rows,
      pageUrl: opts.pageUrl || '',
      uiState: opts.uiState || null,
      blockedFamilies: Array.isArray(opts.blockedFamilies) ? opts.blockedFamilies : [],
      max: Math.max(k * 2, 12),
    });
    ranked.forEach((r) => push(r?.row?.idx));
  } else {
    const shortcut = engine ? engine.findShortcutIntent(userMessage) : null;
    if (shortcut) {
      const scored = rows
        .map((r) => ({
          r,
          score: (function () {
            const n = engine.normalizeLabel(r.label);
            if (!n) return 0;
            let best = 0;
            for (const alias of shortcut.labels) {
              const an = engine.normalizeLabel(alias);
              if (!an) continue;
              if (n === an) best = Math.max(best, 100);
              else if (n.includes(an) && an.length >= 3) best = Math.max(best, 88);
              else if (an.includes(n) && n.length >= 3) best = Math.max(best, 70);
            }
            return best;
          })(),
        }))
        .filter((x) => x.score >= 60)
        .sort((a, b) => b.score - a.score);
      for (const s of scored) push(s.r.idx);
    }
  }
  for (const r of rows) {
    if (picks.length >= k) break;
    push(r.idx);
  }
  return picks.slice(0, k);
}

/** Triage-acceptance gate: confidence, valid candidate index, reasonable label agreement. */
function validateTriageAcceptance(triage, rows, goal = '', blockedFamilies = []) {
  if (!triage || !Array.isArray(rows) || !rows.length) return { accepted: false };
  const conf = Number(triage.confidence);
  if (!Number.isFinite(conf) || conf < 0.66) return { accepted: false, reason: 'low_conf' };
  const ci = Number(triage.candidateIndex);
  if (!Number.isFinite(ci) || ci < 0) return { accepted: false, reason: 'no_index' };
  const idx = rows.findIndex((r) => Number(r.idx) === Math.round(ci));
  if (idx < 0) return { accepted: false, reason: 'index_out_of_range' };
  const row = rows[idx];
  const fam = labelFamily(row?.label || '');
  if (Array.isArray(blockedFamilies) && blockedFamilies.includes(fam) && !rowAlignsWithGoal(row.label, goal)) {
    return { accepted: false, reason: 'blocked_family' };
  }
  const engine = typeof window !== 'undefined' ? window.IG_DECISION : null;
  if (engine && triage.elementLabel) {
    const a = engine.normalizeLabel(row.label);
    const b = engine.normalizeLabel(triage.elementLabel);
    if (a && b && a !== b && !a.includes(b) && !b.includes(a)) {
      const words = b.split(' ').filter((w) => w.length > 2);
      const allIn = words.length && words.every((w) => a.includes(w));
      if (!allIn) return { accepted: false, reason: 'label_mismatch' };
    }
  }
  return { accepted: true, idx };
}

// DOM
const chatMessages = document.getElementById('chat-messages');
const chatForm = document.getElementById('chat-form');
const chatInput = document.getElementById('chat-input');
const journeyBar = document.getElementById('journey-bar');
const welcomeScreen = document.getElementById('welcome-screen');

// Tabs
document.querySelectorAll('.tab').forEach(tab => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
    document.querySelectorAll('.panel').forEach(p => p.classList.remove('active'));
    tab.classList.add('active');
    document.getElementById(`panel-${tab.dataset.tab}`).classList.add('active');
  });
});

document.getElementById('llm-provider-select')?.addEventListener('change', (e) => {
  state.llmProvider = e.target.value || 'gemini';
});

// Settings
document.getElementById('save-btn').addEventListener('click', () => {
  const fcKey = document.getElementById('firecrawl-key-input').value.trim();
  const gmKey = document.getElementById('gemini-key-input').value.trim();
  const antKey = document.getElementById('anthropic-key-input').value.trim();
  const oaiKey = document.getElementById('openai-key-input').value.trim();
  const misKey = document.getElementById('mistral-key-input').value.trim();
  const prov = document.getElementById('llm-provider-select').value || 'gemini';
  chrome.storage.local.set(
    {
      firecrawl_key: fcKey,
      gemini_key: gmKey,
      anthropic_key: antKey,
      openai_key: oaiKey,
      mistral_key: misKey,
      llm_provider: prov,
    },
    () => {
      state.firecrawlKey = fcKey;
      state.geminiKey = gmKey;
      state.anthropicKey = antKey;
      state.openaiKey = oaiKey;
      state.mistralKey = misKey;
      state.llmProvider = prov;
      showStatus('Settings saved securely ✓', true);
    }
  );
});

document.getElementById('clear-btn').addEventListener('click', () => {
  chrome.storage.local.clear(() => {
    state.firecrawlKey = '';
    state.geminiKey = '';
    state.anthropicKey = '';
    state.openaiKey = '';
    state.mistralKey = '';
    state.llmProvider = 'gemini';
    state.messages = [];
    state.journey = [];
    state.lastGoal = '';
    state.guidanceGoal = '';
    state.guidanceStepsDone = [];
    state.lastGuidanceUrl = '';
    state.guidanceTabId = null;
    state.guidanceDomain = '';
    state.lastGuidanceAnalyzeAt = 0;
    state.analyzeInFlight = 0;
    state.activeAnalyzeEpoch = 0;
    state.guidanceEpoch = 0;
    state.deepGuidanceOptIn = false;
    state.completionPromptShown = false;
    state.taskCompletionPaused = false;
    state.pauseAutoAnalysis = false;
    state.awaitingContextChoice = false;
    state.stickyManualPause = false;
    state.lastCachePick = Object.create(null);
    state.cacheBustedKeys = new Set();
    state.goalPickHistory = Object.create(null);
    cancelPendingNavigation();
    syncGuidanceEpochToStorage();
    hideContextStrip();
    chrome.storage.local.remove('guide_session_end_v1');
    document.getElementById('firecrawl-key-input').value = '';
    document.getElementById('gemini-key-input').value = '';
    document.getElementById('anthropic-key-input').value = '';
    document.getElementById('openai-key-input').value = '';
    document.getElementById('mistral-key-input').value = '';
    document.getElementById('llm-provider-select').value = 'gemini';
    chatMessages.innerHTML = '';
    chatMessages.appendChild(welcomeScreen);
    welcomeScreen.style.display = 'flex';
    journeyBar.classList.remove('visible');
    journeyBar.innerHTML = '';
    updateGuidanceBar();
    showStatus('All data cleared', true);
  });
});

document.getElementById('next-step-btn').addEventListener('click', async () => {
  if (!state.guidanceGoal || !hasActiveLlmKey()) {
    showStatus('Add your API key for the selected provider and type a goal in chat first', false);
    return;
  }
  state.pauseAutoAnalysis = false;
  state.awaitingContextChoice = false;
  state.stickyManualPause = false;
  state.taskCompletionPaused = false;
  markCurrentGoalCacheBusted('next_step');
  hideContextStrip();
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    if (tabs[0]?.id) state.guidanceTabId = tabs[0].id;
  });
  addMessage('assistant', '**Next step:** analyzing this page…');
  await analyzeCurrentPage(buildContinuationPrompt());
});

document.getElementById('forget-goal-btn').addEventListener('click', async () => {
  if (!state.guidanceGoal || !hasActiveLlmKey()) {
    showStatus('Start a goal first, then use this memory reset', false);
    return;
  }
  await forgetCurrentGoalMemory();
  addMessage(
    'assistant',
    'Forgot saved memory for this goal on this site. Re-analyzing this screen without replaying cache/history…'
  );
  await analyzeCurrentPage(buildContinuationPrompt());
});

document.getElementById('reset-guidance-btn').addEventListener('click', () => {
  state.guidanceGoal = '';
  state.guidanceStepsDone = [];
  state.lastGoal = '';
  state.lastGuidanceUrl = '';
  state.guidanceTabId = null;
  state.guidanceDomain = '';
  state.guidanceEpoch += 1;
  state.lastCachePick = Object.create(null);
  state.cacheBustedKeys = new Set();
  state.goalPickHistory = Object.create(null);
  cancelPendingNavigation();
  syncGuidanceEpochToStorage();
  state.deepGuidanceOptIn = false;
  state.completionPromptShown = false;
  state.taskCompletionPaused = false;
  state.pauseAutoAnalysis = false;
  state.awaitingContextChoice = false;
  state.stickyManualPause = false;
  hideContextStrip();
  updateGuidanceBar();
  removeStaleAnalyzeTypingUI();
  addMessage('assistant', 'Guidance reset. Describe a **new goal** when you are ready.');
});

document.getElementById('continue-here-btn').addEventListener('click', async () => {
  if (!state.guidanceGoal || !hasActiveLlmKey()) {
    showStatus('Add your API key for the selected provider and a goal first', false);
    return;
  }
  const tabs = await new Promise((resolve) => {
    chrome.tabs.query({ active: true, currentWindow: true }, resolve);
  });
  const t = tabs[0];
  if (!t?.id || !t.url || t.url.startsWith('chrome://')) {
    showStatus('Open a normal browser tab first', false);
    return;
  }
  state.guidanceTabId = t.id;
  try {
    state.guidanceDomain = new URL(t.url).hostname;
  } catch {
    state.guidanceDomain = '';
  }
  state.pauseAutoAnalysis = false;
  state.awaitingContextChoice = false;
  state.stickyManualPause = false;
  state.taskCompletionPaused = false;
  state.lastGuidanceUrl = '';
  hideContextStrip();
  addMessage('assistant', '**Continuing** your goal on this tab…');
  const prompt = state.guidanceStepsDone.length ? buildContinuationPrompt() : state.lastGoal;
  await analyzeCurrentPage(prompt);
});

document.getElementById('stay-manual-btn').addEventListener('click', () => {
  state.pauseAutoAnalysis = true;
  state.awaitingContextChoice = true;
  state.stickyManualPause = true;
  const strip = document.getElementById('context-strip');
  const msg = document.getElementById('context-strip-msg');
  if (strip && msg) {
    msg.textContent =
      'Auto-follow is paused. Open the tab you want, then tap Continue goal here, or use Next step for one-off analysis.';
    strip.classList.add('visible');
  }
  addMessage(
    'assistant',
    'Auto-follow is **paused** until you press **Next step**, send a new chat, or **Continue goal here** on the tab you want.'
  );
});

function showStatus(msg, ok) {
  const el = document.getElementById('status-text');
  el.textContent = msg;
  el.className = 'status-text ' + (ok ? 'success' : 'error');
  setTimeout(() => { el.textContent = ''; }, 3000);
}

function normalizeHighlightPercents(response) {
  let x = Number(response.x);
  let y = Number(response.y);
  if (!Number.isFinite(x)) x = 8;
  if (!Number.isFinite(y)) y = 22;
  return {
    xPct: Math.max(0, Math.min(100, x)),
    yPct: Math.max(0, Math.min(100, y)),
  };
}

async function ensureContentScript(tabId) {
  if (!tabId) return false;
  const ping = () =>
    new Promise((resolve) => {
      chrome.tabs.sendMessage(tabId, { type: 'IG_PING' }, (r) => {
        resolve(Boolean(!chrome.runtime.lastError && r?.ok));
      });
    });
  if (await ping()) return true;
  try {
    await chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] });
  } catch {
    return false;
  }
  await new Promise((r) => setTimeout(r, 60));
  return ping();
}

async function deliverHighlight(tabId, response) {
  const ready = await ensureContentScript(tabId);
  if (!ready) return { ok: false, error: 'Could not attach to this page' };
  const { xPct, yPct } = normalizeHighlightPercents(response);
  const payload = {
    xPct,
    yPct,
    description: response.description || 'Click here to continue.',
    elementLabel: response.elementLabel || '',
    intentText: state.guidanceGoal || state.lastGoal || '',
  };
  const ci = Number(response.candidateIndex);
  if (Number.isFinite(ci) && ci >= 0) {
    payload.candidateIndex = ci;
  }
  await new Promise((resolve) => {
    chrome.tabs.sendMessage(tabId, { type: 'CLEAR_HIGHLIGHTS' }, () => resolve());
  });

  const drawViaMessage = () =>
    new Promise((resolve) => {
      chrome.tabs.sendMessage(tabId, { type: 'HIGHLIGHT_AT', ...payload }, (r) => {
        if (chrome.runtime.lastError) resolve(false);
        else resolve(r?.success !== false);
      });
    });

  if (await drawViaMessage()) return { ok: true };

  if (!tabCssInjected.has(tabId)) {
    try {
      await chrome.scripting.insertCSS({ target: { tabId }, files: ['content-styles.css'] });
      tabCssInjected.add(tabId);
    } catch (_) {}
  }

  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      func: (p) => {
        if (typeof window.__integrationGuideDraw === 'function') window.__integrationGuideDraw(p);
      },
      args: [payload],
    });
    return { ok: true };
  } catch (_) {
    try {
      await chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] });
      await new Promise((r) => setTimeout(r, 50));
      await chrome.scripting.executeScript({
        target: { tabId },
        func: (p) => {
          if (typeof window.__integrationGuideDraw === 'function') window.__integrationGuideDraw(p);
        },
        args: [payload],
      });
      return { ok: true };
    } catch (e2) {
      return new Promise((resolve) => {
        chrome.tabs.sendMessage(tabId, { type: 'HIGHLIGHT_AT', ...payload }, (r) => {
          if (chrome.runtime.lastError) {
            resolve({ ok: false, error: chrome.runtime.lastError.message });
          } else if (r && r.success === false) {
            resolve({ ok: false, error: r.error || 'Highlight failed' });
          } else resolve({ ok: true, ...r });
        });
      });
    }
  }
}

function applyPanelCloseSessionEnd() {
  state.guidanceGoal = '';
  state.lastGoal = '';
  state.guidanceStepsDone = [];
  state.guidanceTabId = null;
  state.lastGuidanceUrl = '';
  state.guidanceDomain = '';
  state.pauseAutoAnalysis = true;
  state.stickyManualPause = true;
  state.awaitingContextChoice = false;
  state.lastGuidanceAnalyzeAt = 0;
  state.analyzeInFlight = 0;
  state.activeAnalyzeEpoch = 0;
  state.guidanceEpoch += 1;
  cancelPendingNavigation();
  syncGuidanceEpochToStorage();
  state.deepGuidanceOptIn = false;
  state.completionPromptShown = false;
  state.taskCompletionPaused = false;
  hideContextStrip();
  updateGuidanceBar();
}

// Init
async function init() {
  const result = await chrome.storage.local.get([
    'firecrawl_key',
    'gemini_key',
    'anthropic_key',
    'openai_key',
    'mistral_key',
    'llm_provider',
    'journey_state',
    'chat_history',
    'guide_session_end_v1',
  ]);
  const sessionEndedByPanelClose = Boolean(result.guide_session_end_v1);
  if (sessionEndedByPanelClose) {
    await chrome.storage.local.remove('guide_session_end_v1');
    applyPanelCloseSessionEnd();
  }
  state.firecrawlKey = result.firecrawl_key || '';
  state.geminiKey = result.gemini_key || '';
  state.anthropicKey = result.anthropic_key || '';
  state.openaiKey = result.openai_key || '';
  state.mistralKey = result.mistral_key || '';
  state.llmProvider = result.llm_provider || 'gemini';
  if (result.firecrawl_key) document.getElementById('firecrawl-key-input').value = result.firecrawl_key;
  if (result.gemini_key) document.getElementById('gemini-key-input').value = result.gemini_key;
  if (result.anthropic_key) document.getElementById('anthropic-key-input').value = result.anthropic_key;
  if (result.openai_key) document.getElementById('openai-key-input').value = result.openai_key;
  if (result.mistral_key) document.getElementById('mistral-key-input').value = result.mistral_key;
  const provSel = document.getElementById('llm-provider-select');
  if (provSel && state.llmProvider) provSel.value = state.llmProvider;
  if (result.journey_state) {
    state.journey = result.journey_state;
    renderJourney();
  }
  if (result.chat_history?.length) {
    welcomeScreen.style.display = 'none';
    result.chat_history.forEach(m => addMessage(m.role, m.text, true));
    state.messages = result.chat_history;
  }
  if (sessionEndedByPanelClose) {
    addMessage(
      'assistant',
      'You closed the side panel, so **guidance is paused** (no auto steps or highlights). Your chat is still here. Send a **new message** when you want to start again.'
    );
  }
  updatePageContext();
  updateGuidanceBar();
  hideContextStrip();
  syncGuidanceEpochToStorage();

  chrome.tabs.onActivated?.addListener((activeInfo) => {
    chrome.tabs.get(activeInfo.tabId, (tab) => {
      if (chrome.runtime.lastError || !tab?.url) {
        updatePageContext();
        return;
      }
      handleSidePanelTabActivated(tab);
    });
  });
  chrome.tabs.onUpdated?.addListener((tabId, changeInfo) => {
    if (changeInfo.status !== 'complete') return;
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (tabs[0]?.id === tabId) scheduleGuidanceFollowUp();
    });
  });
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type === 'URL_CHANGED') scheduleGuidanceFollowUp();
  });
  chrome.storage.onChanged.addListener((changes, area) => {
    if ((area !== 'session' && area !== 'local') || !changes.ig_dom_signal?.newValue) return;
    const sig = changes.ig_dom_signal.newValue;
    if (!sig || sig.tabId !== state.guidanceTabId) return;
    if (sig.epoch != null && sig.epoch !== state.guidanceEpoch) return;
    if (!state.guidanceGoal || state.pauseAutoAnalysis || state.awaitingContextChoice || state.stickyManualPause) return;
    if (state.guidanceStepsDone.length === 0) return;
    if (sig.url !== state.lastGuidanceUrl) return;
    const since = Date.now() - (state.lastGuidanceAnalyzeAt || 0);
    const cooldownMs = sig.source === 'interaction' ? 1500 : 5000;
    if (since < cooldownMs) return;
    if (state.taskCompletionPaused) return;
    scheduleDomGuidanceFollowUp(sig.source === 'interaction');
  });
}

function updatePageContext() {
  chrome.runtime.sendMessage({ type: 'GET_PAGE_INFO' }, (res) => {
    if (res?.url) {
      try {
        const domain = new URL(res.url).hostname;
        if (domain !== state.currentDomain && state.currentDomain) {
          addJourneyStep(domain);
        }
        state.currentUrl = res.url;
        state.currentDomain = domain;
      } catch {}
    }
  });
}

function hideContextStrip() {
  document.getElementById('context-strip')?.classList.remove('visible');
}

function showContextStrip() {
  const strip = document.getElementById('context-strip');
  const msg = document.getElementById('context-strip-msg');
  if (!strip || !msg) return;
  const g = state.guidanceGoal || state.lastGoal || 'your goal';
  const short = g.length > 48 ? `${g.slice(0, 48)}…` : g;
  msg.textContent = `Different tab than your guide. Continue "${short}" on this tab, or tap Next step only to pause auto-follow.`;
  strip.classList.add('visible');
}

function adoptGuidanceTab(tabId) {
  state.guidanceTabId = tabId;
  state.pauseAutoAnalysis = false;
  state.awaitingContextChoice = false;
  state.lastGuidanceUrl = '';
  hideContextStrip();
  addMessage(
    'assistant',
    '**Continuing** on the tab you opened (same goal). Updating the guide for this page…'
  );
  scheduleGuidanceFollowUp();
}

function handleSidePanelTabActivated(tab) {
  const tabId = tab.id;
  updatePageContext();
  if (!state.guidanceGoal || !state.lastGoal) {
    hideContextStrip();
    return;
  }
  const opener = tab.openerTabId;
  if (state.guidanceTabId != null && opener === state.guidanceTabId) {
    adoptGuidanceTab(tabId);
    return;
  }
  if (state.guidanceTabId == null) {
    hideContextStrip();
    return;
  }
  if (tabId === state.guidanceTabId) {
    if (!state.stickyManualPause) {
      state.pauseAutoAnalysis = false;
      state.awaitingContextChoice = false;
    }
    hideContextStrip();
    return;
  }
  state.pauseAutoAnalysis = true;
  state.awaitingContextChoice = true;
  showContextStrip();
}

function scheduleGuidanceFollowUp() {
  const epoch = state.guidanceEpoch;
  const prevDomain = state.currentDomain;
  updatePageContext();
  if (navigateDebounce) clearTimeout(navigateDebounce);
  navigateDebounce = setTimeout(() => {
    navigateDebounce = null;
    if (epoch !== state.guidanceEpoch) return;
    if (!state.lastGoal || !hasActiveLlmKey()) return;
    if (state.pauseAutoAnalysis || state.awaitingContextChoice || state.stickyManualPause) return;
    if (state.taskCompletionPaused) return;
    if (state.analyzeInFlight > 0) return;
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (epoch !== state.guidanceEpoch) return;
      const t = tabs[0];
      if (!t?.id || !t.url || t.url.startsWith('chrome://')) return;
      if (state.guidanceTabId != null && t.id !== state.guidanceTabId) return;
      if (t.url === state.lastGuidanceUrl) return;
      if (state.currentDomain && prevDomain && state.currentDomain !== prevDomain) {
        addMessage('assistant', `🌐 You are on **${state.currentDomain}** now. Continuing your guided goal.`);
      }
      const prompt =
        state.guidanceStepsDone.length > 0 ? buildContinuationPrompt() : state.lastGoal;
      analyzeCurrentPage(prompt);
    });
  }, 1200);
}

/** Same URL but DOM changed (e.g. menu opened) — continue multi-step guidance. */
function scheduleDomGuidanceFollowUp(fromInteraction) {
  const epoch = state.guidanceEpoch;
  if (navigateDebounce) clearTimeout(navigateDebounce);
  navigateDebounce = setTimeout(() => {
    navigateDebounce = null;
    if (epoch !== state.guidanceEpoch) return;
    if (!state.lastGoal || !hasActiveLlmKey()) return;
    if (state.pauseAutoAnalysis || state.awaitingContextChoice || state.stickyManualPause) return;
    if (state.taskCompletionPaused) return;
    if (state.analyzeInFlight > 0) return;
    if (state.guidanceStepsDone.length === 0) return;
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (epoch !== state.guidanceEpoch) return;
      const t = tabs[0];
      if (!t?.id || t.id !== state.guidanceTabId) return;
      if (t.url !== state.lastGuidanceUrl) return;
      addMessage(
        'assistant',
        fromInteraction
          ? 'You used the page, so we are updating your **next step**…'
          : 'The page changed a bit. Getting your **next step**…'
      );
      analyzeCurrentPage(buildContinuationPrompt());
    });
  }, 400);
}

function addJourneyStep(domain) {
  if (!state.journey.includes(domain)) {
    state.journey.push(domain);
    chrome.storage.local.set({ journey_state: state.journey });
    renderJourney();
  }
}

function renderJourney() {
  if (!state.journey.length) { journeyBar.classList.remove('visible'); return; }
  journeyBar.classList.add('visible');
  journeyBar.innerHTML = state.journey.map((s, i) => {
    const isLast = i === state.journey.length - 1;
    return `<span class="${isLast ? 'step-active' : ''}">${s}</span>${!isLast ? '<span class="arrow">→</span>' : ''}`;
  }).join('');
}

function confidenceToneLine(conf) {
  if (conf >= 0.7) return 'Strong match. We will try to **highlight** it on the page.';
  if (conf >= 0.4) return 'Probably the right control, but sites word things differently.';
  if (conf > 0) return 'Best guess. Sites often use different names for the same action.';
  return '';
}

function userMessageIsContinuation(userMessage) {
  return (
    typeof userMessage === 'string' &&
    /CONTINUATION\s*-\s*same overall task/i.test(userMessage)
  );
}

/** Header / global search affordance (not every button whose label contains "search"). */
function responseTargetsSiteSearch(elementLabel, description) {
  const label = String(elementLabel || '').toLowerCase().trim();
  const desc = String(description || '').toLowerCase();
  if (!label && !desc) return false;
  if (/site search|search bar|search field|search box|global search|⌘k|cmd\+k|ctrl\+k/.test(desc)) {
    return true;
  }
  if (label === 'search' || label === 'suche') {
    return true;
  }
  if (/\bsearch\b/.test(label) && label.length <= 28) {
    return true;
  }
  return false;
}

function userGoalMentionsSearchExplicitly() {
  const g = `${state.guidanceGoal || ''} ${state.lastGoal || ''}`.toLowerCase();
  return /\bsearch(\s+the|\s+for|\s+box|\s+bar)?\b/.test(g) || /\buse\s+search\b/.test(g);
}

function buildContinuationPrompt() {
  const goal = state.guidanceGoal || state.lastGoal;
  const done =
    state.guidanceStepsDone.length > 0
      ? state.guidanceStepsDone.map((s, i) => `${i + 1}. ${s}`).join('\n')
      : '(none yet — infer from the goal and page)';
  const deep = state.deepGuidanceOptIn
    ? '\n\n**Deep guidance is ON** - continue through forms, OAuth, vendor dashboards, or new tabs (e.g. API keys on another product) until the user can complete the goal.'
    : '';
  return `CONTINUATION - same overall task.\n\nOriginal goal: "${goal}"\n\nActions already suggested in this session (do not repeat those clicks; choose the NEXT control on screen now):\n${done}${deep}\n\nCRITICAL: If a menu, dialog, or dropdown is ALREADY OPEN in the screenshot, do NOT target the opener/avatar again - target the row or button INSIDE that UI (e.g. "Switch account", "Sponsors") that matches the goal.\n\nWRONG-PAGE RECOVERY: If this viewport does NOT show the goal option but earlier steps already moved the user, the last area was probably wrong or incomplete. Do NOT default to the site search box. First try another path: Back, breadcrumbs, a different nav section, categories, Docs/Help, Account/Settings, or browse/A-Z. Only point at search if those paths are exhausted or missing, and say clearly in description that search is a last resort and why.\n\nOutput only one click on the CURRENT viewport. If the next control is not visible, explain where to navigate and use lower confidence.`;
}

function updateGuidanceBar() {
  const bar = document.getElementById('guidance-bar');
  const status = document.getElementById('guidance-status');
  if (!bar || !status) return;
  if (!state.guidanceGoal) {
    bar.classList.remove('visible');
    return;
  }
  bar.classList.add('visible');
  const n = state.guidanceStepsDone.length;
  const g = state.guidanceGoal;
  const short = g.length > 52 ? `${g.slice(0, 52)}…` : g;
  status.textContent = n
    ? `Multi-step · ${n} step(s) logged · ${short}`
    : `Goal: ${short}. After you click, press **Next step**.`;
}

// Chat
chatForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const text = chatInput.value.trim();
  if (!text) return;
  chatInput.value = '';

  if (!hasActiveLlmKey()) {
    addMessage('user', text);
    addMessage(
      'assistant',
      '⚙️ Open **Settings**, choose a **vision model provider**, and paste **that provider’s API key** (you only need one key — the other fields can stay empty). Firecrawl is optional if live tab capture fails.'
    );
    return;
  }

  const lower = text.toLowerCase().trim();
  if (
    state.completionPromptShown &&
    text.length < 96 &&
    /^(y|yes|yeah|sure|ok|continue|keep going|go ahead|help)/i.test(lower)
  ) {
    addMessage('user', text);
    state.deepGuidanceOptIn = true;
    state.taskCompletionPaused = false;
    state.pauseAutoAnalysis = false;
    addMessage(
      'assistant',
      '**Continuing:** I will help you finish the flow, including new tabs or vendor sites when needed.'
    );
    await analyzeCurrentPage(buildContinuationPrompt());
    return;
  }
  if (state.completionPromptShown && /^(no thanks|done|stop|that'?s enough|not now)$/i.test(lower)) {
    addMessage('user', text);
    state.taskCompletionPaused = true;
    state.pauseAutoAnalysis = true;
    addMessage(
      'assistant',
      'Sounds good. I will stop auto steps here. Send a **new message** anytime you want more help.'
    );
    return;
  }

  addMessage('user', text);
  state.lastGoal = text;
  state.guidanceGoal = text;
  state.guidanceStepsDone = [];
  state.lastGuidanceUrl = '';
  state.pauseAutoAnalysis = false;
  state.awaitingContextChoice = false;
  state.stickyManualPause = false;
  state.deepGuidanceOptIn = false;
  state.completionPromptShown = false;
  state.taskCompletionPaused = false;
  state.guidanceEpoch += 1;
  cancelPendingNavigation();
  syncGuidanceEpochToStorage();
  hideContextStrip();
  updateGuidanceBar();
  removeStaleAnalyzeTypingUI();
  addMessage('assistant', `🔍 Looking for **"${text}"** on this page…`);
  await analyzeCurrentPage(text);
});

async function analyzeCurrentPage(userMessage) {
  const runEpoch = state.guidanceEpoch;
  if (state.analyzeInFlight > 0 && state.activeAnalyzeEpoch === runEpoch) {
    return;
  }
  state.activeAnalyzeEpoch = runEpoch;
  state.analyzeInFlight += 1;
  removeStaleAnalyzeTypingUI();
  const typingEl = showTyping();
  chrome.runtime.sendMessage({ type: 'CLEAR_HIGHLIGHTS' });
  const engine = window.IG_DECISION;

  const tAnalyze0 = performance.now();

  try {
    const pageInfo = await new Promise((resolve) => {
      chrome.runtime.sendMessage({ type: 'GET_PAGE_INFO' }, resolve);
    });
    if (runEpoch !== state.guidanceEpoch) {
      removeEl(typingEl);
      return;
    }

    const url = pageInfo?.url || state.currentUrl;
    if (!url || url.startsWith('chrome://')) {
      removeEl(typingEl);
      addMessage('assistant', '⚠️ Open a normal website first. I cannot read Chrome internal pages.');
      return;
    }

    const tabs = await new Promise((resolve) => {
      chrome.tabs.query({ active: true, currentWindow: true }, resolve);
    });
    const activeTab = tabs[0];
    if (activeTab?.id) {
      state.guidanceTabId = activeTab.id;
      try {
        state.guidanceDomain = new URL(url).hostname;
      } catch {
        state.guidanceDomain = '';
      }
    }
    const canCapture =
      activeTab?.id &&
      !url.startsWith('chrome://') &&
      !url.startsWith('chrome-extension://') &&
      !url.startsWith('edge://');

    setAnalyzeStatus(typingEl, 'Reading this page…');
    const tCand0 = performance.now();
    const candRes = canCapture
      ? await getClickableCandidatesFromTab(activeTab.id)
      : { rows: [], text: '', domSig: '' };
    const candRows = Array.isArray(candRes?.rows) ? candRes.rows : [];
    const domSig = candRes?.domSig || '';
    const compactCandidatesText = engine.buildCompactCandidatesText(candRows, 1500);
    const uiState =
      engine?.detectUiState?.({ candidates: candRows, pageUrl: url }) || {};
    const candMs = performance.now() - tCand0;

    if (runEpoch !== state.guidanceEpoch) {
      removeEl(typingEl);
      return;
    }

    const isContinuation = userMessageIsContinuation(userMessage);
    const intentGoalRaw = (isContinuation ? (state.guidanceGoal || state.lastGoal) : userMessage) || '';
    const intentGoal = String(intentGoalRaw).trim() || String(userMessage || '').trim();
    const shortcutIntent = engine?.findShortcutIntent?.(intentGoal) || null;
    const bypassHeuristicForContinuation = isContinuation && shortcutIntent?.name === 'sponsors';

    const hasKey = hasActiveLlmKey();
    const provider = state.llmProvider;
    const apiKey = getApiKeyForProvider(provider).trim();
    const cacheKey = engine.makeCacheKey(state.guidanceDomain, intentGoal);
    const blockedFamilies = getBlockedFamilies(cacheKey, intentGoal);
    const flowPolicyHit = engine?.runFlowPolicyHeuristic?.({
      goal: intentGoal,
      pageUrl: url,
      candidates: candRows,
      uiState,
      blockedFamilies,
    }) || null;
    const rankedPreview = engine?.rankCandidatesForGoal
      ? engine.rankCandidatesForGoal({
          goal: intentGoal,
          candidates: candRows,
          pageUrl: url,
          uiState,
          blockedFamilies,
          max: 3,
        })
      : [];
    igLog('ranking', {
      flowPolicyMatched: Boolean(flowPolicyHit?.hit),
      uiState,
      blockedFamilies,
      top3Candidates: rankedPreview.map((r) => ({
        idx: r?.row?.idx,
        label: r?.row?.label,
        score: r?.score,
        reasons: r?.reasons,
      })),
    });

    // Stage 1 — cache + heuristic shortcut (zero network).
    // Bust stale cache entries when the user asks the same goal again quickly:
    // a recent hit means the previous answer was not helpful, so force a fresh pass.
    setAnalyzeStatus(typingEl, 'Checking for a shortcut…');
    const tStage1 = performance.now();
    const now = Date.now();
    const cacheBypassRecent =
      Number(state.lastCachePick?.[cacheKey]) > 0 &&
      now - Number(state.lastCachePick[cacheKey]) < 120_000;
    const cacheBypassFromNextStep = state.cacheBustedKeys?.has(cacheKey);
    const cacheBypass = cacheBypassRecent || cacheBypassFromNextStep;

    let cacheMap = await loadIgCache();
    if (cacheBypass) {
      await deleteIgCache(cacheKey).catch(() => {});
      cacheMap = { ...cacheMap };
      delete cacheMap[cacheKey];
      if (state.lastCachePick) delete state.lastCachePick[cacheKey];
      state.cacheBustedKeys?.delete(cacheKey);
    }

    let stage = null;
    let response = null;
    let scanSummaryLine = '';

    const cacheHit = engine.tryCacheResolve({
      cache: cacheMap, cacheKey, domSig, candidates: candRows,
    });
    if (cacheHit?.hit) {
      const cacheFam = labelFamily(cacheHit.row?.label || '');
      const cacheBlocked = blockedFamilies.includes(cacheFam) && !rowAlignsWithGoal(cacheHit.row?.label, intentGoal);
      if (!cacheBlocked) {
        response = buildResponseFromCandidate(cacheHit.row, {
          source: 'cache',
          description: `Click **${cacheHit.row.label}** — remembered from a previous visit.`,
          confidence: 0.95,
          pageTitle: pageInfo?.title || activeTab?.title || '',
        });
        stage = 'cache';
        scanSummaryLine = '⚡ **Shortcut:** recognized this goal on this site from a previous visit.';
        state.lastCachePick[cacheKey] = now;
      }
    }
    if (!response) {
      const flow = flowPolicyHit;
      if (flow?.hit) {
        response = buildResponseFromCandidate(flow.row, {
          source: 'flow_policy',
          description: `Click **${flow.row.label}**.`,
          confidence: 0.96,
          pageTitle: pageInfo?.title || activeTab?.title || '',
        });
        stage = 'flow_policy';
        scanSummaryLine = `🧭 **Flow policy:** ${flow.policy} (${flow.reason}).`;
      } else {
        if (!bypassHeuristicForContinuation) {
          const heur = engine.runStage1Heuristic({ goal: intentGoal, candidates: candRows });
          if (heur?.hit) {
            const fam = labelFamily(heur.row?.label || '');
            const blocked = blockedFamilies.includes(fam) && !rowAlignsWithGoal(heur.row?.label, intentGoal);
            if (!blocked) {
              response = buildResponseFromCandidate(heur.row, {
                source: 'heuristic',
                description: `Click **${heur.row.label}**.`,
                confidence: 0.9,
                pageTitle: pageInfo?.title || activeTab?.title || '',
              });
              stage = 'heuristic';
              scanSummaryLine = `⚡ **Fast match:** matched a common "${heur.intent}" control on this page.`;
            }
          }
        }
      }
    }
    const stage1Ms = performance.now() - tStage1;

    // Warm the capture in parallel when we'll likely need Stage 3
    let capturePromise = null;
    if (!response && canCapture && hasKey && engine.shouldWarmCapture(userMessage)) {
      capturePromise = captureVisibleTabDataUrl(activeTab.windowId).catch(() => null);
    }

    // Stage 2 — text-only triage with a fast model
    let triageRes = null;
    let stage2Ms = 0;
    if (!response && hasKey && candRows.length) {
      setAnalyzeStatus(typingEl, `Quick text check with ${providerDisplayName(provider)}…`);
      const tStage2 = performance.now();
      try {
        triageRes = await requestTextTriage({
          userMessage,
          pageTitle: pageInfo?.title || activeTab?.title || '',
          pageUrl: url,
          candidatesText: compactCandidatesText,
          doneSteps: state.guidanceStepsDone,
          llmProvider: provider,
          apiKey,
        });
      } catch (e) {
        triageRes = { error: String(e?.message || e) };
      }
      stage2Ms = performance.now() - tStage2;

      if (runEpoch !== state.guidanceEpoch) {
        removeEl(typingEl);
        return;
      }

      if (triageRes && !triageRes.error) {
        const gate = validateTriageAcceptance(triageRes, candRows, intentGoal, blockedFamilies);
        if (gate.accepted) {
          const row = candRows[gate.idx];
          response = buildResponseFromCandidate(row, {
            source: 'text_llm',
            description: triageRes.description,
            confidence: triageRes.confidence,
            stepSummary: triageRes.stepSummary,
            isMultiStep: triageRes.isMultiStep,
            overallPlan: triageRes.overallPlan,
            elementLabel: triageRes.elementLabel || row.label,
            pageTitle: pageInfo?.title || activeTab?.title || '',
            llmTimings: triageRes.timings,
          });
          stage = 'text_llm';
          scanSummaryLine = `⚡ **Fast pass:** matched by label in ${Math.round(stage2Ms)} ms.`;
        }
      }
    }

    // Stage 3 — SoM vision fallback
    let stage3Ms = 0;
    if (!response && hasKey) {
      const captureOnlyNoCandidates = canCapture && candRows.length === 0;
      if (!canCapture) {
        setAnalyzeStatus(typingEl, 'No live screenshot. Using server snapshot…');
        const tFb = performance.now();
        response = await requestServerAnalyze({
          url,
          userMessage,
          firecrawlKey: state.firecrawlKey,
          llmProvider: provider,
          apiKey,
          pageText: '',
          pageTitle: pageInfo?.title || activeTab?.title || '',
          clickableCandidatesText: '',
        });
        stage3Ms = performance.now() - tFb;
        stage = 'som_vision';
        scanSummaryLine = '📄 **Server snapshot:** used a remote page render (live capture unavailable).';
      } else if (captureOnlyNoCandidates) {
        setAnalyzeStatus(typingEl, `Full-screen vision with ${providerDisplayName(provider)}…`);
        const raw = await captureVisibleTabDataUrl(activeTab.windowId).catch(() => null);
        if (raw) {
          const scaled = await downscaleDataUrlForGemini(raw);
          const tFv = performance.now();
          response = await requestServerAnalyze({
            url,
            userMessage,
            firecrawlKey: state.firecrawlKey,
            llmProvider: provider,
            apiKey,
            clientScreenshot: scaled,
            pageText: '',
            pageTitle: pageInfo?.title || activeTab?.title || '',
            clickableCandidatesText: '',
          });
          stage3Ms = performance.now() - tFv;
          stage = 'som_vision';
          scanSummaryLine = '🔍 **Vision pass:** full viewport (no DOM candidates available).';
        } else {
          removeEl(typingEl);
          addMessage('assistant', '⚠️ Could not capture this tab.');
          return;
        }
      } else {
        setAnalyzeStatus(typingEl, `Zooming in with ${providerDisplayName(provider)} vision…`);
        const k = Math.min(10, Math.max(3, candRows.length));
        const topK = computeSomTopKIndices(candRows, intentGoal, triageRes, k, {
          pageUrl: url,
          uiState,
          blockedFamilies,
        });

        const [hull, rawCapture] = await Promise.all([
          computeCropHullFromTab(activeTab.id, topK),
          capturePromise || captureVisibleTabDataUrl(activeTab.windowId).catch(() => null),
        ]);
        if (runEpoch !== state.guidanceEpoch) {
          removeEl(typingEl);
          return;
        }

        if (!rawCapture) {
          removeEl(typingEl);
          addMessage('assistant', '⚠️ Could not capture this tab for a vision pass.');
          return;
        }

        const scaled = await downscaleDataUrlForGemini(rawCapture);
        const useFull = Boolean(hull?.fullViewport);
        const cropRect = useFull ? { x: 0, y: 0, w: 100, h: 100 } : hull;
        const cropped = useFull ? scaled : await cropDataUrlByRect(scaled, cropRect);

        const somBoxes = topK
          .map((idx) => {
            const row = candRows.find((r) => r.idx === idx);
            if (!row) return null;
            return {
              number: row.idx,
              xPct: (row.xPct || 0) - (row.wPct || 0) / 2,
              yPct: (row.yPct || 0) - (row.hPct || 0) / 2,
              wPct: row.wPct || 0,
              hPct: row.hPct || 0,
            };
          })
          .filter(Boolean);

        const annotated = await drawSomOverlay(cropped, cropRect, somBoxes);

        const somList = topK
          .map((idx) => {
            const row = candRows.find((r) => r.idx === idx);
            if (!row) return null;
            return `${row.idx}|${row.role}|${String(row.label || '').slice(0, 40)}`;
          })
          .filter(Boolean)
          .join('\n');

        const tStage3 = performance.now();
        let somRes = null;
        try {
          somRes = await requestSomVision({
            screenshot: annotated,
            userMessage,
            pageTitle: pageInfo?.title || activeTab?.title || '',
            pageUrl: url,
            somList,
            doneSteps: state.guidanceStepsDone,
            llmProvider: provider,
            apiKey,
          });
        } catch (e) {
          throw e;
        }
        stage3Ms = performance.now() - tStage3;

        if (runEpoch !== state.guidanceEpoch) {
          removeEl(typingEl);
          return;
        }

        const chosen = Number(somRes?.candidateIndex);
        const chosenRow = Number.isFinite(chosen) && chosen >= 0
          ? candRows.find((r) => r.idx === chosen)
          : null;

        if (chosenRow) {
          // Never trust the LLM's elementLabel for SoM — it often disagrees with the
          // box it actually picked. The DOM row is the source of truth for both the
          // highlight target and the visible label in the tip bubble.
          const authoritativeLabel = chosenRow.label;
          const modelLabel = String(somRes?.elementLabel || '').trim();
          const labelAgrees = rowLabelMatchesText(chosenRow.label, modelLabel);
          const goalAlignsWithRow = rowAlignsWithGoal(chosenRow.label, intentGoal);
          const family = labelFamily(chosenRow.label);
          const familyBlocked = blockedFamilies.includes(family) && !goalAlignsWithRow;

          // Rewrite the description if the model's label disagrees with the row,
          // so the tip bubble does not say "Sponsors" while highlighting "Stars".
          const rawDescription = String(somRes?.description || '').trim();
          const mentionsRowLabel = rawDescription
            ? rowLabelMatchesText(chosenRow.label, rawDescription)
            : false;
          const description = familyBlocked
            ? 'That target keeps leading to the wrong place. Open your profile/avatar menu first, then choose **Sponsors** from that menu.'
            : (labelAgrees || mentionsRowLabel || !rawDescription
            ? (rawDescription || `Click **${authoritativeLabel}**.`)
            : `Click **${authoritativeLabel}** — closest thing I can see for this goal here. If it is not the right control, tap **Next step**.`);

          // Demote confidence when the model's pick has zero goal-keyword overlap —
          // prevents a confident wrong highlight from being written to cache.
          const rawConf = Number(somRes?.confidence);
          const baseConf = Number.isFinite(rawConf) ? Math.max(0, Math.min(1, rawConf)) : 0.4;
          let adjustedConf = baseConf;
          if (familyBlocked) adjustedConf = Math.min(adjustedConf, 0.2);
          if (!goalAlignsWithRow && !labelAgrees) adjustedConf = Math.min(adjustedConf, 0.45);
          else if (!goalAlignsWithRow) adjustedConf = Math.min(adjustedConf, 0.6);

          response = buildResponseFromCandidate(chosenRow, {
            source: 'som_vision',
            description,
            confidence: adjustedConf,
            stepSummary: somRes.stepSummary,
            isMultiStep: somRes.isMultiStep,
            overallPlan: somRes.overallPlan,
            elementLabel: authoritativeLabel,
            pageTitle: pageInfo?.title || activeTab?.title || '',
            llmTimings: somRes.timings,
          });
        } else if (somRes) {
          response = {
            ...somRes,
            pageTitle: pageInfo?.title || activeTab?.title || '',
            usedRemoteScrape: false,
          };
        }
        stage = 'som_vision';
        scanSummaryLine = useFull
          ? '🔍 **Vision pass:** scanned the full viewport.'
          : '🔍 **Vision pass:** zoomed into the most likely region.';
      }
    }

    if (!response && !hasKey) {
      removeEl(typingEl);
      addMessage(
        'assistant',
        '⚠️ Add your API key for the selected provider in **Settings** first — only one key is required.'
      );
      return;
    }

    // Convert "no clear target, but try profile dropdown" style narratives into an
    // actual clickable suggestion when rows are available.
    if (response) {
      const recovered = recoverActionableStepFromRows({
        response,
        intentGoal,
        rows: candRows,
        pageUrl: url,
        uiState,
        blockedFamilies,
        pageTitle: pageInfo?.title || activeTab?.title || '',
      });
      if (recovered) {
        response = recovered;
        stage = 'policy_recovery';
        scanSummaryLine = '🧭 **Smart recovery:** converted a narrative hint into the next concrete click.';
      }
    }
    if (response) {
      response = applyCriticalIntentGuards(response, candRows, intentGoal);
    }

    const analyzeWallMs = performance.now() - tAnalyze0;
    const usedVision = stage === 'som_vision';
    igLog('timings', {
      stage,
      cacheHit: stage === 'cache',
      escalated: usedVision,
      candMs: Math.round(candMs),
      stage1Ms: Math.round(stage1Ms),
      stage2Ms: Math.round(stage2Ms),
      stage3Ms: Math.round(stage3Ms),
      analyzeMs: Math.round(analyzeWallMs),
      ...(response?.timings || {}),
      usedRemoteScrape: Boolean(response?.usedRemoteScrape),
    });

    // Write cache on a confident, labeled pick (skip server-snapshot results — too unreliable).
    // Extra guards prevent poisoning the cache with hallucinated picks:
    //  - require ≥ 0.8 confidence (was 0.7)
    //  - require the elementLabel to reference the DOM row we are highlighting
    //  - require the row label to share at least one goal token (so "Stars" cannot
    //    get cached for "add sponsors")
    const cacheWriteRow = Number.isFinite(response?.candidateIndex) && response.candidateIndex >= 0
      ? candRows.find((r) => r.idx === response.candidateIndex)
      : null;
    const labelAgreesWithRow = cacheWriteRow
      ? rowLabelMatchesText(cacheWriteRow.label, response?.elementLabel || '')
      : false;
    const rowAlignsWithAsk = cacheWriteRow
      ? rowAlignsWithGoal(cacheWriteRow.label, intentGoal)
      : false;
    if (
      response &&
      stage &&
      stage !== 'cache' &&
      !response.usedRemoteScrape &&
      Number(response.confidence) >= 0.8 &&
      response.elementLabel &&
      cacheWriteRow &&
      labelAgreesWithRow &&
      rowAlignsWithAsk
    ) {
      writeIgCache(cacheKey, {
        elementLabel: String(response.elementLabel).slice(0, 80),
        labelNorm: engine.normalizeLabel(response.elementLabel).slice(0, 80),
        domSig,
        xPct: Number(response.x) || 0,
        yPct: Number(response.y) || 0,
        ts: Date.now(),
      });
    }

    if (response && Number(response.confidence) > 0) {
      recordGoalPick(cacheKey, response, intentGoal);
    }

    removeEl(typingEl);

    if (!response) return;
    if (runEpoch !== state.guidanceEpoch) return;

    state.lastGuidanceUrl = url;

    const confRaw = Number(response.confidence);
    const conf = Number.isFinite(confRaw) ? Math.max(0, Math.min(1, confRaw)) : 0;
    const tone = confidenceToneLine(conf);
    const usedFallback = Boolean(response.usedFallback);

    if (conf > 0) {
      const summary =
        (response.stepSummary || '').trim() ||
        (response.description || '').slice(0, 120);
      if (summary) {
        const last = state.guidanceStepsDone[state.guidanceStepsDone.length - 1];
        if (last !== summary) {
          state.guidanceStepsDone.push(summary);
          if (state.guidanceStepsDone.length > 25) state.guidanceStepsDone.shift();
        }
      }
    }
    updateGuidanceBar();

    let msg = '';
    if (usedFallback) {
      msg = `🔁 **No clear click target here.**\n\n${response.description}\n\nUse **Next step** on this screen, or tell me what you see.`
    } else if (conf >= 0.7) {
      msg = `🎯 **${response.elementLabel}** (${response.pageTitle || 'this page'})\n\n${response.description}\n\n${tone}`
    } else if (conf >= 0.4) {
      msg = `🤔 **${response.elementLabel}** (best match we see)\n\n${response.description}\n\n${tone}`
    } else if (conf > 0) {
      msg = `🔎 **${response.elementLabel}** (tentative)\n\n${response.description}\n\n${tone}`
    } else {
      msg = `❓ ${response.description}\n\nTry **Next step** or ask a shorter question.`
    }
    if (response.isMultiStep && response.overallPlan) {
      msg += `\n\n📋 **Steps ahead**\n${response.overallPlan}`;
    }
    if (conf > 0 && (state.guidanceStepsDone.length > 1 || response.isMultiStep)) {
      msg += `\n\nWhen you are done, tap **Next step** in the bar above.`
    }
    if (response.usedRemoteScrape) {
      msg +=
        '\n\nUsing a **server snapshot**, which may not match your logged-in tab.';
    }
    const modelExplainedRethinkOrSearchFallback =
      /last resort|exhausted|wrong (page|screen|area)|re-?think|did not show|doesn'?t show|no (clear )?link|try (instead|going)|go back|breadcrumb/i.test(
        `${response.description || ''} ${response.overallPlan || ''}`
      );
    if (
      userMessageIsContinuation(userMessage) &&
      state.guidanceStepsDone.length >= 2 &&
      conf > 0 &&
      !usedFallback &&
      !userGoalMentionsSearchExplicitly() &&
      responseTargetsSiteSearch(response.elementLabel, response.description) &&
      !modelExplainedRethinkOrSearchFallback
    ) {
      msg +=
        '\n\n**About search:** Prefer Back, main nav, Settings, or Help/Docs if they get you closer. Site search is a backup when this screen does not show a direct path.';
    }
    if (scanSummaryLine) {
      msg = `${scanSummaryLine}\n\n${msg}`;
    }
    const fallbackUrl = engine?.fallbackUrlForGoal?.(intentGoal, url) || '';
    if (fallbackUrl && (conf <= 0.25 || usedFallback || !response.elementLabel)) {
      msg += `\n\nIf this screen still does not show the right control, open this direct fallback URL: ${fallbackUrl}`;
    }
    addMessage('assistant', msg);

    if (
      !state.completionPromptShown &&
      !response.isMultiStep &&
      conf >= 0.74 &&
      state.guidanceStepsDone.length >= 2 &&
      !state.deepGuidanceOptIn
    ) {
      state.completionPromptShown = true;
      state.taskCompletionPaused = true;
      state.pauseAutoAnalysis = true;
      addMessage(
        'assistant',
        '✅ **You seem to be in the right area.**\n\nWant help **finishing** (forms, sign-in, API keys, or another site)? Reply **yes** to keep going, or **done** to stop auto steps here.'
      );
    }

    const labelTrim = (response.elementLabel || '').trim();
    const shouldTryHighlight =
      conf > 0 &&
      (labelTrim ||
        Number.isFinite(Number(response.x)) ||
        Number.isFinite(Number(response.y)));

    if (shouldTryHighlight && activeTab?.id && runEpoch === state.guidanceEpoch) {
      const tHl0 = performance.now();
      const hl = await deliverHighlight(activeTab.id, response);
      igLog('highlight', { ms: Math.round(performance.now() - tHl0), ok: hl.ok });
      if (runEpoch !== state.guidanceEpoch) return;
      if (hl.ok) {
        addMessage('assistant', '🟠 I added a **ghost marker** on the page where you should click.');
      } else {
        addMessage(
          'assistant',
          `⚠️ Could not draw the on-page marker (${hl.error || 'unknown'}). Follow the text above. Open any collapsed sidebar or menu if the item is hidden.`
        );
      }
    }

    state.lastGuidanceAnalyzeAt = Date.now();
  } catch (err) {
    removeEl(typingEl);
    if (runEpoch === state.guidanceEpoch) {
      addMessage('assistant', `❌ ${err.message}`);
    }
  } finally {
    state.analyzeInFlight -= 1;
    if (state.analyzeInFlight < 0) state.analyzeInFlight = 0;
  }
}

function addMessage(role, text, silent) {
  if (welcomeScreen.style.display !== 'none') welcomeScreen.style.display = 'none';

  state.messages.push({ role, text });
  if (!silent) {
    chrome.storage.local.set({ chat_history: state.messages.slice(-50) });
  }

  const div = document.createElement('div');
  div.className = `msg ${role}`;

  if (role === 'assistant') {
    div.innerHTML = `
      <div class="msg-avatar">
        <svg fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path d="M12 2L2 12h3v8h6v-6h2v6h6v-8h3L12 2z"/></svg>
      </div>
      <div class="msg-bubble">${formatMd(text)}</div>
    `;
  } else {
    div.innerHTML = `<div class="msg-bubble">${esc(text)}</div>`;
  }

  chatMessages.appendChild(div);
  chatMessages.scrollTop = chatMessages.scrollHeight;
}

function showTyping() {
  const div = document.createElement('div');
  div.className = 'msg assistant analyze-typing';
  div.innerHTML = `
    <div class="msg-avatar">
      <svg fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path d="M12 2L2 12h3v8h6v-6h2v6h6v-8h3L12 2z"/></svg>
    </div>
    <div class="msg-bubble">
      <div class="analyze-status">Analyzing…</div>
      <div class="typing-dots"><span class="typing-dot"></span><span class="typing-dot"></span><span class="typing-dot"></span></div>
    </div>
  `;
  chatMessages.appendChild(div);
  chatMessages.scrollTop = chatMessages.scrollHeight;
  return div;
}

function removeEl(el) { el?.remove(); }

/** Drop in-progress analyze rows so a new goal does not stack loading bubbles. */
function removeStaleAnalyzeTypingUI() {
  const root = document.getElementById('chat-messages');
  if (!root) return;
  root.querySelectorAll('.msg.assistant.analyze-typing').forEach((el) => el.remove());
}

function esc(s) { const d = document.createElement('div'); d.textContent = s; return d.innerHTML; }
function formatMd(t) {
  const badges = [];
  let s = t.replace(/<span class="([^"]*confidence-badge[^"]*)">([\s\S]*?)<\/span>/gi, (_, cls, inner) => {
    const i = badges.length;
    badges.push({ cls, inner });
    return `\x01B${i}\x01`;
  });
  s = s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\x01B(\d+)\x01/g, (_, j) => {
      const b = badges[Number(j)];
      if (!b) return '';
      const inner = b.inner.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
      return `<span class="${b.cls}">${inner}</span>`;
    })
    .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
    .replace(/\*(.*?)\*/g, '<em>$1</em>')
    .replace(/`(.*?)`/g, '<code>$1</code>')
    .replace(/\n/g, '<br/>');
  return s;
}

window.addEventListener('pagehide', () => {
  try {
    chrome.runtime.sendMessage({ type: 'END_GUIDE_SESSION' });
  } catch (_) {}
});

init();
