import type {
  ChangePlan,
  Handoff,
  LocalCheck,
  PublishedSpecification,
  Role,
  RunState,
  SpecificationReview,
  SpecifierTurn,
  TokenUsage,
  WorkspaceBootstrap,
} from "../../domain/schemas.ts";

export interface WorkspaceFacts {
  workspace: string;
  packageManager: "bun" | "npm" | "pnpm" | "yarn" | "unknown";
  scripts: Record<string, string>;
  sourceRoots: string[];
  testRoots: string[];
  topLevelDirectories: string[];
  configFiles: string[];
  architectureBaseline: string[];
}

export interface RunRepository {
  load(runDirectory: string): Promise<RunState>;
  save(runDirectory: string, state: RunState): Promise<void>;
}

export interface PublishSpecificationRequest {
  workspace: string;
  sourceReviewId: string;
  specification: SpecifierTurn;
}

export interface SpecificationJournal {
  publish(request: PublishSpecificationRequest): Promise<PublishedSpecification>;
  verify(workspace: string): Promise<void>;
}

export interface WorkspaceBootstrapper {
  bootstrap(workspace: string, plan: ChangePlan): Promise<WorkspaceBootstrap>;
}

export interface WorkspaceInventory {
  load(workspace: string, runDirectory: string): Promise<WorkspaceFacts>;
  refresh(workspace: string, runDirectory: string): Promise<WorkspaceFacts>;
}

export interface QualityGateOptions {
  workspace: string;
  facts: WorkspaceFacts;
  changedFiles: string[];
  turn: number;
  sequence: number;
  role: Role;
  runBrowserTests?: boolean;
  runScripts?: boolean;
  runCoverage?: boolean;
}

export interface QualityGate {
  run(options: QualityGateOptions): Promise<LocalCheck>;
}

export interface OperatorLog {
  turnStarted(runDirectory: string, state: RunState, role: Role): Promise<void>;
  turnCompleted(
    runDirectory: string,
    state: RunState,
    role: Role,
    usage: TokenUsage | null,
  ): Promise<void>;
  humanReviewRequested(runDirectory: string, specification: SpecifierTurn): Promise<void>;
  specificationReview(runDirectory: string, review: SpecificationReview): Promise<void>;
  handoff(runDirectory: string, message: Handoff): Promise<void>;
  runFailure(
    runDirectory: string,
    state: RunState,
    role: Role | null,
    failure: string,
  ): Promise<void>;
  localCheck(runDirectory: string, state: RunState, check: LocalCheck): Promise<void>;
  workspaceBootstrap(
    runDirectory: string,
    state: RunState,
    bootstrap: WorkspaceBootstrap,
  ): Promise<void>;
}

export interface DevelopmentServices {
  runRepository: RunRepository;
  workspaceInventory: WorkspaceInventory;
  qualityGate: QualityGate;
  operatorLog: OperatorLog;
}
