// launchd jobs so the ledger stays fresh without the UI open:
//   io.dabba.sync      every day at 07:00
//   io.dabba.briefing  Mondays at 07:30
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

const agentsDir = join(homedir(), "Library", "LaunchAgents");
const projectDir = resolve(new URL("..", import.meta.url).pathname);
const logDir = join(projectDir, "data", "logs");

const jobs = [
  { label: "io.dabba.sync", args: ["sync"], calendar: { Hour: 7, Minute: 0 } },
  { label: "io.dabba.briefing", args: ["briefing"], calendar: { Weekday: 1, Hour: 7, Minute: 30 } },
];

function plist(job: (typeof jobs)[number]): string {
  const cal = Object.entries(job.calendar)
    .map(([k, v]) => `      <key>${k}</key><integer>${v}</integer>`)
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${job.label}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${process.execPath}</string>
    <string>--env-file=.env</string>
    <string>src/cli.ts</string>
${job.args.map((a) => `    <string>${a}</string>`).join("\n")}
  </array>
  <key>WorkingDirectory</key><string>${projectDir}</string>
  <key>StartCalendarInterval</key>
  <dict>
${cal}
  </dict>
  <key>StandardOutPath</key><string>${join(logDir, `${job.label}.log`)}</string>
  <key>StandardErrorPath</key><string>${join(logDir, `${job.label}.err.log`)}</string>
  <key>EnvironmentVariables</key>
  <dict><key>PATH</key><string>/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin</string></dict>
</dict>
</plist>
`;
}

function uid(): string {
  return execFileSync("id", ["-u"]).toString().trim();
}

export function installSchedule(): string {
  mkdirSync(agentsDir, { recursive: true });
  mkdirSync(logDir, { recursive: true });
  const out: string[] = [];
  for (const job of jobs) {
    const path = join(agentsDir, `${job.label}.plist`);
    try {
      execFileSync("launchctl", ["bootout", `gui/${uid()}/${job.label}`], { stdio: "ignore" });
    } catch {
      /* not loaded yet */
    }
    writeFileSync(path, plist(job));
    execFileSync("launchctl", ["bootstrap", `gui/${uid()}`, path]);
    out.push(`${job.label}: installed (${path})`);
  }
  out.push(`Logs in ${logDir}. Remove with: node src/cli.ts schedule remove`);
  return out.join("\n");
}

export function removeSchedule(): string {
  const out: string[] = [];
  for (const job of jobs) {
    const path = join(agentsDir, `${job.label}.plist`);
    try {
      execFileSync("launchctl", ["bootout", `gui/${uid()}/${job.label}`], { stdio: "ignore" });
    } catch {
      /* not loaded */
    }
    if (existsSync(path)) unlinkSync(path);
    out.push(`${job.label}: removed`);
  }
  return out.join("\n");
}

export function scheduleStatus(): Array<{ label: string; installed: boolean }> {
  return jobs.map((j) => ({ label: j.label, installed: existsSync(join(agentsDir, `${j.label}.plist`)) }));
}
