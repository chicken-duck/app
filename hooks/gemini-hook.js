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

runHook("gemini-cli", HOOK_MAP);