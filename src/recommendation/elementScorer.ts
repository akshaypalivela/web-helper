import type {
  IntentResult,
  ScoredElement,
  UIElement,
  UIMap,
  UserContext,
  VerifiedFlow,
} from "./types";

const KEYWORDS_BY_INTENT: Record<string, string[]> = {
  invite_user: ["invite", "member", "team", "user", "people"],
  create_project: ["new", "create", "project"],
  update_billing: ["billing", "payment", "invoice", "card"],
  change_password: ["password", "security", "credential"],
  manage_team: ["team", "roles", "permissions", "members"],
  export_report: ["export", "download", "report", "csv"],
  book_resource: ["book", "reserve", "schedule", "resource"],
  contact_support: ["support", "help", "contact", "ticket"],
};

function tokenSet(text: string): Set<string> {
  return new Set(text.toLowerCase().split(/\W+/).filter((t) => t.length > 2));
}

function overlapScore(a: Set<string>, b: Set<string>): number {
  if (!a.size || !b.size) return 0;
  let hit = 0;
  for (const value of a) {
    if (b.has(value)) hit += 1;
  }
  return hit / Math.max(a.size, 1);
}

function roleWeight(role: UIElement["role"]): number {
  if (role === "button" || role === "nav_item") return 1;
  if (role === "link") return 0.85;
  if (role === "input") return 0.7;
  return 0.5;
}

function regionWeight(region: UIElement["region"]): number {
  if (region === "navigation") return 0.9;
  if (region === "main") return 1;
  if (region === "modal") return 0.95;
  if (region === "table") return 0.8;
  if (region === "sidebar") return 0.88;
  return 0.6;
}

export function scoreElement(
  element: UIElement,
  intent: IntentResult,
  uiMap: UIMap,
  context: UserContext,
  flow?: VerifiedFlow,
): ScoredElement {
  const promptTokens = tokenSet(intent.normalizedGoal);
  const labelTokens = tokenSet(`${element.label} ${element.ariaLabel || ""}`);
  const intentKeywords = new Set(KEYWORDS_BY_INTENT[intent.name] || []);

  const textMatch = overlapScore(promptTokens, labelTokens);
  const semanticMatch = intentKeywords.size ? overlapScore(intentKeywords, labelTokens) : 0;
  const keywordMatch = [...intentKeywords].some((kw) => element.label.toLowerCase().includes(kw)) ? 1 : 0;
  const visibility = element.visible ? 1 : 0;
  const roleScore = roleWeight(element.role);
  const positionScore = element.position.y < window.innerHeight * 0.75 ? 0.8 : 0.6;
  const roleCompat = flow ? (flow.requiredUserRole.includes(context.role) ? 1 : 0.2) : 0.8;
  const historicalSuccess = flow?.historicalSuccessRate ?? context.historicalSuccessByIntent?.[intent.name] ?? 0.6;
  const regionScore = regionWeight(element.region);

  const score =
    textMatch * 0.22 +
    semanticMatch * 0.16 +
    keywordMatch * 0.12 +
    visibility * 0.1 +
    roleScore * 0.1 +
    positionScore * 0.08 +
    roleCompat * 0.1 +
    historicalSuccess * 0.06 +
    regionScore * 0.06;

  return {
    element,
    score: Math.max(0, Math.min(1, score)),
    breakdown: {
      textMatch,
      intentMatch: semanticMatch,
      keywordMatch,
      visibility,
      roleWeight: roleScore,
      positionWeight: positionScore,
      userRoleCompatibility: roleCompat,
      historicalSuccess,
      regionWeight: regionScore,
    },
    reason: `Scored from label match, intent keywords, visibility, role, region, and historical reliability.`,
  };
}

export function scoreVisibleElements(
  elements: UIElement[],
  intent: IntentResult,
  uiMap: UIMap,
  context: UserContext,
  flow?: VerifiedFlow,
): ScoredElement[] {
  return elements
    .filter((el) => el.visible)
    .map((el) => scoreElement(el, intent, uiMap, context, flow))
    .sort((a, b) => b.score - a.score);
}

