#!/usr/bin/env node
// Clawd Desktop Pet — Copilot CLI Hook Script
// Zero dependencies, fast cold start, 1s timeout
// Usage: node copilot-hook.js <event_name>
// Reads stdin JSON from Copilot CLI for sessionId (camelCase)

const { runHook } = require("./hook-common");

const EVENT_TO_STATE = {
  sessionStart: "idle",
  sessionEnd: "sleeping",
  userPromptSubmitted: "thinking",
  preToolUse: "working",
  postToolUse: "working",
  errorOccurred: "error",
  agentStop: "attention",
  subagentStart: "juggling",
  subagentStop: "working",
  preCompact: "sweeping",
};

runHook({
  agentId: "copilot-cli",
  eventMap: EVENT_TO_STATE,
  agentNames: {
    win: new Set(["copilot.exe"]),
    mac: new Set(["copilot"]),
    linux: new Set(["copilot"]),
    nodeCommandCheck: (cmd) => cmd.includes("@github/copilot"),
  },
  startEvent: "sessionStart",
});
