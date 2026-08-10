import { open, stat } from "node:fs/promises";
import { resolve } from "node:path";

const runDirectory = process.argv[2];

if (!runDirectory) {
  throw new Error("Usage: watch-summary <run-directory>");
}

const logPath = resolve(runDirectory, "logs", "summary.log");
const pane = process.env.TMUX_PANE;
let offset = 0;

console.log("\u001b[1;36m╭──────────────────────────────────────────────╮");
console.log("│  WEB APP DEV TEAM · RUN SUMMARY              │");
console.log("╰──────────────────────────────────────────────╯\u001b[0m");
console.log("Important workflow events appear here.\n");

if (pane) {
  Bun.spawnSync(["tmux", "select-pane", "-t", pane, "-T", "RUN SUMMARY"], {
    stderr: "ignore",
    stdout: "ignore",
  });
}

while (true) {
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
