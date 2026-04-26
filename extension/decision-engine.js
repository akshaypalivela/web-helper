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

  // Deterministic intent taxonomy for non-LLM routing.
  const INTENT_RULES = [
    {
      name: 'invite_user',
      test: /\b(invite|add teammate|add member|team invite|invite user)\b/i,
      entities: ['invite', 'teammate', 'member', 'team'],
      keywords: ['invite', 'member', 'team', 'people', 'user'],
    },
    {
      name: 'create_project',
      test: /\b(create project|new project|start project)\b/i,
      entities: ['project'],
      keywords: ['create', 'new', 'project'],
    },
    {
      name: 'update_billing',
      test: /\b(billing|payment|subscription|invoice|card)\b/i,
      entities: ['billing', 'payment'],
      keywords: ['billing', 'payment', 'invoice', 'subscription', 'card'],
    },
    {
      name: 'change_password',
      test: /\b(change password|reset password|password|security)\b/i,
      entities: ['password', 'security'],
      keywords: ['password', 'security', 'credential'],
    },
    {
      name: 'manage_team',
      test: /\b(manage team|team settings|permissions|roles|members?)\b/i,
      entities: ['team', 'roles', 'permissions'],
      keywords: ['team', 'member', 'role', 'permission', 'settings'],
    },
    {
      name: 'export_report',
      test: /\b(export|download report|csv|xlsx|report)\b/i,
      entities: ['export', 'report'],
      keywords: ['export', 'download', 'report', 'csv', 'xlsx'],
    },
    {
      name: 'book_resource',
      test: /\b(book|reserve|schedule|resource|room)\b/i,
      entities: ['book', 'resource'],
      keywords: ['book', 'reserve', 'schedule', 'resource', 'room'],
    },
    {
      name: 'contact_support',
      test: /\b(contact support|help|support|ticket|faq)\b/i,
      entities: ['support'],
      keywords: ['support', 'help', 'contact', 'ticket', 'faq', 'docs'],
    },
  ];

  const VERIFIED_FLOWS = [
    {
      id: 'invite_user_settings_team',
      intents: ['invite_user', 'manage_team'],
      url: [/\/settings/i, /\/team/i, /\/members/i],
      roles: ['owner', 'admin'],
      successRate: 0.93,
      stepAliases: ['team', 'members', 'people', 'invite', 'add member'],
      successCriteria: ['invite modal opens', 'pending invite visible'],
    },
    {
      id: 'update_billing_settings',
      intents: ['update_billing'],
      url: [/\/settings/i, /\/billing/i, /\/account/i],
      roles: ['owner', 'admin', 'billing_admin'],
      successRate: 0.9,
      stepAliases: ['billing', 'payment', 'invoice', 'card', 'subscription'],
      successCriteria: ['payment form visible'],
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

  function classifyIntent(goal) {
    const g = normalizeLabel(goal);
    if (!g) {
      return { name: 'unknown', entities: [], confidence: 0, normalizedGoal: '' };
    }
    let best = null;
    let bestScore = 0;
    for (const r of INTENT_RULES) {
      let score = 0;
      if (r.test.test(g)) score += 2;
      const hits = (r.keywords || []).filter((k) => g.includes(normalizeLabel(k))).length;
      score += Math.min(2, hits);
      if (score > bestScore) {
        best = r;
        bestScore = score;
      }
    }
    if (!best || bestScore <= 0) {
      return { name: 'unknown', entities: [], confidence: 0.35, normalizedGoal: g };
    }
    return {
      name: best.name,
      entities: (best.entities || []).slice(),
      confidence: Math.min(0.95, 0.55 + bestScore * 0.12),
      normalizedGoal: g,
    };
  }

  function labelFamilyFromLabel(label) {
    const n = normalizeLabel(label || '');
    if (/\bsponsors?\b/.test(n)) return 'sponsors';
    if (/\bstars?\b|\bstarred\b/.test(n)) return 'stars';
    if (/\bcontribution/.test(n)) return 'contribution';
    if (/\bprofile\b|\baccount\b|\bavatar\b/.test(n)) return 'profile';
    if (/\bsettings?\b|\bpreferences?\b/.test(n)) return 'settings';
    const t = tokenizeWords(n)[0];
    return t || 'other';
  }

  function buildStructuredUiMap({ candidates, pageUrl = '', pageTitle = '' }) {
    const rows = Array.isArray(candidates) ? candidates : [];
    const text = rows.map((r) => String(r?.label || '')).filter(Boolean).join(' ');
    const byRole = (re) => rows.filter((r) => re.test(String(r?.role || '').toLowerCase()));
    return {
      currentUrl: String(pageUrl || ''),
      pageTitle: String(pageTitle || ''),
      visibleText: text.slice(0, 4000),
      buttons: byRole(/\bbutton\b/),
      links: byRole(/\blink\b/),
      inputs: byRole(/\b(input|textbox|searchbox|combobox)\b/),
      navItems: rows.filter((r) => /\b(menu|menuitem|tab|navigation|nav)\b/.test(String(r?.role || '').toLowerCase())),
      modals: rows.filter((r) => includesAny(r?.label, ['modal', 'dialog', 'close'])),
      tables: rows.filter((r) => /\b(row|cell|grid)\b/.test(String(r?.role || '').toLowerCase())),
      elements: rows.slice(),
    };
  }

  function lookupVerifiedFlow({ intent, pageUrl = '', userRole = 'member', candidates }) {
    const role = normalizeLabel(userRole || 'member');
    const flow = VERIFIED_FLOWS.find((f) => {
      const intentOk = (f.intents || []).includes(intent?.name);
      const urlOk = (f.url || []).some((re) => re.test(String(pageUrl || '')));
      const roleOk = (f.roles || []).map((x) => normalizeLabel(x)).includes(role);
      return intentOk && urlOk && roleOk;
    });
    if (!flow) return null;
    const rows = Array.isArray(candidates) ? candidates : [];
    const step = rows.find((r) => {
      const label = normalizeLabel(r?.label || '');
      return flow.stepAliases.some((a) => label.includes(normalizeLabel(a)));
    });
    if (!step) return null;
    return {
      hit: true,
      flowId: flow.id,
      row: step,
      confidence: Math.min(0.98, 0.82 + flow.successRate * 0.16),
      reason: `verified_flow:${flow.id}`,
      successRate: flow.successRate,
    };
  }

  function scoreElementDeterministic({
    goal,
    intent,
    row,
    pageUrl = '',
    blockedFamilies = [],
  }) {
    const goalTokens = tokenizeWords(normalizeLabel(goal)).filter((t) => !GOAL_STOPWORDS.has(t));
    const rowLabel = normalizeLabel(row?.label);
    const rowTokens = tokenizeWords(rowLabel);
    const role = normalizeLabel(row?.role || '');
    if (!rowLabel) return { score: 0, reasons: ['empty_label'] };

    const textHits = goalTokens.filter((t) => rowTokens.includes(t)).length;
    const textMatch = goalTokens.length ? textHits / goalTokens.length : 0;
    const intentRule = INTENT_RULES.find((r) => r.name === intent?.name);
    const kwHits = intentRule
      ? intentRule.keywords.filter((k) => rowLabel.includes(normalizeLabel(k))).length
      : 0;
    const semanticMatch = intentRule ? kwHits / Math.max(1, intentRule.keywords.length) : 0;
    const roleWeight =
      /\b(button|menuitem|tab|link)\b/.test(role) ? 1 : /\b(input|textbox|searchbox)\b/.test(role) ? 0.72 : 0.55;
    const positionWeight = Number(row?.yPct) <= 75 ? 0.85 : 0.65;
    const navWeight = /\b(menu|tab|navigation|nav)\b/.test(role) ? 0.92 : 0.74;
    const urlWeight = /\/settings|\/account|\/team|\/members|\/billing/.test(String(pageUrl || '')) ? 0.82 : 0.65;

    let blockedPenalty = 0;
    const fam = labelFamilyFromLabel(rowLabel);
    if (Array.isArray(blockedFamilies) && blockedFamilies.includes(fam)) blockedPenalty = 0.4;

    let intentPenalty = 0;
    if (intent?.name === 'update_billing') {
      const billingish = /\b(billing|payment|invoice|subscription|card|plan)\b/.test(rowLabel);
      if (!billingish) intentPenalty += 0.22;
    }
    if (intent?.name === 'invite_user' || intent?.name === 'manage_team') {
      const teamish = /\b(invite|member|team|people|user|users)\b/.test(rowLabel);
      if (!teamish) intentPenalty += 0.12;
    }

    const score = Math.max(
      0,
      Math.min(
        1,
        textMatch * 0.28 +
          semanticMatch * 0.2 +
          roleWeight * 0.14 +
          positionWeight * 0.1 +
          navWeight * 0.1 +
          urlWeight * 0.08 +
          Number(Boolean(row?.label)) * 0.1 -
          intentPenalty -
          blockedPenalty
      )
    );

    return {
      score,
      reasons: [
        `text:${textMatch.toFixed(2)}`,
        `semantic:${semanticMatch.toFixed(2)}`,
        `role:${roleWeight.toFixed(2)}`,
        `intentPenalty:${intentPenalty.toFixed(2)}`,
        `blockedPenalty:${blockedPenalty.toFixed(2)}`,
      ],
    };
  }

  function createActionGraphFromCandidates(candidates, pageUrl = '') {
    const root = `state:${fnvHash(String(pageUrl || '')).slice(0, 8)}`;
    const rows = Array.isArray(candidates) ? candidates : [];
    const nodes = [{ id: root, type: 'ui_state', label: String(pageUrl || 'current page') }];
    const edges = [];
    for (const r of rows) {
      const id = `el:${Number.isFinite(Number(r?.idx)) ? Number(r.idx) : nodes.length}`;
      nodes.push({ id, type: 'element', label: String(r?.label || ''), idx: r?.idx });
      edges.push({
        from: root,
        to: id,
        action: /\b(input|textbox|searchbox)\b/.test(String(r?.role || '').toLowerCase()) ? 'type' : 'click',
        cost: r?.visible === false ? 3 : 1,
      });
    }
    return { nodes, edges };
  }

  function rankCandidatePaths({ goal, intent, candidates, pageUrl = '', blockedFamilies = [], max = 5 }) {
    const graph = createActionGraphFromCandidates(candidates, pageUrl);
    const byNode = new Map();
    const rows = Array.isArray(candidates) ? candidates : [];
    for (const r of rows) {
      const id = `el:${Number.isFinite(Number(r?.idx)) ? Number(r.idx) : -1}`;
      byNode.set(id, r);
    }
    const ranked = graph.edges
      .map((e) => {
        const row = byNode.get(e.to);
        const s = scoreElementDeterministic({ goal, intent, row, pageUrl, blockedFamilies });
        return { edge: e, row, score: s.score, reasons: s.reasons };
      })
      .filter((x) => x.row)
      .sort((a, b) => b.score - a.score);
    return ranked.slice(0, Math.max(1, Number(max) || 5));
  }

  function recommendDeterministicPath({
    goal,
    pageUrl = '',
    pageTitle = '',
    candidates,
    userRole = 'member',
    blockedFamilies = [],
  }) {
    const rows = Array.isArray(candidates) ? candidates : [];
    if (!goal || !rows.length) return null;

    const intent = classifyIntent(goal);
    const shortcut = findShortcutIntent(goal);
    const uiMap = buildStructuredUiMap({ candidates: rows, pageUrl, pageTitle });
    const flow = lookupVerifiedFlow({ intent, pageUrl, userRole, candidates: rows });
    if (flow?.hit && flow?.row) {
      return {
        hit: true,
        strategy: 'verified_flow',
        row: flow.row,
        intent,
        confidence: flow.confidence,
        requiresConfirmation: flow.confidence < 0.85,
        reason: flow.reason,
        explanation: `Used verified flow (${flow.flowId}) with historical success ${Math.round(flow.successRate * 100)}%.`,
        uiMap,
      };
    }

    const ranked = rankCandidatePaths({
      goal,
      intent,
      candidates: rows,
      pageUrl,
      blockedFamilies,
      max: 3,
    });
    if (!ranked.length) {
      const sponsorClarify = shortcut?.name === 'sponsors'
        ? 'I cannot see a Sponsors control on this screen yet. Open your avatar/profile menu first, then choose Sponsors.'
        : 'Should we do this from team settings, account settings, or project settings?';
      return {
        hit: false,
        strategy: 'clarify',
        intent,
        confidence: Math.max(0.2, intent.confidence * 0.5),
        requiresConfirmation: true,
        clarifyingQuestion: sponsorClarify,
        reason: 'no_ranked_candidates',
        explanation: 'No deterministic target found in the visible controls.',
        uiMap,
      };
    }

    const top = ranked[0];
    const confidence = Math.max(0, Math.min(1, Number(top.score) || 0));

    // For sponsors flows, profile/avatar is often the right first move before Sponsors is visible.
    if (shortcut?.name === 'sponsors' && confidence < 0.6) {
      const profileLike = rows
        .map((r) => ({
          row: r,
          alias: labelAliasScore(['profile', 'account', 'avatar', 'user menu'], r?.label || ''),
        }))
        .sort((a, b) => b.alias - a.alias)[0];
      if (profileLike?.row && Number(profileLike.alias) >= 88) {
        return {
          hit: true,
          strategy: 'action_graph',
          row: profileLike.row,
          intent,
          confidence: 0.82,
          requiresConfirmation: true,
          reason: 'sponsors_profile_first_best_guess',
          explanation: 'Sponsors control is not visible yet; open profile/account menu first as the most reliable next step.',
          topCandidates: ranked,
          uiMap,
        };
      }
    }

    if (confidence < 0.6) {
      const sponsorClarify = shortcut?.name === 'sponsors'
        ? 'This page does not show Sponsors yet. Open the profile/avatar menu or use the direct sponsors accounts page.'
        : 'I am not confident from this screen yet. Which area should we open first: settings, team, billing, or support?';
      return {
        hit: false,
        strategy: 'clarify',
        intent,
        confidence,
        requiresConfirmation: true,
        clarifyingQuestion: sponsorClarify,
        reason: 'low_confidence',
        explanation: `Top deterministic candidate was "${top?.row?.label || ''}" with low confidence.`,
        topCandidates: ranked,
        uiMap,
      };
    }

    return {
      hit: true,
      strategy: 'action_graph',
      row: top.row,
      intent,
      confidence,
      requiresConfirmation: confidence < 0.85,
      reason: `graph_top:${(top.reasons || []).join(',')}`,
      explanation: `Deterministic path selected from structured UI map and action graph ranking.`,
      topCandidates: ranked,
      uiMap,
    };
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
  NS.classifyIntent = classifyIntent;
  NS.buildStructuredUiMap = buildStructuredUiMap;
  NS.lookupVerifiedFlow = lookupVerifiedFlow;
  NS.createActionGraphFromCandidates = createActionGraphFromCandidates;
  NS.rankCandidatePaths = rankCandidatePaths;
  NS.scoreElementDeterministic = scoreElementDeterministic;
  NS.recommendDeterministicPath = recommendDeterministicPath;
  NS.fallbackUrlForGoal = fallbackUrlForGoal;
  NS.runStage1Heuristic = runStage1Heuristic;
  NS.tryCacheResolve = tryCacheResolve;
  NS.decideStage = decideStage;
  NS.shouldWarmCapture = shouldWarmCapture;

  if (typeof window !== 'undefined') window.IG_DECISION = NS;
  if (typeof self !== 'undefined') self.IG_DECISION = NS;
})();
