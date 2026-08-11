import { afterEach, describe, expect, test } from "bun:test";
import { readFile, writeFile } from "node:fs/promises";
import { basename, resolve } from "node:path";
import {
  buildAgentPrompt,
  loadCommunicationStandard,
  loadRoleInstructions,
  roleExecutionMetadata,
  roleInstructionsPath,
} from "../../../src/infrastructure/agents/prompt-builder.ts";
import { roles, type Handoff } from "../../../src/domain/schemas.ts";
import { Role } from "../../../src/domain/roles.ts";
import {
  RunStatus,
  SpecificationReviewDecision,
  TurnDecision,
} from "../../../src/domain/workflow-values.ts";
import {
  createRunState,
  saveRunState,
} from "../../../src/infrastructure/persistence/file-run-store.ts";
import { TemporaryWorkspaceManager } from "../../support/temporary-workspaces.ts";
import { publishedSpecificationFactory } from "../../support/domain-factories.ts";

const temporary = new TemporaryWorkspaceManager();

afterEach(async () => {
  await temporary.cleanup();
});

describe("role instructions", () => {
  for (const role of roles) {
    test(`loads readable Markdown for ${role}`, async () => {
      const instructions = await loadRoleInstructions(role);

      expect(basename(roleInstructionsPath(role))).toBe(`${role}.md`);
      expect(instructions).toStartWith("# ");
      expect(instructions.toLowerCase()).toContain(role.replace("-", " "));
      expect(instructions).toContain("## Responsibility");
      expect(instructions.trim().length).toBeGreaterThan(100);
    });
  }

  test("architect policy keeps the opinionated DDD boundaries explicit", async () => {
    const instructions = await loadRoleInstructions(Role.Architect);

    expect(instructions).toContain("Domain code never imports tRPC");
    expect(instructions).toContain("domain/repositories");
    expect(instructions).toContain("apps/<application-name>");
    expect(instructions).toContain("tRPC with the Fetch API");
    expect(instructions).toContain("Drizzle ORM");
  });

  test("UI designer policy keeps simple interactions compact", async () => {
    const instructions = await loadRoleInstructions(Role.UiDesigner);
    const normalized = instructions.replace(/\s+/g, " ");

    expect(instructions).toContain("Use breadcrumbs only when");
    expect(normalized).toContain("Do not create a route only to represent another state");
    expect(normalized).toContain("Do not inspect backend files unless");
    expect(normalized).toContain("Do not inspect tests during a normal initial UI design turn");
    expect(normalized).toContain("Do not repeat the complete behavior");
  });

  test("test-writing roles prioritize business rules and pure functions", async () => {
    for (const role of [Role.DataEngineer, Role.BackendCoder, Role.FrontendCoder, Role.Qa]) {
      const instructions = (await loadRoleInstructions(role)).toLowerCase();

      expect(instructions).toContain("business rules");
      expect(instructions).toContain("pure functions");
    }
  });

  test("loads the shared STE communication standard", async () => {
    const standard = await loadCommunicationStandard();

    expect(standard).toContain("ASD-STE100 Simplified Technical English");
    expect(standard).toContain("Use the active voice");
  });
});

