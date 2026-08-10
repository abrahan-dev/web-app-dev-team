import { createHash } from "node:crypto";
import { chmod, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import { installLinuxGithubMcp } from "../../../src/apps/cli/github-mcp-installer.ts";
import { TemporaryWorkspaceManager } from "../../support/temporary-workspaces.ts";

const temporary = new TemporaryWorkspaceManager();

afterEach(async () => {
  await temporary.cleanup();
});

describe("GitHub MCP Linux installer", () => {
  test("verifies and installs an official release archive", async () => {
    const fixture = await temporary.create("mcp-release-");
    const home = await temporary.create("mcp-home-");
    const binary = join(fixture, "github-mcp-server");
    const archiveName = "github-mcp-server_Linux_x86_64.tar.gz";
    const archive = join(fixture, archiveName);
    await writeFile(binary, "test binary");
    await chmod(binary, 0o755);
    expect(
      Bun.spawnSync([
        "tar",
        "--create",
        "--gzip",
        "--file",
        archive,
        "--directory",
        fixture,
        "github-mcp-server",
      ]).exitCode,
    ).toBe(0);
    const archiveBytes = await readFile(archive);
    const checksum = createHash("sha256").update(archiveBytes).digest("hex");
    const release = {
      assets: [
        { name: archiveName, browser_download_url: "https://example.test/archive" },
        {
          name: "github-mcp-server_1.0.0_checksums.txt",
          browser_download_url: "https://example.test/checksums",
        },
      ],
    };
    const fetcher = (async (input: string | URL | Request) => {
      const url = String(input);

      if (url.endsWith("/latest")) {
        return Response.json(release);
      }

      if (url.endsWith("/archive")) {
        return new Response(archiveBytes);
      }

      return new Response(`${checksum}  ${archiveName}\n`);
    }) as typeof fetch;

    const installed = await installLinuxGithubMcp({
      architecture: "x64",
      fetcher,
      home,
    });

    expect(await readFile(installed, "utf8")).toBe("test binary");
    expect((await stat(installed)).mode & 0o777).toBe(0o755);
  });

  test("rejects an unsupported architecture", async () => {
    expect(installLinuxGithubMcp({ architecture: "riscv64", home: "/tmp/unused" })).rejects.toThrow(
      "no supported Linux build",
    );
  });
});
