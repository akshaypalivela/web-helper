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
  llmProvider: 'gemini'
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

/** Vertical slice of a data URL image; yStartFrac/yEndFrac in [0,1] relative to full height. */
function cropDataUrlVerticalSlice(dataUrl, yStartFrac, yEndFrac) {
  if (!dataUrl || typeof dataUrl !== 'string' || !dataUrl.startsWith('data:image')) {
    return Promise.resolve(dataUrl);
  }
  const ys = Math.max(0, Math.min(1, yStartFrac));
  const ye = Math.max(ys, Math.min(1, yEndFrac));
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      try {
        const w = img.naturalWidth;
        const h = img.naturalHeight;
        if (!w || !h) {
          resolve(dataUrl);
          return;
        }
        const sy = Math.round(ys * h);
        const sh = Math.max(1, Math.round(ye * h) - sy);
        const c = document.createElement('canvas');
        c.width = w;
        c.height = sh;
        const ctx = c.getContext('2d');
        if (!ctx) {
          resolve(dataUrl);
          return;
        }
        ctx.drawImage(img, 0, sy, w, sh, 0, 0, w, sh);
        resolve(c.toDataURL('image/jpeg', 0.88));
      } catch {
        resolve(dataUrl);
      }
    };
    img.onerror = () => resolve(dataUrl);
    img.src = dataUrl;
  });
}

function setAnalyzeStatus(typingRowEl, text) {
  const el = typingRowEl?.querySelector?.('.analyze-status');
  if (el) el.textContent = text;
}

/** Map model y (0–100 within crop) to full viewport y; cropped passes must not use candidateIndex. */
function mapPhaseResponseToViewport(res, half) {
  if (!res || typeof res !== 'object') return res;
  const out = { ...res, candidateIndex: -1 };
  let y = Number(out.y);
  if (!Number.isFinite(y)) y = 22;
  y = Math.max(0, Math.min(100, y));
  if (half === 'top') out.y = y * 0.5;
  else if (half === 'bottom') out.y = 50 + y * 0.5;
  return out;
}

