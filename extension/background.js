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

function repairJsonString(s) {
  if (!s || typeof s !== 'string') return s;
  return s.replace(/,\s*([}\]])/g, '$1').trim();
}

function tryParseJsonWithRepair(s) {
  if (!s) return null;
  const t = s.trim();
  try {
    return JSON.parse(t);
  } catch {
    try {
      return JSON.parse(repairJsonString(t));
    } catch {
      return null;
    }
  }
}

function buildFallbackGuideFromRawText(rawText) {
  const stripped = String(rawText || '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/\{[^{}]*(?:\{[^{}]*\}[^{}]*)*\}/g, ' ')
    .trim();
  let clean = stripJsonArtifacts(stripped.slice(0, 600)) || stripJsonArtifacts(String(rawText || '').slice(0, 600));
  clean = clean.replace(/\s+/g, ' ').trim();
  return {
    x: 50,
    y: 44,
    description:
      clean ||
      'No solid target on this screen. Try another area of the site (nav, back, or settings), then use **Next step** when the right UI is visible.',
    confidence: 0.42,
    elementLabel: 'Next control',
    isMultiStep: false,
    overallPlan: '',
    stepSummary: '',
    candidateIndex: -1,
    usedFallback: true,
  };
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
    candidateIndex: {
      type: 'NUMBER',
      description: 'If the target matches a row in the numbered candidate list, set this index (0-based). Otherwise -1.',
    },
  },
  required: [
    'x',
    'y',
    'description',
    'confidence',
    'elementLabel',
    'isMultiStep',
    'overallPlan',
    'stepSummary',
    'candidateIndex',
  ],
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

function emitDomSignal(payload) {
  if (chrome.storage.session) {
    chrome.storage.session.set({ ig_dom_signal: payload });
  } else {
    chrome.storage.local.set({ ig_dom_signal: payload });
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'GUIDANCE_DOM_CHANGED' || message.type === 'GUIDANCE_USER_INTERACTION') {
    const tabId = sender.tab?.id;
    if (!tabId) return;

    const base = {
      tabId,
      url: message.url || '',
      t: Date.now(),
      source: message.type === 'GUIDANCE_USER_INTERACTION' ? 'interaction' : 'dom',
    };

    const finish = (epoch) => {
      emitDomSignal({ ...base, epoch: typeof epoch === 'number' ? epoch : 0 });
    };

    if (chrome.storage.session) {
      chrome.storage.session.get('ig_guidance_epoch', (r) => {
        finish(r?.ig_guidance_epoch ?? 0);
      });
    } else {
      chrome.storage.local.get('ig_guidance_epoch', (r) => {
        finish(r?.ig_guidance_epoch ?? 0);
      });
    }
    return;
  }

  if (message.type === 'HIGHLIGHT_AT') {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (tabs[0]?.id) {
        chrome.tabs
          .sendMessage(tabs[0].id, {
            type: 'HIGHLIGHT_AT',
            xPct: message.xPct,
            yPct: message.yPct,
            description: message.description,
            elementLabel: message.elementLabel || '',
            intentText: message.intentText || '',
            candidateIndex: message.candidateIndex,
          })
          .catch(() => {});
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
        chrome.tabs.sendMessage(tabs[0].id, { type: 'CLEAR_HIGHLIGHTS' }).catch(() => {});
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

  if (message.type === 'ANALYZE_TEXT_TRIAGE') {
    analyzeTextTriage(message.payload).then(sendResponse).catch((err) => {
      sendResponse({ success: false, error: err.message });
    });
    return true;
  }

  if (message.type === 'ANALYZE_SOM_VISION') {
    analyzeSomVision(message.payload).then(sendResponse).catch((err) => {
      sendResponse({ success: false, error: err.message });
    });
    return true;
  }
});

/** Main vision models — used only when we fall through to Stage 3 (SoM). */
const GEMINI_MODEL = 'gemini-2.5-flash';
const ANTHROPIC_MODEL = 'claude-3-5-sonnet-20241022';
const OPENAI_MODEL = 'gpt-4o';
const MISTRAL_MODEL = 'mistral-small-latest';

/** Fast / cheap models used for Stage 2 text-only triage. */
const GEMINI_FAST_MODEL = 'gemini-2.5-flash-lite';
const ANTHROPIC_FAST_MODEL = 'claude-3-5-haiku-latest';
const OPENAI_FAST_MODEL = 'gpt-4o-mini';
const MISTRAL_FAST_MODEL = 'mistral-small-latest';

function fastModelFor(provider) {
  switch (String(provider || '').toLowerCase()) {
    case 'anthropic': return ANTHROPIC_FAST_MODEL;
    case 'openai': return OPENAI_FAST_MODEL;
    case 'mistral': return MISTRAL_FAST_MODEL;
    case 'gemini':
    default: return GEMINI_FAST_MODEL;
  }
}

function inferImageMimeFromInput(screenshot) {
  if (!screenshot || typeof screenshot !== 'string') return 'image/png';
  if (screenshot.startsWith('data:image/jpeg')) return 'image/jpeg';
  if (screenshot.startsWith('data:image/webp')) return 'image/webp';
  if (screenshot.startsWith('data:image/gif')) return 'image/gif';
  return 'image/png';
}

/** Nudge the model when URL + intent suggest Git OAuth, not marketplace tiles. */
function extraIntentContextForPrompt(pageUrl, userMessage) {
  const url = String(pageUrl || '').toLowerCase();
  const msg = String(userMessage || '').toLowerCase();
  const wantsGitConnect =
    /github|gitlab|bitbucket|\bgit\b.*(connect|link|account|repo)|connect.*(github|gitlab)|link.*(github|gitlab)|authorize.*(github|gitlab)/.test(
      msg
    );
  if (!wantsGitConnect) return '';
  const hosting =
    /vercel\.com|\.vercel\.app|netlify\.app|netlify\.com|railway\.app|render\.com|pages\.dev|cloudflare\.com/.test(
      url
    );
  if (!hosting) return '';
  return '\n[Context: User wants to connect or manage their Git provider account for deploys. Integrations Marketplace product cards for databases or storage are not the GitHub login path. Prefer Settings, Git, Import project, or a visible Connect GitHub flow.]\n';
}

function buildViewportHints(usedLiveViewport) {
  const coordHint = usedLiveViewport
    ? `CRITICAL: The image is a pixel-accurate capture of the user's current browser viewport (what they see right now). x and y MUST be the center of the target control as a percentage of THIS image: x = 100 * (centerX / imageWidth), y = 100 * (centerY / imageHeight). Do not guess adjacent nav items — if the user asked for "Explore", the point must be on Explore, not Home. When the chosen next step is genuinely to use site search (user asked to search, or RULES say search is last resort), the target MUST be the search field, search submit, or magnifying-glass control — never a random sidebar link (e.g. "Job center") unless the user explicitly asked for that page.`
    : `The image may be from a server-side render and can differ from the user's tab (login, scroll, window size). Prefer anchors from the page text below when they disambiguate. x/y are still viewport percentages of this image.`;
  return { coordHint };
}

function buildGuideSystemInstruction(coordHint) {
  return `You are a UI Guide. You help users navigate web interfaces step-by-step.

RULES:
- Analyze the screenshot and the page text/markdown to find the specific control the user should use NEXT.
${coordHint}
- elementLabel MUST be the exact visible text, aria-label, or tooltip of the element you target. x/y MUST be the center of THAT same element — never a different widget. If you cannot align label and position, lower confidence.
- **Search vs browse (government portals, multi-language sites):** Many sites only match search keywords in the **local UI language**. If the user typed intent in English but the portal is German (etc.), do NOT rely on the keyword box alone — prefer a visible **A–Z**, **Authorities A–Z**, **Behörden A–Z**, **Themen**, **Service**, or category browse link that leads toward the service. Mention in description that they may need terms in the site language, or use browse/A–Z instead of search.
- **Wrong page or missing option (read user message for session context):** If the user message lists **actions already suggested** or clearly continues a multi-step flow, assume they may have landed where the goal control is **not** visible. **Re-think the path** before suggesting anything. Prefer, in order: **Back** or **breadcrumbs**, a different **top nav** or **sidebar** item, **category / docs / help / support** links, **Account** or **Settings** submenus, **More** menus, or **A–Z / browse** paths. Set **isMultiStep** true when useful; in **overallPlan** and **description**, briefly say that the previous area did not show the target and what you are trying instead (e.g. "That screen did not have X; open Settings then …").
- **Site search is LAST RESORT:** Do **not** target the header **search field**, **search icon**, **Cmd/Ctrl-K** palette, or **Search** button unless at least one of these is true: (1) you have no reasonable browse or nav path left on this page toward the goal, (2) the user **explicitly** asked to search, or (3) after checking nav, back, and categories, search is clearly the only practical next step. If you do use search as fallback, **say so in description** in plain language (e.g. "No nav link to X here, so search is the fallback; try keywords …"). Prefer **lower confidence** when you are defaulting to search after a dead-end page.
- **When search truly is the next step:** Target only the real search affordance: \`<input>\` in the header, search icon, "Search" / "Suche" button, or opened search overlay — not unrelated left-nav items.
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
- **Language / locale:** The UI may be in any language. The user might ask in English (e.g. "careers page") while the visible nav says **Karriere**, **Empleo**, **Carrières**, etc. Map intent semantically: Careers/Jobs/Hiring ↔ Karriere/Stellen/Jobs/Recrutement/Offene Stellen/Trabaja con nosotros. **elementLabel MUST use the exact text as it appears on screen** (including accents), not a translation the user said — so the extension can match the real link.
- Be smart about synonyms: "Settings" = gear icon, preferences, account, config.
- If the user says "Profile", also look for avatar, account, user icon.
- If you cannot find a control that matches the user's intent, set confidence to 0, still pick best-effort x/y for a related area, and explain in description (without embedding JSON).
- Never put a JSON object inside "description".
- Many apps use a long scrollable left sidebar: nav links may appear in the page text but be off-screen. Prefer elementLabel text that literally appears in the page text; the extension will scroll the sidebar. If the item is not in the screenshot, place x/y over the sidebar strip (often x around 5–18%) and lower confidence slightly.
- For "dashboard", "home", or "main hub": target the product logo/home link, a "Dashboard" or "Home" nav item, or the primary app switcher — not marketing cards or unrelated titles on landing pages.
- Never invent a button name (e.g. "Admin") if that exact label is not in the screenshot or page text; pick the closest real control.
- If the user asks for "integrations" / HRIS / apps: elementLabel must be the real nav text (e.g. "Integrations", "Connected apps") if it appears anywhere in the page text, even when that row is off-screen in a scrollable sidebar — the extension scrolls to it.
- If the control is inside a collapsed sidebar group, dropdown, or <details>, set isMultiStep true: overallPlan should say to expand/open that section first; stepSummary for this step names that parent (e.g. "Open Playground section"); elementLabel should match the visible expander control.
- **GitHub — Sponsors / GitHub Sponsors:** Prefer the **public profile** (\`github.com/<username>\`, not \`/settings/profile\` or account settings). Look for a **Sponsors** tab or link next to Overview/Repositories, or a **Sponsor** button on the README — those are the right targets. **Do NOT** use **Edit profile** as the primary path for enabling GitHub Sponsors (that page is bio/settings, not sponsorship setup). **Do NOT** highlight **Contribution activity**, the contribution graph, or random activity feed text for "add sponsors" / "sponsors" — those are wrong. If the user is stuck on settings or edit profile, set isMultiStep true and in overallPlan say to open the **public profile** from the avatar menu or go to \`/<username>\` without \`/settings\`, then click **Sponsors**.
- **Connect GitHub / GitLab / Bitbucket (hosting and CI: Vercel, Netlify, Railway, Render, Cloudflare Pages, etc.):** The user wants to link **their Git provider account** for repos and deploys. Valid targets include **Team or Account Settings → Git** (or **Git Integration**, **Connected Git Accounts**), **Import** / **Add New Project → Import**, **Continue with GitHub**, or a visible **Connect Git** on the dashboard. **Do NOT** treat **Integrations Marketplace** or **Add Integration** **product cards** (databases, storage, observability, e.g. SingleStore, Pinecone, Turso, Astra) as "connect GitHub" — those **Integrate** / **Add** actions install **that vendor's product**, not OAuth to GitHub. If the viewport is mostly third-party **product tiles** and the user asked to connect GitHub: set **isMultiStep** true, **confidence** at most **0.4** unless a real Git-connect control is visible, and in **description** explain that marketplace tiles are the wrong place; target **Settings** (avatar/menu), **Back**, **Dashboard** / **Projects**, or **Import** if shown — never a random unrelated product card. **elementLabel** must match what you actually target (e.g. "Settings", "Import Project"), not a misleading label about GitHub on the wrong widget.
- If a numbered **Viewport controls** list is provided and one row clearly matches the next action, set **candidateIndex** to that index and copy **elementLabel** exactly from that row’s quoted text. **Only** set candidateIndex when that row is the true target; if unsure between rows, set **candidateIndex** to **-1** and rely on accurate x/y from the screenshot (wrong index breaks the highlight). Never set candidateIndex for a different control than elementLabel describes. **For "connect GitHub" on marketplace grids, prefer candidateIndex -1** unless a row is explicitly a Git-provider connect action.
- ALWAYS return valid JSON for every request — never an empty response.`;
}

async function buildGuidePromptBundle({
  screenshot,
  markdown,
  userMessage,
  pageTitle,
  pageUrl = '',
  usedLiveViewport,
  clickableCandidatesText,
}) {
  const { coordHint } = buildViewportHints(usedLiveViewport);
  const systemInstruction = buildGuideSystemInstruction(coordHint);
  const candidateBlock =
    usedLiveViewport && clickableCandidatesText && String(clickableCandidatesText).trim()
      ? `\n\nViewport controls (reading order, 0-based index = candidateIndex):\n${String(clickableCandidatesText).slice(0, 12000)}`
      : '';
  const urlLine = pageUrl ? `Page URL: ${pageUrl}\n\n` : '';
  const intentHint = extraIntentContextForPrompt(pageUrl, userMessage);
  const userText = `${urlLine}${intentHint}User intent: "${userMessage}"\n\nPage title: "${pageTitle}"\n\nPage content (markdown):\n${markdown.substring(0, 4500)}${candidateBlock}`;

  let base64Data;
  const imageMime = inferImageMimeFromInput(screenshot);
  if (screenshot.startsWith('http://') || screenshot.startsWith('https://')) {
    base64Data = await imageUrlToBase64(screenshot);
  } else if (screenshot.startsWith('data:')) {
    base64Data = screenshot.split(',')[1];
  } else {
    base64Data = screenshot;
  }

  return { systemInstruction, userText, base64Data, imageMime };
}

function tryExtractGuideJson(rawText) {
  let jsonStr = String(rawText || '').trim();
  const fenceMatch = jsonStr.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenceMatch) jsonStr = fenceMatch[1].trim();
  return (
    tryParseJsonWithRepair(jsonStr) ||
    extractBalancedJsonObject(jsonStr) ||
    extractAnyGuideJson(jsonStr) ||
    tryParseJsonWithRepair(rawText) ||
    extractBalancedJsonObject(rawText) ||
    extractAnyGuideJson(rawText)
  );
}

function shapeGuideResponse(result, rawTextForFallback) {
  if (!result || typeof result !== 'object') {
    return buildFallbackGuideFromRawText(rawTextForFallback || '');
  }

  const usedFallback = Boolean(result.usedFallback);
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

  let candidateIndex = Number(result.candidateIndex);
  if (!Number.isFinite(candidateIndex)) candidateIndex = -1;
  candidateIndex = Math.max(-1, Math.round(candidateIndex));

  return {
    x: Math.max(0, Math.min(100, Number(result.x) || 50)),
    y: Math.max(0, Math.min(100, Number(result.y) || 50)),
    description,
    confidence: Math.max(0, Math.min(1, conf)),
    elementLabel: String(result.elementLabel || 'Element').trim() || 'Element',
    isMultiStep: Boolean(result.isMultiStep),
    overallPlan,
    stepSummary,
    candidateIndex,
    usedFallback,
  };
}

function textToGuideResult(rawText) {
  const result = tryExtractGuideJson(rawText);
  return shapeGuideResponse(result, rawText);
}

async function callGeminiWithBundle(apiKey, bundle) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${apiKey}`;
  const parts = [
    { text: bundle.userText },
    {
      inlineData: {
        mimeType: bundle.imageMime,
        data: bundle.base64Data,
      },
    },
  ];

  const makeBody = (useSchema) => ({
    contents: [{ parts }],
    systemInstruction: { parts: [{ text: bundle.systemInstruction }] },
    generationConfig: {
      temperature: 0.15,
      maxOutputTokens: 1024,
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

  let result = tryExtractGuideJson(rawText);

  if (!result || typeof result !== 'object') {
    const geminiRes2 = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(makeBody(false)),
    });
    const geminiData2 = await geminiRes2.json();
    if (geminiRes2.ok && geminiData2.candidates?.length) {
      const rawText2 = getGeminiResponseText(geminiData2);
      result = tryExtractGuideJson(rawText2);
    }
  }

  return shapeGuideResponse(result, rawText);
}

async function callAnthropicWithBundle(apiKey, bundle) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: ANTHROPIC_MODEL,
      max_tokens: 1024,
      temperature: 0.15,
      system: bundle.systemInstruction,
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'image',
              source: {
                type: 'base64',
                media_type: bundle.imageMime,
                data: bundle.base64Data,
              },
            },
            { type: 'text', text: bundle.userText },
          ],
        },
      ],
    }),
  });
  const data = await res.json();
  if (!res.ok) {
    const errMsg = data.error?.message || `Anthropic error [${res.status}]`;
    throw new Error(errMsg);
  }
  const rawText = (data.content || [])
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('')
    .trim();
  if (!rawText) throw new Error('Empty model output from Anthropic');
  return textToGuideResult(rawText);
}

async function callOpenAICompatibleChat(apiKey, bundle, baseUrl, model, extraBody = {}) {
  const res = await fetch(`${baseUrl}/v1/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      temperature: 0.15,
      max_tokens: 1024,
      messages: [
        { role: 'system', content: bundle.systemInstruction },
        {
          role: 'user',
          content: [
            { type: 'text', text: bundle.userText },
            {
              type: 'image_url',
              image_url: { url: `data:${bundle.imageMime};base64,${bundle.base64Data}` },
            },
          ],
        },
      ],
      ...extraBody,
    }),
  });
  const data = await res.json();
  if (!res.ok) {
    const errMsg = data.error?.message || data.message || `API error [${res.status}]`;
    throw new Error(errMsg);
  }
  const rawText = data.choices?.[0]?.message?.content || '';
  if (!String(rawText).trim()) throw new Error('Empty model output');
  return textToGuideResult(rawText);
}

