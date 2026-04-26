import { describe, expect, it } from "vitest";
import { classifyIntent } from "../recommendation/intentClassifier";
import { getPathRecommendation } from "../recommendation/recommendationEngine";
import { mockPromptInvite, mockUIMap, mockUserContext } from "../recommendation/mockData";
import { FeedbackTracker } from "../recommendation/feedbackTracker";

describe("intentClassifier", () => {
  it("classifies invite prompt", () => {
    const result = classifyIntent({ rawText: "How do I invite a teammate?" });
    expect(result.name).toBe("invite_user");
    expect(result.confidence).toBeGreaterThan(0.6);
  });
});

describe("recommendationEngine", () => {
  it("prefers verified flow when confidence is high", () => {
    const result = getPathRecommendation(mockPromptInvite, mockUIMap, mockUserContext);
    expect(result.strategy).toBe("verified_flow");
    expect(result.confidence).toBeGreaterThanOrEqual(0.85);
    expect(result.steps[0]?.label.toLowerCase()).toContain("team");
  });

  it("falls back to clarify when unknown intent and weak UI signal", () => {
    const weakMap = {
      ...mockUIMap,
      currentUrl: "https://app.example.com/random-page",
      elements: [
        {
          id: "el-1",
          selector: "a[href='/home']",
          label: "Home",
          role: "link" as const,
          visible: true,
          position: { x: 10, y: 10, width: 80, height: 30 },
          region: "navigation" as const,
        },
      ],
    };
    const result = getPathRecommendation({ rawText: "can you do the thing" }, weakMap, {
      role: "member",
    });
    expect(result.strategy).toBe("clarify");
    expect(result.clarifyingQuestion).toBeTruthy();
  });
});

describe("feedbackTracker", () => {
  it("tracks completion rate per intent", () => {
    const tracker = new FeedbackTracker();
    const recommendation = getPathRecommendation(mockPromptInvite, mockUIMap, mockUserContext);
    tracker.record(
      FeedbackTracker.buildFeedbackEvent({
        prompt: mockPromptInvite.rawText,
        detectedIntent: recommendation.intent,
        selectedPath: recommendation.steps,
        completed: true,
      }),
    );
    expect(tracker.getSuccessRateByIntent("invite_user")).toBe(1);
  });
});

