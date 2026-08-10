import { describe, expect, test } from "bun:test";
import { check, getFileInfo } from "prettier";
import type { ChangePlan } from "../../../../src/domain/schemas.ts";
import { webAppTemplate } from "../../../../src/infrastructure/workspace/templates/web-app.ts";

const fullStackPlan: ChangePlan = {
  applicationName: "purchase-orders",
  contexts: ["purchasing"],
  dataRequired: true,
  backendRequired: true,
  frontendRequired: true,
};

describe("web application template", () => {
  test("renders external template placeholders", () => {
    const files = webAppTemplate(fullStackPlan);

    expect(files["index.html"]).toContain("/src/apps/purchase-orders/frontend/main.tsx");
    expect(files["src/apps/purchase-orders/frontend/app.tsx"]).toContain(
      '<h1 id="application-title">purchase-orders</h1>',
    );
    expect(files["src/apps/purchase-orders/backend/server.ts"]).toContain(
      "export function handleRequest",
    );
    expect(files["test/e2e/purchase-orders-smoke.e2e.ts"]).toContain("All systems ready");
    expect(files["test/e2e/purchase-orders-smoke.spec.ts"]).toBeUndefined();
    expect(files["playwright.config.ts"]).toContain('testMatch: "**/*.e2e.ts"');
    expect(files["drizzle.config.ts"]).toContain('url: "./.data/purchase-orders.sqlite"');
    expect(files[".github/workflows/ci.yml"]).toContain("bun-version: 1.3.10");
    expect(files[".github/workflows/ci.yml"]).toContain("actions/checkout@v6");
    expect(files[".github/workflows/ci.yml"]).toContain("actions/cache@v5");
    expect(files[".github/workflows/ci.yml"]).toContain("bun run test:coverage");
    expect(files[".github/workflows/ci.yml"]?.endsWith("\n")).toBeTrue();
    expect(files[".github/workflows/ci.yml"]?.endsWith("\n\n")).toBeFalse();
    expect(files["bunfig.toml"]).toContain(
      "coverageThreshold = { lines = 0.8, functions = 0.8, statements = 0.8 }",
    );
    expect(JSON.parse(files["package.json"] ?? "{}").scripts["test:coverage"]).toBe(
      "bun test --coverage",
    );

    const output = Object.values(files).join("\n");
    expect(output).not.toContain("{{applicationName}}");
    expect(output).not.toContain("{{bunVersion}}");
    expect(output).not.toContain("{{frontendSteps}}");
  });

  test("selects only the templates required by the change plan", () => {
    const files = webAppTemplate({
      ...fullStackPlan,
      dataRequired: false,
      frontendRequired: false,
    });

    expect(files["src/apps/purchase-orders/backend/server.ts"]).toBeDefined();
    expect(files["src/apps/purchase-orders/frontend/main.tsx"]).toBeUndefined();
    expect(files["drizzle.config.ts"]).toBeUndefined();
    expect(files[".github/workflows/ci.yml"]).not.toContain("Playwright");
  });

  test("renders files that pass Prettier", async () => {
    const files = webAppTemplate({
      ...fullStackPlan,
      applicationName: "hello-world-login",
    });

    for (const [path, content] of Object.entries(files)) {
      const fileInfo = await getFileInfo(path);

      if (fileInfo.inferredParser) {
        expect(await check(content, { filepath: path })).toBeTrue();
      }
    }
  });
});
