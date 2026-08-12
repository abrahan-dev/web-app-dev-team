import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { workspaceTemplatesRoot } from "../../../package-paths.ts";
import { stackCatalog } from "../../configuration/stack-catalog.ts";
import type { ChangePlan } from "../../../domain/schemas.ts";

export const webAppTemplateVersion = 3 as const;
const templateRoot = workspaceTemplatesRoot;

function template(path: string): string {
  return readFileSync(resolve(templateRoot, path), "utf8");
}

function renderTemplate(path: string, variables: Record<string, string>): string {
  let content = template(path);

  for (const [name, value] of Object.entries(variables)) {
    content = content.replaceAll(`{{${name}}}`, value);
  }

  return content;
}

function packageJson(plan: ChangePlan): string {
  const { dependencies: catalogDependencies } = stackCatalog;
  const { developmentDependencies: catalogDevelopmentDependencies } = stackCatalog;
  const dependencies: Record<string, string> = { zod: catalogDependencies.zod };
  const developmentDependencies: Record<string, string> = {
    "@types/bun": catalogDevelopmentDependencies["@types/bun"],
    oxlint: catalogDevelopmentDependencies.oxlint,
    prettier: catalogDevelopmentDependencies.prettier,
    typescript: catalogDevelopmentDependencies.typescript,
  };
  const scripts: Record<string, string> = {
    format: "prettier --write .",
    "format:check": "prettier --check .",
    lint: "oxlint src test",
    typecheck: "tsc --noEmit",
    test: "bun test",
    "test:coverage": "bun test --coverage",
  };

  if (plan.backendRequired) {
    Object.assign(dependencies, {
      "@trpc/server": catalogDependencies["@trpc/server"],
      "swagger-ui-dist": catalogDependencies["swagger-ui-dist"],
    });
    Object.assign(developmentDependencies, {
      "@hey-api/openapi-ts": catalogDevelopmentDependencies["@hey-api/openapi-ts"],
      "@trpc/openapi": catalogDevelopmentDependencies["@trpc/openapi"],
    });
    scripts["dev:backend"] = `bun --watch src/apps/${plan.applicationName}/backend/server.ts`;
    scripts["openapi:generate"] =
      `trpc-openapi src/apps/${plan.applicationName}/backend/router.ts --export AppRouter --output openapi.json --title "${plan.applicationName} API" --version 0.1.0 --server-url /trpc`;
  }

  if (plan.dataRequired) {
    dependencies["drizzle-orm"] = catalogDependencies["drizzle-orm"];
    developmentDependencies["drizzle-kit"] = catalogDevelopmentDependencies["drizzle-kit"];
    scripts["db:generate"] = 'drizzle-kit generate && prettier --write "drizzle/meta/**/*.json"';
    scripts["db:migrate"] = "drizzle-kit migrate";
  }

  if (plan.frontendRequired) {
    Object.assign(dependencies, {
      "@tanstack/react-query": catalogDependencies["@tanstack/react-query"],
      "@tanstack/react-router": catalogDependencies["@tanstack/react-router"],
      "@trpc/client": catalogDependencies["@trpc/client"],
      "@trpc/tanstack-react-query": catalogDependencies["@trpc/tanstack-react-query"],
      react: catalogDependencies.react,
      "react-dom": catalogDependencies["react-dom"],
      "react-hook-form": catalogDependencies["react-hook-form"],
    });
    Object.assign(developmentDependencies, {
      "@playwright/test": catalogDevelopmentDependencies["@playwright/test"],
      "@tailwindcss/vite": catalogDevelopmentDependencies["@tailwindcss/vite"],
      "@testing-library/react": catalogDevelopmentDependencies["@testing-library/react"],
      "@types/react": catalogDevelopmentDependencies["@types/react"],
      "@types/react-dom": catalogDevelopmentDependencies["@types/react-dom"],
      "@vitejs/plugin-react": catalogDevelopmentDependencies["@vitejs/plugin-react"],
      "happy-dom": catalogDevelopmentDependencies["happy-dom"],
      tailwindcss: catalogDevelopmentDependencies.tailwindcss,
      vite: catalogDevelopmentDependencies.vite,
    });
    scripts["dev:frontend"] = "vite";
    scripts["test:e2e"] = "playwright test";

    if (plan.backendRequired) {
      scripts["dev:e2e:backend"] = "bun run scripts/start-playwright-backend.ts";
    }
  }

  return `${JSON.stringify(
    {
      name: plan.applicationName,
      version: "0.1.0",
      private: true,
      type: "module",
      packageManager: `bun@${stackCatalog.runtime.bun}`,
      scripts,
      dependencies,
      devDependencies: developmentDependencies,
    },
    null,
    2,
  )}\n`;
}

