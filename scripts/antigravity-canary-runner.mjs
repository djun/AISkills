#!/usr/bin/env node
/**
 * Thin adapter: odai canary harness -> Antigravity CLI runner.
 * Keeps the stream-json trace, writes the final response, and emits a token
 * footer understood by the harness.
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";

function parseArgs(argv) {
  const args = {
    promptFile: "",
    cwd: process.cwd(),
    lastMessage: "",
    model: process.env.ODAI_ANTIGRAVITY_MODEL || "gemini-3.6-flash-high",
    effort: process.env.ODAI_ANTIGRAVITY_EFFORT || "high",
    bin: process.env.ODAI_ANTIGRAVITY_COMMAND || "agy",
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--prompt-file") args.promptFile = argv[++i];
    else if (arg === "--cwd") args.cwd = argv[++i];
    else if (arg === "--last-message") args.lastMessage = argv[++i];
    else if (arg === "--model") args.model = argv[++i];
    else if (arg === "--effort") args.effort = argv[++i];
    else if (arg === "--bin") args.bin = argv[++i];
    else throw new Error(`Unknown argument: ${arg}`);
  }
  if (!args.promptFile || !existsSync(args.promptFile)) throw new Error("--prompt-file is required");
  if (!args.lastMessage) throw new Error("--last-message is required");
  return args;
}

const args = parseArgs(process.argv.slice(2));
const prompt = readFileSync(args.promptFile, "utf8");
const result = spawnSync(
  args.bin,
  [
    "-p", prompt,
    "--new-project",
    "--add-dir", args.cwd,
    "--model", args.model,
    "--effort", args.effort,
    "--output-format", "stream-json",
    "--dangerously-skip-permissions",
    "--disable-slash-commands",
    "--print-timeout", "14m",
  ],
  {
    cwd: args.cwd,
    encoding: "utf8",
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
    env: process.env,
    maxBuffer: 64 * 1024 * 1024,
  },
);

const stdout = result.stdout || "";
const stderr = result.stderr || "";
process.stdout.write(stdout);
process.stderr.write(stderr);

let finalText = "";
let actualModel = "";
let totalTokens = null;
let resultStatus = "";
for (const line of stdout.split(/\r?\n/)) {
  if (!line.trim().startsWith("{")) continue;
  let event;
  try { event = JSON.parse(line); } catch { continue; }
  if (event.event === "init" && typeof event.init?.model === "string") actualModel = event.init.model;
  if (event.event === "result" && event.result && typeof event.result === "object") {
    resultStatus = String(event.result.status || "");
    if (typeof event.result.response === "string") finalText = event.result.response;
    if (Number.isSafeInteger(event.result.usage?.total_tokens)) totalTokens = event.result.usage.total_tokens;
  }
}

if (result.status === 0 && resultStatus === "SUCCESS" && finalText) {
  writeFileSync(args.lastMessage, finalText.endsWith("\n") ? finalText : `${finalText}\n`, "utf8");
} else {
  process.stderr.write("\n[antigravity-runner error: no successful final response]\n");
}

process.stdout.write(`\n[antigravity-runner requested_model ${args.model}]\n`);
if (actualModel) process.stdout.write(`[antigravity-runner actual_model ${actualModel}]\n`);
process.stdout.write(`[antigravity-runner effort ${args.effort}]\n`);
if (totalTokens != null) process.stdout.write(`\ntokens used\n${totalTokens.toLocaleString("en-US")}\n`);

process.exitCode = result.status === 0 && resultStatus === "SUCCESS" && finalText ? 0 : 1;
