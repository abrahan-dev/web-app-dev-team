import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { agentRolesRoot, communicationStandardPath } from "../../package-paths.ts";
import type { AgentContext } from "../../application/ports/agent-runner.ts";
import { describeStackCatalog } from "../configuration/stack-catalog.ts";
import type { AgentTurn, Handoff, SpecificationReview } from "../../domain/schemas.ts";
import { Role } from "../../domain/roles.ts";
import {
  RunStatus,
  SpecificationReviewDecision,
  TurnDecision,
} from "../../domain/workflow-values.ts";
import { transitionDescription } from "../../domain/workflow.ts";
import { activeQualityFailure } from "../../application/development/quality-feedback.ts";
import { describeWorkspaceFacts, loadWorkspaceFacts } from "../workspace/workspace-inspector.ts";

export function roleInstructionsPath(role: Role): string {
  return resolve(agentRolesRoot, `${role}.md`);
}

export function loadRoleInstructions(role: Role): Promise<string> {
  return readFile(roleInstructionsPath(role), "utf8");
}

export function loadCommunicationStandard(): Promise<string> {
  return readFile(communicationStandardPath, "utf8");
}

export interface RoleExecutionMetadata {
  roleTurn: number;
  initialRoleTurn: boolean;
  newCodexSession: boolean;
  codexSessionResumed: boolean;
  recoveryAttempt: boolean;
  routedCorrection: boolean;
  consecutiveQualityFailures: number;
  previousRoleInterruption: string | null;
}

export function consecutiveQualityFailures(context: AgentContext): number {
  if (![Role.DataEngineer, Role.BackendCoder, Role.FrontendCoder].includes(context.role)) {
    return 0;
  }

  const assignment = context.state.messages.findLast((message) => message.to === context.role);
  const checks = context.state.localChecks.filter(
    (check) =>
      check.role === context.role &&
      check.kind === "quality-gate" &&
      (!assignment || check.createdAt > assignment.createdAt),
  );
  let failures = 0;

  for (const check of checks.toReversed()) {
    if (check.passed) {
      break;
    }

    failures += 1;
  }

  return failures;
}

export function roleExecutionMetadata(
  context: AgentContext,
  codexSessionResumed: boolean,
): RoleExecutionMetadata {
  const roleExecutions = context.state.executions.filter(
    (execution) => execution.role === context.role,
  );
  const recoveryAttempt = roleExecutions.at(-1)?.status === RunStatus.Failed;
  const interruption = context.state.interruptions.findLast(
    (candidate) => candidate.role === context.role,
  );
  const latestAssignment = context.state.messages.findLast(
    (message) => message.to === context.role,
  );
  const roleTurn = roleExecutions.length + 1;
  const routedCorrection =
    roleTurn > 1 &&
    latestAssignment !== undefined &&
    (latestAssignment.from === Role.Qa || latestAssignment.from === Role.Architect);

  return {
    roleTurn,
    initialRoleTurn: roleTurn === 1 && !recoveryAttempt,
    newCodexSession: !codexSessionResumed,
    codexSessionResumed,
    recoveryAttempt,
    routedCorrection,
    consecutiveQualityFailures: consecutiveQualityFailures(context),
    previousRoleInterruption: interruption
      ? `turn ${interruption.turn}: ${interruption.reason}`
      : null,
  };
}

function describeRoleExecution(metadata: RoleExecutionMetadata): string {
  const yesNo = (value: boolean): string => (value ? "yes" : "no");

  return [
    `Role turn: ${metadata.roleTurn}`,
    `Initial role turn: ${yesNo(metadata.initialRoleTurn)}`,
    `New Codex session: ${yesNo(metadata.newCodexSession)}`,
    `Codex session resumed: ${yesNo(metadata.codexSessionResumed)}`,
    `Recovery attempt: ${yesNo(metadata.recoveryAttempt)}`,
    `Routed correction: ${yesNo(metadata.routedCorrection)}`,
    `Consecutive quality failures: ${metadata.consecutiveQualityFailures}`,
    `Previous role interruption: ${metadata.previousRoleInterruption ?? "none"}`,
  ].join("\n");
}