test("projects role-specific context and caches the workspace inventory", async () => {
  const root = await temporary.create("web-app-dev-team-context-");
  await writeFile(
    resolve(root, "package.json"),
    JSON.stringify({ scripts: { test: "bun test", lint: "eslint ." } }),
  );
  const created = await createRunState({
    prompt: "Implement checkout",
    workspace: root,
    runsRoot: root,
    maxTurns: 12,
  });
  const handoffs = [
    {
      id: Role.Specifier,
      sequence: 1,
      from: Role.Specifier,
      to: Role.Architect,
      createdAt: new Date().toISOString(),
      turn: {
        role: Role.Specifier,
        featureId: "secret-old-spec",
        summary: "IRRELEVANT_SPECIFIER_HISTORY",
        specification: "Feature: Old",
        assumptions: ["KEEP_SPECIFIER_ASSUMPTION"],
        outOfScope: [],
        artifacts: [],
        evidence: [],
        decision: TurnDecision.Handoff,
        nextRole: Role.Architect,
        reason: "ready",
      },
    },
    {
      id: Role.Architect,
      sequence: 2,
      from: Role.Architect,
      to: Role.BackendCoder,
      createdAt: new Date().toISOString(),
      turn: {
        role: Role.Architect,
        summary: "LATEST_ARCHITECTURE",
        design: "Use a checkout aggregate.",
        changePlan: {
          applicationName: "operations",
          contexts: ["checkout"],
          persistenceContexts: [],
          dataRequired: false,
          backendRequired: true,
          frontendRequired: false,
        },
        domainModel: ["Checkout aggregate"],
        apiContract: ["checkout.submit mutation"],
        security: ["Authenticated actor"],
        constraints: [],
        risks: [],
        reviewStatus: "not-applicable",
        reviewFindings: [],
        failureOwner: null,
        artifacts: [],
        evidence: [],
        decision: TurnDecision.Handoff,
        nextRole: Role.BackendCoder,
        reason: "implement",
      },
    },
    {
      id: Role.UiDesigner,
      sequence: 3,
      from: Role.UiDesigner,
      to: Role.BackendCoder,
      createdAt: new Date().toISOString(),
      turn: {
        role: Role.UiDesigner,
        summary: "LATEST_UI_DESIGN",
        screens: ["Checkout"],
        interactions: ["Submit cart"],
        interfaceStates: ["Ready"],
        accessibility: ["Labeled controls"],
        artifacts: [],
        evidence: [],
        decision: TurnDecision.Handoff,
        nextRole: Role.BackendCoder,
        reason: "design ready",
      },
    },
    {
      id: Role.Qa,
      sequence: 4,
      from: Role.Qa,
      to: Role.BackendCoder,
      createdAt: new Date().toISOString(),
      turn: {
        role: Role.Qa,
        summary: "LATEST_QA_FEEDBACK",
        scenariosTested: [],
        commands: [],
        failures: ["Checkout rejects valid carts."],
        failureOwner: Role.BackendCoder,
        artifacts: [],
        evidence: [],
        decision: TurnDecision.Handoff,
        nextRole: Role.BackendCoder,
        reason: "fix",
      },
    },
  ] satisfies Handoff[];
  const specification = handoffs[0]?.turn;

  if (!specification || specification.role !== Role.Specifier) {
    throw new Error("The test specification handoff is invalid.");
  }

  created.state.currentRole = Role.BackendCoder;
  created.state.messages.push(...handoffs);
  created.state.specificationReviews.push({
    id: "review-1",
    createdAt: new Date().toISOString(),
    specification,
    decision: SpecificationReviewDecision.Approved,
    feedback: null,
    publishedSpecification: publishedSpecificationFactory(),
  });
  created.state.localChecks.push({
    sequence: 1,
    turn: 2,
    role: Role.FrontendCoder,
    kind: "quality-gate",
    createdAt: new Date().toISOString(),
    passed: true,
    summary: "Browser verification passed.",
    details: [],
    commands: [{ command: "bun run test:e2e", exitCode: 0, output: "7 passed" }],
  });
  await saveRunState(created.runDirectory, created.state);

  const prompt = await buildAgentPrompt({
    role: Role.BackendCoder,
    state: created.state,
    runDirectory: created.runDirectory,
  });

  expect(prompt).toContain("LATEST_ARCHITECTURE");
  expect(prompt).toContain("Required communication standard:");
  expect(prompt).toContain("ASD-STE100 Simplified Technical English");
  expect(prompt).toContain("Do not run Git commands");
  expect(prompt).toContain("Use workspace-relative paths for all file edits");
  expect(prompt).toContain("Do not pass an absolute path to a file-edit tool");
  expect(prompt).toContain("Use focused checks while you edit");
  expect(prompt).toContain("The controller runs it after a coder handoff");
  expect(prompt).not.toContain("role-check --workspace");
  expect(prompt).toContain("Do not run full workspace format, lint, typecheck, test");
  expect(prompt).toContain("Do not start a local development server");
  expect(prompt).toContain("Browser verification passed");
  expect(prompt).toContain("bun run test:e2e: exit 0");
  expect(prompt).toContain("LATEST_QA_FEEDBACK");
  expect(prompt).not.toContain("LATEST_UI_DESIGN");
  expect(prompt).not.toContain("IRRELEVANT_SPECIFIER_HISTORY");
  expect(prompt).not.toContain("Feature: Old");
  expect(prompt).toContain("Published artifact: specifications/000001-feature-1.feature");
  expect(prompt).toContain("Available scripts: lint, test");
  expect(prompt).toContain("Workspace kind: existing");
  expect(prompt).not.toContain("Resolved stack catalog for new projects:");

  const architectPrompt = await buildAgentPrompt({
    role: Role.Architect,
    state: created.state,
    runDirectory: created.runDirectory,
  });

  expect(architectPrompt).toContain("Resolved stack catalog for new projects:");
  expect(architectPrompt).toContain("- bun: 1.3.10");
  expect(architectPrompt).toContain("- typescript: 7.0.2");
  expect(architectPrompt).toContain(
    "For an existing project, use its package.json and lockfile versions.",
  );
  expect(architectPrompt).toContain("KEEP_SPECIFIER_ASSUMPTION");
  expect(architectPrompt).not.toContain("Feature: Old");
  expect(await readFile(resolve(created.runDirectory, "workspace-facts.json"), "utf8")).toContain(
    '"lint": "eslint ."',
  );

  const dataPrompt = await buildAgentPrompt({
    role: Role.DataEngineer,
    state: created.state,
    runDirectory: created.runDirectory,
  });

  expect(dataPrompt).toContain("LATEST_ARCHITECTURE");
  expect(dataPrompt).not.toContain("LATEST_UI_DESIGN");
  expect(dataPrompt).toContain("Domain model: Checkout aggregate");
  expect(dataPrompt).not.toContain("API contract: checkout.submit mutation");
  expect(dataPrompt).toContain("database.test.ts");

  const uiPrompt = await buildAgentPrompt({
    role: Role.UiDesigner,
    state: created.state,
    runDirectory: created.runDirectory,
  });

  expect(uiPrompt).toContain("Design:\nUse a checkout aggregate.");
  expect(uiPrompt).toContain("API contract: checkout.submit mutation");
  expect(uiPrompt).not.toContain("Domain model: Checkout aggregate");
  expect(uiPrompt).not.toContain("Security: Authenticated actor");

  const frontendPrompt = await buildAgentPrompt({
    role: Role.FrontendCoder,
    state: created.state,
    runDirectory: created.runDirectory,
  });

  expect(frontendPrompt).toContain("Design:\nUse a checkout aggregate.");
  expect(frontendPrompt).toContain("API contract: checkout.submit mutation");
  expect(frontendPrompt).not.toContain("Domain model: Checkout aggregate");

  created.state.architectureReviewStatus = "pending";
  const reviewPrompt = await buildAgentPrompt({
    role: Role.Architect,
    state: created.state,
    runDirectory: created.runDirectory,
  });

  expect(reviewPrompt).toContain("Architecture task:\nimplementation review");
  expect(reviewPrompt).toContain("LATEST_ARCHITECTURE");
  expect(reviewPrompt).toContain("Approve QA or return concrete findings");
  created.state.architectureReviewStatus = "not-started";

  created.state.currentRole = Role.Qa;
  created.state.localChecks.push({
    sequence: 2,
    turn: 4,
    role: Role.Qa,
    kind: "quality-gate",
    createdAt: new Date().toISOString(),
    passed: false,
    summary: "Coverage failed.",
    details: ["frontend/app.tsx has insufficient coverage."],
    commands: [{ command: "bun run test:coverage", exitCode: 1, output: "79%" }],
  });
  await saveRunState(created.runDirectory, created.state);

  const qaPrompt = await buildAgentPrompt({
    role: Role.Qa,
    state: created.state,
    runDirectory: created.runDirectory,
  });

  expect(qaPrompt).toContain("MANDATORY QA FAILURE ROUTING");
  expect(qaPrompt).toContain("Do not return complete while this local check remains failed");
  expect(qaPrompt).toContain("frontend/app.tsx has insufficient coverage");
});

