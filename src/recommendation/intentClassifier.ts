import type { IntentName, IntentResult, UserPrompt } from "./types";

type IntentRule = {
  name: IntentName;
  patterns: RegExp[];
  entities: string[];
};

const INTENT_RULES: IntentRule[] = [
  {
    name: "invite_user",
    patterns: [/\binvite\b/, /\badd teammate\b/, /\badd member\b/, /\bteam invite\b/],
    entities: ["teammate", "member", "invite"],
  },
  {
    name: "create_project",
    patterns: [/\bcreate project\b/, /\bnew project\b/, /\bstart project\b/],
    entities: ["project"],
  },
  {
    name: "update_billing",
    patterns: [/\bbilling\b/, /\bpayment\b/, /\bsubscription\b/, /\binvoice\b/],
    entities: ["billing", "subscription", "payment"],
  },
  {
    name: "change_password",
    patterns: [/\bchange password\b/, /\breset password\b/, /\bpassword\b/],
    entities: ["password", "security"],
  },
  {
    name: "manage_team",
    patterns: [/\bmanage team\b/, /\bteam settings\b/, /\broles?\b/, /\bpermissions?\b/],
    entities: ["team", "roles", "permissions"],
  },
  {
    name: "export_report",
    patterns: [/\bexport\b/, /\bdownload report\b/, /\bcsv\b/, /\bxlsx\b/, /\breport\b/],
    entities: ["report", "export"],
  },
  {
    name: "book_resource",
    patterns: [/\bbook\b/, /\breserve\b/, /\bschedule\b/, /\bresource\b/, /\broom\b/],
    entities: ["booking", "resource"],
  },
  {
    name: "contact_support",
    patterns: [/\bcontact support\b/, /\bhelp\b/, /\bsupport\b/, /\bticket\b/],
    entities: ["support", "help"],
  },
];

export function normalizePrompt(text: string): string {
  return text.toLowerCase().replace(/[^\w\s]/g, " ").replace(/\s+/g, " ").trim();
}

export function classifyIntent(prompt: UserPrompt): IntentResult {
  const normalized = normalizePrompt(prompt.rawText || "");
  if (!normalized) {
    return {
      name: "unknown",
      entities: [],
      confidence: 0,
      normalizedGoal: "",
    };
  }

  let best: IntentRule | null = null;
  let bestScore = 0;
  for (const rule of INTENT_RULES) {
    const score = rule.patterns.reduce((acc, pattern) => acc + (pattern.test(normalized) ? 1 : 0), 0);
    if (score > bestScore) {
      best = rule;
      bestScore = score;
    }
  }

  if (!best || bestScore === 0) {
    return {
      name: "unknown",
      entities: [],
      confidence: 0.35,
      normalizedGoal: normalized,
    };
  }

  const confidence = Math.min(0.55 + bestScore * 0.2, 0.95);
  return {
    name: best.name,
    entities: [...best.entities],
    confidence,
    normalizedGoal: normalized,
  };
}
