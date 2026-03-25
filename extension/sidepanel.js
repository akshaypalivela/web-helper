// State
const state = {
  messages: [],
  journey: [],
  currentUrl: '',
  currentDomain: '',
  lastGoal: '',
  firecrawlKey: ''
};

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
  const key = document.getElementById('firecrawl-key-input').value.trim();
  if (!key) {
    showStatus('Please enter your API key', false);
    return;
  }
  chrome.storage.local.set({ firecrawl_key: key }, () => {
    state.firecrawlKey = key;
    showStatus('Settings saved securely ✓', true);
  });
});

document.getElementById('clear-btn').addEventListener('click', () => {
  chrome.storage.local.clear(() => {
    state.firecrawlKey = '';
    state.messages = [];
    state.journey = [];
    document.getElementById('firecrawl-key-input').value = '';
    chatMessages.innerHTML = '';
    chatMessages.appendChild(welcomeScreen);
    welcomeScreen.style.display = 'flex';
    journeyBar.classList.remove('visible');
    journeyBar.innerHTML = '';
    showStatus('All data cleared', true);
  });
});

function showStatus(msg, ok) {
  const el = document.getElementById('status-text');
  el.textContent = msg;
  el.className = 'status-text ' + (ok ? 'success' : 'error');
  setTimeout(() => { el.textContent = ''; }, 3000);
}

// Init
async function init() {
  const result = await chrome.storage.local.get(['firecrawl_key', 'journey_state', 'chat_history']);
  state.firecrawlKey = result.firecrawl_key || '';
  if (result.firecrawl_key) {
    document.getElementById('firecrawl-key-input').value = result.firecrawl_key;
  }
  if (result.journey_state) {
    state.journey = result.journey_state;
    renderJourney();
  }
  if (result.chat_history?.length) {
    welcomeScreen.style.display = 'none';
    result.chat_history.forEach(m => addMessage(m.role, m.text, true));
    state.messages = result.chat_history;
  }
  updatePageContext();

  chrome.tabs.onActivated?.addListener(() => updatePageContext());
  chrome.tabs.onUpdated?.addListener((_, changeInfo) => {
    if (changeInfo.status === 'complete') handlePageChange();
  });
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type === 'URL_CHANGED') handlePageChange();
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

function handlePageChange() {
  updatePageContext();
  setTimeout(() => {
    if (state.lastGoal && state.firecrawlKey) {
      addMessage('assistant', '🔄 Page changed — analyzing...');
      analyzeCurrentPage(state.lastGoal);
    }
  }, 1500);
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

// Chat
chatForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const text = chatInput.value.trim();
  if (!text) return;
  chatInput.value = '';

  if (!state.firecrawlKey) {
    addMessage('user', text);
    addMessage('assistant', '⚙️ Please add your Firecrawl API key in the **Settings** tab first.');
    return;
  }

  addMessage('user', text);
  state.lastGoal = text;
  addMessage('assistant', `🔍 Searching for **"${text}"** on this page...`);
  await analyzeCurrentPage(text);
});

async function analyzeCurrentPage(userMessage) {
  const typingEl = showTyping();
  chrome.runtime.sendMessage({ type: 'CLEAR_HIGHLIGHTS' });

  try {
    const pageInfo = await new Promise((resolve) => {
      chrome.runtime.sendMessage({ type: 'GET_PAGE_INFO' }, resolve);
    });

    const url = pageInfo?.url || state.currentUrl;
    if (!url || url.startsWith('chrome://')) {
      removeEl(typingEl);
      addMessage('assistant', '⚠️ Navigate to a website first — I can\'t read Chrome internal pages.');
      return;
    }

    const response = await new Promise((resolve, reject) => {
      chrome.runtime.sendMessage({
        type: 'SCRAPE_AND_GUIDE',
        payload: { url, userMessage, pageContext: state.journey.join(' → '), firecrawlKey: state.firecrawlKey }
      }, (res) => {
        if (res?.error && !res.success) reject(new Error(res.error));
        else resolve(res);
      });
    });

    removeEl(typingEl);

    if (response?.message) addMessage('assistant', response.message);
    if (response?.element?.selector) {
      chrome.runtime.sendMessage({
        type: 'HIGHLIGHT_ELEMENT',
        selector: response.element.selector,
        description: response.element.description || 'Click here to continue.'
      });
    }
    if (response?.alternatives?.length) {
      response.alternatives.forEach((alt, i) => {
        addMessage('assistant', `${i === 0 ? '🔹' : '🔸'} Alt: **${alt.description}** — say "try ${i + 2}" to highlight it instead.`);
      });
    }
    if (response?.nextStep) {
      addMessage('assistant', `📋 **Next:** ${response.nextStep}`);
    }
  } catch (err) {
    removeEl(typingEl);
    addMessage('assistant', `❌ ${err.message}`);
  }
}

function addMessage(role, text, silent) {
  if (welcomeScreen.style.display !== 'none') welcomeScreen.style.display = 'none';

  state.messages.push({ role, text });
  if (!silent) {
    chrome.storage.local.set({ chat_history: state.messages.slice(-50) }); // keep last 50
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
  return esc(t)
    .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
    .replace(/\*(.*?)\*/g, '<em>$1</em>')
    .replace(/`(.*?)`/g, '<code>$1</code>');
}

init();
