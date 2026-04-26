import type {
  ActionGraphEdge,
  ActionGraphNode,
  IntentResult,
  UIElement,
  UIMap,
  VerifiedFlow,
} from "./types";

export interface ActionGraph {
  nodes: ActionGraphNode[];
  edges: ActionGraphEdge[];
}

function stateNodeId(uiMap: UIMap): string {
  return `state:${uiMap.currentUrl}`;
}

export function createGraphFromUIMap(uiMap: UIMap): ActionGraph {
  const rootNode: ActionGraphNode = {
    id: stateNodeId(uiMap),
    type: "ui_state",
    label: uiMap.pageTitle || uiMap.currentUrl,
  };

  const elementNodes: ActionGraphNode[] = uiMap.elements.map((el) => ({
    id: `element:${el.id}`,
    type: "element",
    label: el.label || el.selector,
    elementId: el.id,
  }));

  const edges: ActionGraphEdge[] = uiMap.elements.map((el) => ({
    id: `edge:${rootNode.id}->element:${el.id}`,
    from: rootNode.id,
    to: `element:${el.id}`,
    action: el.role === "input" ? "type" : "click",
    cost: el.visible ? 1 : 3,
    reliability: el.visible ? 0.8 : 0.3,
    reason: `Direct interaction with ${el.label || el.selector}`,
  }));

  return { nodes: [rootNode, ...elementNodes], edges };
}

function scoreElementForGoal(element: UIElement, intent: IntentResult, flow?: VerifiedFlow): number {
  const label = (element.label || "").toLowerCase();
  const goal = intent.normalizedGoal;
  const goalTokens = goal.split(" ").filter((t) => t.length > 2);
  const tokenHits = goalTokens.filter((token) => label.includes(token)).length;
  const tokenScore = goalTokens.length > 0 ? tokenHits / goalTokens.length : 0;
  const roleBoost = element.role === "nav_item" || element.role === "button" ? 0.15 : 0.05;
  const flowBoost = flow ? flow.historicalSuccessRate * 0.25 : 0;
  const visibleBoost = element.visible ? 0.2 : 0;
  return Math.max(0, Math.min(1, tokenScore + roleBoost + flowBoost + visibleBoost));
}

export function rankCandidatePaths(
  graph: ActionGraph,
  uiMap: UIMap,
  intent: IntentResult,
  flow?: VerifiedFlow,
): Array<{ nodeId: string; score: number; element: UIElement }> {
  const byId = new Map(uiMap.elements.map((el) => [el.id, el]));
  return graph.nodes
    .filter((n) => n.type === "element" && n.elementId)
    .map((n) => {
      const element = byId.get(n.elementId as string);
      if (!element) return null;
      return {
        nodeId: n.id,
        score: scoreElementForGoal(element, intent, flow),
        element,
      };
    })
    .filter((v): v is { nodeId: string; score: number; element: UIElement } => Boolean(v))
    .sort((a, b) => b.score - a.score);
}

export function findBestPath(
  graph: ActionGraph,
  uiMap: UIMap,
  intent: IntentResult,
  flow?: VerifiedFlow,
): { edge: ActionGraphEdge | null; score: number } {
  const ranked = rankCandidatePaths(graph, uiMap, intent, flow);
  if (!ranked.length) return { edge: null, score: 0 };
  const best = ranked[0];
  const edge = graph.edges.find((e) => e.to === best.nodeId) || null;
  return { edge, score: best.score };
}

