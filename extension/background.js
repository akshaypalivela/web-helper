// Open side panel when extension icon is clicked
chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });

// Listen for messages
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'HIGHLIGHT_ELEMENT') {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (tabs[0]?.id) {
        chrome.tabs.sendMessage(tabs[0].id, {
          type: 'HIGHLIGHT',
          selector: message.selector,
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

  if (message.type === 'SCRAPE_AND_GUIDE') {
    scrapeAndGuide(message.payload).then(sendResponse).catch(err => {
      sendResponse({ success: false, error: err.message });
    });
    return true;
  }
});

async function scrapeAndGuide({ url, userMessage, pageContext, firecrawlKey }) {
  // Step 1: Scrape with Firecrawl
  const scrapeRes = await fetch('https://api.firecrawl.dev/v1/scrape', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${firecrawlKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      url,
      formats: ['markdown', 'screenshot'],
      onlyMainContent: false,
      waitFor: 2000,
    }),
  });

  const scrapeData = await scrapeRes.json();
  if (!scrapeRes.ok) {
    throw new Error(scrapeData.error || `Firecrawl error [${scrapeRes.status}]`);
  }

  const markdown = scrapeData.data?.markdown || scrapeData.markdown || '';
  const pageTitle = scrapeData.data?.metadata?.title || scrapeData.metadata?.title || '';

  // Step 2: Call OpenRouter (free models) for analysis
  // We use a free model via the user's own key isn't needed for AI — 
  // we'll use Firecrawl's markdown and do local heuristic analysis instead
  const guide = analyzePageLocally(markdown, pageTitle, userMessage, pageContext);
  return { success: true, ...guide, pageTitle };
}

function analyzePageLocally(markdown, pageTitle, userMessage, pageContext) {
  const lower = markdown.toLowerCase();
  const goal = userMessage.toLowerCase();
  
  // Simple heuristic-based analysis
  const selectors = [];
  
  // Look for common integration patterns
  if (goal.includes('connect') || goal.includes('integrate') || goal.includes('sync') || goal.includes('setup') || goal.includes('set up')) {
    if (lower.includes('connect')) selectors.push({ selector: 'a[href*="connect"], button:has-text("Connect")', description: '"Connect" button' });
    if (lower.includes('authorize')) selectors.push({ selector: 'a[href*="auth"], button:has-text("Authorize")', description: '"Authorize" button' });
    if (lower.includes('install')) selectors.push({ selector: 'a[href*="install"], button:has-text("Install")', description: '"Install" button' });
    if (lower.includes('sign in') || lower.includes('log in')) selectors.push({ selector: 'a[href*="login"], button:has-text("Sign in"), button:has-text("Log in")', description: '"Sign In" button' });
    if (lower.includes('api key') || lower.includes('api token')) selectors.push({ selector: 'input[type="text"], input[type="password"]', description: 'API Key input field' });
    if (lower.includes('settings')) selectors.push({ selector: 'a[href*="settings"], button:has-text("Settings")', description: '"Settings" link' });
    if (lower.includes('integration')) selectors.push({ selector: 'a[href*="integration"], button:has-text("Integration")', description: '"Integrations" section' });
  }

  const element = selectors.length > 0 ? selectors[0] : null;
  
  let message = `I've analyzed **${pageTitle || 'this page'}**. `;
  if (element) {
    message += `Look for the **${element.description}** — I've highlighted it for you.`;
  } else {
    message += `I can see the page content. Try being more specific about what integration step you're on, and I'll help locate the right element.`;
  }

  return {
    message,
    element,
    nextStep: element ? 'Click the highlighted element, then I\'ll analyze the next page automatically.' : 'Describe what you see or what you\'re trying to do next.'
  };
}
