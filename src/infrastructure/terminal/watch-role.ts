import { open, readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { roleSchema } from "../../domain/schemas.ts";
import {
  paneActivityCommand,
  paneIdentityCommands,
  roleColors,
  roleIsActive,
} from "./active-role-accent.ts";

const runDirectory = process.argv[2];
const role = roleSchema.parse(process.argv[3]);

if (!runDirectory) {
  throw new Error("Usage: watch-role <run-directory> <role>");
}

const logPath = resolve(runDirectory, "logs", `${role}.log`);
const statePath = resolve(runDirectory, "state.json");
const pane = process.env.TMUX_PANE;
let offset = 0;
let active: boolean | undefined;
const color = roleColors[role].ansi;
console.log(`\u001b[1;${color}m╭──────────────────────────────────────────────╮`);
console.log(`│  WEB APP DEV TEAM · ${role.toUpperCase().padEnd(22)}│`);
console.log("╰──────────────────────────────────────────────╯\u001b[0m");
console.log("Waiting for the development loop to start...\n");

function runTmux(command: string[]): void {
  Bun.spawnSync(command, { stderr: "ignore", stdout: "ignore" });
}

if (pane) {
  for (const command of paneIdentityCommands(pane, role)) {
    runTmux(command);
  }
}

while (true) {
  if (pane) {
    try {
      const nextActive = roleIsActive(await readFile(statePath, "utf8"), role);

      if (nextActive !== active) {
        runTmux(paneActivityCommand(pane, nextActive));
        active = nextActive;
      }
    } catch {
      // Keep the last accent while the controller replaces the state file.
    }
  }

  const info = await stat(logPath);

  if (info.size > offset) {
    const file = await open(logPath, "r");
    const buffer = Buffer.alloc(info.size - offset);
    await file.read(buffer, 0, buffer.length, offset);
    await file.close();
    process.stdout.write(buffer);
    offset = info.size;
  }

  await Bun.sleep(250);
}