function getClickableCandidatesFromTab(tabId) {
  return new Promise((resolve) => {
    if (!tabId) {
      resolve({ text: '' });
      return;
    }
    chrome.tabs.sendMessage(tabId, { type: 'GET_CLICKABLE_CANDIDATES' }, (res) => {
      if (chrome.runtime.lastError) resolve({ text: '' });
      else resolve(res || { text: '' });
    });
  });
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
  hideContextStrip();
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    if (tabs[0]?.id) state.guidanceTabId = tabs[0].id;
  });
  addMessage('assistant', '**Next step:** analyzing this page…');
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
    let clientScreenshot;
    let pageText = '';
    let clickableCandidatesText = '';
    const canCapture =
      activeTab?.id &&
      !url.startsWith('chrome://') &&
      !url.startsWith('chrome-extension://') &&
      !url.startsWith('edge://');

    const tCapture0 = performance.now();
    if (canCapture) {
      try {
        const capWindowId = activeTab.windowId;
        const dataUrl = await new Promise((resolve, reject) => {
          chrome.tabs.captureVisibleTab(capWindowId, { format: 'png' }, (du) => {
            if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
            else resolve(du);
          });
        });
        const [textPayload, candRes] = await Promise.all([
          new Promise((resolve) => {
            chrome.tabs.sendMessage(activeTab.id, { type: 'GET_PAGE_TEXT' }, (res) => {
              if (chrome.runtime.lastError) resolve({ text: '' });
              else resolve(res || { text: '' });
            });
          }),
          getClickableCandidatesFromTab(activeTab.id),
        ]);
        pageText = textPayload?.text || '';
        clickableCandidatesText = candRes?.text || '';
        clientScreenshot = await downscaleDataUrlForGemini(dataUrl);
      } catch {
        clientScreenshot = undefined;
      }
    }
    const captureMs = performance.now() - tCapture0;

    if (runEpoch !== state.guidanceEpoch) {
      removeEl(typingEl);
      return;
    }

    let scanSummaryLine = '';
    if (clientScreenshot) {
      setAnalyzeStatus(typingEl, 'Scanning top 50% of viewport…');
    } else {
      setAnalyzeStatus(
        typingEl,
        'No live screenshot. Using page text or a server snapshot…'
      );
      scanSummaryLine =
        '📐 **Viewport:** No live screenshot, so we did not split the screen into top and bottom scans.';
    }

    const baseAnalyzePayload = {
      url,
      userMessage,
      firecrawlKey: state.firecrawlKey,
      llmProvider: state.llmProvider,
      apiKey: getApiKeyForProvider(state.llmProvider).trim(),
      pageText,
      pageTitle: pageInfo?.title || activeTab?.title || '',
    };

    const runAnalyze = (extra) =>
      new Promise((resolve, reject) => {
        chrome.runtime.sendMessage(
          { type: 'ANALYZE_PAGE', payload: { ...baseAnalyzePayload, ...extra } },
          (res) => {
            if (res?.error && !res.success) reject(new Error(res.error));
            else resolve(res);
          }
        );
      });

    const tAnalyze0 = performance.now();
    let response;
    /** Run bottom half only if top is uncertain or fell back to text-only guidance. */
    const PHASE2_CONF_THRESHOLD = 0.58;
    /** If both halves stay below this after comparison, one full-viewport vision pass disambiguates. */
    const WEAK_SPLIT_MAX_CONF = 0.44;
    /** Full pass must beat the best half by this margin to replace the pick. */
    const FULL_VIEWPORT_MARGIN = 0.07;

    if (!clientScreenshot) {
      response = await runAnalyze({ clientScreenshot, clickableCandidatesText });
    } else {
      const topImg = await cropDataUrlVerticalSlice(clientScreenshot, 0, 0.5);
      const resTop = await runAnalyze({
        clientScreenshot: topImg,
        clickableCandidatesText,
        viewportImageRegion: 'top_half',
      });
      if (runEpoch !== state.guidanceEpoch) {
        removeEl(typingEl);
        return;
      }

      const cTopRaw = Number(resTop.confidence);
      const cTop = Number.isFinite(cTopRaw) ? cTopRaw : 0;
      const needBottom =
        cTop < PHASE2_CONF_THRESHOLD || Boolean(resTop.usedFallback);

      if (!needBottom) {
        response = mapPhaseResponseToViewport(resTop, 'top');
        scanSummaryLine = `📐 **Viewport:** Top half only (${Math.round(cTop * 100)}% confidence). Bottom half not needed.`;
      } else {
        setAnalyzeStatus(typingEl, 'Scanning bottom 50% of viewport…');
        const botImg = await cropDataUrlVerticalSlice(clientScreenshot, 0.5, 1);
        const resBot = await runAnalyze({
          clientScreenshot: botImg,
          clickableCandidatesText,
          viewportImageRegion: 'bottom_half',
        });
        if (runEpoch !== state.guidanceEpoch) {
          removeEl(typingEl);
          return;
        }

        const cBotRaw = Number(resBot.confidence);
        const cBot = Number.isFinite(cBotRaw) ? cBotRaw : 0;
        const topMapped = mapPhaseResponseToViewport(resTop, 'top');
        const botMapped = mapPhaseResponseToViewport(resBot, 'bottom');
        const winner = pickSplitViewportWinner(resTop, resBot, topMapped, botMapped);
        response = winner.mapped;
        const maxSplit = Math.max(cTop, cBot);
        const pickNote =
          winner.pick === 'fallback'
            ? ' Picked the side that pointed at a real control when scores were close.'
            : '';
        const winHalf = winner.halfLabel === 'lower' ? 'Lower' : 'Upper';
        const otherPct =
          winner.halfLabel === 'lower' ? Math.round(cTop * 100) : Math.round(cBot * 100);
        scanSummaryLine = `📐 **Viewport:** Checked top and bottom. **${winHalf} half** looked best (${Math.round(winner.choiceConf * 100)}% vs ${otherPct}% on the other).${pickNote}`;

        const gt = resTop.timings?.llmMs;
        const gb = resBot.timings?.llmMs;
        let sumG =
          (typeof gt === 'number' ? gt : 0) + (typeof gb === 'number' ? gb : 0);

        if (maxSplit < WEAK_SPLIT_MAX_CONF) {
          setAnalyzeStatus(typingEl, 'Split view was unclear. Checking the full screen…');
          const resFull = await runAnalyze({
            clientScreenshot,
            clickableCandidatesText,
            viewportImageRegion: 'full',
          });
          if (runEpoch !== state.guidanceEpoch) {
            removeEl(typingEl);
            return;
          }
          const cFullRaw = Number(resFull.confidence);
          const cFull = Number.isFinite(cFullRaw) ? cFullRaw : 0;
          const gf = resFull.timings?.llmMs;
          sumG += typeof gf === 'number' ? gf : 0;
          if (cFull > maxSplit + FULL_VIEWPORT_MARGIN) {
            response = { ...resFull };
            scanSummaryLine = `📐 **Viewport:** Full screen (${Math.round(cFull * 100)}% confidence). Split halves were weak (top ${Math.round(cTop * 100)}%, bottom ${Math.round(cBot * 100)}%).`
          } else {
            scanSummaryLine += ` Full screen (${Math.round(cFull * 100)}%) was not clearly better, so we kept the split pick.`
          }
        }

        response = { ...response, timings: { ...response.timings, llmMs: sumG } };
      }
    }

    const analyzeWallMs = performance.now() - tAnalyze0;
    igLog('timings', {
      captureMs: Math.round(captureMs),
      analyzeMs: Math.round(analyzeWallMs),
      ...(response?.timings || {}),
      usedRemoteScrape: Boolean(response?.usedRemoteScrape),
    });

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

/**
 * Choose top vs bottom half using confidence, with fallback awareness (non-fallback wins when close).
 */
function pickSplitViewportWinner(resTop, resBot, topMapped, botMapped) {
  const cTop = (() => {
    const n = Number(resTop?.confidence);
    return Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : 0;
  })();
  const cBot = (() => {
    const n = Number(resBot?.confidence);
    return Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : 0;
  })();
  const fbT = Boolean(resTop?.usedFallback);
  const fbB = Boolean(resBot?.usedFallback);

  if (fbT && !fbB && cBot >= cTop - 0.12) {
    return { mapped: botMapped, halfLabel: 'lower', choiceConf: cBot, pick: 'fallback' };
  }
  if (!fbT && fbB && cTop >= cBot - 0.12) {
    return { mapped: topMapped, halfLabel: 'upper', choiceConf: cTop, pick: 'fallback' };
  }

  if (cBot > cTop) {
    return { mapped: botMapped, halfLabel: 'lower', choiceConf: cBot, pick: 'confidence' };
  }
  return { mapped: topMapped, halfLabel: 'upper', choiceConf: cTop, pick: 'confidence' };
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
