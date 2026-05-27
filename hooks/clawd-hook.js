#!/usr/bin/env node
// Clawd Desktop Pet — Claude Code Hook Script
// Zero dependencies, fast cold start, 1s timeout
// Usage: node clawd-hook.js <event_name>
// Reads stdin JSON from Claude Code for session_id

const { runHook } = require("./hook-common");

const EVENT_TO_STATE = {
  SessionStart: "idle",
  SessionEnd: "sleeping",
  UserPromptSubmit: "thinking",
  PreToolUse: "working",
  PostToolUse: "working",
  PostToolUseFailure: "error",
  Stop: "attention",
  StopFailure: "error",
  SubagentStart: "juggling",
  SubagentStop: "working",
  PreCompact: "sweeping",
  PostCompact: "attention",
  Notification: "notification",
  Elicitation: "notification",
  WorktreeCreate: "carrying",
};

runHook({
  agentId: "claude-code",
  eventMap: EVENT_TO_STATE,
  agentNames: {
    win: new Set(["claude.exe"]),
    mac: new Set(["claude"]),
    linux: new Set(["claude"]),
    nodeCommandCheck: (cmd) => cmd.includes("claude-code") || cmd.includes("@anthropic-ai"),
  },
  startEvent: "SessionStart",
  headlessCheck: true,
  remoteSupport: true,
  stateResolver: (event, state, source) => {
    // /clear triggers SessionEnd → SessionStart in quick succession;
    // show sweeping (clearing context) instead of sleeping
    return (event === "SessionEnd" && source === "clear") ? "sweeping" : state;
  },
});
