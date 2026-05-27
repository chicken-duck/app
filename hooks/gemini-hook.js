#!/usr/bin/env node
// Clawd — Gemini CLI hook (stdin JSON with hook_event_name; stdout JSON for gating hooks)
// Registered in ~/.gemini/settings.json by hooks/gemini-install.js

const { runHook } = require("./hook-common");

// Gemini hook event → { state, event } for the Clawd state machine
const HOOK_MAP = {
  SessionStart:  { state: "idle",         event: "SessionStart" },
  SessionEnd:    { state: "sleeping",     event: "SessionEnd" },
  BeforeAgent:   { state: "thinking",     event: "UserPromptSubmit" },
  BeforeTool:    { state: "working",      event: "PreToolUse" },
  AfterTool:     { state: "working",      event: "PostToolUse" },
  AfterAgent:    { state: "attention",    event: "Stop" },
  Notification:  { state: "notification", event: "Notification" },
  PreCompress:   { state: "sweeping",     event: "PreCompact" },
};

// Gemini CLI gating hooks need stdout JSON response
function stdoutForEvent(hookName) {
  if (hookName === "BeforeTool") {
    return JSON.stringify({ decision: "allow" });
  }
  if (hookName === "BeforeAgent") {
    return JSON.stringify({});
  }
  return "{}";
}

runHook({
  agentId: "gemini-cli",
  eventMap: (hookName) => HOOK_MAP[hookName],
  agentNames: {
    win: new Set(["gemini.exe"]),
    mac: new Set(["gemini"]),
    linux: new Set(["gemini"]),
  },
  remoteSupport: true,
  stdoutHandler: stdoutForEvent,
});