async function callOpenAIWithBundle(apiKey, bundle) {
  return callOpenAICompatibleChat(apiKey, bundle, 'https://api.openai.com', OPENAI_MODEL, {
    response_format: { type: 'json_object' },
  });
}

async function callMistralWithBundle(apiKey, bundle) {
  try {
    return await callOpenAICompatibleChat(apiKey, bundle, 'https://api.mistral.ai', MISTRAL_MODEL, {
      response_format: { type: 'json_object' },
    });
  } catch {
    return callOpenAICompatibleChat(apiKey, bundle, 'https://api.mistral.ai', MISTRAL_MODEL, {});
  }
}

async function callVisionLlm(provider, apiKey, bundle) {
  const p = String(provider || 'gemini').toLowerCase();
  switch (p) {
    case 'anthropic':
      return callAnthropicWithBundle(apiKey, bundle);
    case 'openai':
      return callOpenAIWithBundle(apiKey, bundle);
    case 'mistral':
      return callMistralWithBundle(apiKey, bundle);
    case 'gemini':
    default:
      return callGeminiWithBundle(apiKey, bundle);
  }
}

/* -----------------------------------------------------------------
 * Stage 2 — text-only triage
 * ----------------------------------------------------------------- */

/** Minimal JSON schema for Stage 2 triage — no x/y, coordinates come from the DOM row. */
const TRIAGE_RESPONSE_SCHEMA = {
  type: 'OBJECT',
  properties: {
    candidateIndex: {
      type: 'NUMBER',
      description: '0-based index of the row the user should click next, or -1 if nothing fits.',
    },
    elementLabel: { type: 'STRING' },
    confidence: { type: 'NUMBER' },
    description: { type: 'STRING' },
    stepSummary: { type: 'STRING' },
    isMultiStep: { type: 'BOOLEAN' },
    overallPlan: { type: 'STRING' },
  },
  required: ['candidateIndex', 'elementLabel', 'confidence', 'description', 'stepSummary', 'isMultiStep', 'overallPlan'],
};

