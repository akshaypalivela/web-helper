// Content script for highlighting elements on the page

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'HIGHLIGHT') {
    clearAllHighlights();

    if (message.selector) {
      const el = document.querySelector(message.selector);
      if (el) {
        highlightElement(el, message.description);
        sendResponse({ success: true, found: true });
        return;
      }
    }

    if (message.coordinates) {
      const { x, y } = message.coordinates;
      const el = document.elementFromPoint(x, y);
      if (el) {
        highlightElement(el, message.description);
        sendResponse({ success: true, found: true });
        return;
      }
    }

    sendResponse({ success: true, found: false });
  }

  if (message.type === 'CLEAR_HIGHLIGHTS') {
    clearAllHighlights();
    sendResponse({ success: true });
  }

  if (message.type === 'GET_PAGE_URL') {
    sendResponse({ url: window.location.href, title: document.title });
  }
});

// Notify sidebar of URL changes (SPA navigation)
let lastUrl = window.location.href;
const urlObserver = new MutationObserver(() => {
  if (window.location.href !== lastUrl) {
    lastUrl = window.location.href;
    chrome.runtime.sendMessage({ type: 'URL_CHANGED', url: lastUrl, title: document.title });
  }
});
urlObserver.observe(document.body, { childList: true, subtree: true });

function highlightElement(el, description) {
  el.classList.add('ig-highlight');

  // Create AI tip bubble
  const tip = document.createElement('div');
  tip.className = 'ig-tip-bubble';
  tip.textContent = description || 'Click here to continue your integration.';

  const rect = el.getBoundingClientRect();
  tip.style.position = 'fixed';
  tip.style.top = `${Math.max(8, rect.top - 44)}px`;
  tip.style.left = `${rect.left}px`;
  tip.style.zIndex = '2147483647';

  document.body.appendChild(tip);

  // Scroll into view
  el.scrollIntoView({ behavior: 'smooth', block: 'center' });
}

function clearAllHighlights() {
  document.querySelectorAll('.ig-highlight').forEach(el => {
    el.classList.remove('ig-highlight');
  });
  document.querySelectorAll('.ig-tip-bubble').forEach(el => el.remove());
}
