import { createGraphFromUIMap, findBestPath, rankCandidatePaths } from "./actionGraph";
import { classifyIntent } from "./intentClassifier";
import { scoreVisibleElements } from "./elementScorer";
import { matchVerifiedFlows } from "./verifiedFlows";
import type {
  PathRecommendation,
  RecommendationStep,
  UIElement,
  UIMap,
  UserContext,
  UserPrompt,
  VerifiedFlow,
} from "./types";

function toStep(element: UIElement, confidence: number, reason: string, stepNumber = 1): RecommendationStep {
  return {
    stepNumber,
    selector: element.selector,
    label: element.label || element.selector,
    action: element.role === "input" ? "type" : "click",
    confidence,
    reason,
  };
}

function buildFlowSteps(flow: VerifiedFlow, visibleElements: UIElement[]): RecommendationStep[] {
  return flow.steps.map((step, index) => {
    const matched = visibleElements.find((el) => {
      const labelMatch = el.label.toLowerCase().includes(step.expectedLabel.toLowerCase());
      const selectorMatch = el.selector.includes(step.selector.split(",")[0].trim().replace(/['"]/g, ""));
      return labelMatch || selectorMatch;
    });

    return {
      stepNumber: index + 1,
      selector: matched?.selector || step.selector,
      label: matched?.label || step.expectedLabel,
      action: step.action,
      confidence: matched ? 0.92 : 0.7,
      reason: step.reason,
    };
  });
}

function confidenceMode(score: number): Pick<PathRecommendation, "requiresConfirmation" | "clarifyingQuestion"> {
  if (score >= 0.85) return { requiresConfirmation: false };
  if (score >= 0.6 && score < 0.85) {
    return { requiresConfirmation: true, clarifyingQuestion: "This is likely correct. Want me to proceed with this path?" };
  }
  return {
    requiresConfirmation: true,
    clarifyingQuestion:
      "I am not confident yet. Are you trying to do this from team settings, account settings, or a project page?",
  };
}

export function getPathRecommendation(
  userPrompt: UserPrompt,
  uiMap: UIMap,
  userContext: UserContext,
): PathRecommendation {
  const intent = classifyIntent(userPrompt);
  const matchedFlows = matchVerifiedFlows(intent, uiMap.currentUrl, userContext);
  const bestFlow = matchedFlows[0];

  // Deterministic preference: high-confidence verified flows first.
  if (bestFlow && bestFlow.historicalSuccessRate >= 0.85) {
    const steps = buildFlowSteps(bestFlow, uiMap.elements);
    const confidence = Math.min(0.98, 0.8 + bestFlow.historicalSuccessRate * 0.2);
    return {
      intent,
      strategy: "verified_flow",
      confidence,
      steps,
      explanation: `Used verified flow "${bestFlow.goal}" because it matches intent, URL pattern, role, and has strong historical success.`,
      ...confidenceMode(confidence),
    };
  }

  const graph = createGraphFromUIMap(uiMap);
  const bestPath = findBestPath(graph, uiMap, intent, bestFlow);
  const ranked = rankCandidatePaths(graph, uiMap, intent, bestFlow);
  const scored = scoreVisibleElements(uiMap.elements, intent, uiMap, userContext, bestFlow);
  const primary = scored[0];

  if (!primary || primary.score < 0.6) {
    return {
      intent,
      strategy: "clarify",
      confidence: primary?.score || 0,
      steps: [],
      explanation:
        "No reliable deterministic match found on this page. Asking clarification to avoid a wrong recommendation.",
      ...confidenceMode(primary?.score || 0),
    };
  }

  const bestEdgeReason = bestPath.edge?.reason || "Best-ranked reachable UI action from current state graph.";
  const alternatives = ranked.slice(1, 3).map((p) => p.element.label || p.element.selector).join(", ");
  const step = toStep(
    primary.element,
    primary.score,
    `${primary.reason} Graph reasoning: ${bestEdgeReason}. Alternatives considered: ${alternatives || "none"}.`,
  );
  const confidence = Math.max(primary.score, bestPath.score);

  return {
    intent,
    strategy: "action_graph",
    confidence,
    steps: [step],
    explanation: "Selected using deterministic element scoring plus action-graph reliability ranking.",
    ...confidenceMode(confidence),
  };
}

