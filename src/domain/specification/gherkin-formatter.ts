const sectionPattern = /^(Background|Scenario):/;
const stepPattern = /^(Given|When|Then|And)\b/;

function appendSection(lines: string[], line: string): void {
  if (lines.length > 0 && lines.at(-1) !== "") {
    lines.push("");
  }

  lines.push(`  ${line}`);
}

export function formatGherkin(source: string): string {
  const formatted: string[] = [];

  for (const rawLine of source.split("\n")) {
    const line = rawLine.trim();

    if (!line) {
      continue;
    }

    if (sectionPattern.test(line)) {
      appendSection(formatted, line);
      continue;
    }

    formatted.push(stepPattern.test(line) ? `    ${line}` : line);
  }

  return formatted.join("\n");
}
