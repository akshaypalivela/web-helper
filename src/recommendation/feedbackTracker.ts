import type { FeedbackEvent, IntentName, RecommendationStep } from "./types";

interface IntentFeedbackStats {
  attempts: number;
  completions: number;
}

export class FeedbackTracker {
  private events: FeedbackEvent[] = [];
  private stats: Record<IntentName, IntentFeedbackStats> = {
    invite_user: { attempts: 0, completions: 0 },
    create_project: { attempts: 0, completions: 0 },
    update_billing: { attempts: 0, completions: 0 },
    change_password: { attempts: 0, completions: 0 },
    manage_team: { attempts: 0, completions: 0 },
    export_report: { attempts: 0, completions: 0 },
    book_resource: { attempts: 0, completions: 0 },
    contact_support: { attempts: 0, completions: 0 },
    unknown: { attempts: 0, completions: 0 },
  };

  record(event: FeedbackEvent): void {
    this.events.push(event);
    const intent = event.detectedIntent.name;
    this.stats[intent].attempts += 1;
    if (event.completed) this.stats[intent].completions += 1;
  }

  listEvents(): FeedbackEvent[] {
    return [...this.events];
  }

  getSuccessRateByIntent(intent: IntentName): number {
    const stat = this.stats[intent];
    if (!stat || stat.attempts === 0) return 0;
    return stat.completions / stat.attempts;
  }

  static buildFeedbackEvent(params: {
    prompt: string;
    detectedIntent: FeedbackEvent["detectedIntent"];
    selectedPath: RecommendationStep[];
    completed: boolean;
    dropOffStep?: number;
    userFeedback?: string;
  }): FeedbackEvent {
    return {
      prompt: params.prompt,
      detectedIntent: params.detectedIntent,
      selectedPath: params.selectedPath,
      completed: params.completed,
      dropOffStep: params.dropOffStep,
      userFeedback: params.userFeedback,
      timestamp: new Date().toISOString(),
    };
  }
}

