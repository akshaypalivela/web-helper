# Integration Guide (web-helper)

**A browser “teacher” for the long tail of the web** — it suggests the **next click** on the page you’re already on, instead of doing everything for you or locking you into one vendor’s assistant.

> **Work in progress.** Behavior, accuracy, and latency will change. This is experimental—not a substitute for reading terms, permissions, or security prompts on the sites you use.

## Why

Most people don’t want to memorize every admin console, government portal, or developer surface they touch once a month. At the same time, **outsourcing entire flows** to an opaque agent doesn’t match everyone’s comfort level for accounts, money, or compliance. I believe there is room for a third path: **help that keeps you in control**, shows you **where** to act on the **real UI**, and lets you **build muscle memory** over time.

## Why now

- **Autonomous agents** are mainstream in demos—but **trust and delegation** are still uneven in real life: many users want to **see** what’s happening and **learn**, not hand over the whole session.
- **Vision-capable models** are finally usable for “what should I click *here*?” instead of only chat-in-a-box.
- **Platform-specific** copilots help inside one product, but work and life still span **many** sites—there is still a **cross-platform adoption** gap the browser is well placed to address.

## The problem

- **Dense UIs** hide settings (API keys, billing, permissions) behind layers of navigation.
- **Help center articles** often don’t match the current screen, theme, or locale.
- **Language mismatch**: the user thinks in one language; the portal’s search expects another.
- **Fear of wrong clicks** on high-stakes pages slows people down—even when they’re willing to learn.

## What I’m building

**Integration Guide** is a Chrome extension I’m building that looks at **your current tab** (viewport + page text), proposes **one next action**, and draws a **ghost marker** on the target control. You execute the click—step by step.

### Three patterns for AI + software (where this fits)

| | **Autonomous agents** | **Platform-specific assistants** | **Integration Guide** |
|---|------------------------|----------------------------------|-------------------------|
| **Promise** | “Complete tasks for me.” | “Help inside *this* product.” | “Teach me the **next click** on **this** page.” |
| **Scope** | Broad; acts on your behalf. | One vendor / product family. | **Any site** you open in the browser. |
| **Trust model** | High delegation; varies by person. | High when you live in that ecosystem. | **Low delegation**: you stay in the loop and learn the UI. |

## How it works (overview)

1. You describe your goal in the **side panel**.
2. The extension captures the **live viewport** (and text) or, in some setups, uses an alternate scrape path (see `extension/background.js`).
3. A **vision model** (Gemini in the current implementation) returns a suggested target; the **content script** renders a highlight on the page.

Technical shape: **Manifest V3** extension — service worker, content script, side panel — with **user-supplied API keys**.

## Who it’s for

### Teams & SaaS admins

Rare logins into complex consoles: “Where is **API keys** / **billing** / **roles**?”

### Public-sector & multilingual portals

When browse paths (**A–Z**, topics) beat keyword search; user intent and portal language don’t always align.

### Developers & power users

**GitHub**, dashboards, internal tools—reduce wrong turns while you still **follow** the flow.

## What this is not

- **Not** a fully autonomous agent that runs end-to-end tasks without you.
- **Not** legal, financial, or security advice—always read the real prompts and terms on the site.
- **Not** a guarantee of correct highlights (especially while WIP).

## Current status & limitations

Latency follows the **AI API** (often multiple seconds). **Rate limits** apply per provider. Highlights can be **wrong** on complex or dynamic pages. Treat output as **guidance**, not ground truth.

## Getting started

**Requirements:** Chromium browser with MV3 extensions; a **Gemini API key** (e.g. Google AI Studio). Optional: **Firecrawl** key if you use the scrape-oriented path.

**Install (development):**

1. Clone this repository.
2. Open `chrome://extensions` → enable **Developer mode** → **Load unpacked** → select the **`extension`** folder (contains `manifest.json`).
3. Open the extension **Settings** and paste your key(s).
4. After `git pull`, click **Reload** on the extension and refresh the tab.

## Privacy

Viewport and text are sent to the **configured AI provider**. Keys are stored **locally** in the extension. Review provider terms before use.

## Repo layout

- **`extension/`** — MV3 extension (background / content / side panel).
- **Root** — May include additional app assets depending on branch.

## Contributing

I welcome issues and PRs. Expect rough edges while this is **WIP**.

## License

See `LICENSE` if present; otherwise **TBD**.
