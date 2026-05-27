#!/usr/bin/env node
// Clawd Desktop Pet — Copilot CLI Hook Script
// Usage: node copilot-hook.js <event_name>

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

runHook("copilot-cli", EVENT_TO_STATE, {
  sessionIdKeys: ["sessionId", "session_id"],
  agentProcessNames: {
    win: ["copilot.exe"],
    mac: ["copilot"],
  },
  agentNodePattern: "@github/copilot",
  preResolveEvent: "sessionStart",
});
