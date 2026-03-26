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
  geminiKey: ''
};

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

/** Smaller JPEG for Gemini multimodal (faster upload). */
function downscaleDataUrlForGemini(dataUrl, maxWidth = 1280, quality = 0.82) {
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

// Settings
document.getElementById('save-btn').addEventListener('click', () => {
  const fcKey = document.getElementById('firecrawl-key-input').value.trim();
  const gmKey = document.getElementById('gemini-key-input').value.trim();
  if (!gmKey) {
    showStatus('Gemini API key is required', false);
    return;
  }
  chrome.storage.local.set({ firecrawl_key: fcKey, gemini_key: gmKey }, () => {
    state.firecrawlKey = fcKey;
    state.geminiKey = gmKey;
    showStatus('Settings saved securely ✓', true);
  });
});

document.getElementById('clear-btn').addEventListener('click', () => {
  chrome.storage.local.clear(() => {
    state.firecrawlKey = '';
    state.geminiKey = '';
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
  if (!state.guidanceGoal || !state.geminiKey) {
    showStatus('Add your Gemini key and type a goal in chat first', false);
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
  addMessage('assistant', '**Next step** — analyzing the current page…');
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
  addMessage('assistant', 'Guidance reset. Describe a **new goal** when you are ready.');
});

document.getElementById('continue-here-btn').addEventListener('click', async () => {
  if (!state.guidanceGoal || !state.geminiKey) {
    showStatus('Add your Gemini key and a goal first', false);
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
  addMessage('assistant', '**Continuing** your goal on **this** tab…');
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
  if (result.firecrawl_key) document.getElementById('firecrawl-key-input').value = result.firecrawl_key;
  if (result.gemini_key) document.getElementById('gemini-key-input').value = result.gemini_key;
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
      'You closed the side panel — **guidance is stopped** (no auto steps or highlights). Chat above is unchanged. Send a **new message** when you want to start again.'
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
    if (!state.lastGoal || !state.geminiKey) return;
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
        addMessage('assistant', `🌐 You're on **${state.currentDomain}** now — continuing your guided goal.`);
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
    if (!state.lastGoal || !state.geminiKey) return;
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
          ? '_You interacted with the page — updating the **next step**…_'
          : '_The page layout changed — fetching the **next step** for your goal…_'
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
  if (conf >= 0.7) return '_I’m confident this is the right control — I’ll highlight it for you._';
  if (conf >= 0.4) return '_This looks like the right place; wording can differ by site._';
  if (conf > 0) return '_Sites use different labels for the same thing — this is our best guess._';
  return '';
}

function buildContinuationPrompt() {
  const goal = state.guidanceGoal || state.lastGoal;
  const done =
    state.guidanceStepsDone.length > 0
      ? state.guidanceStepsDone.map((s, i) => `${i + 1}. ${s}`).join('\n')
      : '(none yet — infer from the goal and page)';
  const deep = state.deepGuidanceOptIn
    ? '\n\n**Deep guidance is ON** — continue through forms, OAuth, vendor dashboards, or new tabs (e.g. API keys on another product) until the user can complete the goal.'
    : '';
  return `CONTINUATION — same overall task.\n\nOriginal goal: "${goal}"\n\nActions already suggested in this session (do not repeat; choose the NEXT control on screen now):\n${done}${deep}\n\nCRITICAL: If a menu, dialog, or dropdown is ALREADY OPEN in the screenshot, do NOT target the opener/avatar again — target the row or button INSIDE that UI (e.g. "Switch account", "Sponsors") that matches the goal.\n\nOutput only one click on the CURRENT viewport. If the next control is not visible, explain where to navigate and use lower confidence.`;
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
    : `Goal: ${short} — after you click, press **Next step**.`;
}

// Chat
chatForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const text = chatInput.value.trim();
  if (!text) return;
  chatInput.value = '';

  if (!state.geminiKey) {
    addMessage('user', text);
    addMessage('assistant', '⚙️ Add your **Gemini** API key in **Settings**. A Firecrawl key is optional (only if live tab capture fails).');
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
      '**Continuing** — I’ll help you finish the flow (including new tabs or vendor sites when needed).'
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
      'Sounds good — I’ll stop auto steps here. Send a **new message** anytime you want more help.'
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
  addMessage('assistant', `🔍 Searching for **"${text}"** on this page...`);
  await analyzeCurrentPage(text);
});

async function analyzeCurrentPage(userMessage) {
  const runEpoch = state.guidanceEpoch;
  if (state.analyzeInFlight > 0 && state.activeAnalyzeEpoch === runEpoch) {
    return;
  }
  state.activeAnalyzeEpoch = runEpoch;
  state.analyzeInFlight += 1;
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
      addMessage('assistant', '⚠️ Navigate to a website first — I can\'t read Chrome internal pages.');
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

    const tAnalyze0 = performance.now();
    const response = await new Promise((resolve, reject) => {
      chrome.runtime.sendMessage({
        type: 'ANALYZE_PAGE',
        payload: {
          url,
          userMessage,
          firecrawlKey: state.firecrawlKey,
          geminiKey: state.geminiKey,
          clientScreenshot,
          pageText,
          pageTitle: pageInfo?.title || activeTab?.title || '',
          clickableCandidatesText,
        },
      }, (res) => {
        if (res?.error && !res.success) reject(new Error(res.error));
        else resolve(res);
      });
    });
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
      msg = `🔁 **I couldn’t find a clean spot here — let’s try another way.**\n\n${response.description}\n\n_Tap **Next step** from this screen, or describe what you see._`;
    } else if (conf >= 0.7) {
      msg = `🎯 **${response.elementLabel}** — ${response.pageTitle || 'this page'}\n\n${response.description}\n\n${tone}`;
    } else if (conf >= 0.4) {
      msg = `🤔 **${response.elementLabel}** (best match here)\n\n${response.description}\n\n${tone}`;
    } else if (conf > 0) {
      msg = `🔎 **${response.elementLabel}** — tentative\n\n${response.description}\n\n${tone}`;
    } else {
      msg = `❓ ${response.description}\n\n_I couldn’t pin this down — try **Next step** or a shorter question._`;
    }
    if (response.isMultiStep && response.overallPlan) {
      msg += `\n\n📋 **Plan:** ${response.overallPlan}`;
    }
    if (conf > 0 && (state.guidanceStepsDone.length > 1 || response.isMultiStep)) {
      msg += `\n\n_Tap **Next step** in the bar above after you perform this action._`;
    }
    if (response.usedRemoteScrape) {
      msg +=
        '\n\n_Using a **server snapshot** of the page — it may not match your logged-in tab._';
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
        '✅ **Looks like you’re in the right area.**\n\nWant help **finishing** this (forms, OAuth, API keys, or another site)? Reply **yes** to keep going, or **done** to stop auto steps here.'
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
        addMessage('assistant', '🟠 I\'ve placed a **ghost marker** on the page where you should click.');
      } else {
        addMessage(
          'assistant',
          `⚠️ Could not draw the on-page marker (${hl.error || 'unknown'}). Follow the suggestion above — expand any collapsed sidebar or menu first if the item is hidden.`
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
  div.className = 'msg assistant';
  div.innerHTML = `
    <div class="msg-avatar">
      <svg fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path d="M12 2L2 12h3v8h6v-6h2v6h6v-8h3L12 2z"/></svg>
    </div>
    <div class="msg-bubble"><div class="typing-dots"><span class="typing-dot"></span><span class="typing-dot"></span><span class="typing-dot"></span></div></div>
  `;
  chatMessages.appendChild(div);
  chatMessages.scrollTop = chatMessages.scrollHeight;
  return div;
}

function removeEl(el) { el?.remove(); }
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
