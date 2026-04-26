import type { IntentResult, UserContext, VerifiedFlow } from "./types";

export const VERIFIED_FLOWS: VerifiedFlow[] = [
  {
    id: "invite-user-settings-team",
    goal: "Invite a teammate to the workspace",
    intents: ["invite_user", "manage_team"],
    supportedUrlPatterns: [/\/settings/i, /\/team/i, /\/members/i],
    requiredUserRole: ["owner", "admin"],
    steps: [
      {
        id: "open-team",
        action: "click",
        selector: "[data-testid='nav-team'], a[href*='team']",
        expectedLabel: "Team",
        expectedRegion: "navigation",
        reason: "Team management is usually under workspace settings.",
      },
      {
        id: "click-invite",
        action: "click",
        selector: "button[data-testid='invite-member'], button:has-text('Invite')",
        expectedLabel: "Invite",
        expectedRole: "button",
        reason: "Invite action starts member onboarding.",
      },
    ],
    successCriteria: ["invite dialog opens", "member appears as pending"],
    historicalSuccessRate: 0.93,
  },
  {
    id: "update-billing-settings",
    goal: "Update billing method",
    intents: ["update_billing"],
    supportedUrlPatterns: [/\/settings/i, /\/billing/i, /\/account/i],
    requiredUserRole: ["owner", "admin", "billing_admin"],
    steps: [
      {
        id: "open-billing",
        action: "click",
        selector: "a[href*='billing'], button:has-text('Billing')",
        expectedLabel: "Billing",
        expectedRegion: "navigation",
        reason: "Billing pages are grouped in account settings.",
      },
      {
        id: "open-payment-method",
        action: "click",
        selector: "button:has-text('Payment'), button:has-text('Update card')",
        expectedLabel: "Payment",
        expectedRole: "button",
        reason: "Payment action allows card changes.",
      },
    ],
    successCriteria: ["payment form visible", "updated card confirmation"],
    historicalSuccessRate: 0.9,
  },
];

export function matchVerifiedFlows(intent: IntentResult, currentUrl: string, context: UserContext): VerifiedFlow[] {
  return VERIFIED_FLOWS.filter((flow) => {
    const intentMatch = flow.intents.includes(intent.name);
    const urlMatch = flow.supportedUrlPatterns.some((pattern) => pattern.test(currentUrl));
    const roleMatch = flow.requiredUserRole.includes(context.role);
    return intentMatch && urlMatch && roleMatch;
  }).sort((a, b) => b.historicalSuccessRate - a.historicalSuccessRate);
}

