#!/usr/bin/env node
// Clawd — Gemini CLI hook (stdin JSON with hook_event_name; stdout JSON for gating hooks)
// Registered in ~/.gemini/settings.json by hooks/gemini-install.js

const { runHook } = require("./hook-common");

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

function stdoutForEvent(hookName) {
  if (hookName === "BeforeTool") return JSON.stringify({ decision: "allow" });
  if (hookName === "BeforeAgent") return JSON.stringify({});
  return "{}";
}

runHook("gemini-cli", HOOK_MAP, {
  eventSource: { stdinKey: "hook_event_name" },
  agentProcessNames: {
    win: ["gemini.exe"],
    mac: ["gemini"],
    linux: ["gemini"],
  },
  preResolveEvent: "SessionStart",
  remoteSupport: true,
  stdoutForEvent,
});
