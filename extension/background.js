// Open side panel when extension icon is clicked
chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'HIGHLIGHT_AT') {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (tabs[0]?.id) {
        chrome.tabs.sendMessage(tabs[0].id, {
          type: 'HIGHLIGHT_AT',
          xPct: message.xPct,
          yPct: message.yPct,
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
    return true;
  }

  if (message.type === 'ANALYZE_PAGE') {
    analyzePage(message.payload).then(sendResponse).catch(err => {
      sendResponse({ success: false, error: err.message });
    });
    return true;
  }
});

async function analyzePage({ url, userMessage, firecrawlKey, geminiKey }) {
  // Step 1: Firecrawl screenshot + markdown
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

  const screenshot = scrapeData.data?.screenshot || scrapeData.screenshot || '';
  const markdown = scrapeData.data?.markdown || scrapeData.markdown || '';
  const pageTitle = scrapeData.data?.metadata?.title || scrapeData.metadata?.title || '';

  if (!screenshot) {
    throw new Error('Firecrawl did not return a screenshot. Try again.');
  }

  // Step 2: Send screenshot to Gemini 3 Flash
  const geminiResult = await callGemini({
    geminiKey,
    screenshot,
    markdown,
    userMessage,
    pageTitle,
  });

  return { success: true, ...geminiResult, pageTitle };
}

async function callGemini({ geminiKey, screenshot, markdown, userMessage, pageTitle }) {
  const systemInstruction = `You are a UI Guide. You help users navigate web interfaces step-by-step.

RULES:
- Analyze the screenshot and the page markdown to find the specific button, link, or UI element the user needs to interact with next.
- Return ONLY a valid JSON object. No markdown fences, no explanation outside JSON.
- The JSON must have these fields:
  {
    "x": <number 0-100, percentage from left>,
    "y": <number 0-100, percentage from top>,
    "description": "<1-sentence explanation of what this element does>",
    "confidence": <number 0.0 to 1.0>,
    "elementLabel": "<the visible text or icon name of the element>"
  }
- Be smart about synonyms: "Settings" = gear icon, preferences, account, config.
- If the user says "Profile", also look for avatar, account, user icon.
- Always pick the MOST LIKELY match even if uncertain — set confidence accordingly.
- If you truly cannot find anything relevant, set confidence to 0 and describe what you see.`;

  // Build the request parts
  const parts = [
    { text: `User intent: "${userMessage}"\n\nPage title: "${pageTitle}"\n\nPage content (markdown):\n${markdown.substring(0, 3000)}` },
  ];

  // Add screenshot as inline image
  // Firecrawl returns base64 screenshot (data URI or raw base64)
  let base64Data = screenshot;
  if (base64Data.startsWith('data:')) {
    base64Data = base64Data.split(',')[1];
  }

  const body = {
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
      maxOutputTokens: 500,
    }
  };

  const geminiRes = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${geminiKey}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }
  );

  const geminiData = await geminiRes.json();
  if (!geminiRes.ok) {
    const errMsg = geminiData.error?.message || `Gemini error [${geminiRes.status}]`;
    throw new Error(errMsg);
  }

  // Parse the response text
  const rawText = geminiData.candidates?.[0]?.content?.parts?.[0]?.text || '';
  
  // Extract JSON from response (handle markdown fences)
  let jsonStr = rawText.trim();
  const fenceMatch = jsonStr.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenceMatch) jsonStr = fenceMatch[1].trim();
  
  try {
    const result = JSON.parse(jsonStr);
    return {
      x: Math.max(0, Math.min(100, Number(result.x) || 50)),
      y: Math.max(0, Math.min(100, Number(result.y) || 50)),
      description: result.description || 'Click this element.',
      confidence: Math.max(0, Math.min(1, Number(result.confidence) || 0.5)),
      elementLabel: result.elementLabel || 'Element',
    };
  } catch {
    // If JSON parse fails, return a fallback
    return {
      x: 50, y: 50,
      description: rawText.substring(0, 200) || 'Could not parse Gemini response.',
      confidence: 0,
      elementLabel: 'Unknown',
    };
  }
}