function buildTriageSystemInstruction() {
  return `You are a UI Guide working from a compact list of clickable controls — no screenshot this round.
Each candidate is one line: "idx|role|label|x|y" (x,y are percentages of the viewport).

RULES:
- Pick the single row the user should click NEXT toward their goal.
- candidateIndex MUST be one of the listed idx values. Use -1 only if no row fits.
- elementLabel MUST match that row's label verbatim (accents included).
- Multilingual UIs: map intent semantically (Careers↔Karriere/Empleo, Settings↔Einstellungen, etc.).
- SITE SEARCH IS LAST RESORT. Do NOT choose a header search field, search icon, or Cmd/Ctrl-K unless the user explicitly asked to search OR no browse/nav path in the candidates leads toward the goal. If you fall back to search, say so in description and keep confidence below 0.55.
- When the screen does not contain a direct next step (e.g. wrong page after several attempts), prefer Back, breadcrumbs, Settings, Account, Help, or a clearly relevant nav link — mention briefly in description.
- For multi-screen goals, set isMultiStep true and give a short overallPlan (2–4 sentences). Still return ONE action for now. stepSummary is a past-tense line suitable for step history.
- Lower confidence when the visible candidates do not clearly match the goal. Confidence below 0.66 tells downstream code to escalate to a vision pass.
- Return ONLY a valid JSON object matching the schema. No markdown fences, no text outside JSON.`;
}

