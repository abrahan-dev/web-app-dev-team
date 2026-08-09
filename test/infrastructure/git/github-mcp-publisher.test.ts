import { describe, expect, test } from "bun:test";
import type { PullRequestRequest } from "../../../src/application/ports/repository-workflow.ts";
import {
  GitHubMcpPullRequestPublisher,
  type GitHubMcpConnection,
} from "../../../src/infrastructure/git/github-mcp-publisher.ts";

const request: PullRequestRequest = {
  owner: "example",
  repository: "business-app",
  baseBranch: "main",
  featureBranch: "feat/approve-orders",
  title: "feat: implement approve-orders",
  body: "## Evidence\n\n- Tests pass.",
};

function connection(options: { tools?: string[]; isError?: boolean; url?: string | null }): {
  value: GitHubMcpConnection;
  calls: Record<string, unknown>[];
  closed: () => boolean;
} {
  const calls: Record<string, unknown>[] = [];
  let isClosed = false;

  return {
    calls,
    closed: () => isClosed,
    value: {
      connect: () => Promise.resolve(),
      listToolNames: () => Promise.resolve(options.tools ?? ["create_pull_request"]),
      createPullRequest(arguments_) {
        calls.push(arguments_);

        return Promise.resolve({
          isError: options.isError,
          structuredContent: options.url ? { html_url: options.url } : undefined,
          content: [],
        });
      },
      close() {
        isClosed = true;

        return Promise.resolve();
      },
    },
  };
}

describe("GitHub MCP pull request publisher", () => {
  test("creates a pull request and closes the connection", async () => {
    const fake = connection({ url: "https://github.com/example/business-app/pull/7" });
    const publisher = new GitHubMcpPullRequestPublisher(
      { command: "github-mcp-server", arguments_: ["stdio"] },
      () => fake.value,
    );

    expect(await publisher.create(request)).toEqual({
      url: "https://github.com/example/business-app/pull/7",
    });
    expect(fake.calls[0]).toMatchObject({
      owner: "example",
      repo: "business-app",
      base: "main",
      head: "feat/approve-orders",
      draft: false,
    });
    expect(fake.closed()).toBe(true);
  });

  test("rejects a server without the required tool", async () => {
    const fake = connection({ tools: [] });
    const publisher = new GitHubMcpPullRequestPublisher(
      { command: "github-mcp-server", arguments_: [] },
      () => fake.value,
    );

    expect(publisher.create(request)).rejects.toThrow("does not provide create_pull_request");
    expect(fake.closed()).toBe(true);
  });

  test("rejects an MCP error or a response without a URL", async () => {
    const failed = connection({ isError: true });
    const missingUrl = connection({});

    expect(
      new GitHubMcpPullRequestPublisher(
        { command: "github-mcp-server", arguments_: [] },
        () => failed.value,
      ).create(request),
    ).rejects.toThrow("could not create");
    expect(
      new GitHubMcpPullRequestPublisher(
        { command: "github-mcp-server", arguments_: [] },
        () => missingUrl.value,
      ).create(request),
    ).rejects.toThrow("does not contain a pull request URL");
  });
});
