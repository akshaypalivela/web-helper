// State
const state = {
  messages: [],
  journey: [],
  currentUrl: '',
  currentDomain: '',
  hasConfig: false,
  lastGoal: ''
};

// DOM elements
const chatContainer = document.getElementById('chat-container');
const chatForm = document.getElementById('chat-form');
const chatInput = document.getElementById('chat-input');
const settingsBtn = document.getElementById('settings-btn');
const settingsPanel = document.getElementById('settings-panel');
const chatContainerEl = document.getElementById('chat-container');
const inputSection = chatForm.closest('.px-4');
const supabaseUrlInput = document.getElementById('supabase-url-input');
const anonKeyInput = document.getElementById('anon-key-input');
const saveConfigBtn = document.getElementById('save-config-btn');
const configStatus = document.getElementById('config-status');
const backBtn = document.getElementById('back-btn');
const pageContext = document.getElementById('page-context');
const journeyBar = document.getElementById('journey-bar');
const journeySteps = document.getElementById('journey-steps');

// Init
async function init() {
  const result = await chrome.storage.local.get(['supabase_url', 'supabase_anon_key', 'journey_state']);
  state.hasConfig = !!(result.supabase_url && result.supabase_anon_key);
  if (result.journey_state) {
    state.journey = result.journey_state;
    renderJourney();
  }
  updatePageContext();

  // Listen for tab changes
  chrome.tabs.onActivated?.addListener(() => updatePageContext());
  chrome.tabs.onUpdated?.addListener((tabId, changeInfo) => {
    if (changeInfo.status === 'complete') handlePageChange();
  });

  // Listen for SPA URL changes from content script
  chrome.runtime.onMessage.addListener((message) => {
    if (message.type === 'URL_CHANGED') {
      handlePageChange();
    }
  });
}

function updatePageContext() {
  chrome.runtime.sendMessage({ type: 'GET_PAGE_INFO' }, (response) => {
    if (response?.url) {
      try {
        const url = new URL(response.url);
        const domain = url.hostname;
        pageContext.textContent = domain;
        if (domain !== state.currentDomain && state.currentDomain) {
          addJourneyStep(domain);
        }
        state.currentUrl = response.url;
        state.currentDomain = domain;
      } catch {
        pageContext.textContent = 'Ready to help';
      }
    }
  });
}

function handlePageChange() {
  updatePageContext();
  // If user has an active goal, auto-analyze the new page
  setTimeout(() => {
    if (state.lastGoal && state.hasConfig) {
      addMessage('assistant', `🔄 Page changed! Analyzing the new page...`);
      analyzeCurrentPage(state.lastGoal);
    }
  }, 1500); // Wait for page to settle
}

function addJourneyStep(domain) {
  if (!state.journey.includes(domain)) {
    state.journey.push(domain);
    chrome.storage.local.set({ journey_state: state.journey });
    renderJourney();
  }
}

function renderJourney() {
  if (state.journey.length === 0) {
    journeyBar.classList.add('hidden');
    return;
  }
  journeyBar.classList.remove('hidden');
  journeySteps.innerHTML = state.journey.map((step, i) => {
    const isLast = i === state.journey.length - 1;
    return `<span class="${isLast ? 'text-purple-400 font-medium' : ''}">${step}</span>${!isLast ? '<span class="text-white/20">→</span>' : ''}`;
  }).join('');
}

// Settings toggle
settingsBtn.addEventListener('click', () => {
  const isHidden = settingsPanel.classList.contains('hidden');
  settingsPanel.classList.toggle('hidden');
  chatContainerEl.classList.toggle('hidden', !settingsPanel.classList.contains('hidden'));
  inputSection.classList.toggle('hidden', !settingsPanel.classList.contains('hidden'));
  if (isHidden) {
    chrome.storage.local.get(['supabase_url', 'supabase_anon_key'], (result) => {
      if (result.supabase_url) supabaseUrlInput.value = result.supabase_url;
      if (result.supabase_anon_key) anonKeyInput.value = result.supabase_anon_key;
      if (result.supabase_url && result.supabase_anon_key) {
        configStatus.textContent = '✓ Configuration saved';
        configStatus.className = 'text-xs text-green-400';
      }
    });
  }
});

backBtn.addEventListener('click', () => {
  settingsPanel.classList.add('hidden');
  chatContainerEl.classList.remove('hidden');
  inputSection.classList.remove('hidden');
});

saveConfigBtn.addEventListener('click', () => {
  const url = supabaseUrlInput.value.trim();
  const key = anonKeyInput.value.trim();
  if (!url || !key) {
    configStatus.textContent = 'Please fill in both fields';
    configStatus.className = 'text-xs text-red-400';
    return;
  }
  chrome.storage.local.set({ supabase_url: url, supabase_anon_key: key }, () => {
    state.hasConfig = true;
    configStatus.textContent = '✓ Configuration saved securely';
    configStatus.className = 'text-xs text-green-400';
  });
});