function buildDoneStepsBlock(doneSteps) {
  const arr = Array.isArray(doneSteps) ? doneSteps.filter(Boolean).slice(-6) : [];
  if (!arr.length) return '';
  return `\n\nSteps already completed (most recent last):\n- ${arr.join('\n- ')}`;
}

function buildTextTriageBundle({
  userMessage,
  pageTitle,
  pageUrl = '',
  candidatesText,
  doneSteps,
}) {
  const systemInstruction = buildTriageSystemInstruction();
  const urlLine = pageUrl ? `Page URL: ${pageUrl}\n\n` : '';
  const intentHint = extraIntentContextForPrompt(pageUrl, userMessage);
  const stepsBlock = buildDoneStepsBlock(doneSteps);
  const candBlock = String(candidatesText || '').slice(0, 1800) || '(no candidates collected)';
  const userText = `${urlLine}${intentHint}User intent: "${userMessage}"\n\nPage title: "${pageTitle || ''}"${stepsBlock}\n\nCandidates (idx|role|label|x|y):\n${candBlock}`;
  return { systemInstruction, userText };
}

function shapeTriageResponse(result, rawText) {
  if (!result || typeof result !== 'object') {
    return {
      candidateIndex: -1,
      elementLabel: '',
      confidence: 0,
      description: stripJsonArtifacts(String(rawText || '').slice(0, 400)) || 'No clear target.',
      stepSummary: '',
      isMultiStep: false,
      overallPlan: '',
      usedFallback: true,
    };
  }
  let ci = Number(result.candidateIndex);
  if (!Number.isFinite(ci)) ci = -1;
  ci = Math.max(-1, Math.round(ci));
  let conf = Number(result.confidence);
  if (!Number.isFinite(conf)) conf = 0.4;
  conf = Math.max(0, Math.min(1, conf));
  const description = stripJsonArtifacts(String(result.description || '').trim()) || 'Click this element.';
  return {
    candidateIndex: ci,
    elementLabel: String(result.elementLabel || '').trim(),
    confidence: conf,
    description,
    stepSummary: stripJsonArtifacts(String(result.stepSummary || '').trim()),
    isMultiStep: Boolean(result.isMultiStep),
    overallPlan: stripJsonArtifacts(String(result.overallPlan || '').trim()),
    usedFallback: Boolean(result.usedFallback),
  };
}

