import { createHash } from "node:crypto";
import { copyFile, chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const releaseApi = "https://api.github.com/repos/github/github-mcp-server/releases/latest";

interface ReleaseAsset {
  name: string;
  browser_download_url: string;
}

interface ReleaseData {
  assets?: ReleaseAsset[];
}

export interface LinuxInstallerOptions {
  architecture: string;
  home: string;
  fetcher?: typeof fetch;
  run?: (command: string[]) => number;
}

function releaseArchitecture(architecture: string): string {
  const architectures: Record<string, string> = {
    arm64: "arm64",
    ia32: "i386",
    x64: "x86_64",
  };
  const value = architectures[architecture];

  if (!value) {
    throw new Error(`GitHub MCP server has no supported Linux build for ${architecture}.`);
  }

  return value;
}

async function download(fetcher: typeof fetch, url: string): Promise<Uint8Array> {
  const response = await fetcher(url, { headers: { "User-Agent": "web-app-dev-team" } });

  if (!response.ok) {
    throw new Error(`Download failed with HTTP ${response.status}.`);
  }

  return new Uint8Array(await response.arrayBuffer());
}

function selectAsset(assets: ReleaseAsset[], suffix: string): ReleaseAsset {
  const asset = assets.find(({ name }) => name.endsWith(suffix));

  if (!asset) {
    throw new Error(`The latest GitHub MCP release has no ${suffix} asset.`);
  }

  return asset;
}

function expectedChecksum(content: string, fileName: string): string {
  const line = content.split(/\r?\n/u).find((item) => item.trim().endsWith(fileName));
  const checksum = line?.trim().split(/\s+/u)[0];

  if (!checksum || !/^[a-fA-F0-9]{64}$/u.test(checksum)) {
    throw new Error(`The release checksum does not include ${fileName}.`);
  }

  return checksum.toLowerCase();
}

function defaultRun(command: string[]): number {
  return Bun.spawnSync(command, {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  }).exitCode;
}

export async function installLinuxGithubMcp(options: LinuxInstallerOptions): Promise<string> {
  const fetcher = options.fetcher ?? fetch;
  const run = options.run ?? defaultRun;
  const architecture = releaseArchitecture(options.architecture);
  const response = await fetcher(releaseApi, {
    headers: { Accept: "application/vnd.github+json", "User-Agent": "web-app-dev-team" },
  });

  if (!response.ok) {
    throw new Error(`GitHub release lookup failed with HTTP ${response.status}.`);
  }

  const release = (await response.json()) as ReleaseData;
  const assets = release.assets ?? [];
  const archive = selectAsset(assets, `Linux_${architecture}.tar.gz`);
  const checksums = selectAsset(assets, "_checksums.txt");
  const temporaryDirectory = await mkdtemp(join(tmpdir(), "web-app-dev-team-mcp-"));

  try {
    const archivePath = join(temporaryDirectory, archive.name);
    const [archiveBytes, checksumBytes] = await Promise.all([
      download(fetcher, archive.browser_download_url),
      download(fetcher, checksums.browser_download_url),
    ]);
    const actual = createHash("sha256").update(archiveBytes).digest("hex");
    const expected = expectedChecksum(new TextDecoder().decode(checksumBytes), archive.name);

    if (actual !== expected) {
      throw new Error("The GitHub MCP server checksum is invalid.");
    }

    await writeFile(archivePath, archiveBytes, { mode: 0o600 });

    if (
      run([
        "tar",
        "--extract",
        "--gzip",
        "--file",
        archivePath,
        "--directory",
        temporaryDirectory,
      ]) !== 0
    ) {
      throw new Error("The GitHub MCP server archive could not be extracted.");
    }

    const binaryDirectory = resolve(options.home, ".local/bin");
    const binaryPath = join(binaryDirectory, "github-mcp-server");
    await mkdir(binaryDirectory, { recursive: true, mode: 0o755 });
    await copyFile(join(temporaryDirectory, "github-mcp-server"), binaryPath);
    await chmod(binaryPath, 0o755);

    return binaryPath;
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
}
