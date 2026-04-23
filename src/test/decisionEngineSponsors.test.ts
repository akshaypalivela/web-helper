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
});