async function callGeminiTextTriage(apiKey, bundle) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_FAST_MODEL}:generateContent?key=${apiKey}`;
  const makeBody = (useSchema) => ({
    contents: [{ parts: [{ text: bundle.userText }] }],
    systemInstruction: { parts: [{ text: bundle.systemInstruction }] },
    generationConfig: {
      temperature: 0.15,
      maxOutputTokens: 512,
      responseMimeType: 'application/json',
      ...(useSchema ? { responseSchema: TRIAGE_RESPONSE_SCHEMA } : {}),
    },
  });

  let res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(makeBody(true)),
  });
  let data = await res.json();
  if (!res.ok) {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(makeBody(false)),
    });
    data = await res.json();
  }
  if (!res.ok) {
    throw new Error(data.error?.message || `Gemini triage error [${res.status}]`);
  }
  const rawText = getGeminiResponseText(data);
  const result = tryExtractGuideJson(rawText);
  return shapeTriageResponse(result, rawText);
}

async function callAnthropicTextTriage(apiKey, bundle) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: ANTHROPIC_FAST_MODEL,
      max_tokens: 600,
      temperature: 0.15,
      system: bundle.systemInstruction,
      messages: [{ role: 'user', content: [{ type: 'text', text: bundle.userText }] }],
    }),
  });
  const data = await res.json();
  if (!res.ok) {
    throw new Error(data.error?.message || `Anthropic triage error [${res.status}]`);
  }
  const rawText = (data.content || [])
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('')
    .trim();
  const result = tryExtractGuideJson(rawText);
  return shapeTriageResponse(result, rawText);
}

async function callOpenAICompatibleTextTriage(apiKey, bundle, baseUrl, model, extraBody = {}) {
  const res = await fetch(`${baseUrl}/v1/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      temperature: 0.15,
      max_tokens: 600,
      messages: [
        { role: 'system', content: bundle.systemInstruction },
        { role: 'user', content: bundle.userText },
      ],
      ...extraBody,
    }),
  });
  const data = await res.json();
  if (!res.ok) {
    throw new Error(data.error?.message || data.message || `Triage error [${res.status}]`);
  }
  const rawText = data.choices?.[0]?.message?.content || '';
  const result = tryExtractGuideJson(rawText);
  return shapeTriageResponse(result, rawText);
}

