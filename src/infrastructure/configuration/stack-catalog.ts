import { readFileSync } from "node:fs";
import { z } from "zod";
import { stackCatalogPath } from "../../package-paths.ts";

const stackCatalogSchema = z.object({
  runtime: z.object({
    bun: z.string().min(1),
  }),
  dependencies: z.object({
    "@tanstack/react-query": z.string().min(1),
    "@tanstack/react-router": z.string().min(1),
    "@trpc/client": z.string().min(1),
    "@trpc/openapi": z.string().min(1),
    "@trpc/server": z.string().min(1),
    "@trpc/tanstack-react-query": z.string().min(1),
    "drizzle-orm": z.string().min(1),
    react: z.string().min(1),
    "react-dom": z.string().min(1),
    "react-hook-form": z.string().min(1),
    zod: z.string().min(1),
  }),
  developmentDependencies: z.object({
    "@playwright/test": z.string().min(1),
    "@tailwindcss/vite": z.string().min(1),
    "@testing-library/react": z.string().min(1),
    "@types/bun": z.string().min(1),
    "@types/react": z.string().min(1),
    "@types/react-dom": z.string().min(1),
    "@vitejs/plugin-react": z.string().min(1),
    "drizzle-kit": z.string().min(1),
    oxlint: z.string().min(1),
    prettier: z.string().min(1),
    tailwindcss: z.string().min(1),
    typescript: z.string().min(1),
    vite: z.string().min(1),
  }),
});

export type StackCatalog = z.infer<typeof stackCatalogSchema>;

export { stackCatalogPath };

export function loadStackCatalog(): StackCatalog {
  return stackCatalogSchema.parse(JSON.parse(readFileSync(stackCatalogPath, "utf8")));
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
