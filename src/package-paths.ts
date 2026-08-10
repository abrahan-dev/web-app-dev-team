import { resolve } from "node:path";

export const packageRoot = resolve(import.meta.dir, "..");
export const assetsRoot = resolve(packageRoot, "assets");
export const cliEntryPath = resolve(packageRoot, "dist/cli.js");
export const roleWatcherPath = resolve(packageRoot, "dist/watch-role.js");
export const summaryWatcherPath = resolve(packageRoot, "dist/watch-summary.js");
export const packageJsonPath = resolve(packageRoot, "package.json");
export const agentRolesRoot = resolve(assetsRoot, "agents/roles");
export const agentSchemasRoot = resolve(assetsRoot, "agents/output-schemas");
export const communicationStandardPath = resolve(assetsRoot, "agents/communication.md");
export const workspaceTemplatesRoot = resolve(assetsRoot, "workspace/templates");
export const stackCatalogPath = resolve(assetsRoot, "workspace/stack.json");
export const pullRequestTemplatePath = resolve(assetsRoot, "git/pull-request.md");
