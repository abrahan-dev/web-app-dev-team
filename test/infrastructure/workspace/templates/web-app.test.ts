import { describe, expect, test } from "bun:test";
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
      "<h1>purchase-orders</h1>",
    );
    expect(files["drizzle.config.ts"]).toContain('url: "./.data/purchase-orders.sqlite"');
    expect(files[".github/workflows/ci.yml"]).toContain("bun-version: 1.3.10");

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
});