// Chat
chatForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const text = chatInput.value.trim();
  if (!text) return;
  chatInput.value = '';

  addMessage('user', text);
  state.lastGoal = text;

  if (!state.hasConfig) {
    addMessage('assistant', '⚙️ Please configure your backend URL first! Click the gear icon in the top-right.');
    return;
  }

  await analyzeCurrentPage(text);
});

async function analyzeCurrentPage(userMessage) {
  const typingEl = showTyping();

  // Clear previous highlights
  chrome.runtime.sendMessage({ type: 'CLEAR_HIGHLIGHTS' });

  try {
    // Get current page URL
    const pageInfo = await new Promise((resolve) => {
      chrome.runtime.sendMessage({ type: 'GET_PAGE_INFO' }, resolve);
    });

    const currentUrl = pageInfo?.url || state.currentUrl;
    if (!currentUrl || currentUrl.startsWith('chrome://')) {
      removeTyping(typingEl);
      addMessage('assistant', '⚠️ I can\'t analyze Chrome internal pages. Please navigate to a website first.');
      return;
    }

    const response = await new Promise((resolve, reject) => {
      chrome.runtime.sendMessage({
        type: 'CALL_GUIDE',
        payload: {
          url: currentUrl,
          userMessage,
          pageContext: state.journey.join(' → ')
        }
      }, (res) => {
        if (res?.error && !res.success) reject(new Error(res.error === 'NO_CONFIG' ? res.message : res.error));
        else resolve(res);
      });
    });

    removeTyping(typingEl);

    if (response?.message) {
      addMessage('assistant', response.message);
    }

    if (response?.element?.selector) {
      chrome.runtime.sendMessage({
        type: 'HIGHLIGHT_ELEMENT',
        selector: response.element.selector,
        description: response.element.description || 'Click here to continue your integration.'
      });
      addMessage('assistant', `🟣 I've highlighted the **${response.element.description || 'target element'}** on the page. Look for the purple glow!`);
    }

    if (response?.nextStep) {
      addMessage('assistant', `📋 **Next up:** ${response.nextStep}`);
    }

  } catch (err) {
    removeTyping(typingEl);
    addMessage('assistant', `❌ Error: ${err.message}`);
  }
}

function addMessage(role, text) {
  state.messages.push({ role, text });
  const div = document.createElement('div');
  div.className = 'msg-appear flex gap-2.5';

  if (role === 'user') {
    div.innerHTML = `
      <div class="ml-auto bg-purple-500/20 border border-purple-500/30 rounded-xl rounded-tr-sm px-3 py-2 text-sm text-white/90 max-w-[85%]">
        ${escapeHtml(text)}
      </div>
    `;
  } else {
    div.innerHTML = `
      <div class="w-6 h-6 rounded-full bg-gradient-to-br from-purple-500 to-purple-600 flex items-center justify-center shrink-0 mt-0.5">
        <svg class="w-3 h-3 text-white" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path d="M12 2L2 12h3v8h6v-6h2v6h6v-8h3L12 2z"/></svg>
      </div>
      <div class="bg-navy-700 rounded-xl rounded-tl-sm px-3 py-2 text-sm text-white/90 max-w-[85%]">
        ${formatMarkdown(text)}
      </div>
    `;
  }

  chatContainer.appendChild(div);
  chatContainer.scrollTop = chatContainer.scrollHeight;
}

function showTyping() {
  const div = document.createElement('div');
  div.className = 'msg-appear flex gap-2.5';
  div.id = 'typing-indicator';
  div.innerHTML = `
    <div class="w-6 h-6 rounded-full bg-gradient-to-br from-purple-500 to-purple-600 flex items-center justify-center shrink-0 mt-0.5">
      <svg class="w-3 h-3 text-white" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path d="M12 2L2 12h3v8h6v-6h2v6h6v-8h3L12 2z"/></svg>
    </div>
    <div class="bg-navy-700 rounded-xl rounded-tl-sm px-3 py-3 flex gap-1">
      <span class="typing-dot w-1.5 h-1.5 bg-white/50 rounded-full"></span>
      <span class="typing-dot w-1.5 h-1.5 bg-white/50 rounded-full"></span>
      <span class="typing-dot w-1.5 h-1.5 bg-white/50 rounded-full"></span>
    </div>
  `;
  chatContainer.appendChild(div);
  chatContainer.scrollTop = chatContainer.scrollHeight;
  return div;
}

function removeTyping(el) { el?.remove(); }

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

function formatMarkdown(text) {
  return escapeHtml(text)
    .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
    .replace(/\*(.*?)\*/g, '<em>$1</em>')
    .replace(/`(.*?)`/g, '<code class="bg-white/10 px-1 rounded text-xs">$1</code>');
}

init();