function list(values: string[], separator = "; "): string {
  return values.join(separator) || "none";
}

function describeSpecifier(turn: Extract<AgentTurn, { role: Role.Specifier }>): string {
  return [`Assumptions: ${list(turn.assumptions)}`, `Out of scope: ${list(turn.outOfScope)}`].join(
    "\n",
  );
}

function describeArchitect(
  turn: Extract<AgentTurn, { role: Role.Architect }>,
  recipient: Role,
): string {
  const plan = [
    `Application: ${turn.changePlan.applicationName}`,
    `Contexts: ${list(turn.changePlan.contexts, ", ")}`,
    `Persistence contexts: ${list(turn.changePlan.persistenceContexts, ", ")}`,
    `Required surfaces: data=${turn.changePlan.dataRequired}, backend=${turn.changePlan.backendRequired}, frontend=${turn.changePlan.frontendRequired}`,
  ];
  const design = `Design:\n${turn.design}`;
  const domain = `Domain model: ${list(turn.domainModel)}`;
  const api = `API contract: ${list(turn.apiContract)}`;
  const security = `Security: ${list(turn.security)}`;
  const constraints = `Constraints: ${list(turn.constraints)}`;
  const risks = `Risks: ${list(turn.risks)}`;
  const review = [
    `Architecture review: ${turn.reviewStatus}`,
    `Review findings: ${list(turn.reviewFindings)}`,
    `Review failure owner: ${turn.failureOwner ?? "none"}`,
  ];
  const sections: Record<Role, string[]> = {
    [Role.Specifier]: [design, domain, api, security, constraints, risks],
    [Role.Architect]: [design, domain, api, security, constraints, risks],
    [Role.UiDesigner]: [design, api],
    [Role.DataEngineer]: [domain, security, constraints, risks],
    [Role.BackendCoder]: [design, domain, api, security, constraints, risks],
    [Role.FrontendCoder]: [design, api, security, constraints, risks],
    [Role.Qa]: [design, domain, api, security, constraints, risks],
  };

  return [...plan, ...sections[recipient], ...review].join("\n");
}

function describeUiDesigner(turn: Extract<AgentTurn, { role: Role.UiDesigner }>): string {
  return [
    `Screens: ${list(turn.screens)}`,
    `Interactions: ${list(turn.interactions)}`,
    `States: ${list(turn.interfaceStates)}`,
    `Accessibility: ${list(turn.accessibility)}`,
  ].join("\n");
}

function describeDataEngineer(turn: Extract<AgentTurn, { role: Role.DataEngineer }>): string {
  return [
    `Schema changes: ${list(turn.schemaChanges)}`,
    `Migrations: ${list(turn.migrations)}`,
    `Mappings: ${list(turn.persistenceMappings)}`,
    `Tests: ${list(turn.tests)}`,
  ].join("\n");
}

function describeBackendCoder(turn: Extract<AgentTurn, { role: Role.BackendCoder }>): string {
  return [
    `Changes: ${list(turn.changes)}`,
    `Tests: ${list(turn.tests)}`,
    `API procedures: ${list(turn.apiProcedures)}`,
    `Domain decisions: ${list(turn.domainDecisions)}`,
  ].join("\n");
}

function describeFrontendCoder(turn: Extract<AgentTurn, { role: Role.FrontendCoder }>): string {
  return [
    `Changes: ${list(turn.changes)}`,
    `Tests: ${list(turn.tests)}`,
    `Screens: ${list(turn.screens)}`,
    `API usage: ${list(turn.apiUsage)}`,
  ].join("\n");
}

function describeQa(turn: Extract<AgentTurn, { role: Role.Qa }>): string {
  return [
    `Scenarios tested: ${list(turn.scenariosTested)}`,
    `Commands: ${list(turn.commands)}`,
    `Failures: ${list(turn.failures)}`,
  ].join("\n");
}

