# Chrome-first roadmap and Phase 2 inputs

This document implements the **Chrome-first, then next two browsers** strategy: Phase 1 exit criteria, a **point-in-time** public browser-share snapshot (re-check before expanding), and an **engineering-cost** comparison for Edge vs Safari vs Firefox.

---

## Phase 1 exit criteria (Chrome extension)

Ship the best guided-adoption experience in **Chrome** before porting. Use these as **team-defined** gates; adjust numbers to your product constraints.

### Latency

| Metric | How to measure | Suggested target |
|--------|----------------|------------------|
| **Analyze wall time** | Console `[IntegrationGuide] timings` → `analyzeMs` / `geminiMs` | **p95 &lt; 15 s** on a typical integration page after payload/model tuning; document baseline if APIs are slower. |
| **Capture** | Same log → `captureMs` | **p95 &lt; 500 ms** (local work). |
| **Highlight** | Same log → `highlight.ms` | **p95 &lt; 100 ms**, `ok: true` unless page blocks scripting. |

*Rationale:* Logs showed **~26 s** dominated by Gemini (`geminiMs`); Phase 1 “done” means either **acceptable** latency with a documented ceiling or **continued** optimization until targets are met.

### Reliability

| Metric | Suggested target |
|--------|------------------|
| **Highlight success** | **≥ 95%** of steps where `confidence > 0` on supported `https` pages. |
| **Live path** | Prefer **`dataSource: live`**; **`usedRemoteScrape: true`** should be rare and user-visible. |
| **Regression** | No known **P0** breaks on top **N** integration flows (define the list below). |

### Key flows (define your own “top N”)

Replace with real customer journeys, e.g.:

1. OAuth / “Connect” on a major SaaS.
2. API key or webhook setup in a dashboard.
3. Multi-step nav (sidebar → submenu → form).

**Exit:** All **N** flows completable with guidance **without** manual workarounds, or gaps filed and accepted.

---

## Browser market snapshot (re-check before Phase 2)

**Do not** treat the numbers below as permanent. Before choosing the **next two** browsers, open **StatCounter** (or your analytics) for **your regions** and **desktop vs mobile**.

**Source:** [StatCounter — Desktop browser market share worldwide](https://gs.statcounter.com/browser-market-share/desktop/worldwide) (and regional tabs).

**Point-in-time reference** (worldwide desktop, order after Chrome — verify live):

| Rank (after Chrome) | Browser | Approx. share (verify on StatCounter) |
|---------------------|---------|----------------------------------------|
| 2 | Microsoft Edge | Often **#2** on desktop worldwide |
| 3 | Safari | Strong on **macOS**; lower on **global desktop** |
| 4 | Firefox | Material but smaller share |

Third-party summaries (e.g. blogs quoting StatCounter) drift; **always** use the official StatCounter charts for the month you plan expansion.

---

## Phase 2 engineering comparison: Edge vs Safari vs Firefox

Rough **relative** effort to port an MV3-style integration guide extension **after** Chrome is solid. Not a substitute for a spike.

| Factor | Edge (Chromium) | Safari (Web Extension) | Firefox |
|--------|-------------------|-------------------------|---------|
| **Engine alignment** | Same Chromium lineage as Chrome; many MV3 patterns **reuse** | **Different** toolchain (Xcode, App Store Connect for distribution); APIs differ | **Gecko**; manifest/API differences (e.g. `browser.*`, MV3 quirks) |
| **Typical work** | Manifest tweaks, QA on Edge, separate store listing | Packaging, permissions, WebKit behavior, **more** QA | `manifest.json` + API shims, full regression |
| **Risk** | Low–medium | Medium–high | Medium |
| **Order-of-magnitude** | Often **first** after Chrome if share justifies it | Often **second** if macOS audience is large | Strong if **privacy / dev** audience |

**Practical note:** “Next two by **global** share” might be **Chrome → Edge → Safari** on desktop; “next two by **your** enterprise mix” might differ. Combine **usage data** with this table before committing.

---

## Sequencing checklist

1. Meet Phase 1 exit criteria (or explicitly waive with rationale).
2. Pull **fresh** StatCounter (and internal analytics) for **target regions**.
3. Rank **business impact vs engineering cost** (Edge often cheaper than Safari for Chromium-like ports).
4. Port **one** browser at a time with a full test matrix.