async function callOpenAITextTriage(apiKey, bundle) {
  return callOpenAICompatibleTextTriage(apiKey, bundle, 'https://api.openai.com', OPENAI_FAST_MODEL, {
    response_format: { type: 'json_object' },
  });
}

async function callMistralTextTriage(apiKey, bundle) {
  try {
    return await callOpenAICompatibleTextTriage(apiKey, bundle, 'https://api.mistral.ai', MISTRAL_FAST_MODEL, {
      response_format: { type: 'json_object' },
    });
  } catch {
    return callOpenAICompatibleTextTriage(apiKey, bundle, 'https://api.mistral.ai', MISTRAL_FAST_MODEL, {});
  }
}

async function callTextOnlyTriage(provider, apiKey, bundle) {
  const p = String(provider || 'gemini').toLowerCase();
  switch (p) {
    case 'anthropic': return callAnthropicTextTriage(apiKey, bundle);
    case 'openai': return callOpenAITextTriage(apiKey, bundle);
    case 'mistral': return callMistralTextTriage(apiKey, bundle);
    case 'gemini':
    default: return callGeminiTextTriage(apiKey, bundle);
  }
}

async function analyzeTextTriage({
  userMessage,
  pageTitle,
  pageUrl = '',
  candidatesText,
  doneSteps,
  llmProvider = 'gemini',
  apiKey,
}) {
  const key = apiKey && String(apiKey).trim();
  if (!key) {
    throw new Error('No API key for the selected model.');
  }
  const bundle = buildTextTriageBundle({ userMessage, pageTitle, pageUrl, candidatesText, doneSteps });
  const tLlm = Date.now();
  const triage = await callTextOnlyTriage(llmProvider, key, bundle);
  const llmMs = Date.now() - tLlm;
  return {
    success: true,
    ...triage,
    timings: {
      stage: 'text_llm',
      llmMs,
      llmProvider: String(llmProvider || 'gemini').toLowerCase(),
      model: fastModelFor(llmProvider),
    },
  };
}

/* -----------------------------------------------------------------
 * Stage 3 — SoM vision (pre-cropped image, numbered overlay boxes)
 * ----------------------------------------------------------------- */

/** SoM response schema — same shape as the main guide + an explicit chosenNumber. */
const SOM_RESPONSE_SCHEMA = {
  type: 'OBJECT',
  properties: {
    chosenNumber: {
      type: 'NUMBER',
      description: 'The integer number drawn on the box the user should click, or -1 if none fits.',
    },
    elementLabel: { type: 'STRING' },
    confidence: { type: 'NUMBER' },
    description: { type: 'STRING' },
    stepSummary: { type: 'STRING' },
    isMultiStep: { type: 'BOOLEAN' },
    overallPlan: { type: 'STRING' },
  },
  required: ['chosenNumber', 'elementLabel', 'confidence', 'description', 'stepSummary', 'isMultiStep', 'overallPlan'],
};

