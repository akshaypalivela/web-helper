// State
const state = {
  messages: [],
  journey: [],
  currentDomain: '',
  hasApiKey: false
};

// DOM elements
const chatContainer = document.getElementById('chat-container');
const chatForm = document.getElementById('chat-form');
const chatInput = document.getElementById('chat-input');
const settingsBtn = document.getElementById('settings-btn');
const settingsPanel = document.getElementById('settings-panel');
const chatContainerEl = document.getElementById('chat-container');
const inputSection = chatForm.closest('.px-4');
const apiKeyInput = document.getElementById('api-key-input');
const saveKeyBtn = document.getElementById('save-key-btn');
const keyStatus = document.getElementById('key-status');
const backBtn = document.getElementById('back-btn');
const pageContext = document.getElementById('page-context');
const journeyBar = document.getElementById('journey-bar');
const journeySteps = document.getElementById('journey-steps');

// Init
async function init() {
  const result = await chrome.storage.local.get(['multion_api_key', 'journey_state']);
  state.hasApiKey = !!result.multion_api_key;
  if (result.journey_state) {
    state.journey = result.journey_state;
    renderJourney();
  }
  updatePageContext();

  // Listen for tab changes
  chrome.tabs.onActivated?.addListener(() => updatePageContext());
  chrome.tabs.onUpdated?.addListener((tabId, changeInfo) => {
    if (changeInfo.status === 'complete') updatePageContext();
  });
}

function updatePageContext() {
  chrome.runtime.sendMessage({ type: 'GET_PAGE_INFO' }, (response) => {
    if (response?.url) {
      try {
        const domain = new URL(response.url).hostname;
        pageContext.textContent = domain;
        if (domain !== state.currentDomain && state.currentDomain) {
          addJourneyStep(domain);
        }
        state.currentDomain = domain;
      } catch {
        pageContext.textContent = 'Ready to help';
      }
    }
  });
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
    return `<span class="${isLast ? 'text-flame-400 font-medium' : ''}">${step}</span>${!isLast ? '<span class="text-white/20">→</span>' : ''}`;
  }).join('');
}

// Settings toggle
settingsBtn.addEventListener('click', () => {
  const isHidden = settingsPanel.classList.contains('hidden');
  settingsPanel.classList.toggle('hidden');
  chatContainerEl.classList.toggle('hidden', !settingsPanel.classList.contains('hidden'));
  inputSection.classList.toggle('hidden', !settingsPanel.classList.contains('hidden'));
  if (isHidden) {
    chrome.storage.local.get(['multion_api_key'], (result) => {
      if (result.multion_api_key) {
        apiKeyInput.value = result.multion_api_key;
        keyStatus.textContent = '✓ Key saved';
        keyStatus.className = 'text-xs text-green-400';
      }
    });
  }
});

backBtn.addEventListener('click', () => {
  settingsPanel.classList.add('hidden');
  chatContainerEl.classList.remove('hidden');
  inputSection.classList.remove('hidden');
});

saveKeyBtn.addEventListener('click', () => {
  const key = apiKeyInput.value.trim();
  if (!key) {
    keyStatus.textContent = 'Please enter a valid key';
    keyStatus.className = 'text-xs text-red-400';
    return;
  }
  chrome.storage.local.set({ multion_api_key: key }, () => {
    state.hasApiKey = true;
    keyStatus.textContent = '✓ Key saved securely';
    keyStatus.className = 'text-xs text-green-400';
  });
});

// Chat
chatForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const text = chatInput.value.trim();
  if (!text) return;
  chatInput.value = '';

  addMessage('user', text);

  if (!state.hasApiKey) {
    addMessage('assistant', '⚙️ Please set your MultiOn API key first! Click the gear icon in the top-right.');
    return;
  }

  // Show typing
  const typingEl = showTyping();

  try {
    const response = await new Promise((resolve, reject) => {
      chrome.runtime.sendMessage({
        type: 'CALL_MULTION',
        payload: {
          cmd: text,
          url: state.currentDomain ? `https://${state.currentDomain}` : undefined,
          local: false
        }
      }, (res) => {
        if (res?.error) reject(new Error(res.error === 'NO_API_KEY' ? res.message : res.error));
        else resolve(res);
      });
    });

    removeTyping(typingEl);

    // Process response - extract element info
    if (response?.message) {
      addMessage('assistant', response.message);
    }

    if (response?.element) {
      // Highlight the element on the page
      chrome.runtime.sendMessage({
        type: 'HIGHLIGHT_ELEMENT',
        selector: response.element.selector,
        coordinates: response.element.coordinates,
        description: response.element.description || 'Click here'
      });
      addMessage('assistant', `🔶 I've highlighted the element: **${response.element.description || 'target element'}**. Look for the orange glow on the page!`);
    } else if (response?.status) {
      addMessage('assistant', `Status: ${response.status}. ${response.url ? `Current page: ${response.url}` : ''}`);
    }

  } catch (err) {
    removeTyping(typingEl);
    addMessage('assistant', `❌ Error: ${err.message}`);
  }
});

function addMessage(role, text) {
  state.messages.push({ role, text });
  const div = document.createElement('div');
  div.className = 'msg-appear flex gap-2.5';

  if (role === 'user') {
    div.innerHTML = `
      <div class="ml-auto bg-flame-500/20 border border-flame-500/30 rounded-xl rounded-tr-sm px-3 py-2 text-sm text-white/90 max-w-[85%]">
        ${escapeHtml(text)}
      </div>
    `;
  } else {
    div.innerHTML = `
      <div class="w-6 h-6 rounded-full bg-gradient-to-br from-flame-500 to-flame-400 flex items-center justify-center shrink-0 mt-0.5">
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
    <div class="w-6 h-6 rounded-full bg-gradient-to-br from-flame-500 to-flame-400 flex items-center justify-center shrink-0 mt-0.5">
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

function removeTyping(el) {
  el?.remove();
}

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
