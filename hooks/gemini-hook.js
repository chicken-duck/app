#!/usr/bin/env node

const { runHook } = require("./hook-common");

const EVENT_TO_STATE = {
  SessionStart: { state: "idle", event: "SessionStart" },
  SessionEnd: { state: "sleeping", event: "SessionEnd" },
  BeforeAgent: { state: "thinking", event: "UserPromptSubmit" },
  BeforeTool: { state: "working", event: "PreToolUse" },
  AfterTool: { state: "working", event: "PostToolUse" },
  AfterAgent: { state: "attention", event: "Stop" },
  Notification: { state: "notification", event: "Notification" },
  PreCompress: { state: "sweeping", event: "PreCompact" },
};

runHook("gemini-cli", EVENT_TO_STATE);
