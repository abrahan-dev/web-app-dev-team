import type { AgentRunner } from "../../src/application/ports/agent-runner.ts";
import type { RepositoryWorkflow } from "../../src/application/ports/repository-workflow.ts";
import type {
  SpecificationJournal,
  WorkspaceBootstrapper,
} from "../../src/application/ports/development-services.ts";
import type { SpecificationReviewer } from "../../src/application/ports/specification-reviewer.ts";
import { AutomaticSpecificationReviewer } from "../../src/application/ports/specification-reviewer.ts";
import { runDevelopmentTeam } from "../../src/application/development/run-development-team.ts";
import type { RunState } from "../../src/domain/schemas.ts";
import { ScriptedAgentRunner } from "../../src/infrastructure/agents/scripted/scripted-agent-runner.ts";
import { developmentServices } from "../../src/infrastructure/development-services.ts";
import { FileSpecificationJournal } from "../../src/infrastructure/persistence/file-specification-journal.ts";
import { createRunState } from "../../src/infrastructure/persistence/file-run-store.ts";
import { DeterministicWorkspaceBootstrapper } from "../../src/infrastructure/workspace/workspace-bootstrapper.ts";
import type { TemporaryWorkspaceManager } from "./temporary-workspaces.ts";

export class DevelopmentTeamHarness {
  private runner: AgentRunner = new ScriptedAgentRunner();
  private reviewer: SpecificationReviewer = new AutomaticSpecificationReviewer();
  private journal: SpecificationJournal = new FileSpecificationJournal();
  private bootstrapper: WorkspaceBootstrapper = new DeterministicWorkspaceBootstrapper();
  private repositoryWorkflow?: RepositoryWorkflow;

  private constructor(readonly runDirectory: string) {}

  static async create(
    temporary: TemporaryWorkspaceManager,
    maxTurns = 12,
  ): Promise<DevelopmentTeamHarness> {
    const workspace = await temporary.createApplication();
    const created = await createRunState({
      prompt: "Build a small feature",
      workspace,
      runsRoot: workspace,
      maxTurns,
    });

    return new DevelopmentTeamHarness(created.runDirectory);
  }

  withRunner(runner: AgentRunner): this {
    this.runner = runner;

    return this;
  }

  withReviewer(reviewer: SpecificationReviewer): this {
    this.reviewer = reviewer;

    return this;
  }

  withJournal(journal: SpecificationJournal): this {
    this.journal = journal;

    return this;
  }

  withBootstrapper(bootstrapper: WorkspaceBootstrapper): this {
    this.bootstrapper = bootstrapper;

    return this;
  }

  withRepositoryWorkflow(repositoryWorkflow: RepositoryWorkflow): this {
    this.repositoryWorkflow = repositoryWorkflow;

    return this;
  }

  run(): Promise<RunState> {
    return runDevelopmentTeam(
      this.runner,
      this.runDirectory,
      this.reviewer,
      this.journal,
      developmentServices,
      this.bootstrapper,
      this.repositoryWorkflow,
    );
  }
}
