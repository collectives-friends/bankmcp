// Talk to your bank with a local model. Bridges an Ollama model (or any
// OpenAI-style chat endpoint with tool calling) to the BankMCP™ tools over stdio,
// so nothing about your accounts ever reaches a model provider.
//
//   npm run chat -- "what's my balance?"      one question
//   npm run chat                              interactive
//
// Env: OLLAMA_URL (default http://127.0.0.1:11434), OLLAMA_MODEL (default qwen3:8b)
import { createInterface } from "node:readline/promises";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const OLLAMA = (process.env.OLLAMA_URL ?? "http://127.0.0.1:11434").replace(/\/+$/, "");
const MODEL = process.env.OLLAMA_MODEL ?? "qwen3:8b";

const mcp = new Client({ name: "bank-local-chat", version: "0.1.0" });
await mcp.connect(new StdioClientTransport({ command: process.execPath, args: ["--env-file-if-exists=.env", "src/stdio.ts"], stderr: "inherit" }));
const { tools } = await mcp.listTools();

const ollamaTools = tools.map((t) => ({ type: "function", function: { name: t.name, description: t.description ?? "", parameters: t.inputSchema } }));

type Msg = { role: "system" | "user" | "assistant" | "tool"; content: string; tool_calls?: Array<{ function: { name: string; arguments: Record<string, unknown> | string } }>; tool_name?: string };

const system = [
  mcp.getInstructions() ?? "",
  "You are a careful personal-finance assistant with read-only access to the user's own bank accounts through tools.",
  "Always fetch data with tools before answering about money; never guess numbers. Call list_accounts first if you do not know the accounts.",
  "Transaction amounts are signed: negative is money out. Sum carefully and show your working in one line when you total anything.",
  `Today is ${new Date().toISOString().slice(0, 10)}.`,
].join("\n");

async function chat(messages: Msg[]): Promise<Msg> {
  const res = await fetch(`${OLLAMA}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: MODEL, messages, tools: ollamaTools, stream: false, options: { temperature: 0.2 } }),
  });
  if (!res.ok) throw new Error(`Ollama ${res.status}: ${await res.text()}`);
  const data = (await res.json()) as { message: Msg };
  return data.message;
}

async function ask(history: Msg[], question: string): Promise<string> {
  history.push({ role: "user", content: question });
  for (let step = 0; step < 12; step++) {
    const reply = await chat(history);
    history.push(reply);
    if (!reply.tool_calls?.length) return reply.content;
    for (const call of reply.tool_calls) {
      const args = typeof call.function.arguments === "string" ? JSON.parse(call.function.arguments || "{}") : (call.function.arguments ?? {});
      process.stderr.write(`  → ${call.function.name}(${JSON.stringify(args)})\n`);
      let text: string;
      try {
        const result = await mcp.callTool({ name: call.function.name, arguments: args });
        text = (result.content as Array<{ type: string; text?: string }>).map((c) => c.text ?? "").join("\n");
        // Keep very large tool results within a small model's context.
        if (text.length > 24_000) text = text.slice(0, 24_000) + "\n…(truncated; ask for a narrower date range)";
      } catch (err) {
        text = `Tool error: ${(err as Error).message}`;
      }
      history.push({ role: "tool", content: text, tool_name: call.function.name });
    }
  }
  return "I ran out of steps. Try a narrower question.";
}

const history: Msg[] = [{ role: "system", content: system }];
const oneShot = process.argv.slice(2).join(" ").trim();
if (oneShot) {
  console.log(await ask(history, oneShot));
} else {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  console.log(`BankMCP™ · local model ${MODEL} · ${tools.length} tools. Ctrl-C to quit.`);
  for (;;) {
    const q = (await rl.question("\n> ")).trim();
    if (!q) continue;
    console.log("\n" + (await ask(history, q)));
  }
}
