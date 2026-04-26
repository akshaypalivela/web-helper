export type IntentName =
  | "invite_user"
  | "create_project"
  | "update_billing"
  | "change_password"
  | "manage_team"
  | "export_report"
  | "book_resource"
  | "contact_support"
  | "unknown";

export interface UserPrompt {
  rawText: string;
  locale?: string;
}

export interface IntentResult {
  name: IntentName;
  entities: string[];
  confidence: number;
  normalizedGoal: string;
}

export type ElementRole =
  | "button"
  | "link"
  | "input"
  | "nav_item"
  | "modal_action"
  | "table_action"
  | "unknown";

export interface ElementPosition {
  x: number;
  y: number;
  width: number;
  height: number;
}

export type UIRegion = "navigation" | "modal" | "table" | "main" | "sidebar" | "unknown";

export interface UIElement {
  id: string;
  selector: string;
  label: string;
  role: ElementRole;
  visible: boolean;
  position: ElementPosition;
  region: UIRegion;
  ariaLabel?: string;
  href?: string;
  inputType?: string;
  metadata?: Record<string, string | number | boolean>;
}

export interface UIMap {
  currentUrl: string;
  pageTitle: string;
  visibleText: string;
  buttons: UIElement[];
  links: UIElement[];
  inputs: UIElement[];
  navItems: UIElement[];
  modals: UIElement[];
  tables: UIElement[];
  elements: UIElement[];
  scannedAt: string;
}

export interface FlowStep {
  id: string;
  action: "click" | "type" | "select" | "navigate";
  selector: string;
  expectedLabel: string;
  expectedRole?: ElementRole;
  expectedRegion?: UIRegion;
  reason: string;
}

export interface VerifiedFlow {
  id: string;
  goal: string;
  intents: IntentName[];
  supportedUrlPatterns: RegExp[];
  requiredUserRole: string[];
  steps: FlowStep[];
  successCriteria: string[];
  historicalSuccessRate: number;
}

export interface ActionGraphNode {
  id: string;
  type: "ui_state" | "element";
  label: string;
  elementId?: string;
}

export interface ActionGraphEdge {
  id: string;
  from: string;
  to: string;
  action: "click" | "type" | "navigate";
  cost: number;
  reliability: number;
  reason: string;
}

export interface RecommendationStep {
  stepNumber: number;
  selector: string;
  label: string;
  action: "click" | "type" | "select" | "navigate";
  confidence: number;
  reason: string;
}

export interface PathRecommendation {
  intent: IntentResult;
  strategy: "verified_flow" | "action_graph" | "clarify";
  confidence: number;
  steps: RecommendationStep[];
  explanation: string;
  requiresConfirmation: boolean;
  clarifyingQuestion?: string;
}

export interface FeedbackEvent {
  prompt: string;
  detectedIntent: IntentResult;
  selectedPath: RecommendationStep[];
  completed: boolean;
  dropOffStep?: number;
  userFeedback?: string;
  timestamp: string;
}

export interface UserContext {
  role: string;
  historicalSuccessByIntent?: Partial<Record<IntentName, number>>;
}

export interface CandidateScoreBreakdown {
  textMatch: number;
  intentMatch: number;
  keywordMatch: number;
  visibility: number;
  roleWeight: number;
  positionWeight: number;
  userRoleCompatibility: number;
  historicalSuccess: number;
  regionWeight: number;
}

export interface ScoredElement {
  element: UIElement;
  score: number;
  breakdown: CandidateScoreBreakdown;
  reason: string;
}
