import { describe, expect, test } from "bun:test";
import { inspectSystem, renderDoctorChecks } from "../../../src/apps/cli/system-doctor.ts";

describe("system doctor", () => {
  test("does not inspect an implicit workspace", async () => {
    const checks = await inspectSystem();

    expect(checks.some(({ name }) => name === "workspace")).toBeFalse();
    expect(checks.some(({ name }) => name === "Git repository")).toBeFalse();
  });

  test("reports the platform, Bun, and workspace", async () => {
    const checks = await inspectSystem(process.cwd());

    expect(checks.find(({ name }) => name === "platform")?.status).toBe("PASS");
    expect(checks.find(({ name }) => name === "Bun")?.detail).toBe(Bun.version);
    expect(checks.find(({ name }) => name === "workspace")?.status).toBe("PASS");
    expect(checks.some(({ name }) => name === "Codex execution model")).toBe(
      Bun.which("codex") !== null,
    );
    expect(checks.some(({ name }) => name === "Codex planner model")).toBe(
      Bun.which("codex") !== null,
    );
  });

  test("renders stable status columns", () => {
    expect(
      renderDoctorChecks([
        { status: "PASS", name: "Bun", detail: "1.2.3" },
        { status: "WARNING", name: "Git", detail: "Not configured." },
      ]),
    ).toBe("PASS    Bun: 1.2.3\nWARNING Git: Not configured.");
  });
});
