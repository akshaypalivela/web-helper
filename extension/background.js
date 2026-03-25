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
  const scrapeRes = await fetch('https://api.firecrawl.dev/v1/scrape', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${firecrawlKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      url,
      formats: ['markdown', 'screenshot', 'links', 'html'],
      onlyMainContent: false,
      waitFor: 2000,
    }),
  });

  const scrapeData = await scrapeRes.json();
  if (!scrapeRes.ok) {
    throw new Error(scrapeData.error || `Firecrawl error [${scrapeRes.status}]`);
  }

  const markdown = scrapeData.data?.markdown || scrapeData.markdown || '';
  const html = scrapeData.data?.html || scrapeData.html || '';
  const links = scrapeData.data?.links || scrapeData.links || [];
  const pageTitle = scrapeData.data?.metadata?.title || scrapeData.metadata?.title || '';

  const guide = analyzePageSmart(markdown, html, links, pageTitle, userMessage, pageContext);
  return { success: true, ...guide, pageTitle };
}

// --- Synonym / fuzzy matching dictionaries ---
const SYNONYMS = {
  settings: ['settings', 'preferences', 'options', 'gear', 'config', 'configuration', 'account settings', 'app settings', 'general'],
  profile: ['profile', 'my account', 'account', 'user', 'avatar', 'my profile', 'personal', 'personal info'],
  login: ['login', 'log in', 'sign in', 'signin', 'authenticate', 'sso'],
  signup: ['signup', 'sign up', 'register', 'create account', 'get started', 'join'],
  connect: ['connect', 'integrate', 'integration', 'sync', 'link', 'add', 'install', 'enable', 'activate', 'authorize', 'oauth'],
  dashboard: ['dashboard', 'home', 'overview', 'main', 'start'],
  api: ['api', 'api key', 'api token', 'developer', 'developers', 'tokens', 'credentials', 'keys', 'webhook', 'webhooks'],
  billing: ['billing', 'payment', 'subscription', 'plan', 'pricing', 'upgrade', 'invoice'],
  notifications: ['notifications', 'alerts', 'notify', 'bell', 'email notifications'],
  security: ['security', 'password', 'two-factor', '2fa', 'mfa', 'authentication', 'privacy'],
  help: ['help', 'support', 'docs', 'documentation', 'faq', 'contact', 'feedback'],
  search: ['search', 'find', 'lookup', 'filter'],
  menu: ['menu', 'hamburger', 'navigation', 'nav', 'sidebar', 'drawer'],
  logout: ['logout', 'log out', 'sign out', 'signout', 'disconnect'],
};

function getExpandedTerms(userInput) {
  const lower = userInput.toLowerCase().trim();
  const terms = new Set([lower]);

  for (const [, synonyms] of Object.entries(SYNONYMS)) {
    if (synonyms.some(s => lower.includes(s))) {
      synonyms.forEach(s => terms.add(s));
    }
  }

  // Also add individual words
  lower.split(/\s+/).forEach(w => {
    terms.add(w);
    for (const [, synonyms] of Object.entries(SYNONYMS)) {
      if (synonyms.includes(w)) {
        synonyms.forEach(s => terms.add(s));
      }
    }
  });

  return [...terms];
}

// Common interactive element patterns in HTML/markdown
const CLICKABLE_PATTERNS = [
  // Links with text
  { regex: /\[([^\]]+)\]\(([^)]+)\)/g, type: 'link' },
  // Buttons mentioned in markdown
  { regex: /(?:button|btn|click|tap|press|select|choose)\s*[:\-–]?\s*["']?([^"'\n,.]{2,40})["']?/gi, type: 'button' },
];