test("describes the role execution and safe specifier inspection rules", async () => {
  const root = await temporary.create("web-app-dev-team-specifier-context-");
  const created = await createRunState({
    prompt: "Create a login page",
    workspace: root,
    runsRoot: root,
    maxTurns: 12,
  });
  const context = {
    role: Role.Specifier,
    state: created.state,
    runDirectory: created.runDirectory,
  };
  const initial = roleExecutionMetadata(context, false);
  const prompt = await buildAgentPrompt(context, initial);

  expect(initial).toMatchObject({
    roleTurn: 1,
    initialRoleTurn: true,
    newCodexSession: true,
    codexSessionResumed: false,
    recoveryAttempt: false,
    routedCorrection: false,
    previousRoleInterruption: null,
  });
  expect(prompt).toContain("Role turn: 1");
  expect(prompt).toContain("Initial role turn: yes");
  expect(prompt).toContain("New Codex session: yes");
  expect(prompt).toContain("Codex session resumed: no");
  expect(prompt).toContain("Recovery attempt: no");
  expect(prompt).toContain("Previous role interruption: none");
  expect(prompt).toContain("Workspace kind: new");
  expect(prompt).toContain("do not enumerate files");
  expect(prompt).toContain("Do not read `state.json` during a normal initial role turn");
  expect(prompt).not.toContain("complete durable history remains");

  created.state.executions.push({
    sequence: 1,
    turn: 1,
    role: Role.Specifier,
    startedAt: "2026-08-11T10:00:00.000Z",
    completedAt: "2026-08-11T10:01:00.000Z",
    status: RunStatus.Failed,
    usage: null,
    commands: [],
    changedFiles: [],
  });
  created.state.executions[0]!.status = RunStatus.Completed;

  expect(roleExecutionMetadata(context, true)).toMatchObject({
    roleTurn: 2,
    initialRoleTurn: false,
    newCodexSession: false,
    codexSessionResumed: true,
    recoveryAttempt: false,
    routedCorrection: false,
  });

  created.state.executions[0]!.status = RunStatus.Failed;
  created.state.interruptions.push({
    sequence: 1,
    role: Role.Specifier,
    turn: 1,
    createdAt: "2026-08-11T10:01:00.000Z",
    reason: "Codex exited with code 1.",
    logPath: `${created.runDirectory}/logs/specifier.log`,
  });

  expect(roleExecutionMetadata(context, true)).toMatchObject({
    roleTurn: 2,
    initialRoleTurn: false,
    newCodexSession: false,
    codexSessionResumed: true,
    recoveryAttempt: true,
    routedCorrection: false,
    previousRoleInterruption: "turn 1: Codex exited with code 1.",
  });
});

