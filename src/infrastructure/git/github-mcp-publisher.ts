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
  constructor(private readonly options: GitHubMcpOptions) {}

  async create(request: PullRequestRequest): Promise<{ url: string }> {
    const client = new Client({ name: "web-app-dev-team", version: "0.1.0" });
    const transport = new StdioClientTransport({
      command: this.options.command,
      args: this.options.arguments_,
    });

    try {
      await client.connect(transport);
      const tools = await client.listTools();

      if (!tools.tools.some(({ name }) => name === "create_pull_request")) {
        throw new Error("The GitHub MCP server does not provide create_pull_request.");
      }

      const result = await client.callTool({
        name: "create_pull_request",
        arguments: {
          owner: request.owner,
          repo: request.repository,
          base: request.baseBranch,
          head: request.featureBranch,
          title: request.title,
          body: request.body,
          draft: false,
          maintainer_can_modify: true,
        },
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
      await client.close();
    }
  }
}
