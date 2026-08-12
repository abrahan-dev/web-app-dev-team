import { readFileSync } from "node:fs";
import { z } from "zod";
import { stackCatalogPath } from "../../package-paths.ts";

const exactVersionSchema = z
  .string()
  .regex(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u, "Use one exact semantic version.");

const stackCatalogSchema = z.object({
  runtime: z.object({
    bun: exactVersionSchema,
  }),
  dependencies: z.object({
    "@tanstack/react-query": exactVersionSchema,
    "@tanstack/react-router": exactVersionSchema,
    "@trpc/client": exactVersionSchema,
    "@trpc/server": exactVersionSchema,
    "@trpc/tanstack-react-query": exactVersionSchema,
    "drizzle-orm": exactVersionSchema,
    react: exactVersionSchema,
    "react-dom": exactVersionSchema,
    "react-hook-form": exactVersionSchema,
    "swagger-ui-dist": exactVersionSchema,
    zod: exactVersionSchema,
  }),
  developmentDependencies: z.object({
    "@hey-api/openapi-ts": exactVersionSchema,
    "@playwright/test": exactVersionSchema,
    "@tailwindcss/vite": exactVersionSchema,
    "@testing-library/react": exactVersionSchema,
    "@types/bun": exactVersionSchema,
    "@types/react": exactVersionSchema,
    "@types/react-dom": exactVersionSchema,
    "@vitejs/plugin-react": exactVersionSchema,
    "@trpc/openapi": exactVersionSchema,
    "drizzle-kit": exactVersionSchema,
    "happy-dom": exactVersionSchema,
    oxlint: exactVersionSchema,
    prettier: exactVersionSchema,
    tailwindcss: exactVersionSchema,
    typescript: exactVersionSchema,
    vite: exactVersionSchema,
  }),
});

export type StackCatalog = z.infer<typeof stackCatalogSchema>;

export const testedApiStack = {
  "@hey-api/openapi-ts": "0.94.5",
  "@trpc/client": "11.18.0",
  "@trpc/openapi": "11.18.0-alpha",
  "@trpc/server": "11.18.0",
  "@trpc/tanstack-react-query": "11.18.0",
  "swagger-ui-dist": "5.32.13",
  typescript: "6.0.3",
  zod: "4.4.3",
} as const;

export { stackCatalogPath };

function apiStackValue(catalog: StackCatalog, name: keyof typeof testedApiStack): string {
  return (
    catalog.dependencies[name as keyof StackCatalog["dependencies"]] ??
    catalog.developmentDependencies[name as keyof StackCatalog["developmentDependencies"]]
  );
}

export function assertStackCatalogCompatibility(catalog: StackCatalog): void {
  const mismatches = Object.entries(testedApiStack).filter(
    ([name, version]) => apiStackValue(catalog, name as keyof typeof testedApiStack) !== version,
  );

  if (mismatches.length > 0) {
    const details = mismatches
      .map(
        ([name, version]) =>
          `${name} must be ${version}; received ${apiStackValue(catalog, name as keyof typeof testedApiStack)}.`,
      )
      .join(" ");

    throw new Error(`The stack catalog does not match the tested API stack. ${details}`);
  }
}

export function parseStackCatalog(value: unknown): StackCatalog {
  const catalog = stackCatalogSchema.parse(value);
  assertStackCatalogCompatibility(catalog);

  return catalog;
}

export function loadStackCatalog(): StackCatalog {
  return parseStackCatalog(JSON.parse(readFileSync(stackCatalogPath, "utf8")));
}

export const stackCatalog = loadStackCatalog();

export function describeStackCatalog(catalog = stackCatalog): string {
  const packages = [
    ...Object.entries(catalog.dependencies),
    ...Object.entries(catalog.developmentDependencies),
  ].sort(([left], [right]) => left.localeCompare(right));

  return [
    `- bun: ${catalog.runtime.bun}`,
    ...packages.map(([name, version]) => `- ${name}: ${version}`),
  ].join("\n");
}
