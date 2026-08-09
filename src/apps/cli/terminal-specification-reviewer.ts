import { createInterface } from "node:readline/promises";
import type { SpecificationReviewDecision } from "../../domain/schemas.ts";
import { SpecificationReviewDecision as ReviewDecision } from "../../domain/workflow-values.ts";
import type {
  SpecificationReviewContext,
  SpecificationReviewer,
} from "../../application/ports/specification-reviewer.ts";
import type { CommandRunner } from "../../infrastructure/terminal/tmux.ts";

type Ask = (prompt: string) => Promise<string>;

function printList(title: string, values: string[]): void {
  if (values.length > 0) {
    console.log(`\n${title}:\n- ${values.join("\n- ")}`);
  }
}

function renderReview({ specification, state }: SpecificationReviewContext): void {
  const tokens = new Intl.NumberFormat("en-US").format(state.tokenTotals.team.totalTokens);
  console.log("\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  console.log(`HUMAN REVIEW  ·  TURN ${state.turns}/${state.maxTurns}  ·  TEAM TOKENS ${tokens}`);
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  console.log(`\nFeature: ${specification.featureId}`);
  console.log(`\n${specification.specification}`);
  printList("Assumptions", specification.assumptions);
  printList("Out of scope", specification.outOfScope);
  printList("Acceptance evidence", specification.evidence);
  console.log(`\nProposed handoff: ${specification.reason}\n`);
}

async function askForDecision(ask: Ask): Promise<SpecificationReviewDecision> {
  while (true) {
    const answer = (await ask("Approve specification or request changes? [a/c]: "))
      .trim()
      .toLowerCase();

    if (answer === "a" || answer === "approve") {
      return { decision: ReviewDecision.Approved, feedback: null };
    }

    if (answer === "c" || answer === "changes") {
      const feedback = (await ask("Describe the required changes: ")).trim();

      if (feedback) {
        return { decision: ReviewDecision.ChangesRequested, feedback };
      }

      console.log("Feedback cannot be empty.");
      continue;
    }

    console.log('Enter "a" to approve or "c" to request changes.');
  }
}

export class TerminalSpecificationReviewer implements SpecificationReviewer {
  constructor(
    private readonly commandRunner: CommandRunner,
    private readonly tmuxSession?: string,
    private readonly injectedAsk?: Ask,
  ) {}

  private async selectWindow(name: "agents" | "orchestrator"): Promise<void> {
    if (!this.tmuxSession) {
      return;
    }

    await this.commandRunner.run(["tmux", "select-window", "-t", `${this.tmuxSession}:${name}`]);
  }

  async review({
    specification,
    state,
  }: SpecificationReviewContext): Promise<SpecificationReviewDecision> {
    await this.selectWindow("orchestrator");
    renderReview({ specification, state });

    const readline = this.injectedAsk
      ? undefined
      : createInterface({ input: process.stdin, output: process.stdout });
    const ask = this.injectedAsk ?? ((prompt: string) => readline!.question(prompt));

    try {
      return await askForDecision(ask);
    } finally {
      readline?.close();
      await this.selectWindow("agents");
    }
  }
}
