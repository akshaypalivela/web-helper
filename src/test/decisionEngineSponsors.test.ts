import { describe, expect, it } from "vitest";
import fs from "node:fs";
import vm from "node:vm";

function loadDecisionEngine() {
  const source = fs.readFileSync("extension/decision-engine.js", "utf8");
  const sandbox: Record<string, unknown> = { self: {} };
  vm.runInNewContext(source, sandbox, { filename: "decision-engine.js" });
  const engine = (sandbox.self as any).IG_DECISION;
  if (!engine) throw new Error("IG_DECISION not initialized");
  return engine;
}

describe("decision engine sponsors flow policy", () => {
  const engine = loadDecisionEngine();

  it("prefers sponsors intent over generic account/profile intent", () => {
    const shortcut = engine.findShortcutIntent("Where can I add sponsors to my account?");
    expect(shortcut?.name).toBe("sponsors");
  });

  it("provides direct github sponsors fallback URL", () => {
    const url = engine.fallbackUrlForGoal(
      "I want to add sponsors to my account",
      "https://github.com/akshaypalivela"
    );
    expect(url).toBe("https://github.com/sponsors/accounts");
  });

  it("detects integrations shortcut intent", () => {
    const shortcut = engine.findShortcutIntent("Help me set up integrations");
    expect(shortcut?.name).toBe("integrations");
  });

  it("prefers Sponsors row when profile menu is open", () => {
    const candidates = [
      { idx: 1, label: "Profile", role: "menuitem" },
      { idx: 2, label: "Repositories", role: "menuitem" },
      { idx: 3, label: "Stars", role: "menuitem" },
      { idx: 4, label: "Sponsors", role: "menuitem" },
      { idx: 5, label: "Settings", role: "menuitem" },
    ];
    const uiState = engine.detectUiState({
      candidates,
      pageUrl: "https://github.com/akshaypalivela",
    });
    const hit = engine.runFlowPolicyHeuristic({
      goal: "add sponsors",
      pageUrl: "https://github.com/akshaypalivela",
      candidates,
      uiState,
      blockedFamilies: [],
    });
    expect(hit?.hit).toBe(true);
    expect(hit?.row?.label).toBe("Sponsors");
  });

  it("routes from settings toward Profile when Sponsors is absent", () => {
    const candidates = [
      { idx: 1, label: "Profile", role: "link" },
      { idx: 2, label: "Account", role: "link" },
      { idx: 3, label: "Emails", role: "link" },
    ];
    const hit = engine.runFlowPolicyHeuristic({
      goal: "add sponsors",
      pageUrl: "https://github.com/settings/profile",
      candidates,
      uiState: engine.detectUiState({
        candidates,
        pageUrl: "https://github.com/settings/profile",
      }),
      blockedFamilies: [],
    });
    expect(hit?.hit).toBe(true);
    expect(hit?.row?.label).toBe("Profile");
    expect(
      hit?.reason === "settings_to_profile_route" || hit?.reason === "route_to_profile_or_settings"
    ).toBe(true);
  });

  it("penalizes Stars when that family is blocked", () => {
    const candidates = [
      { idx: 1, label: "Stars", role: "tab" },
      { idx: 2, label: "Overview", role: "tab" },
      { idx: 3, label: "Repositories", role: "tab" },
    ];
    const ranked = engine.rankCandidatesForGoal({
      goal: "add sponsors",
      candidates,
      pageUrl: "https://github.com/akshaypalivela",
      uiState: engine.detectUiState({
        candidates,
        pageUrl: "https://github.com/akshaypalivela",
      }),
      blockedFamilies: ["stars"],
      max: 3,
    });
    expect(ranked[0]?.row?.label).not.toBe("Stars");
  });

  it("avoids edit profile as sponsors routing fallback", () => {
    const candidates = [
      { idx: 1, label: "Edit profile", role: "button" },
      { idx: 2, label: "Contribution settings", role: "button" },
      { idx: 3, label: "Profile", role: "menuitem" },
    ];
    const hit = engine.runFlowPolicyHeuristic({
      goal: "add sponsors to my account",
      pageUrl: "https://github.com/akshaypalivela",
      candidates,
      uiState: engine.detectUiState({
        candidates,
        pageUrl: "https://github.com/akshaypalivela",
      }),
      blockedFamilies: [],
    });
    expect(hit?.hit).toBe(true);
    expect(hit?.row?.label).toBe("Profile");
  });

  it("classifies invite teammate intent deterministically", () => {
    const intent = engine.classifyIntent("How do I invite a teammate?");
    expect(intent?.name).toBe("invite_user");
    expect(Number(intent?.confidence)).toBeGreaterThan(0.6);
  });

  it("uses deterministic verified flow for invite path", () => {
    const candidates = [
      { idx: 0, label: "Team", role: "menuitem", xPct: 12, yPct: 30 },
      { idx: 1, label: "Invite member", role: "button", xPct: 82, yPct: 22 },
      { idx: 2, label: "Billing", role: "menuitem", xPct: 12, yPct: 38 },
    ];
    const rec = engine.recommendDeterministicPath({
      goal: "How do I invite a teammate?",
      pageUrl: "https://app.example.com/settings/members",
      pageTitle: "Workspace Settings",
      candidates,
      userRole: "admin",
      blockedFamilies: [],
    });
    expect(rec?.hit).toBe(true);
    expect(rec?.strategy).toBe("verified_flow");
    expect(rec?.row?.label).toBe("Team");
    expect(Number(rec?.confidence)).toBeGreaterThanOrEqual(0.85);
  });

  it("asks clarification for low-confidence deterministic match", () => {
    const candidates = [
      { idx: 0, label: "Home", role: "link", xPct: 8, yPct: 12 },
      { idx: 1, label: "Overview", role: "tab", xPct: 26, yPct: 12 },
    ];
    const rec = engine.recommendDeterministicPath({
      goal: "Please do the thing for me",
      pageUrl: "https://app.example.com/dashboard",
      candidates,
      userRole: "member",
      blockedFamilies: [],
    });
    expect(rec?.hit).toBe(false);
    expect(rec?.strategy).toBe("clarify");
    expect(Number(rec?.confidence)).toBeLessThan(0.6);
  });

  it("uses sponsors-specific clarification wording when sponsors missing", () => {
    const candidates = [
      { idx: 0, label: "Contribution settings", role: "button", xPct: 58, yPct: 40 },
      { idx: 1, label: "Overview", role: "tab", xPct: 25, yPct: 19 },
    ];
    const rec = engine.recommendDeterministicPath({
      goal: "how do I add sponsors to my account",
      pageUrl: "https://github.com/some-user",
      candidates,
      userRole: "member",
      blockedFamilies: [],
    });
    expect(rec?.strategy).toBe("clarify");
    expect(String(rec?.clarifyingQuestion || "").toLowerCase()).toContain("sponsors");
  });

  it("penalizes non-billing rows for billing intent", () => {
    const row = { idx: 0, label: "Profile", role: "button", xPct: 90, yPct: 8 };
    const intent = engine.classifyIntent("update billing method");
    const s = engine.scoreElementDeterministic({
      goal: "update billing method",
      intent,
      row,
      pageUrl: "https://example.com/home",
      blockedFamilies: [],
    });
    expect(Number(s?.score)).toBeLessThan(0.6);
  });

  it("uses profile-first best guess for sponsors when confidence is low", () => {
    const candidates = [
      { idx: 0, label: "Contribution settings", role: "button", xPct: 62, yPct: 39 },
      { idx: 1, label: "Avatar", role: "button", xPct: 95, yPct: 8 },
      { idx: 2, label: "Overview", role: "tab", xPct: 24, yPct: 17 },
    ];
    const rec = engine.recommendDeterministicPath({
      goal: "where can I add sponsors?",
      pageUrl: "https://github.com/some-user",
      candidates,
      userRole: "member",
      blockedFamilies: [],
    });
    expect(rec?.hit).toBe(true);
    expect(rec?.strategy).toBe("action_graph");
    expect(rec?.row?.label).toBe("Avatar");
    expect(Number(rec?.confidence)).toBeGreaterThanOrEqual(0.8);
  });
});
