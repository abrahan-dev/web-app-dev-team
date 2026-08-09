import type {
  GitCommandResult,
  GitCommandRunner,
} from "../../application/ports/repository-workflow.ts";

export class BunGitCommandRunner implements GitCommandRunner {
  async run(arguments_: string[], workspace: string): Promise<GitCommandResult> {
    try {
      const child = Bun.spawn(["git", ...arguments_], {
        cwd: workspace,
        stdout: "pipe",
        stderr: "pipe",
      });
      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]);

      return {
        command: ["git", ...arguments_],
        exitCode,
        output: `${stdout}${stderr}`.trim(),
      };
    } catch (error) {
      return {
        command: ["git", ...arguments_],
        exitCode: 127,
        output: error instanceof Error ? error.message : String(error),
      };
    }
  }
}
