// Pure functions for the cascaded waterfall: cache keys, heuristic shortcuts,
// compact prompt building, fast-model selection. No DOM access, no network.
// Loaded both in the sidepanel (via <script>) and the background worker
// (via importScripts). Exposes window.IG_DECISION / self.IG_DECISION.

(function () {
  'use strict';

  const NS = {};
  const GOAL_STOPWORDS = new Set([
    'the', 'and', 'for', 'with', 'this', 'that', 'please', 'help', 'want', 'need', 'how',
    'get', 'can', 'you', 'your', 'about', 'from', 'into', 'onto', 'add', 'set', 'let', 'use',
    'tab', 'button', 'link', 'click', 'open', 'goto', 'next', 'step', 'page', 'here', 'show',
    'make', 'take', 'give', 'put', 'there', 'still', 'correctly', 'option', 'options',
  ]);

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

  function tokenizeWords(text) {
    const s = normalizeLabel(text);
    if (!s) return [];
    return (s.match(/[a-z0-9]+/g) || []).filter((t) => t.length >= 3);
  }

  function includesAny(text, aliases) {
    const n = normalizeLabel(text);
    if (!n) return false;
    return aliases.some((a) => n.includes(normalizeLabel(a)));
  }

  function parseUrlParts(rawUrl) {
    const text = String(rawUrl || '').trim();
    if (!text) return { host: '', path: '' };
    if (typeof URL !== 'undefined') {
      try {
        const u = new URL(text);
        return {
          host: String(u.hostname || '').toLowerCase(),
          path: String(u.pathname || ''),
        };
      } catch (_) {}
    }
    const m = text.match(/^https?:\/\/([^/?#]+)(\/[^?#]*)?/i);
    if (m) {
      return {
        host: String(m[1] || '').toLowerCase(),
        path: String(m[2] || ''),
      };
    }
    return { host: '', path: '' };
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
      name: 'sponsors',
      test: /\b(sponsor|sponsors|github sponsors|add sponsors?)\b/i,
      labels: ['sponsor', 'sponsors', 'github sponsors', 'become a sponsor'],
    },
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
      name: 'integrations',
      test: /\b(integrations?|connected apps?|app integrations?|plugins?|marketplace)\b/i,
      labels: [
        'integrations',
        'integration',
        'connected apps',
        'apps',
        'app marketplace',
        'marketplace',
        'plugins',
        'application',
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

  const FLOW_POLICIES = [
    {
      name: 'github_sponsors',
      testGoal: /\b(sponsor|sponsors|add sponsors?)\b/i,
      testUrl: /(^|\.)github\.com$/i,
      positive: ['sponsor', 'sponsors'],
      negatives: [
        'stars',
        'starred',
        'contribution settings',
        'contribution activity',
        'edit profile',
      ],
      menuCluster: ['profile', 'repositories', 'stars', 'settings'],
      profileTabs: ['overview', 'repositories', 'projects', 'packages', 'stars'],
      routeLabels: [
        'profile',
        'settings',
        'account',
        'avatar',
        'my profile',
        'user menu',
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

  function detectUiState({ candidates, pageUrl }) {
    const rows = Array.isArray(candidates) ? candidates : [];
    const labels = rows.map((r) => normalizeLabel(r?.label));
    const { host, path } = parseUrlParts(pageUrl);
    const onGithub = /(^|\.)github\.com$/.test(host);
    const onGithubSettings = /^\/settings(\/|$)/.test(path);
    const onGithubPublicProfile = /^\/[^/]+\/?$/.test(path);
    const hasSponsorsVisible = labels.some((l) => includesAny(l, ['sponsor', 'sponsors']));
    const hasProfileLabel = labels.some((l) => includesAny(l, ['profile']));
    const hasSettingsLabel = labels.some((l) => includesAny(l, ['settings']));
    const hasStarsLabel = labels.some((l) => includesAny(l, ['stars', 'starred']));
    const hasRepositoriesLabel = labels.some((l) => includesAny(l, ['repositories']));
    const hasProfileMenuRows =
      Number(hasProfileLabel) +
        Number(hasSettingsLabel) +
        Number(hasStarsLabel) +
        Number(hasRepositoriesLabel) >=
      3;
    const hasPublicProfileTabs =
      labels.some((l) => includesAny(l, ['overview'])) &&
      labels.some((l) => includesAny(l, ['repositories'])) &&
      labels.some((l) => includesAny(l, ['stars']));
    return {
      onGithub,
      onGithubSettings,
      onGithubPublicProfile,
      hasSponsorsVisible,
      hasProfileMenuRows,
      hasPublicProfileTabs,
    };
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

  function scoreCandidateForGoal({
    goal,
    row,
    pageUrl = '',
    uiState = null,
    blockedFamilies = [],
  }) {
    const rowLabel = normalizeLabel(row?.label);
    if (!rowLabel) return { score: -999, reasons: ['empty_label'] };
    const reasons = [];
    let score = 0;
    const g = normalizeLabel(goal);
    const goalTokens = tokenizeWords(g).filter((t) => !GOAL_STOPWORDS.has(t));
    const rowTokens = tokenizeWords(rowLabel);
    const tokenHits = goalTokens.filter((t) => rowTokens.includes(t)).length;
    score += tokenHits * 10;
    if (tokenHits) reasons.push(`token_hits:${tokenHits}`);

    const shortcut = findShortcutIntent(goal);
    if (shortcut) {
      const shortcutScore = labelAliasScore(shortcut.labels, rowLabel);
      score += Math.round(shortcutScore * 0.7);
      if (shortcutScore) reasons.push(`shortcut:${shortcut.name}:${shortcutScore}`);
    }

    const parts = parseUrlParts(pageUrl);
    const policy = FLOW_POLICIES.find(
      (p) => p.testGoal.test(goal || '') && (!p.testUrl || p.testUrl.test(parts.host))
    );
    if (policy) {
      if (includesAny(rowLabel, policy.positive)) {
        score += 110;
        reasons.push(`flow_positive:${policy.name}`);
      }
      if (includesAny(rowLabel, policy.negatives)) {
        score -= 100;
        reasons.push(`flow_negative:${policy.name}`);
      }
      if (uiState?.hasProfileMenuRows && includesAny(rowLabel, policy.menuCluster)) {
        score += 8;
      }
      if (uiState?.hasPublicProfileTabs && includesAny(rowLabel, policy.profileTabs)) {
        score += 6;
      }
      if (uiState?.hasProfileMenuRows && includesAny(rowLabel, ['sponsors'])) {
        score += 25;
        reasons.push('menu_sponsors_boost');
      }
    }

    const blocked = new Set(Array.isArray(blockedFamilies) ? blockedFamilies : []);
    for (const fam of blocked) {
      if (!fam) continue;
      if (fam === 'stars' && includesAny(rowLabel, ['stars', 'starred'])) {
        score -= 130;
        reasons.push('blocked_family:stars');
      } else if (fam === 'contribution' && includesAny(rowLabel, ['contribution'])) {
        score -= 130;
        reasons.push('blocked_family:contribution');
      } else if (fam === 'profile' && includesAny(rowLabel, ['profile'])) {
        score -= 55;
        reasons.push('blocked_family:profile');
      } else if (fam === 'settings' && includesAny(rowLabel, ['settings'])) {
        score -= 55;
        reasons.push('blocked_family:settings');
      }
    }
    return { score, reasons };
  }

  function rankCandidatesForGoal({
    goal,
    candidates,
    pageUrl = '',
    uiState = null,
    blockedFamilies = [],
    max = 20,
  }) {
    if (!Array.isArray(candidates) || !candidates.length) return [];
    const ranked = candidates
      .map((row) => {
        const s = scoreCandidateForGoal({ goal, row, pageUrl, uiState, blockedFamilies });
        return { row, score: s.score, reasons: s.reasons };
      })
      .sort((a, b) => b.score - a.score);
    return ranked.slice(0, Math.max(1, Number(max) || 20));
  }

  function runFlowPolicyHeuristic({
    goal,
    pageUrl = '',
    candidates,
    uiState = null,
    blockedFamilies = [],
  }) {
    if (!goal || !Array.isArray(candidates) || !candidates.length) return null;
    const goalText = String(goal || '');
    const state = uiState || detectUiState({ candidates, pageUrl });
    const policy = FLOW_POLICIES.find((p) => p.testGoal.test(goalText));
    if (!policy) return null;

    const { host, path } = parseUrlParts(pageUrl);
    if (!policy.testUrl.test(host)) return null;

    const rows = candidates.map((r) => ({ row: r, n: normalizeLabel(r?.label) })).filter((x) => x.n);
    const sponsorRow = rows.find((x) => includesAny(x.n, ['sponsor', 'sponsors']));
    if (sponsorRow) {
      return {
        hit: true,
        row: sponsorRow.row,
        intent: 'github_sponsors',
        policy: policy.name,
        reason: state.hasProfileMenuRows ? 'profile_menu_sponsors_visible' : 'sponsors_visible',
        score: 140,
      };
    }

    // When the menu is open but Sponsors is not visible, do not pick Stars/contribution.
    // Let later stages explain navigation with lower confidence instead.
    if (state.hasProfileMenuRows) {
      return null;
    }

    // Sponsors intent but Sponsors row not visible yet: route toward account/profile/settings
    // entry points, but explicitly avoid distractors like Edit profile and contribution controls.
    const routeCandidates = rows
      .filter((x) => includesAny(x.n, policy.routeLabels || []))
      .filter(
        (x) =>
          !includesAny(x.n, ['edit profile', 'contribution settings', 'contribution activity', 'stars', 'starred'])
      );
    if (routeCandidates.length) {
      const bestRoute = routeCandidates[0];
      const blocked = new Set(Array.isArray(blockedFamilies) ? blockedFamilies : []);
      const fam = includesAny(bestRoute.n, ['settings'])
        ? 'settings'
        : includesAny(bestRoute.n, ['profile', 'account', 'avatar'])
          ? 'profile'
          : '';
      if (!fam || !blocked.has(fam)) {
        return {
          hit: true,
          row: bestRoute.row,
          intent: 'github_sponsors',
          policy: policy.name,
          reason: 'route_to_profile_or_settings',
          score: 98,
        };
      }
    }

    // On settings/edit pages, the deterministic move is "Profile" to route back to
    // public profile where Sponsors controls are expected.
    const onSettings = state.onGithubSettings || /^\/settings(\/|$)/.test(path);
    if (onSettings) {
      const profileRow = rows.find((x) => includesAny(x.n, ['profile']));
      if (profileRow) {
        const blocked = new Set(Array.isArray(blockedFamilies) ? blockedFamilies : []);
        if (!blocked.has('profile')) {
          return {
            hit: true,
            row: profileRow.row,
            intent: 'github_sponsors',
            policy: policy.name,
            reason: 'settings_to_profile_route',
            score: 102,
          };
        }
      }
    }

    return null;
  }

  function fallbackUrlForGoal(goal, pageUrl = '') {
    const g = String(goal || '').toLowerCase();
    const { host } = parseUrlParts(pageUrl);
    if (/\b(sponsor|sponsors|add sponsors?)\b/.test(g) && (!host || /(^|\.)github\.com$/.test(host))) {
      return 'https://github.com/sponsors/accounts';
    }
    return '';
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
  NS.FLOW_POLICIES = FLOW_POLICIES;
  NS.findShortcutIntent = findShortcutIntent;
  NS.detectUiState = detectUiState;
  NS.scoreCandidateForGoal = scoreCandidateForGoal;
  NS.rankCandidatesForGoal = rankCandidatesForGoal;
  NS.runFlowPolicyHeuristic = runFlowPolicyHeuristic;
  NS.fallbackUrlForGoal = fallbackUrlForGoal;
  NS.runStage1Heuristic = runStage1Heuristic;
  NS.tryCacheResolve = tryCacheResolve;
  NS.decideStage = decideStage;
  NS.shouldWarmCapture = shouldWarmCapture;

  if (typeof window !== 'undefined') window.IG_DECISION = NS;
  if (typeof self !== 'undefined') self.IG_DECISION = NS;
})();
