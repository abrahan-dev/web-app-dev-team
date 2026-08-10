interface SemanticVersion {
  core: [bigint, bigint, bigint];
  prerelease: string[];
}

function parseSemanticVersion(value: string): SemanticVersion {
  const match =
    /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.exec(
      value,
    );

  if (!match?.[1] || !match[2] || !match[3]) {
    throw new Error(`Invalid semantic version: ${value}`);
  }

  const prerelease = match[4]?.split(".") ?? [];
  const invalidNumericIdentifier = prerelease.find(
    (identifier) => /^\d+$/.test(identifier) && identifier.length > 1 && identifier.startsWith("0"),
  );

  if (invalidNumericIdentifier) {
    throw new Error(`Invalid semantic version: ${value}`);
  }

  return {
    core: [BigInt(match[1]), BigInt(match[2]), BigInt(match[3])],
    prerelease,
  };
}

function compareIdentifiers(left: string, right: string): number {
  const leftIsNumeric = /^\d+$/.test(left);
  const rightIsNumeric = /^\d+$/.test(right);

  if (leftIsNumeric && rightIsNumeric) {
    const leftNumber = BigInt(left);
    const rightNumber = BigInt(right);

    return leftNumber < rightNumber ? -1 : leftNumber > rightNumber ? 1 : 0;
  }

  if (leftIsNumeric !== rightIsNumeric) {
    return leftIsNumeric ? -1 : 1;
  }

  return left < right ? -1 : left > right ? 1 : 0;
}

export function compareSemanticVersions(leftValue: string, rightValue: string): number {
  const left = parseSemanticVersion(leftValue);
  const right = parseSemanticVersion(rightValue);

  for (let index = 0; index < left.core.length; index += 1) {
    const leftPart = left.core[index]!;
    const rightPart = right.core[index]!;

    if (leftPart !== rightPart) {
      return leftPart < rightPart ? -1 : 1;
    }
  }

  if (left.prerelease.length === 0 || right.prerelease.length === 0) {
    if (left.prerelease.length === right.prerelease.length) {
      return 0;
    }

    return left.prerelease.length === 0 ? 1 : -1;
  }

  const identifierCount = Math.max(left.prerelease.length, right.prerelease.length);

  for (let index = 0; index < identifierCount; index += 1) {
    const leftIdentifier = left.prerelease[index];
    const rightIdentifier = right.prerelease[index];

    if (leftIdentifier === undefined || rightIdentifier === undefined) {
      return leftIdentifier === undefined ? -1 : 1;
    }

    const comparison = compareIdentifiers(leftIdentifier, rightIdentifier);

    if (comparison !== 0) {
      return comparison;
    }
  }

  return 0;
}

export function validateReleaseVersion(currentVersion: string, releaseVersion: string): void {
  if (compareSemanticVersions(releaseVersion, currentVersion) < 0) {
    throw new Error(
      `Release version ${releaseVersion} must be equal to or greater than current version ${currentVersion}.`,
    );
  }
}

if (import.meta.main) {
  const [currentVersion, releaseVersion] = process.argv.slice(2);

  if (!currentVersion || !releaseVersion) {
    console.error("Usage: validate-release-version <current-version> <release-version>");
    process.exit(1);
  }

  try {
    validateReleaseVersion(currentVersion, releaseVersion);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
