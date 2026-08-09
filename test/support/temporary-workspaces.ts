import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

export class TemporaryWorkspaceManager {
  private readonly directories: string[] = [];

  async create(prefix = "web-app-dev-team-"): Promise<string> {
    const directory = await mkdtemp(resolve(tmpdir(), prefix));
    this.directories.push(directory);

    return directory;
  }

  async createApplication(prefix = "web-app-dev-team-"): Promise<string> {
    const directory = await this.create(prefix);
    await writeFile(resolve(directory, "README.md"), "# Existing test project\n");
    await writeFile(
      resolve(directory, "package.json"),
      JSON.stringify({
        scripts: {
          "test:coverage": "bun -e \"console.log('coverage passed')\"",
        },
      }),
    );

    return directory;
  }

  async cleanup(): Promise<void> {
    await Promise.all(
      this.directories
        .splice(0)
        .map((directory) => rm(directory, { recursive: true, force: true })),
    );
  }
}
