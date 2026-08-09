import { describe, expect, test } from "bun:test";
import {
  BunGitCommandRunner,
  type GitProcessSpawner,
} from "../../../src/infrastructure/git/git-command-runner.ts";

function stream(value: string): ReadableStream<Uint8Array> {
  return new Blob([value]).stream();
}

describe("Bun Git command runner", () => {
  test("returns combined process output", async () => {
    const calls: Array<{ command: string[]; workspace: string }> = [];

    const spawn: GitProcessSpawner = (command, workspace) => {
      calls.push({ command, workspace });

      return {
        stdout: stream("commit-sha\n"),
        stderr: stream("warning\n"),
        exited: Promise.resolve(0),
      };
    };

    const result = await new BunGitCommandRunner(spawn).run(["rev-parse", "HEAD"], "/workspace");

    expect(calls).toEqual([{ command: ["git", "rev-parse", "HEAD"], workspace: "/workspace" }]);
    expect(result).toEqual({
      command: ["git", "rev-parse", "HEAD"],
      exitCode: 0,
      output: "commit-sha\nwarning",
    });
  });

  test("returns exit 127 when the process cannot start", async () => {
    const spawn: GitProcessSpawner = () => {
      throw new Error("git is unavailable");
    };

    expect(await new BunGitCommandRunner(spawn).run(["status"], "/workspace")).toEqual({
      command: ["git", "status"],
      exitCode: 127,
      output: "git is unavailable",
    });
  });
});