function backendFiles(applicationName: string): Record<string, string> {
  const root = `src/apps/${applicationName}/backend`;
  const variables = { applicationName };

  return {
    [`${root}/documentation.ts`]: template("backend/documentation.ts.tmpl"),
    [`${root}/trpc.ts`]: template("backend/trpc.ts.tmpl"),
    [`${root}/router.ts`]: template("backend/router.ts.tmpl"),
    [`${root}/server.ts`]: template("backend/server.ts.tmpl"),
    [`test/apps/${applicationName}/backend/server.test.ts`]: renderTemplate(
      "backend/server.test.ts.tmpl",
      variables,
    ),
  };
}

function frontendFiles(applicationName: string, backendRequired: boolean): Record<string, string> {
  const root = `src/apps/${applicationName}/frontend`;
  const variables = { applicationName };

  return {
    "index.html": renderTemplate("frontend/index.html.tmpl", variables),
    [`${root}/app.tsx`]: renderTemplate("frontend/app.tsx.tmpl", variables),
    [`${root}/main.tsx`]: template("frontend/main.tsx.tmpl"),
    [`${root}/styles.css`]: template("frontend/styles.css.tmpl"),
    [`${root}/ui-rules.ts`]: template("frontend/ui-rules.ts.tmpl"),
    [`${root}/env.d.ts`]: template("frontend/env.d.ts.tmpl"),
    [`test/apps/${applicationName}/frontend/app.test.tsx`]: renderTemplate(
      "frontend/app.test.tsx.tmpl",
      variables,
    ),
    [`test/apps/${applicationName}/frontend/styles.test.ts`]: renderTemplate(
      "frontend/styles.test.ts.tmpl",
      variables,
    ),
    [`test/apps/${applicationName}/frontend/ui-rules.test.ts`]: renderTemplate(
      "frontend/ui-rules.test.ts.tmpl",
      variables,
    ),
    "test/setup.ts": template("frontend/test-setup.ts.tmpl"),
    "playwright.config.ts": renderTemplate("frontend/playwright.config.ts.tmpl", {
      backendServer: backendRequired ? template("frontend/playwright-backend-server.ts.tmpl") : "",
    }),
    ...(backendRequired
      ? {
          "scripts/start-playwright-backend.ts": template(
            "frontend/start-playwright-backend.ts.tmpl",
          ),
        }
      : {}),
    [`test/e2e/${applicationName}-smoke.e2e.ts`]: renderTemplate(
      "frontend/smoke.e2e.ts.tmpl",
      variables,
    ),
    "test/e2e/support/crud.ts": template("frontend/crud-e2e-support.ts.tmpl"),
    "vite.config.ts": template("frontend/vite.config.ts.tmpl"),
  };
}

function continuousIntegrationWorkflow(plan: ChangePlan): string {
  const content = renderTemplate("ci/workflow.yml.tmpl", {
    backendSteps: plan.backendRequired ? template("ci/backend-steps.yml.tmpl") : "",
    bunVersion: stackCatalog.runtime.bun,
    frontendSteps: plan.frontendRequired ? template("ci/frontend-steps.yml.tmpl") : "",
  });

  return `${content.trimEnd()}\n`;
}

export function webAppTemplate(plan: ChangePlan): Record<string, string> {
  const files: Record<string, string> = {
    ".github/workflows/ci.yml": continuousIntegrationWorkflow(plan),
    ".data/.gitkeep": "",
    ".gitignore": template("base/gitignore.tmpl"),
    "bunfig.toml": renderTemplate("base/bunfig.toml.tmpl", {
      coveragePreloadIgnore: plan.frontendRequired
        ? '  # Browser-only global setup is not application logic.\n  "test/setup.ts",'
        : "",
      testPreload: plan.frontendRequired ? 'preload = ["./test/setup.ts"]' : "",
    }),
    "package.json": packageJson(plan),
    "test/.gitkeep": "",
    "tsconfig.json": template("base/tsconfig.json.tmpl"),
  };

  for (const context of plan.contexts) {
    for (const layer of ["application", "domain", "infrastructure"] as const) {
      files[`src/contexts/${context}/${layer}/.gitkeep`] = "";
    }
  }

  if (plan.backendRequired) {
    Object.assign(files, backendFiles(plan.applicationName));
  }

  if (plan.frontendRequired) {
    Object.assign(files, frontendFiles(plan.applicationName, plan.backendRequired));
  }

  if (plan.dataRequired) {
    files["drizzle/.gitkeep"] = "";
    files["drizzle.config.ts"] = renderTemplate("data/drizzle.config.ts.tmpl", {
      applicationName: plan.applicationName,
    });

    for (const context of plan.persistenceContexts) {
      const root = `src/contexts/${context}/infrastructure/persistence`;
      files[`${root}/database.ts`] = renderTemplate("data/database.ts.tmpl", {
        applicationName: plan.applicationName,
      });
      files[`${root}/index.ts`] = template("data/index.ts.tmpl");
      files[`test/contexts/${context}/infrastructure/persistence/database.test.ts`] =
        renderTemplate("data/database.test.ts.tmpl", { context });
    }
  }

  return files;
}
