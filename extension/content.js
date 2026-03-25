// Content script for highlighting elements on the page

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'HIGHLIGHT') {
    clearAllHighlights();

    if (message.selector) {
      const el = document.querySelector(message.selector);
      if (el) {
        highlightElement(el, message.description);
      }
    } else if (message.coordinates) {
      const { x, y } = message.coordinates;
      const el = document.elementFromPoint(x, y);
      if (el) {
        highlightElement(el, message.description);
      }
    }

    sendResponse({ success: true });
  }

  if (message.type === 'CLEAR_HIGHLIGHTS') {
    clearAllHighlights();
    sendResponse({ success: true });
  }
});

function highlightElement(el, description) {
  el.classList.add('ig-highlight');
  el.dataset.igDescription = description || '';

  // Create tooltip
  const tooltip = document.createElement('div');
  tooltip.className = 'ig-tooltip';
  tooltip.textContent = description || 'Click here';

  const rect = el.getBoundingClientRect();
  tooltip.style.position = 'fixed';
  tooltip.style.top = `${rect.top - 40}px`;
  tooltip.style.left = `${rect.left}px`;
  tooltip.style.zIndex = '2147483647';

  document.body.appendChild(tooltip);

  // Scroll into view
  el.scrollIntoView({ behavior: 'smooth', block: 'center' });
}

function clearAllHighlights() {
  document.querySelectorAll('.ig-highlight').forEach(el => {
    el.classList.remove('ig-highlight');
    delete el.dataset.igDescription;
  });
  document.querySelectorAll('.ig-tooltip').forEach(el => el.remove());
}
