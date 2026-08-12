import { describe, expect, test } from "bun:test";
import { check, getFileInfo } from "prettier";
import type { ChangePlan } from "../../../../src/domain/schemas.ts";
import { webAppTemplate } from "../../../../src/infrastructure/workspace/templates/web-app.ts";

const fullStackPlan: ChangePlan = {
  applicationName: "purchase-orders",
  contexts: ["purchasing"],
  persistenceContexts: ["purchasing"],
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
    expect(files["src/apps/purchase-orders/backend/documentation.ts"]).toContain(
      'url: "/openapi.json"',
    );
    expect(files["test/e2e/purchase-orders-smoke.e2e.ts"]).toContain("All systems ready");
    expect(files["test/e2e/purchase-orders-smoke.spec.ts"]).toBeUndefined();
    expect(files["playwright.config.ts"]).toContain('testMatch: "**/*.e2e.ts"');
    expect(files["playwright.config.ts"]).toContain('url: "http://127.0.0.1:3000/health"');
    expect(files["playwright.config.ts"]).toContain('url: "http://127.0.0.1:5173"');
    expect(files["vite.config.ts"]).toContain('host: "127.0.0.1"');
    expect(files["vite.config.ts"]).toContain("strictPort: true");
    expect(files["drizzle.config.ts"]).toContain('url: "./.data/purchase-orders.sqlite"');
    expect(files["src/contexts/purchasing/infrastructure/persistence/database.ts"]).toContain(
      'process.env.WEB_APP_DATABASE_PATH ?? ".data/purchase-orders.sqlite"',
    );
    expect(files["test/contexts/purchasing/infrastructure/persistence/database.test.ts"]).toContain(
      "opens the application database",
    );
    expect(files[".github/workflows/ci.yml"]).toContain("bun-version: 1.3.10");
    expect(files[".github/workflows/ci.yml"]).toContain("actions/checkout@v6");
    expect(files[".github/workflows/ci.yml"]).toContain("actions/cache@v5");
    expect(files[".github/workflows/ci.yml"]).toContain("bun run test:coverage");
    expect(files[".github/workflows/ci.yml"]).toContain("bun run openapi:generate");
    expect(files[".github/workflows/ci.yml"]?.endsWith("\n")).toBeTrue();
    expect(files[".github/workflows/ci.yml"]?.endsWith("\n\n")).toBeFalse();
    expect(files["bunfig.toml"]).toContain(
      "coverageThreshold = { lines = 0.8, functions = 0.8, statements = 0.8 }",
    );
    expect(files["bunfig.toml"]).toContain('"src/contexts/*/infrastructure/persistence/schema.ts"');
    expect(files["bunfig.toml"]).toContain("# Browser-only global setup is not application logic.");
    expect(files["bunfig.toml"]).toContain('"test/setup.ts"');
    expect(JSON.parse(files["package.json"] ?? "{}").scripts["test:coverage"]).toBe(
      "bun test --coverage",
    );
    expect(JSON.parse(files["package.json"] ?? "{}").scripts["openapi:generate"]).toContain(
      "--export AppRouter --output openapi.json",
    );
    expect(JSON.parse(files["package.json"] ?? "{}").scripts["db:generate"]).toBe(
      'drizzle-kit generate && prettier --write "drizzle/meta/**/*.json"',
    );

    const output = Object.values(files).join("\n");
    expect(output).not.toContain("{{applicationName}}");
    expect(output).not.toContain("{{bunVersion}}");
    expect(output).not.toContain("{{frontendSteps}}");
    expect(output).not.toContain("{{backendSteps}}");
  });

  test("selects only the templates required by the change plan", () => {
    const files = webAppTemplate({
      ...fullStackPlan,
      persistenceContexts: [],
      dataRequired: false,
      frontendRequired: false,
    });

    expect(files["src/apps/purchase-orders/backend/server.ts"]).toBeDefined();
    expect(files["src/apps/purchase-orders/frontend/main.tsx"]).toBeUndefined();
    expect(files["bunfig.toml"]).not.toContain('"test/setup.ts"');
    expect(files["drizzle.config.ts"]).toBeUndefined();
    expect(files[".github/workflows/ci.yml"]).not.toContain("Playwright");

    const frontendOnly = webAppTemplate({
      ...fullStackPlan,
      persistenceContexts: [],
      dataRequired: false,
      backendRequired: false,
    });
    expect(frontendOnly[".github/workflows/ci.yml"]).not.toContain("openapi:generate");
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
