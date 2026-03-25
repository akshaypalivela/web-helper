// Content script: ghost mouse + AI tip bubble

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'HIGHLIGHT_AT') {
    clearAllHighlights();
    drawGhostMouse(message.xPct, message.yPct, message.description);
    sendResponse({ success: true });
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

function drawGhostMouse(xPct, yPct, description) {
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const x = (xPct / 100) * vw;
  const y = (yPct / 100) * vh;

  // Ghost mouse circle
  const circle = document.createElement('div');
  circle.className = 'ig-ghost-mouse';
  circle.style.left = `${x}px`;
  circle.style.top = `${y}px`;
  document.body.appendChild(circle);

  // AI Tip bubble
  const tip = document.createElement('div');
  tip.className = 'ig-tip-bubble';
  tip.textContent = description || 'Click here to continue your integration.';
  
  // Position tip above the circle
  tip.style.position = 'fixed';
  tip.style.left = `${Math.max(8, x - 80)}px`;
  tip.style.top = `${Math.max(8, y - 60)}px`;
  tip.style.zIndex = '2147483647';
  document.body.appendChild(tip);

  // Scroll the area into view
  window.scrollTo({
    top: window.scrollY + y - vh / 2,
    behavior: 'smooth'
  });
}

function clearAllHighlights() {
  document.querySelectorAll('.ig-ghost-mouse').forEach(el => el.remove());
  document.querySelectorAll('.ig-tip-bubble').forEach(el => el.remove());
}
