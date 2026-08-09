import { afterEach, describe, expect, test } from "bun:test";
import { readFile, writeFile } from "node:fs/promises";
import { basename, resolve } from "node:path";
import {
  buildAgentPrompt,
  loadCommunicationStandard,
  loadRoleInstructions,
  roleInstructionsPath,
} from "../../../src/infrastructure/agents/prompt-builder.ts";
import { roles, type Handoff } from "../../../src/domain/schemas.ts";
import { Role } from "../../../src/domain/roles.ts";
import { TurnDecision } from "../../../src/domain/workflow-values.ts";
import {
  createRunState,
  saveRunState,
} from "../../../src/infrastructure/persistence/file-run-store.ts";
import { TemporaryWorkspaceManager } from "../../support/temporary-workspaces.ts";

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
        assumptions: [],
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
          dataRequired: false,
          backendRequired: true,
          frontendRequired: false,
        },
        domainModel: ["Checkout aggregate"],
        apiContract: ["checkout.submit mutation"],
        security: ["Authenticated actor"],
        constraints: [],
        risks: [],
        artifacts: [],
        evidence: [],
        decision: TurnDecision.Handoff,
        nextRole: Role.BackendCoder,
        reason: "implement",
      },
    },
    {
      id: Role.Qa,
      sequence: 3,
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
  created.state.currentRole = Role.BackendCoder;
  created.state.messages.push(...handoffs);
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
  expect(prompt).toContain("LATEST_QA_FEEDBACK");
  expect(prompt).not.toContain("IRRELEVANT_SPECIFIER_HISTORY");
  expect(prompt).toContain("Available scripts: lint, test");
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
  expect(await readFile(resolve(created.runDirectory, "workspace-facts.json"), "utf8")).toContain(
    '"lint": "eslint ."',
  );
});