function describeDeliverable(message: Handoff, recipient: Role): string {
  switch (message.turn?.role) {
    case Role.Specifier:
      return describeSpecifier(message.turn);
    case Role.Architect:
      return describeArchitect(message.turn, recipient);
    case Role.UiDesigner:
      return describeUiDesigner(message.turn);
    case Role.DataEngineer:
      return describeDataEngineer(message.turn);
    case Role.BackendCoder:
      return describeBackendCoder(message.turn);
    case Role.FrontendCoder:
      return describeFrontendCoder(message.turn);
    case Role.Qa:
      return describeQa(message.turn);
    default:
      return "";
  }
}

function describeHandoff(message: Handoff, recipient: Role): string {
  if (message.turn === null) {
    return `#${message.sequence} user -> ${message.to}`;
  }

  return [
    `#${message.sequence} ${message.from} -> ${message.to ?? TurnDecision.Complete}`,
    `Summary: ${message.turn.summary}`,
    describeDeliverable(message, recipient),
    `Artifacts: ${message.turn.artifacts.join(", ") || "none"}`,
    `Evidence: ${message.turn.evidence.join("; ") || "none"}`,
    `Reason: ${message.turn.reason}`,
  ].join("\n");
}

function describeSpecificationReview(review: SpecificationReview): string {
  return [
    `Feature ID: ${review.specification.featureId}`,
    `Specification:\n${review.specification.specification}`,
    `Assumptions: ${review.specification.assumptions.join("; ") || "none"}`,
    `Out of scope: ${review.specification.outOfScope.join("; ") || "none"}`,
    `Human decision: ${review.decision}`,
    `Human feedback: ${review.feedback ?? "none"}`,
    `Published artifact: ${review.publishedSpecification?.path ?? "none"}`,
  ].join("\n");
}

function latestHandoffFrom(state: AgentContext["state"], role: Role): Handoff | undefined {
  return state.messages.findLast((message) => message.turn?.role === role);
}

function previousArchitectRequestedChanges(state: AgentContext["state"]): boolean {
  const turn = latestHandoffFrom(state, Role.Architect)?.turn;

  return turn?.role === Role.Architect && turn.reviewStatus === "changes-requested";
}

function relevantHandoffs(context: AgentContext): Handoff[] {
  const { role, state } = context;
  const latestAddressedToRole = state.messages.findLast((message) => message.to === role);
  const candidates =
    role === Role.Specifier
      ? [latestHandoffFrom(state, Role.Architect)]
      : role === Role.Architect
        ? state.architectureReviewStatus === "pending"
          ? previousArchitectRequestedChanges(state)
            ? [latestHandoffFrom(state, Role.Architect), latestAddressedToRole]
            : [
                latestHandoffFrom(state, Role.Architect),
                latestHandoffFrom(state, Role.DataEngineer),
                latestHandoffFrom(state, Role.BackendCoder),
                latestHandoffFrom(state, Role.FrontendCoder),
                latestAddressedToRole,
              ]
          : [latestHandoffFrom(state, Role.Specifier), latestAddressedToRole]
        : role === Role.UiDesigner
          ? [latestHandoffFrom(state, Role.Architect), latestHandoffFrom(state, Role.Qa)]
          : role === Role.DataEngineer
            ? [latestHandoffFrom(state, Role.Architect), latestHandoffFrom(state, Role.Qa)]
            : role === Role.BackendCoder
              ? [
                  latestHandoffFrom(state, Role.Architect),
                  latestHandoffFrom(state, Role.DataEngineer),
                  latestHandoffFrom(state, Role.Qa),
                ]
              : role === Role.FrontendCoder
                ? [
                    latestHandoffFrom(state, Role.Architect),
                    latestHandoffFrom(state, Role.UiDesigner),
                    latestHandoffFrom(state, Role.BackendCoder),
                    latestHandoffFrom(state, Role.Qa),
                  ]
                : [
                    latestHandoffFrom(state, Role.DataEngineer),
                    latestHandoffFrom(state, Role.BackendCoder),
                    latestHandoffFrom(state, Role.FrontendCoder),
                  ];

  return candidates.filter(
    (message, index, all): message is Handoff =>
      message !== undefined && all.findIndex((item) => item?.id === message.id) === index,
  );
}