test("builds a compact prompt for a routed correction in a fresh session", async () => {
  const root = await temporary.create("web-app-dev-team-correction-context-");
  const created = await createRunState({
    prompt: "Create a login page",
    workspace: root,
    runsRoot: root,
    maxTurns: 12,
  });
  created.state.currentRole = Role.DataEngineer;
  created.state.turns = 1;
  created.state.executions.push({
    sequence: 1,
    turn: 1,
    role: Role.DataEngineer,
    startedAt: "2026-08-11T10:00:00.000Z",
    completedAt: "2026-08-11T10:01:00.000Z",
    status: RunStatus.Completed,
    usage: null,
    commands: [],
    changedFiles: [],
  });
  created.state.messages.push({
    id: "qa-correction",
    sequence: 1,
    from: Role.Qa,
    to: Role.DataEngineer,
    createdAt: "2026-08-11T10:02:00.000Z",
    turn: {
      role: Role.Qa,
      summary: "Migration metadata needs formatting.",
      scenariosTested: [],
      commands: ["bun run format:check"],
      failures: ["drizzle/meta/_journal.json is not formatted."],
      failureOwner: Role.DataEngineer,
      artifacts: [],
      evidence: ["bun run format:check: exit 1"],
      decision: TurnDecision.Handoff,
      nextRole: Role.DataEngineer,
      reason: "Correct the generated metadata.",
    },
  });
  const context = {
    role: Role.DataEngineer,
    state: created.state,
    runDirectory: created.runDirectory,
  };
  const execution = roleExecutionMetadata(context, false);
  const prompt = await buildAgentPrompt(context, execution);

  expect(execution).toMatchObject({
    roleTurn: 2,
    newCodexSession: true,
    routedCorrection: true,
  });
  expect(prompt).toContain("focused correction assignment");
  expect(prompt).toContain("Migration metadata needs formatting");
  expect(prompt).toContain("Correct only the current findings");
  expect(prompt).not.toContain("Deterministic workspace bootstrap:");
  expect(prompt).not.toContain("Latest passed deterministic verification:");
});
