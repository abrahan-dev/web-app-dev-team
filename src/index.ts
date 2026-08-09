import { runCli } from "./apps/cli/commands.ts";

try {
  await runCli();
} catch (error) {
  console.error(error instanceof Error ? `\nError: ${error.message}` : error);
  process.exitCode = 1;
}