function buildSomSystemInstruction() {
  return `You are a UI Guide. The user's viewport has been cropped to the region most likely to contain the target, and numbered boxes have been drawn over candidate clickable elements. Each candidate also appears as one row: "number|role|label".

RULES:
- Return the integer number printed on the box the user should click NEXT, in chosenNumber. If no box fits, set chosenNumber to -1.
- elementLabel MUST match the label of the box whose number you chose (verbatim, accents included).
- Coordinates are NOT required — the extension resolves them from the chosen number.
- Prefer browse/nav/settings over site search. Use search only if the user explicitly asked OR no browse/nav path leads toward the goal; if you do, say so in description and keep confidence below 0.6.
- Multi-screen goals: set isMultiStep true and fill overallPlan with a 2–4 sentence outline; still pick ONE action for now. stepSummary is one past-tense line for step history.
- If no numbered box matches the goal, set chosenNumber -1, confidence 0, and use description to explain what to do next (scroll, go Back, open a menu, try Settings, etc.).
- Return ONLY a valid JSON object matching the schema. No markdown fences, no text outside JSON.`;
}

function buildSomVisionBundle({
  screenshot,
  userMessage,
  pageTitle,
  pageUrl = '',
  somList,
  doneSteps,
}) {
  const systemInstruction = buildSomSystemInstruction();
  const urlLine = pageUrl ? `Page URL: ${pageUrl}\n\n` : '';
  const intentHint = extraIntentContextForPrompt(pageUrl, userMessage);
  const stepsBlock = buildDoneStepsBlock(doneSteps);
  const somBlock = String(somList || '').slice(0, 1400) || '(no candidates)';
  const userText = `${urlLine}${intentHint}User intent: "${userMessage}"\n\nPage title: "${pageTitle || ''}"${stepsBlock}\n\nNumbered candidates (number|role|label):\n${somBlock}`;

  const imageMime = inferImageMimeFromInput(screenshot);
  let base64Data;
  if (typeof screenshot === 'string' && screenshot.startsWith('data:')) {
    base64Data = screenshot.split(',')[1];
  } else if (typeof screenshot === 'string' && /^https?:/.test(screenshot)) {
    // Remote URL — caller should normally crop locally, but support it anyway.
    base64Data = null;
  } else {
    base64Data = screenshot;
  }
  return { systemInstruction, userText, base64Data, imageMime };
}

function shapeSomResponse(result, rawText) {
  const base = shapeGuideResponse(result, rawText);
  const ch = Number(result?.chosenNumber);
  const idx = Number.isFinite(ch) ? Math.max(-1, Math.round(ch)) : -1;
  return { ...base, candidateIndex: idx };
}

async function callGeminiSom(apiKey, bundle) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${apiKey}`;
  const parts = [
    { text: bundle.userText },
    { inlineData: { mimeType: bundle.imageMime, data: bundle.base64Data } },
  ];
  const makeBody = (useSchema) => ({
    contents: [{ parts }],
    systemInstruction: { parts: [{ text: bundle.systemInstruction }] },
    generationConfig: {
      temperature: 0.15,
      maxOutputTokens: 900,
      responseMimeType: 'application/json',
      ...(useSchema ? { responseSchema: SOM_RESPONSE_SCHEMA } : {}),
    },
  });
  let res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(makeBody(true)),
  });
  let data = await res.json();
  if (!res.ok) {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(makeBody(false)),
    });
    data = await res.json();
  }
  if (!res.ok) {
    throw new Error(data.error?.message || `Gemini SoM error [${res.status}]`);
  }
  const rawText = getGeminiResponseText(data);
  const parsed = tryExtractGuideJson(rawText);
  return shapeSomResponse(parsed, rawText);
}

async function callAnthropicSom(apiKey, bundle) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: ANTHROPIC_MODEL,
      max_tokens: 900,
      temperature: 0.15,
      system: bundle.systemInstruction,
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'image',
              source: { type: 'base64', media_type: bundle.imageMime, data: bundle.base64Data },
            },
            { type: 'text', text: bundle.userText },
          ],
        },
      ],
    }),
  });
  const data = await res.json();
  if (!res.ok) {
    throw new Error(data.error?.message || `Anthropic SoM error [${res.status}]`);
  }
  const rawText = (data.content || [])
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('')
    .trim();
  const parsed = tryExtractGuideJson(rawText);
  return shapeSomResponse(parsed, rawText);
}

async function callOpenAICompatibleSom(apiKey, bundle, baseUrl, model, extraBody = {}) {
  const res = await fetch(`${baseUrl}/v1/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      temperature: 0.15,
      max_tokens: 900,
      messages: [
        { role: 'system', content: bundle.systemInstruction },
        {
          role: 'user',
          content: [
            { type: 'text', text: bundle.userText },
            {
              type: 'image_url',
              image_url: { url: `data:${bundle.imageMime};base64,${bundle.base64Data}` },
            },
          ],
        },
      ],
      ...extraBody,
    }),
  });
  const data = await res.json();
  if (!res.ok) {
    throw new Error(data.error?.message || data.message || `SoM error [${res.status}]`);
  }
  const rawText = data.choices?.[0]?.message?.content || '';
  const parsed = tryExtractGuideJson(rawText);
  return shapeSomResponse(parsed, rawText);
}

