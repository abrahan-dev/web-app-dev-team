import type {
  GitCommandResult,
  GitCommandRunner,
} from "../../application/ports/repository-workflow.ts";

interface GitProcess {
  stdout: ReadableStream<Uint8Array>;
  stderr: ReadableStream<Uint8Array>;
  exited: Promise<number>;
}

export type GitProcessSpawner = (command: string[], workspace: string) => GitProcess;

const spawnGitProcess: GitProcessSpawner = (command, workspace) =>
  Bun.spawn(command, {
    cwd: workspace,
    stdout: "pipe",
    stderr: "pipe",
  });

export class BunGitCommandRunner implements GitCommandRunner {
  constructor(private readonly spawn: GitProcessSpawner = spawnGitProcess) {}

  async run(arguments_: string[], workspace: string): Promise<GitCommandResult> {
    try {
      const child = this.spawn(["git", ...arguments_], workspace);
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
