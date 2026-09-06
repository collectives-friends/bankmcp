// Command line entry points, also used by the launchd schedule:
//   npm run sync            fetch from the banks and rebuild the ledger
//   npm run briefing        generate (and deliver) the weekly briefing
//   node src/cli.ts process   rebuild the ledger without calling the banks
//   node src/cli.ts schedule install|remove   manage the launchd jobs
import { isConfigured, setupProblems } from "./config.ts";
import { syncAll } from "./sync.ts";
import { postProcess } from "./pipeline.ts";
import { generateBriefing } from "./briefing.ts";
import { installSchedule, removeSchedule } from "./schedule.ts";

const [command, ...rest] = process.argv.slice(2);
const flags = new Set(rest.filter((a) => a.startsWith("--")));
const arg = rest.find((a) => !a.startsWith("--"));

function needsBank() {
  if (!isConfigured()) {
    console.error("Not configured:\n  - " + setupProblems().join("\n  - "));
    process.exit(1);
  }
}

switch (command) {
  case "sync": {
    needsBank();
    const { results, pipeline } = await syncAll();
    for (const r of results) {
      console.log(r.error ? `✗ ${r.name ?? r.accountUid}: ${r.error}` : `✓ ${r.name ?? r.accountUid}: ${r.transactions} transactions`);
    }
    console.log(`ledger: ${pipeline.internalPairs} transfer pairs, ${pipeline.ruleCategorized} categorized by rules, ${pipeline.ai.applied} by AI${pipeline.ai.skipped ? ` (${pipeline.ai.skipped})` : ""}, ${pipeline.recurring} recurring items`);
    break;
  }
  case "process": {
    const p = await postProcess({ ai: !flags.has("--no-ai"), reset: flags.has("--reset") });
    console.log(JSON.stringify(p, null, 2));
    break;
  }
  case "briefing": {
    const b = await generateBriefing({ deliver: !flags.has("--no-deliver") });
    console.log(b.markdown);
    console.log(b.delivered ? "\n(delivered to webhook)" : "\n(not delivered: set BRIEFING_WEBHOOK_URL to post to Slack)");
    break;
  }
  case "schedule": {
    if (arg === "remove") console.log(removeSchedule());
    else console.log(installSchedule());
    break;
  }
  default:
    console.error("Usage: node src/cli.ts <sync | process [--no-ai] [--reset] | briefing [--no-deliver] | schedule [install|remove]>");
    process.exit(1);
}
