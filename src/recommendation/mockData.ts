import type { UIMap, UserContext, UserPrompt } from "./types";

export const mockPromptInvite: UserPrompt = {
  rawText: "How do I invite a teammate?",
};

export const mockUserContext: UserContext = {
  role: "admin",
  historicalSuccessByIntent: {
    invite_user: 0.88,
    manage_team: 0.82,
  },
};

export const mockUIMap: UIMap = {
  currentUrl: "https://app.example.com/settings/members",
  pageTitle: "Workspace Settings",
  visibleText: "Team Members Invite Member Billing Settings",
  buttons: [
    {
      id: "btn-invite",
      selector: "[data-testid='invite-member']",
      label: "Invite member",
      role: "button",
      visible: true,
      position: { x: 860, y: 210, width: 120, height: 36 },
      region: "main",
    },
  ],
  links: [
    {
      id: "lnk-billing",
      selector: "a[href='/settings/billing']",
      label: "Billing",
      role: "link",
      visible: true,
      position: { x: 28, y: 220, width: 100, height: 32 },
      region: "navigation",
      href: "/settings/billing",
    },
  ],
  inputs: [],
  navItems: [
    {
      id: "nav-team",
      selector: "a[href='/settings/members']",
      label: "Team",
      role: "nav_item",
      visible: true,
      position: { x: 28, y: 180, width: 100, height: 32 },
      region: "navigation",
      href: "/settings/members",
    },
  ],
  modals: [],
  tables: [],
  elements: [],
  scannedAt: new Date().toISOString(),
};

mockUIMap.elements = [...mockUIMap.buttons, ...mockUIMap.links, ...mockUIMap.navItems];