async function callOpenAISom(apiKey, bundle) {
  return callOpenAICompatibleSom(apiKey, bundle, 'https://api.openai.com', OPENAI_MODEL, {
    response_format: { type: 'json_object' },
  });
}

async function callMistralSom(apiKey, bundle) {
  try {
    return await callOpenAICompatibleSom(apiKey, bundle, 'https://api.mistral.ai', MISTRAL_MODEL, {
      response_format: { type: 'json_object' },
    });
  } catch {
    return callOpenAICompatibleSom(apiKey, bundle, 'https://api.mistral.ai', MISTRAL_MODEL, {});
  }
}

async function callSomVisionLlm(provider, apiKey, bundle) {
  const p = String(provider || 'gemini').toLowerCase();
  switch (p) {
    case 'anthropic': return callAnthropicSom(apiKey, bundle);
    case 'openai': return callOpenAISom(apiKey, bundle);
    case 'mistral': return callMistralSom(apiKey, bundle);
    case 'gemini':
    default: return callGeminiSom(apiKey, bundle);
  }
}

async function analyzeSomVision({
  screenshot,
  userMessage,
  pageTitle,
  pageUrl = '',
  somList,
  doneSteps,
  llmProvider = 'gemini',
  apiKey,
}) {
  const key = apiKey && String(apiKey).trim();
  if (!key) throw new Error('No API key for the selected model.');
  if (!screenshot || typeof screenshot !== 'string') {
    throw new Error('SoM stage requires a pre-cropped screenshot.');
  }
  const bundle = buildSomVisionBundle({ screenshot, userMessage, pageTitle, pageUrl, somList, doneSteps });
  const tLlm = Date.now();
  const out = await callSomVisionLlm(llmProvider, key, bundle);
  const llmMs = Date.now() - tLlm;
  return {
    success: true,
    ...out,
    timings: {
      stage: 'som_vision',
      llmMs,
      llmProvider: String(llmProvider || 'gemini').toLowerCase(),
      model: (function () {
        const p = String(llmProvider || 'gemini').toLowerCase();
        if (p === 'anthropic') return ANTHROPIC_MODEL;
        if (p === 'openai') return OPENAI_MODEL;
        if (p === 'mistral') return MISTRAL_MODEL;
        return GEMINI_MODEL;
      })(),
    },
  };
}

async function analyzePage({
  url,
  userMessage,
  firecrawlKey,
  llmProvider = 'gemini',
  apiKey,
  geminiKey,
  clientScreenshot,
  pageText,
  pageTitle: clientTitle,
  clickableCandidatesText,
}) {
  const key =
    (apiKey && String(apiKey).trim()) ||
    (geminiKey && String(geminiKey).trim()) ||
    '';
  if (!key) {
    throw new Error(
      'No API key for the selected model. Open Settings, pick a provider, and paste that provider’s key (only one key is required).'
    );
  }

  let screenshot;
  let markdown;
  let pageTitle = clientTitle || '';
  let firecrawlMs = 0;
  const usedLiveViewport = Boolean(
    clientScreenshot && typeof clientScreenshot === 'string' && clientScreenshot.startsWith('data:image')
  );

  if (usedLiveViewport) {
    screenshot = clientScreenshot;
    markdown = (pageText || '').slice(0, 8000);
  } else {
    if (!firecrawlKey || !String(firecrawlKey).trim()) {
      throw new Error(
        'Could not capture this tab and no Firecrawl key is set. Open a normal https page, use the extension on the active tab, or add a Firecrawl API key in Settings.'
      );
    }
    const tFc = Date.now();
    const scrapeRes = await fetch('https://api.firecrawl.dev/v1/scrape', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${firecrawlKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        url,
        formats: ['screenshot', 'markdown'],
        onlyMainContent: false,
        waitFor: 1200,
      }),
    });

    const scrapeData = await scrapeRes.json();
    firecrawlMs = Date.now() - tFc;
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

  const bundle = await buildGuidePromptBundle({
    screenshot,
    markdown,
    userMessage,
    pageTitle,
    pageUrl: url || '',
    usedLiveViewport,
    clickableCandidatesText: usedLiveViewport ? clickableCandidatesText : '',
  });

  const tLlm = Date.now();
  const guideResult = await callVisionLlm(llmProvider, key, bundle);
  const llmMs = Date.now() - tLlm;

  return {
    success: true,
    ...guideResult,
    pageTitle,
    usedRemoteScrape: !usedLiveViewport,
    timings: {
      dataSource: usedLiveViewport ? 'live' : 'firecrawl',
      firecrawlMs: usedLiveViewport ? 0 : firecrawlMs,
      llmMs,
      llmProvider: String(llmProvider || 'gemini').toLowerCase(),
    },
  };
}
