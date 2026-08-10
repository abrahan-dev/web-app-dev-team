import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import type {
  PullRequestPublisher,
  PullRequestRequest,
} from "../../application/ports/repository-workflow.ts";

interface GitHubMcpOptions {
  command: string;
  arguments_: string[];
}

interface GitHubMcpResult {
  isError?: boolean;
  structuredContent?: unknown;
  content: Array<{ type: string; text?: string }>;
}

export interface GitHubMcpConnection {
  connect(): Promise<void>;
  listToolNames(): Promise<string[]>;
  createPullRequest(arguments_: Record<string, unknown>): Promise<GitHubMcpResult>;
  close(): Promise<void>;
}

export type GitHubMcpConnectionFactory = (options: GitHubMcpOptions) => GitHubMcpConnection;

const createGitHubMcpConnection: GitHubMcpConnectionFactory = (options) => {
  const client = new Client({ name: "web-app-dev-team", version: "0.1.0" });
  const transport = new StdioClientTransport({
    command: options.command,
    args: options.arguments_,
  });

  return {
    connect: () => client.connect(transport),
    async listToolNames() {
      return (await client.listTools()).tools.map(({ name }) => name);
    },
    async createPullRequest(arguments_) {
      const result = await client.callTool({ name: "create_pull_request", arguments: arguments_ });

      return {
        isError: result.isError,
        structuredContent: result.structuredContent,
        content: result.content.flatMap((item) =>
          item.type === "text" ? [{ type: item.type, text: item.text }] : [],
        ),
      };
    },
    close: () => client.close(),
  };
};

function resultUrl(result: {
  structuredContent?: unknown;
  content: Array<{ type: string; text?: string }>;
}): string | null {
  const structured = result.structuredContent as { html_url?: string; url?: string } | undefined;
  const direct = structured?.html_url ?? structured?.url;

  if (direct) {
    return direct;
  }

  const text = result.content.map((item) => item.text ?? "").join("\n");

  return text.match(/https:\/\/github\.com\/[^\s"}]+\/pull\/\d+/)?.[0] ?? null;
}

export class GitHubMcpPullRequestPublisher implements PullRequestPublisher {
  constructor(
    private readonly options: GitHubMcpOptions,
    private readonly connectionFactory: GitHubMcpConnectionFactory = createGitHubMcpConnection,
  ) {}

  async verify(): Promise<void> {
    const connection = this.connectionFactory(this.options);

    try {
      await connection.connect();
      const tools = await connection.listToolNames();

      if (!tools.includes("create_pull_request")) {
        throw new Error("The GitHub MCP server does not provide create_pull_request.");
      }
    } finally {
      await connection.close();
    }
  }

  async create(request: PullRequestRequest): Promise<{ url: string }> {
    const connection = this.connectionFactory(this.options);

    try {
      await connection.connect();
      const tools = await connection.listToolNames();

      if (!tools.includes("create_pull_request")) {
        throw new Error("The GitHub MCP server does not provide create_pull_request.");
      }

      const result = await connection.createPullRequest({
        owner: request.owner,
        repo: request.repository,
        base: request.baseBranch,
        head: request.featureBranch,
        title: request.title,
        body: request.body,
        draft: false,
        maintainer_can_modify: true,
      });

      if (result.isError) {
        throw new Error("The GitHub MCP server could not create the pull request.");
      }

      const url = resultUrl(result);

      if (!url) {
        throw new Error("The GitHub MCP result does not contain a pull request URL.");
      }

      return { url };
    } finally {
      await connection.close();
    }
  }
}
