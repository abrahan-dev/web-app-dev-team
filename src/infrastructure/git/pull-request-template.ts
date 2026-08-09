import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { Role } from "../../domain/roles.ts";
import type { RunState } from "../../domain/schemas.ts";

const templatePath = resolve(import.meta.dir, "../../../assets/git/pull-request.md");

function bullets(values: string[]): string {
  return values.length === 0 ? "- No details available." : values.map((v) => `- ${v}`).join("\n");
}

export async function renderPullRequestBody(state: RunState): Promise<string> {
  const template = await readFile(templatePath, "utf8");
  const implementation = state.messages
    .filter(({ turn }) => turn && turn.role !== Role.Specifier && turn.role !== Role.Qa)
    .map(({ turn }) => turn?.summary)
    .filter((value): value is string => value !== undefined);
  const qa = state.messages.findLast(({ turn }) => turn?.role === Role.Qa)?.turn;
  const evidence = [
    ...(qa?.role === Role.Qa ? qa.evidence : []),
    ...state.localChecks.filter(({ passed }) => passed).map(({ summary }) => summary),
  ];

  return template
    .replaceAll("{{featureId}}", state.gitWorkflow?.featureId ?? "unknown-feature")
    .replaceAll("{{implementation}}", bullets(implementation))
    .replaceAll("{{evidence}}", bullets(evidence));
}