function relevantReview(context: AgentContext): string {
  const decision =
    context.role === Role.Specifier
      ? SpecificationReviewDecision.ChangesRequested
      : SpecificationReviewDecision.Approved;
  const review = context.state.specificationReviews.findLast(
    (candidate) => candidate.decision === decision,
  );

  if (!review) {
    return "none";
  }

  if (context.role === Role.Specifier) {
    return describeSpecificationReview(review);
  }

  return [
    `Feature ID: ${review.specification.featureId}`,
    `Human decision: ${review.decision}`,
    `Human feedback: ${review.feedback ?? "none"}`,
    `Published artifact: ${review.publishedSpecification?.path ?? "none"}`,
  ].join("\n");
}

function approvedArtifact(state: AgentContext["state"]): string {
  const specification =
    state.targetSpecification ??
    state.specificationReviews.findLast(
      (review) => review.decision === SpecificationReviewDecision.Approved,
    )?.publishedSpecification;

  return specification
    ? `${specification.path}\nSHA-256: ${specification.sha256}\nSequence: ${specification.sequence}`
    : "none";
}

function interruptionSummary(context: AgentContext): string {
  return (
    context.state.interruptions
      .filter((interruption) => interruption.role === context.role)
      .slice(-1)
      .map(
        (interruption) =>
          `#${interruption.sequence} ${interruption.role} turn ${interruption.turn}: ${interruption.reason}\nLog: ${interruption.logPath}`,
      )
      .join("\n\n") || "none"
  );
}

function localFeedbackSummary(context: AgentContext): string {
  const check = activeQualityFailure(context.state, context.role);

  const feedback = check
    ? [
        `${check.kind}: ${check.summary}`,
        ...(check.findings?.length
          ? check.findings.map(
              ({ code, owner, file, metric, actual, required, message }) =>
                `- ${code}; owner=${owner}; file=${file ?? "none"}; metric=${metric ?? "none"}; actual=${actual ?? "none"}; required=${required ?? "none"}. ${message}`,
            )
          : check.details.map((detail) => `- ${detail}`)),
      ].join("\n")
    : "";

  if (!feedback) {
    return "none";
  }

  if (context.role !== Role.Qa) {
    return feedback;
  }

  return `MANDATORY QA FAILURE ROUTING:
The controller rejected the previous QA completion.
Do not return complete while this local check remains failed.
Do not change implementation code.
Use the failed paths and diagnostics to select one responsible role.
Return a handoff with concrete failures. Set failureOwner and nextRole to that role.

${feedback}`;
}

function escalatedQualityBlocker(context: AgentContext): string | null {
  if (context.role !== Role.Architect) {
    return null;
  }

  const handoff = context.state.messages.findLast(
    (message) =>
      message.to === Role.Architect &&
      message.turn !== null &&
      [Role.DataEngineer, Role.BackendCoder, Role.FrontendCoder].includes(message.from as Role) &&
      /architect must resolve this blocker/iu.test(message.turn.reason),
  );

  return handoff?.turn?.reason ?? null;
}

function deterministicVerificationSummary(context: AgentContext): string {
  const check = context.state.localChecks.findLast(
    (candidate) => candidate.kind === "quality-gate" && candidate.passed,
  );

  if (!check) {
    return "none";
  }

  return [
    `Turn ${check.turn}; role ${check.role}: ${check.summary}`,
    ...check.commands.map(({ command, exitCode }) => `- ${command}: exit ${exitCode}`),
  ].join("\n");
}

function bootstrapSummary(state: AgentContext["state"]): string {
  const bootstrap = state.workspaceBootstrap;

  return bootstrap
    ? `${bootstrap.status}: ${bootstrap.reason}\nTemplate: ${bootstrap.template} v${bootstrap.templateVersion}\nCreated files: ${list(bootstrap.createdFiles, ", ")}\nCommands: ${list(
        bootstrap.commands.map(({ command, exitCode }) => `${command} (exit ${exitCode})`),
        ", ",
      )}`
    : "not evaluated yet";
}

