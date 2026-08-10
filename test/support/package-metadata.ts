import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const metadata = JSON.parse(
  readFileSync(resolve(import.meta.dir, "../../package.json"), "utf8"),
) as {
  version: string;
};

export const expectedPackageVersion = metadata.version;
