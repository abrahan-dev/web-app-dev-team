import { afterEach, expect, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { checkArchitecture } from "../../../src/infrastructure/quality/architecture-guard.ts";
import { TemporaryWorkspaceManager } from "../../support/temporary-workspaces.ts";

const temporary = new TemporaryWorkspaceManager();

afterEach(async () => {
  await temporary.cleanup();
});

test("detects forbidden layer imports, domain frameworks, cycles and misplaced tests", async () => {
  const root = await temporary.create("web-app-dev-team-architecture-");
  await mkdir(resolve(root, "src", "orders", "domain"), { recursive: true });
  await mkdir(resolve(root, "src", "orders", "infrastructure"), {
    recursive: true,
  });
  await writeFile(
    resolve(root, "src", "orders", "domain", "order.ts"),
    'import "typeorm";\nimport "../infrastructure/store.ts";\nimport "./cycle.ts";\n@Entity\nexport class Order {}\n',
  );
  await writeFile(
    resolve(root, "src", "orders", "domain", "cycle.ts"),
    'import "./order.ts";\nexport const cycle = true;\n',
  );
  await writeFile(
    resolve(root, "src", "orders", "infrastructure", "store.ts"),
    "export const store = {};\n",
  );
  await writeFile(resolve(root, "src", "orders", "domain", "order.test.ts"), "export {};\n");

  const violations = await checkArchitecture(root);

  expect(violations.some((value) => value.includes("domain cannot import infrastructure"))).toBe(
    true,
  );
  expect(violations.some((value) => value.includes("domain imports framework package"))).toBe(true);
  expect(violations.some((value) => value.includes("Circular dependency"))).toBe(true);
  expect(violations.some((value) => value.includes("tests must live outside src"))).toBe(true);
});

test("enforces context/app topology and prevents frontend persistence access", async () => {
  const root = await temporary.create("web-app-dev-team-topology-");
  await mkdir(resolve(root, "src", "misc"), { recursive: true });
  await mkdir(resolve(root, "src", "contexts", "orders", "wrong-layer"), {
    recursive: true,
  });
  await mkdir(resolve(root, "src", "apps", "operations", "frontend"), {
    recursive: true,
  });
  await writeFile(resolve(root, "src", "misc", "loose.ts"), "export {};\n");
  await writeFile(
    resolve(root, "src", "contexts", "orders", "wrong-layer", "order.ts"),
    "export {};\n",
  );
  await writeFile(
    resolve(root, "src", "apps", "operations", "frontend", "db.ts"),
    'import { Database } from "bun:sqlite";\nexport { Database };\n',
  );

  const violations = await checkArchitecture(root);

  expect(violations.some((value) => value.includes("src/contexts or src/apps"))).toBe(true);
  expect(violations.some((value) => value.includes("must select application"))).toBe(true);
  expect(violations.some((value) => value.includes("frontend cannot access"))).toBe(true);
});
