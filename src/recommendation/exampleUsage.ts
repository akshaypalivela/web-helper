import { getPathRecommendation } from "./recommendationEngine";
import { FeedbackTracker } from "./feedbackTracker";
import { mockPromptInvite, mockUIMap, mockUserContext } from "./mockData";

// Example integration point for product code.
export function runRecommendationExample() {
  const recommendation = getPathRecommendation(mockPromptInvite, mockUIMap, mockUserContext);

  const feedbackTracker = new FeedbackTracker();
  feedbackTracker.record(
    FeedbackTracker.buildFeedbackEvent({
      prompt: mockPromptInvite.rawText,
      detectedIntent: recommendation.intent,
      selectedPath: recommendation.steps,
      completed: true,
      userFeedback: "Invite dialog opened successfully.",
    }),
  );

  return {
    recommendation,
    inviteIntentSuccessRate: feedbackTracker.getSuccessRateByIntent("invite_user"),
  };
}