function restitutionRules(state: AgentContext["state"]): string {
  return state.mode === "restitution"
    ? `\nRestitution rules:\n- Implement only specification sequence ${state.targetSpecification?.sequence}.\n- Later specification files may exist, but must not influence this sequence.\n- The specification is already human-approved and immutable; never hand off to the specifier.\n- QA completion commits the restitution checkpoint and permits the next sequence to start.\n`
    : "";
}

function resolvedStack(role: Role): string {
  return role === Role.Architect
    ? `
Resolved stack catalog for new projects:
${describeStackCatalog()}

Version rules:
- For a new project, use the exact catalog versions.
- For an existing project, use its package.json and lockfile versions.
- Do not update a dependency unless the task requires the update.
`
    : "";
}

function architectureTask(context: AgentContext): string {
  if (context.role !== Role.Architect) {
    return "not applicable";
  }

  const previousReview = context.state.messages.findLast(
    (message) =>
      message.turn?.role === Role.Architect && message.turn.reviewStatus === "changes-requested",
  );

  const blocker = escalatedQualityBlocker(context);

  if (blocker) {
    return `escalated deterministic quality blocker
- Resolve this blocker before you route another finding.
- Do not mark the blocker as resolved without a passing deterministic check or a concrete correction.
- Blocker: ${blocker}`;
  }

  return context.state.architectureReviewStatus === "pending"
    ? previousReview
      ? `incremental implementation review
- Verify each previous finding first.
- Inspect the latest correction diff and its cited files.
- Do not repeat a full repository review unless the correction changed architecture boundaries.
- Approve QA or return only unresolved or new findings to one implementation failure owner.`
      : `implementation review
- Inspect the completed implementation against the approved specification and architecture plan.
- Approve QA or return concrete findings to one implementation failure owner.`
    : "technical planning";
}

function recentChangedFiles(context: AgentContext): string {
  const files = context.state.executions
    .filter((execution) => execution.role !== context.role)
    .slice(-3)
    .flatMap((execution) => execution.changedFiles);

  return [...new Set(files)].sort().join(", ") || "none";
}

