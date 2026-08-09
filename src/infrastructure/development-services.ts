import type { DevelopmentServices } from "../application/ports/development-services.ts";
import {
  recordHandoff,
  recordHumanReviewRequested,
  recordLocalCheck,
  recordRunFailure,
  recordSpecificationReview,
  recordTurnCompleted,
  recordTurnStarted,
  recordWorkspaceBootstrap,
} from "./observability/operator-log.ts";
import { loadRunState, saveRunState } from "./persistence/file-run-store.ts";
import { runQualityGate } from "./quality/quality-gate.ts";
import { loadWorkspaceFacts, refreshWorkspaceFacts } from "./workspace/workspace-inspector.ts";

export const developmentServices: DevelopmentServices = {
  runRepository: {
    load: loadRunState,
    save: saveRunState,
  },
  workspaceInventory: {
    load: loadWorkspaceFacts,
    refresh: refreshWorkspaceFacts,
  },
  qualityGate: {
    run: runQualityGate,
  },
  operatorLog: {
    turnStarted: recordTurnStarted,
    turnCompleted: recordTurnCompleted,
    humanReviewRequested: recordHumanReviewRequested,
    specificationReview: recordSpecificationReview,
    handoff: recordHandoff,
    runFailure: recordRunFailure,
    localCheck: recordLocalCheck,
    workspaceBootstrap: recordWorkspaceBootstrap,
  },
};
