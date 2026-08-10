import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { workspaceTemplatesRoot } from "../../../package-paths.ts";
import { stackCatalog } from "../../configuration/stack-catalog.ts";
import type { ChangePlan } from "../../../domain/schemas.ts";

export const webAppTemplateVersion = 1 as const;
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
      "@trpc/openapi": catalogDependencies["@trpc/openapi"],
      "@trpc/server": catalogDependencies["@trpc/server"],
    });
    scripts["dev:backend"] = `bun --watch src/apps/${plan.applicationName}/backend/server.ts`;
    scripts["openapi:generate"] = "trpc-openapi generate";
  }

  if (plan.dataRequired) {
    dependencies["drizzle-orm"] = catalogDependencies["drizzle-orm"];
    developmentDependencies["drizzle-kit"] = catalogDevelopmentDependencies["drizzle-kit"];
    scripts["db:generate"] = "drizzle-kit generate";
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
      tailwindcss: catalogDevelopmentDependencies.tailwindcss,
      vite: catalogDevelopmentDependencies.vite,
    });
    scripts["dev:frontend"] = "vite";
    scripts["test:e2e"] = "playwright test";
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
    [`${root}/trpc.ts`]: template("backend/trpc.ts.tmpl"),
    [`${root}/router.ts`]: template("backend/router.ts.tmpl"),
    [`${root}/server.ts`]: template("backend/server.ts.tmpl"),
    [`test/apps/${applicationName}/backend/server.test.ts`]: renderTemplate(
      "backend/server.test.ts.tmpl",
      variables,
    ),
  };
}

function frontendFiles(applicationName: string): Record<string, string> {
  const root = `src/apps/${applicationName}/frontend`;
  const variables = { applicationName };

  return {
    "index.html": renderTemplate("frontend/index.html.tmpl", variables),
    [`${root}/app.tsx`]: renderTemplate("frontend/app.tsx.tmpl", variables),
    [`${root}/main.tsx`]: template("frontend/main.tsx.tmpl"),
    [`${root}/styles.css`]: template("frontend/styles.css.tmpl"),
    [`${root}/env.d.ts`]: template("frontend/env.d.ts.tmpl"),
    [`test/apps/${applicationName}/frontend/app.test.tsx`]: renderTemplate(
      "frontend/app.test.tsx.tmpl",
      variables,
    ),
    "playwright.config.ts": template("frontend/playwright.config.ts.tmpl"),
    "test/e2e/.gitkeep": "",
    "vite.config.ts": template("frontend/vite.config.ts.tmpl"),
  };
}

function continuousIntegrationWorkflow(plan: ChangePlan): string {
  const content = renderTemplate("ci/workflow.yml.tmpl", {
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
    "bunfig.toml": template("base/bunfig.toml.tmpl"),
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
    Object.assign(files, frontendFiles(plan.applicationName));
  }

  if (plan.dataRequired) {
    files["drizzle/.gitkeep"] = "";
    files["drizzle.config.ts"] = renderTemplate("data/drizzle.config.ts.tmpl", {
      applicationName: plan.applicationName,
    });

    for (const context of plan.contexts) {
      files[`src/contexts/${context}/infrastructure/persistence/.gitkeep`] = "";
    }
  }

  return files;
}
