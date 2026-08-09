export type Layer = "domain" | "application" | "infrastructure";

export function layer(path: string): Layer | null {
  const segments = path.split("/");

  return (
    (["domain", "application", "infrastructure"] as const).find((candidate) =>
      segments.includes(candidate),
    ) ?? null
  );
}

export function importedSpecifiers(source: string): string[] {
  const results: string[] = [];
  const pattern =
    /(?:import|export)\s+(?:[^"']+?\s+from\s+)?["']([^"']+)["']|(?:import|require)\(\s*["']([^"']+)["']\s*\)/g;
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(source))) {
    results.push(match[1] ?? match[2] ?? "");
  }

  return results;
}

function productionRootViolation(path: string, segments: string[]): string | null {
  return segments[0] === "src" && !["contexts", "apps"].includes(segments[1] ?? "")
    ? `${path}: production code must live under src/contexts or src/apps.`
    : null;
}

function contextLayerViolation(path: string, segments: string[]): string | null {
  const validLayers = ["application", "domain", "infrastructure"];

  return segments[0] === "src" &&
    segments[1] === "contexts" &&
    !validLayers.includes(segments[3] ?? "")
    ? `${path}: context code must select application, domain, or infrastructure after its context name.`
    : null;
}

function applicationSurfaceViolation(path: string, segments: string[]): string | null {
  return segments[0] === "src" &&
    segments[1] === "apps" &&
    !["backend", "frontend"].includes(segments[3] ?? "")
    ? `${path}: application code must select backend or frontend after its application name.`
    : null;
}

function misplacedTestViolation(path: string): string | null {
  return /\.(?:test|spec)\.[cm]?[jt]sx?$/.test(path)
    ? `${path}: tests must live outside src/.`
    : null;
}

function decoratorViolation(path: string, source: string, sourceLayer: Layer | null) {
  return sourceLayer === "domain" && /(^|\n)\s*@\w+/m.test(source)
    ? `${path}: framework-style decorator in domain.`
    : null;
}

function frontendPersistenceViolation(
  path: string,
  source: string,
  segments: string[],
): string | null {
  return segments.includes("frontend") &&
    /(?:drizzle|bun:sqlite|better-sqlite3|node:sqlite)/i.test(source)
    ? `${path}: frontend cannot access persistence directly.`
    : null;
}

export function sourceRuleViolations(
  path: string,
  source: string,
  sourceLayer: Layer | null,
): string[] {
  const segments = path.split("/");

  return [
    productionRootViolation(path, segments),
    contextLayerViolation(path, segments),
    applicationSurfaceViolation(path, segments),
    misplacedTestViolation(path),
    decoratorViolation(path, source, sourceLayer),
    frontendPersistenceViolation(path, source, segments),
  ].filter((violation): violation is string => violation !== null);
}

function domainLayerViolation(
  path: string,
  sourceLayer: Layer | null,
  targetLayer: Layer | null,
  specifier: string,
): string | null {
  return sourceLayer === "domain" && targetLayer !== null && targetLayer !== "domain"
    ? `${path}: domain cannot import ${targetLayer} (${specifier}).`
    : null;
}

function applicationLayerViolation(
  path: string,
  sourceLayer: Layer | null,
  targetLayer: Layer | null,
  specifier: string,
): string | null {
  return sourceLayer === "application" && targetLayer === "infrastructure"
    ? `${path}: application cannot import infrastructure (${specifier}).`
    : null;
}

function domainFrameworkViolation(
  path: string,
  sourceLayer: Layer | null,
  specifier: string,
): string | null {
  return sourceLayer === "domain" &&
    /(?:express|fastify|nestjs|@nestjs|typeorm|prisma|sequelize|mongoose|react)/i.test(specifier)
    ? `${path}: domain imports framework package ${specifier}.`
    : null;
}

export function importRuleViolations(
  path: string,
  sourceLayer: Layer | null,
  targetLayer: Layer | null,
  specifier: string,
): string[] {
  return [
    domainLayerViolation(path, sourceLayer, targetLayer, specifier),
    applicationLayerViolation(path, sourceLayer, targetLayer, specifier),
    domainFrameworkViolation(path, sourceLayer, specifier),
  ].filter((violation): violation is string => violation !== null);
}

export function mirroredSourcePath(testFile: string): string | null {
  const segments = testFile.split("/");
  const testRoot = segments.findIndex((segment) => ["test", "tests"].includes(segment));

  if (testRoot < 0) {
    return null;
  }

  return [...segments.slice(0, testRoot), "src", ...segments.slice(testRoot + 1)]
    .join("/")
    .replace(/\.(?:test|spec)(?=\.[^.]+$)/, "");
}
