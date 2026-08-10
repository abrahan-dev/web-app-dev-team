import { describe, expect, test } from "bun:test";
import {
  compareSemanticVersions,
  validateReleaseVersion,
} from "../../scripts/validate-release-version.ts";

describe("npm release version", () => {
  test("accepts equal and greater versions", () => {
    expect(() => validateReleaseVersion("0.1.0-beta.2", "0.1.0-beta.2")).not.toThrow();
    expect(() => validateReleaseVersion("0.1.0-beta.2", "0.1.0-beta.3")).not.toThrow();
    expect(() => validateReleaseVersion("0.1.0-beta.3", "0.1.0")).not.toThrow();
    expect(() => validateReleaseVersion("0.1.0", "0.1.1")).not.toThrow();
  });

  test("rejects lower versions", () => {
    expect(() => validateReleaseVersion("0.1.0-beta.2", "0.0.1-beta.1")).toThrow(
      "must be equal to or greater",
    );
    expect(() => validateReleaseVersion("0.1.0-beta.3", "0.1.0-beta.2")).toThrow(
      "must be equal to or greater",
    );
    expect(() => validateReleaseVersion("0.1.0", "0.1.0-rc.1")).toThrow(
      "must be equal to or greater",
    );
  });

  test("uses semantic prerelease precedence", () => {
    expect(compareSemanticVersions("1.0.0-alpha.1", "1.0.0-alpha.beta")).toBe(-1);
    expect(compareSemanticVersions("1.0.0-beta.11", "1.0.0-rc.1")).toBe(-1);
    expect(compareSemanticVersions("1.0.0+build.2", "1.0.0+build.1")).toBe(0);
  });

  test("rejects invalid semantic versions", () => {
    expect(() => validateReleaseVersion("0.1.0", "ieowjflksdjf")).toThrow(
      "Invalid semantic version",
    );
    expect(() => validateReleaseVersion("0.1.0", "01.0.0")).toThrow("Invalid semantic version");
    expect(() => validateReleaseVersion("0.1.0", "1.0.0-beta.01")).toThrow(
      "Invalid semantic version",
    );
  });
});
