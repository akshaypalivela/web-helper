// Open side panel when extension icon is clicked
chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });

// Listen for messages from the side panel and content scripts
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'HIGHLIGHT_ELEMENT') {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (tabs[0]?.id) {
        chrome.tabs.sendMessage(tabs[0].id, {
          type: 'HIGHLIGHT',
          selector: message.selector,
          coordinates: message.coordinates,
          description: message.description
        }, sendResponse);
      }
    });
    return true;
  }

  if (message.type === 'CLEAR_HIGHLIGHTS') {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (tabs[0]?.id) {
        chrome.tabs.sendMessage(tabs[0].id, { type: 'CLEAR_HIGHLIGHTS' });
      }
    });
    sendResponse({ success: true });
  }

  if (message.type === 'GET_PAGE_INFO') {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (tabs[0]) {
        sendResponse({ url: tabs[0].url, title: tabs[0].title });
      }
    });
    return true;
  }

  if (message.type === 'URL_CHANGED') {
    // Forward URL change from content script to sidepanel
    // The sidepanel listens for this via onMessage
  }

  if (message.type === 'CALL_GUIDE') {
    callGuideFunction(message.payload).then(sendResponse).catch(err => {
      sendResponse({ success: false, error: err.message });
    });
    return true;
  }
});

async function callGuideFunction(payload) {
  const result = await chrome.storage.local.get(['supabase_url', 'supabase_anon_key']);
  const supabaseUrl = result.supabase_url;
  const anonKey = result.supabase_anon_key;

  if (!supabaseUrl || !anonKey) {
    return { success: false, error: 'NO_CONFIG', message: 'Please configure your backend URL in settings.' };
  }

  const response = await fetch(`${supabaseUrl}/functions/v1/integration-guide`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${anonKey}`,
      'apikey': anonKey,
    },
    body: JSON.stringify(payload)
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Guide API error [${response.status}]: ${text}`);
  }

  return await response.json();
}