export async function buildAgentPrompt(
  context: AgentContext,
  execution = roleExecutionMetadata(context, false),
): Promise<string> {
  const { role, state } = context;
  const [roleInstructions, communicationStandard] = await Promise.all([
    loadRoleInstructions(role),
    loadCommunicationStandard(),
  ]);
  const facts = await loadWorkspaceFacts(state.workspace, context.runDirectory);
  const history =
    relevantHandoffs(context)
      .map((handoff) => describeHandoff(handoff, role))
      .join("\n\n") || "none";
  const correctionHandoff = state.messages.findLast((message) => message.to === role);
  const correctionHistory = correctionHandoff ? describeHandoff(correctionHandoff, role) : "none";
  const deterministicCorrection = activeQualityFailure(state, role);
  const correctionAssignment = deterministicCorrection
    ? `Previous assignment context:
${correctionHistory}

Active deterministic assignment:
${localFeedbackSummary(context)}`
    : `Active routed assignment:
${correctionHistory}`;
  const correctionPriorityRule = deterministicCorrection
    ? "- Follow the active deterministic assignment. It supersedes conflicting previous assignment context."
    : "- Follow the active routed assignment.";

  if (execution.routedCorrection || execution.consecutiveQualityFailures >= 1) {
    return `You are the ${role} in a specialized web application development team.

This is a focused correction assignment. Read only the files required by the current findings.

Task from the user:
${state.prompt}

Role execution:
${describeRoleExecution(execution)}

Workspace:
${state.workspace}

Deterministic workspace inventory:
${describeWorkspaceFacts(facts)}

Recent deterministic changed files:
${recentChangedFiles(context)}

Your responsibility:
${roleInstructions}

Required communication standard:
${communicationStandard}

${correctionAssignment}

Latest approved specification artifact:
${approvedArtifact(state)}

Rules:
- Correct only the current findings.
${correctionPriorityRule}
- Read the approved specification only when a finding requires functional context.
- Use workspace-relative paths for all file edits.
- Do not run Git commands.
- Use focused checks while you edit.
- Do not run full workspace format, lint, typecheck, test, coverage, build, or browser scripts.
- Do not run the deterministic role check. The controller runs it after the handoff.
- Do not start a local development server.
- Run one inspection or check in each shell command.
- Use a separate tool call for each format, test, typecheck, and lint command.
- Never place another program name after a command's file arguments.
- Inspect each command output before you report that the command passed.
- Never claim a command passed unless you ran it and saw it pass.
- Stop work immediately after the current findings pass focused checks.
- Do not add optional cleanup, refactors, tests, or features after the findings pass.
- Treat Bun coverage thresholds as per-file thresholds, not only aggregate thresholds.
- Do not add a coverage ignore without a browser-only justification in the same comment.
- Do not reduce or remove a configured coverage threshold during a correction.
- The final response must match the supplied JSON schema.
- decision=handoff requires a legal nextRole.
`;
  }

  return `You are the ${role} in a specialized web application development team.

Task from the user:
${state.prompt}

Role execution:
${describeRoleExecution(execution)}

Architecture task:
${architectureTask(context)}

Workspace:
${state.workspace}

Deterministic workspace inventory:
${describeWorkspaceFacts(facts)}

Recent deterministic changed files:
${recentChangedFiles(context)}

Deterministic workspace bootstrap:
${bootstrapSummary(state)}
${resolvedStack(role)}

Your responsibility:
${roleInstructions}

Required communication standard:
${communicationStandard}

Deterministic workflow (no other transition is legal):
${transitionDescription(state.mode)}
${restitutionRules(state)}

Role-relevant handoffs:
${history}

Latest relevant human specification review:
${relevantReview(context)}

Latest approved specification artifact:
${approvedArtifact(state)}

Previous interrupted attempts:
${interruptionSummary(context)}

Latest failed local check for this role:
${localFeedbackSummary(context)}

Latest passed deterministic verification:
${deterministicVerificationSummary(context)}

Rules:
- Work on the task now using the tools available in this workspace.
- Use workspace-relative paths for all file edits.
- Do not pass an absolute path to a file-edit tool.
- Do not run Git commands. The deterministic repository workflow owns Git operations.
- Use focused checks while you edit.
- Do not run full workspace format, lint, typecheck, test, coverage, build, or browser scripts.
- Do not run the deterministic role check. The controller runs it after a coder handoff.
- Do not run coverage during a coder turn. The controller runs role-scoped coverage.
- The controller checks only the code owned by this role after a coder turn.
- Bun coverage thresholds apply to each measured file, not only to the aggregate result.
- A source file with runtime code must appear in coverage or have a justified browser-only ignore.
- A coverage ignore must include a browser-only justification in the same comment.
- QA runs the full workspace scripts and assigns each failure to its responsible role.
- Do not start a local development server. The controller runs browser tests outside the agent sandbox.
- Run one inspection or check in each shell command.
- Use a separate tool call for each format, test, typecheck, and lint command.
- Never place another program name after a command's file arguments.
- Inspect each command output before you report that the command passed.
- A partial read is not proof for an unread file or unread command output.
- Use exact paths from the deterministic inventory. Do not guess generated file names.
- Inspect node_modules only when a focused compiler error requires exact dependency behavior.
- The fixed product stack is TypeScript, Bun, tRPC, Zod, Drizzle ORM with bun:sqlite, React and Playwright.
- Keep every dependency at one exact version. Do not use latest, caret, or tilde ranges.
- Domain and application code lives under src/contexts; deployable applications live under src/apps/<application-name>/backend or frontend.
- Treat prior summaries as context, but verify claims from files and commands.
- After an interrupted attempt, inspect the current workspace and cited log before deciding what remains; partial edits may already exist.
- Keep the scope to one cohesive feature slice.
- Never claim a command passed unless you ran it and saw it pass.
- The final response must match the supplied JSON schema.
- Populate every role-specific deliverable field with concrete, reviewable content.
- When an approved specification artifact is present, read that workspace file and treat it as the authoritative functional contract.
- decision=handoff requires a legal nextRole.
- decision=complete is legal only for QA and requires nextRole=null.
- artifacts are workspace-relative paths you created, changed, or reviewed.
- evidence contains concise commands, test results, or observable facts.
`;
}
