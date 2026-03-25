// Open side panel when extension icon is clicked
chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });

// Listen for messages from the side panel
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'HIGHLIGHT_ELEMENT') {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (tabs[0]?.id) {
        chrome.tabs.sendMessage(tabs[0].id, {
          type: 'HIGHLIGHT',
          selector: message.selector,
          coordinates: message.coordinates,
          description: message.description
        });
      }
    });
    sendResponse({ success: true });
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
    return true; // async
  }

  if (message.type === 'CALL_MULTION') {
    callMultiOn(message.payload).then(sendResponse).catch(err => {
      sendResponse({ error: err.message });
    });
    return true; // async
  }
});

async function callMultiOn(payload) {
  const result = await chrome.storage.local.get(['multion_api_key']);
  const apiKey = result.multion_api_key;
  if (!apiKey) {
    return { error: 'NO_API_KEY', message: 'Please set your MultiOn API key in the settings.' };
  }

  const response = await fetch('https://api.multion.ai/v1/browse', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`
    },
    body: JSON.stringify(payload)
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`MultiOn API error [${response.status}]: ${text}`);
  }

  return await response.json();
}
