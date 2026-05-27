#!/usr/bin/env node
// Clawd Desktop Pet — Claude Code Hook Script
// Usage: node clawd-hook.js <event_name>

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
  // PermissionRequest is handled by HTTP hook (blocking) — not command hook
  Elicitation: "notification",
  WorktreeCreate: "carrying",
};

runHook("claude-code", EVENT_TO_STATE, {
  agentProcessNames: {
    win: ["claude.exe"],
    mac: ["claude"],
  },
  agentNodePattern: ["claude-code", "@anthropic-ai"],
  preResolveEvent: "SessionStart",
  remoteSupport: true,
  headlessPattern: /\s(-p|--print)(\s|$)/,
  backwardCompatPidKey: "claude_pid",
  stateResolver(state, hookEvent, payload) {
    const source = payload.source || payload.reason || "";
    if (hookEvent === "SessionEnd" && source === "clear") return "sweeping";
    return state;
  },
});