function analyzePageSmart(markdown, html, links, pageTitle, userMessage, pageContext) {
  const terms = getExpandedTerms(userMessage);
  const lower = markdown.toLowerCase();
  const htmlLower = html.toLowerCase();

  // Score-based element matching
  const candidates = [];

  // 1. Search markdown links
  const linkRegex = /\[([^\]]+)\]\(([^)]+)\)/g;
  let match;
  while ((match = linkRegex.exec(markdown)) !== null) {
    const text = match[1].toLowerCase();
    const href = match[2].toLowerCase();
    const score = scoreMatch(text + ' ' + href, terms);
    if (score > 0) {
      candidates.push({
        score,
        selector: `a[href*="${extractPathSegment(match[2])}"]`,
        description: match[1].trim(),
        type: 'link',
      });
    }
  }

  // 2. Search for nav/menu items, buttons from HTML patterns
  const buttonPatterns = [
    { regex: /<a[^>]*href=["']([^"']+)["'][^>]*>([^<]+)<\/a>/gi, selectorFn: (href) => `a[href*="${extractPathSegment(href)}"]` },
    { regex: /<button[^>]*>([^<]+)<\/button>/gi, selectorFn: (_, text) => `button:has-text("${text.trim()}")` },
    { regex: /<input[^>]*type=["']submit["'][^>]*value=["']([^"']+)["']/gi, selectorFn: (_, val) => `input[type="submit"][value="${val.trim()}"]` },
  ];

  for (const { regex, selectorFn } of buttonPatterns) {
    const r = new RegExp(regex.source, regex.flags);
    while ((match = r.exec(html)) !== null) {
      const fullText = (match[2] || match[1] || '').toLowerCase();
      const score = scoreMatch(fullText, terms);
      if (score > 0) {
        const sel = match[2] ? selectorFn(match[1], match[2]) : selectorFn(match[1]);
        candidates.push({
          score,
          selector: sel,
          description: (match[2] || match[1] || '').trim(),
          type: 'button',
        });
      }
    }
  }

  // 3. Search page links array
  for (const link of links) {
    const linkLower = link.toLowerCase();
    const score = scoreMatch(linkLower, terms);
    if (score > 0) {
      const pathSeg = extractPathSegment(link);
      candidates.push({
        score,
        selector: `a[href*="${pathSeg}"]`,
        description: pathSeg.replace(/[/-]/g, ' ').trim() || link,
        type: 'link',
      });
    }
  }

  // 4. Fallback: check for common UI patterns in markdown text
  const lines = markdown.split('\n').filter(l => l.trim());
  for (const line of lines) {
    const lineLower = line.toLowerCase().trim();
    if (lineLower.length > 100) continue; // skip long paragraphs
    const score = scoreMatch(lineLower, terms);
    if (score > 0 && (lineLower.startsWith('#') || lineLower.startsWith('-') || lineLower.startsWith('*') || lineLower.length < 50)) {
      const cleanText = line.replace(/^[#\-*\s]+/, '').trim();
      candidates.push({
        score: score * 0.5, // lower priority for text-only matches
        selector: `*:has-text("${cleanText.substring(0, 30)}")`,
        description: cleanText,
        type: 'text',
      });
    }
  }

  // Sort by score descending, take top 3
  candidates.sort((a, b) => b.score - a.score);
  const unique = deduplicateCandidates(candidates);
  const top3 = unique.slice(0, 3);

  if (top3.length === 0) {
    return {
      message: `I searched for **"${userMessage}"** on **${pageTitle || 'this page'}** but couldn't find any matching elements. Try describing what you see, or use a different keyword.`,
      element: null,
      nextStep: 'Try a different search term, or tell me what buttons or links you can see on the page.',
    };
  }

  const best = top3[0];
  const confidence = best.score >= 3 ? 'high' : best.score >= 1.5 ? 'medium' : 'low';

  let message;
  if (confidence === 'high') {
    message = `Found **"${best.description}"** on **${pageTitle || 'this page'}** — highlighted it for you.`;
  } else {
    message = `Best match for **"${userMessage}"**: **"${best.description}"**. Is this what you're looking for?`;
  }

  if (top3.length > 1) {
    const others = top3.slice(1).map(c => `• **${c.description}**`).join('\n');
    message += `\n\nOther matches:\n${others}`;
  }

  return {
    message,
    element: { selector: best.selector, description: best.description },
    alternatives: top3.slice(1).map(c => ({ selector: c.selector, description: c.description })),
    nextStep: confidence === 'high'
      ? 'Click the highlighted element, then I\'ll analyze the next page automatically.'
      : 'Let me know if this is right, or I\'ll search for something else.',
  };
}

function scoreMatch(text, terms) {
  let score = 0;
  for (const term of terms) {
    if (text.includes(term)) {
      // Exact word match gets more points
      const wordBoundary = new RegExp(`\\b${escapeRegex(term)}\\b`, 'i');
      if (wordBoundary.test(text)) {
        score += 2;
      } else {
        score += 1;
      }
    }
  }
  return score;
}

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function extractPathSegment(url) {
  try {
    const u = new URL(url, 'https://placeholder.com');
    const segments = u.pathname.split('/').filter(Boolean);
    return segments[segments.length - 1] || u.pathname;
  } catch {
    return url.split('/').filter(Boolean).pop() || url;
  }
}

function deduplicateCandidates(candidates) {
  const seen = new Set();
  return candidates.filter(c => {
    const key = c.description.toLowerCase().substring(0, 20);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
