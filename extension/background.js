// Helper: convert image URL to raw base64 string
async function imageUrlToBase64(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Failed to fetch screenshot: ${response.status}`);
  const blob = await response.blob();
  if (blob.type.includes('text/html')) throw new Error('Expected image but got text/html');
  const buffer = await blob.arrayBuffer();
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

function extractBalancedJsonObjectFrom(text, start) {
  if (start < 0 || start >= text.length || text[start] !== '{') return null;
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (inStr) {
      if (esc) {
        esc = false;
        continue;
      }
      if (c === '\\') {
        esc = true;
        continue;
      }
      if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') {
      inStr = true;
      continue;
    }
    if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) {
        try {
          return JSON.parse(text.slice(start, i + 1));
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

function extractBalancedJsonObject(text) {
  const start = text.indexOf('{');
  return start < 0 ? null : extractBalancedJsonObjectFrom(text, start);
}

function extractAnyGuideJson(text) {
  if (!text) return null;
  for (let i = 0; i < text.length; i++) {
    if (text[i] !== '{') continue;
    const obj = extractBalancedJsonObjectFrom(text, i);
    if (obj && typeof obj === 'object' && ('description' in obj || 'elementLabel' in obj || 'x' in obj)) {
      return obj;
    }
  }
  return null;
}

function getGeminiResponseText(data) {
  const parts = data.candidates?.[0]?.content?.parts;
  if (!parts?.length) return '';
  return parts.map((p) => (typeof p.text === 'string' ? p.text : '')).join('').trim();
}

/** Structured output — improves JSON reliability; retried without if API rejects. */
const GUIDE_RESPONSE_SCHEMA = {
  type: 'OBJECT',
  properties: {
    x: { type: 'NUMBER' },
    y: { type: 'NUMBER' },
    description: { type: 'STRING' },
    confidence: { type: 'NUMBER' },
    elementLabel: { type: 'STRING' },
    isMultiStep: { type: 'BOOLEAN' },
    overallPlan: { type: 'STRING' },
    stepSummary: { type: 'STRING' },
  },
  required: ['x', 'y', 'description', 'confidence', 'elementLabel', 'isMultiStep', 'overallPlan', 'stepSummary'],
};

function stripJsonArtifacts(str) {
  if (!str || typeof str !== 'string') return '';
  let s = str.trim();
  const leak = s.search(/\{\s*"\s*x\s*"\s*:/);
  if (leak >= 0) s = s.slice(0, leak).trim();
  s = s.replace(/\{\s*"[^"]*"\s*:\s*[^}]*$/g, '').trim();
  s = s.replace(/"description\s*:\s*"[^"]*$/i, '').trim();
  return s.replace(/[,.;:\s]+$/g, '').trim();
}

// Open side panel when extension icon is clicked
chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'GUIDANCE_DOM_CHANGED') {
    const tabId = sender.tab?.id;
    if (tabId) {
      const payload = { tabId, url: message.url || '', t: Date.now() };
      if (chrome.storage.session) {
        chrome.storage.session.set({ ig_dom_signal: payload });
      } else {
        chrome.storage.local.set({ ig_dom_signal: payload });
      }
    }
    return;
  }

  if (message.type === 'HIGHLIGHT_AT') {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (tabs[0]?.id) {
        chrome.tabs.sendMessage(tabs[0].id, {
          type: 'HIGHLIGHT_AT',
          xPct: message.xPct,
          yPct: message.yPct,
          description: message.description,
          elementLabel: message.elementLabel || '',
          intentText: message.intentText || '',
        });
      }
    });
    sendResponse({ success: true });
  }

  if (message.type === 'END_GUIDE_SESSION') {
    chrome.storage.local.set({ guide_session_end_v1: true }, () => {
      chrome.tabs.query({}, (tabs) => {
        for (const t of tabs) {
          if (t?.id && t.url && /^https?:/.test(t.url)) {
            chrome.tabs.sendMessage(t.id, { type: 'CLEAR_HIGHLIGHTS' }).catch(() => {});
          }
        }
        sendResponse({ ok: true });
      });
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

  if (message.type === 'ANALYZE_PAGE') {
    analyzePage(message.payload).then(sendResponse).catch(err => {
      sendResponse({ success: false, error: err.message });
    });
    return true;
  }
});

async function analyzePage({ url, userMessage, firecrawlKey, geminiKey, clientScreenshot, pageText, pageTitle: clientTitle }) {
  let screenshot;
  let markdown;
  let pageTitle = clientTitle || '';

  if (clientScreenshot && typeof clientScreenshot === 'string' && clientScreenshot.startsWith('data:image')) {
    screenshot = clientScreenshot;
    markdown = (pageText || '').slice(0, 8000);
  } else {
    const scrapeRes = await fetch('https://api.firecrawl.dev/v1/scrape', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${firecrawlKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        url,
        formats: ['screenshot', 'markdown'],
        onlyMainContent: false,
        waitFor: 2000,
      }),
    });

    const scrapeData = await scrapeRes.json();
    if (!scrapeRes.ok) {
      throw new Error(scrapeData.error || `Firecrawl error [${scrapeRes.status}]`);
    }

    screenshot = scrapeData.data?.screenshot || scrapeData.screenshot || '';
    markdown = scrapeData.data?.markdown || scrapeData.markdown || '';
    pageTitle = scrapeData.data?.metadata?.title || scrapeData.metadata?.title || pageTitle;

    if (!screenshot) {
      throw new Error('Firecrawl did not return a screenshot. Try again.');
    }
  }

  const geminiResult = await callGemini({
    geminiKey,
    screenshot,
    markdown,
    userMessage,
    pageTitle,
    usedLiveViewport: Boolean(clientScreenshot),
  });

  return { success: true, ...geminiResult, pageTitle };
}

async function callGemini({ geminiKey, screenshot, markdown, userMessage, pageTitle, usedLiveViewport }) {
  const coordHint = usedLiveViewport
    ? `CRITICAL: The image is a pixel-accurate capture of the user's current browser viewport (what they see right now). x and y MUST be the center of the target control as a percentage of THIS image: x = 100 * (centerX / imageWidth), y = 100 * (centerY / imageHeight). Do not guess adjacent nav items — if the user asked for "Explore", the point must be on Explore, not Home.`
    : `The image may be from a server-side render and can differ from the user's tab (login, scroll, window size). Prefer anchors from the page text below when they disambiguate. x/y are still viewport percentages of this image.`;

  const systemInstruction = `You are a UI Guide. You help users navigate web interfaces step-by-step.

RULES:
- Analyze the screenshot and the page text/markdown to find the specific control the user should use NEXT.
${coordHint}
- elementLabel MUST be the exact visible text, aria-label, or tooltip of the element you target. x/y MUST be the center of THAT same element — never a different widget. If you cannot align label and position, lower confidence.
- For goals that need several screens (e.g. "make repo private"), set isMultiStep true, give a short overallPlan (2–4 sentences), but still output only ONE action for what is visible NOW. stepSummary is one past-tense line (e.g. "Opened Settings menu") for history.
- Return ONLY a valid JSON object. No markdown fences, no explanation outside JSON.
- The JSON must have these fields:
  {
    "x": <number 0-100, percentage from left of image>,
    "y": <number 0-100, percentage from top of image>,
    "description": "<1-sentence instruction, no raw coordinates>",
    "confidence": <number 0.0 to 1.0>,
    "elementLabel": "<visible label or aria text of the element you targeted>",
    "isMultiStep": <boolean>,
    "overallPlan": "<brief multi-step overview, or empty string if isMultiStep is false>",
    "stepSummary": "<one line: what this click accomplishes; used for step history>"
  }
- Be smart about synonyms: "Settings" = gear icon, preferences, account, config.
- If the user says "Profile", also look for avatar, account, user icon.
- If you cannot find a control that matches the user's intent, set confidence to 0, still pick best-effort x/y for a related area, and explain in description (without embedding JSON).
- Never put a JSON object inside "description".
- Many apps use a long scrollable left sidebar: nav links may appear in the page text but be off-screen. Prefer elementLabel text that literally appears in the page text; the extension will scroll the sidebar. If the item is not in the screenshot, place x/y over the sidebar strip (often x around 5–18%) and lower confidence slightly.
- For "dashboard", "home", or "main hub": target the product logo/home link, a "Dashboard" or "Home" nav item, or the primary app switcher — not marketing cards or unrelated titles on landing pages.
- Never invent a button name (e.g. "Admin") if that exact label is not in the screenshot or page text; pick the closest real control.
- If the user asks for "integrations" / HRIS / apps: elementLabel must be the real nav text (e.g. "Integrations", "Connected apps") if it appears anywhere in the page text, even when that row is off-screen in a scrollable sidebar — the extension scrolls to it.
- If the control is inside a collapsed sidebar group, dropdown, or <details>, set isMultiStep true: overallPlan should say to expand/open that section first; stepSummary for this step names that parent (e.g. "Open Playground section"); elementLabel should match the visible expander control.`;

  // Build the request parts
  const parts = [
    { text: `User intent: "${userMessage}"\n\nPage title: "${pageTitle}"\n\nPage content (markdown):\n${markdown.substring(0, 3000)}` },
  ];

  // Convert screenshot to base64 - handle URL, data URI, or raw base64
  let base64Data;
  if (screenshot.startsWith('http://') || screenshot.startsWith('https://')) {
    base64Data = await imageUrlToBase64(screenshot);
  } else if (screenshot.startsWith('data:')) {
    base64Data = screenshot.split(',')[1];
  } else {
    base64Data = screenshot;
  }

  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-3-flash-preview:generateContent?key=${geminiKey}`;

  const makeBody = (useSchema) => ({
    contents: [{
      parts: [
        ...parts,
        {
          inlineData: {
            mimeType: 'image/png',
            data: base64Data,
          }
        }
      ]
    }],
    systemInstruction: { parts: [{ text: systemInstruction }] },
    generationConfig: {
      temperature: 0.2,
      maxOutputTokens: 900,
      responseMimeType: 'application/json',
      ...(useSchema ? { responseSchema: GUIDE_RESPONSE_SCHEMA } : {}),
    },
  });

  let geminiRes = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(makeBody(true)),
  });
  let geminiData = await geminiRes.json();

  if (!geminiRes.ok) {
    geminiRes = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(makeBody(false)),
    });
    geminiData = await geminiRes.json();
  }

  if (!geminiRes.ok) {
    const errMsg = geminiData.error?.message || `Gemini error [${geminiRes.status}]`;
    throw new Error(errMsg);
  }

  if (!geminiData.candidates?.length) {
    const block = geminiData.promptFeedback?.blockReason || 'no candidates';
    throw new Error(`Gemini returned no usable reply (${block}). Try rephrasing or another page.`);
  }

  const rawText = getGeminiResponseText(geminiData);
  if (!rawText) {
    const fr = geminiData.candidates[0]?.finishReason || 'unknown';
    throw new Error(`Empty model output (${fr}). Try again or shorten the prompt.`);
  }

  let jsonStr = rawText.trim();
  const fenceMatch = jsonStr.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenceMatch) jsonStr = fenceMatch[1].trim();

  let result = null;
  try {
    result = JSON.parse(jsonStr);
  } catch {
    result =
      extractBalancedJsonObject(jsonStr) ||
      extractAnyGuideJson(jsonStr) ||
      extractBalancedJsonObject(rawText) ||
      extractAnyGuideJson(rawText);
  }

  if (!result || typeof result !== 'object') {
    const geminiRes2 = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(makeBody(false)),
    });
    const geminiData2 = await geminiRes2.json();
    if (geminiRes2.ok && geminiData2.candidates?.length) {
      const rawText2 = getGeminiResponseText(geminiData2);
      let jsonStr2 = rawText2.trim();
      const fence2 = jsonStr2.match(/```(?:json)?\s*([\s\S]*?)```/);
      if (fence2) jsonStr2 = fence2[1].trim();
      try {
        result = JSON.parse(jsonStr2);
      } catch {
        result =
          extractBalancedJsonObject(jsonStr2) ||
          extractAnyGuideJson(jsonStr2) ||
          extractBalancedJsonObject(rawText2) ||
          extractAnyGuideJson(rawText2);
      }
    }
  }

  if (!result || typeof result !== 'object') {
    const fallbackDesc = stripJsonArtifacts(rawText.substring(0, 400)) || 'Could not parse the model response.';
    return {
      x: 50,
      y: 50,
      description: fallbackDesc,
      confidence: 0,
      elementLabel: 'Unknown',
      isMultiStep: false,
      overallPlan: '',
      stepSummary: '',
    };
  }

  let description = stripJsonArtifacts(String(result.description || '').trim());
  if (!description) {
    description =
      Number(result.confidence) === 0
        ? 'Try scrolling until the right control is visible, then use Next step.'
        : 'Click this element.';
  }
  const overallPlan = stripJsonArtifacts(String(result.overallPlan || '').trim());
  const stepSummary = stripJsonArtifacts(String(result.stepSummary || '').trim());

  let conf = Number(result.confidence);
  if (!Number.isFinite(conf)) conf = 0.5;

  return {
    x: Math.max(0, Math.min(100, Number(result.x) || 50)),
    y: Math.max(0, Math.min(100, Number(result.y) || 50)),
    description,
    confidence: Math.max(0, Math.min(1, conf)),
    elementLabel: String(result.elementLabel || 'Element').trim() || 'Element',
    isMultiStep: Boolean(result.isMultiStep),
    overallPlan,
    stepSummary,
  };
}
