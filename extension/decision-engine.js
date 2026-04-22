// Pure functions for the cascaded waterfall: cache keys, heuristic shortcuts,
// compact prompt building, fast-model selection. No DOM access, no network.
// Loaded both in the sidepanel (via <script>) and the background worker
// (via importScripts). Exposes window.IG_DECISION / self.IG_DECISION.

(function () {
  'use strict';

  const NS = {};

  function fnvHash(input) {
    const str = String(input || '');
    let h = 0x811c9dc5;
    for (let i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    return h.toString(16).padStart(8, '0');
  }

  function goalDigest(goal) {
    const clean = String(goal || '').toLowerCase().replace(/\s+/g, ' ').trim();
    return fnvHash(clean).slice(0, 10);
  }

  function makeCacheKey(domain, goal) {
    return `${String(domain || '').toLowerCase()}|${goalDigest(goal)}`;
  }

  function normalizeLabel(s) {
    if (!s || typeof s !== 'string') return '';
    return s
      .toLowerCase()
      .replace(/['`"]/g, '')
      .replace(/\s+/g, ' ')
      .trim();
  }

  /** Provider-specific fast model for the text-only triage stage. */
  function pickFastModel(provider) {
    switch (String(provider || '').toLowerCase()) {
      case 'anthropic':
        return 'claude-3-5-haiku-latest';
      case 'openai':
        return 'gpt-4o-mini';
      case 'mistral':
        return 'mistral-small-latest';
      case 'gemini':
      default:
        return 'gemini-2.5-flash-lite';
    }
  }

  /** Compact candidate list: idx|role|label|x|y — capped at maxChars. */
  function buildCompactCandidatesText(rows, maxChars = 1500) {
    if (!Array.isArray(rows)) return '';
    const out = [];
    let total = 0;
    for (const r of rows) {
      if (!r) continue;
      const idx = Number.isFinite(Number(r.idx)) ? Number(r.idx) : out.length;
      const role = String(r.role || '').slice(0, 16);
      const label = String(r.label || '').replace(/\s+/g, ' ').slice(0, 40);
      const x = Math.round(Number(r.xPct) || 0);
      const y = Math.round(Number(r.yPct) || 0);
      const line = `${idx}|${role}|${label}|${x}|${y}`;
      if (total + line.length + 1 > maxChars) break;
      out.push(line);
      total += line.length + 1;
    }
    return out.join('\n');
  }

  /** Common label aliases by intent. Extends the content-script keyword taxonomy. */
  const SHORTCUT_INTENTS = [
    {
      name: 'settings',
      test: /\b(settings?|preferences?|account\s+settings|configure|configuration)\b/i,
      labels: [
        'settings', 'setting', 'preferences', 'preference', 'account settings',
        'einstellungen', 'konto', 'paramètres', 'parametres',
        'configuración', 'configuracion', 'preferencias', 'impostazioni',
      ],
    },
    {
      name: 'profile',
      test: /\b(profile|my profile|my account|avatar|user menu)\b/i,
      labels: ['profile', 'my profile', 'account', 'my account', 'profil', 'mi perfil'],
    },
    {
      name: 'login',
      test: /\b(login|log ?in|sign ?in)\b/i,
      labels: [
        'log in', 'login', 'sign in', 'signin', 'anmelden',
        'se connecter', 'iniciar sesión', 'iniciar sesion', 'entrar',
      ],
    },
    {
      name: 'logout',
      test: /\b(log ?out|sign ?out)\b/i,
      labels: [
        'log out', 'logout', 'sign out', 'signout', 'abmelden',
        'se déconnecter', 'se deconnecter', 'cerrar sesión', 'cerrar sesion', 'sair',
      ],
    },
    {
      name: 'signup',
      test: /\b(sign ?up|register|create an? account|get started)\b/i,
      labels: [
        'sign up', 'signup', 'register', 'create account', 'get started',
        'registrieren', 'registrar', 'inscription', "s'inscrire",
      ],
    },
    {
      name: 'help',
      test: /\b(help|support|contact|faq|docs?|documentation)\b/i,
      labels: [
        'help', 'support', 'contact', 'faq', 'docs', 'documentation',
        'hilfe', 'kontakt', 'ayuda', 'aide', 'suporte', 'contacto',
      ],
    },
    {
      name: 'pricing',
      test: /\b(pricing|price|plans?|billing|subscription)\b/i,
      labels: [
        'pricing', 'plans', 'billing', 'price', 'subscription',
        'preise', 'tarifs', 'precios', 'prezzi', 'assinatura',
      ],
    },
    {
      name: 'home',
      test: /\b(home|dashboard|main\s+page|start\s+page)\b/i,
      labels: ['home', 'dashboard', 'start', 'inicio', 'início', 'accueil', 'startseite'],
    },
    {
      name: 'careers',
      test: /\b(careers?|jobs?|hiring|work with|join us)\b/i,
      labels: [
        'careers', 'career', 'jobs', 'join us', 'work with us',
        'karriere', 'stellen', 'stellenangebote', 'empleo', 'carrière', 'carrieres',
        'carreiras', 'lavoro', 'vacancies', 'vacature',
      ],
    },
  ];

  function labelAliasScore(aliases, rowLabel) {
    const rn = normalizeLabel(rowLabel);
    if (!rn) return 0;
    let best = 0;
    for (const alias of aliases) {
      const an = normalizeLabel(alias);
      if (!an) continue;
      if (rn === an) {
        best = Math.max(best, 100);
      } else if (rn.startsWith(an) && an.length >= 3) {
        best = Math.max(best, 94);
      } else if (rn.includes(an) && an.length >= 3) {
        best = Math.max(best, 90);
      } else if (an.includes(rn) && rn.length >= 4) {
        best = Math.max(best, 82);
      } else {
        const words = an.split(' ').filter((w) => w.length > 1);
        if (words.length && words.every((w) => rn.includes(w))) best = Math.max(best, 80);
      }
    }
    return best;
  }

  function findShortcutIntent(goal) {
    const g = String(goal || '');
    for (const s of SHORTCUT_INTENTS) {
      if (s.test.test(g)) return s;
    }
    return null;
  }

  /**
   * Pure Stage-1 heuristic. Returns { hit, row, intent, score } or null.
   * Requires: top score >= 88, top beats 2nd by >= 14.
   */
  function runStage1Heuristic({ goal, candidates }) {
    if (!goal || !Array.isArray(candidates) || !candidates.length) return null;
    const shortcut = findShortcutIntent(goal);
    if (!shortcut) return null;

    const scored = candidates
      .map((r) => ({ row: r, score: labelAliasScore(shortcut.labels, r.label) }))
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score);

    if (!scored.length) return null;
    const top = scored[0];
    const second = scored[1];
    if (top.score < 88) return null;
    if (second && top.score - second.score < 14) return null;

    return { hit: true, row: top.row, intent: shortcut.name, score: top.score };
  }

  /**
   * Look up a cache entry and bind it to a live candidate by normalized label.
   * Returns { hit, row, entry } or null. Requires domSig match when present.
   */
  function tryCacheResolve({ cache, cacheKey, domSig, candidates }) {
    if (!cache || !cacheKey || !Array.isArray(candidates)) return null;
    const entry = cache[cacheKey];
    if (!entry) return null;
    if (entry.domSig && domSig && entry.domSig !== domSig) return null;
    const target = normalizeLabel(entry.labelNorm || entry.elementLabel);
    if (!target) return null;
    const match = candidates.find((r) => normalizeLabel(r.label) === target);
    if (!match) return null;
    return { hit: true, row: match, entry };
  }

  /**
   * Decide which stage to run next given the prior outcome.
   * Returns { stage: 'cache' | 'heuristic' | 'text_llm' | 'som_vision', reason }.
   */
  function decideStage(ctx) {
    if (ctx?.cacheHit) return { stage: 'cache', reason: 'cache_hit' };
    if (ctx?.heuristicHit) return { stage: 'heuristic', reason: 'shortcut' };
    if (!ctx?.triage || ctx.triage.escalate) {
      return { stage: 'som_vision', reason: 'triage_escalate' };
    }
    if (ctx.triage.accepted) return { stage: 'text_llm', reason: 'triage_ok' };
    return { stage: 'som_vision', reason: 'fallback' };
  }

  /** Heuristic: should we warm-start the screenshot capture before triage resolves? */
  function shouldWarmCapture(goal) {
    const shortcut = findShortcutIntent(goal);
    return !shortcut;
  }

  NS.fnvHash = fnvHash;
  NS.goalDigest = goalDigest;
  NS.makeCacheKey = makeCacheKey;
  NS.normalizeLabel = normalizeLabel;
  NS.pickFastModel = pickFastModel;
  NS.buildCompactCandidatesText = buildCompactCandidatesText;
  NS.SHORTCUT_INTENTS = SHORTCUT_INTENTS;
  NS.findShortcutIntent = findShortcutIntent;
  NS.runStage1Heuristic = runStage1Heuristic;
  NS.tryCacheResolve = tryCacheResolve;
  NS.decideStage = decideStage;
  NS.shouldWarmCapture = shouldWarmCapture;

  if (typeof window !== 'undefined') window.IG_DECISION = NS;
  if (typeof self !== 'undefined') self.IG_DECISION = NS;
})();
