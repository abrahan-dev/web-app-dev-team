import type { RunState, SpecifierTurn, SpecificationReviewDecision } from "../../domain/schemas.ts";
import { SpecificationReviewDecision as ReviewDecision } from "../../domain/workflow-values.ts";

export interface SpecificationReviewContext {
  state: RunState;
  specification: SpecifierTurn;
}

export interface SpecificationReviewer {
  review(context: SpecificationReviewContext): Promise<SpecificationReviewDecision>;
}

export class AutomaticSpecificationReviewer implements SpecificationReviewer {
  review(): Promise<SpecificationReviewDecision> {
    return Promise.resolve({ decision: ReviewDecision.Approved, feedback: null });
  }
}
