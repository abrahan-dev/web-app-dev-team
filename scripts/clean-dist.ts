import { rm } from "node:fs/promises";
import { resolve } from "node:path";

const distributionDirectory = resolve(import.meta.dir, "../dist");

await rm(distributionDirectory, { force: true, recursive: true });
