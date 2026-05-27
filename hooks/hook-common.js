#!/usr/bin/env node
const { postStateToRunningServer, readHostPrefix } = require("./server-config");

const TERMINAL_NAMES_WIN = new Set([
  "windowsterminal.exe", "cmd.exe", "powershell.exe", "pwsh.exe",
  "code.exe", "alacritty.exe", "wezterm-gui.exe", "mintty.exe",
  "conemu64.exe", "conemu.exe", "hyper.exe", "tabby.exe",
  "antigravity.exe", "warp.exe", "iterm.exe", "ghostty.exe",
]);
const TERMINAL_NAMES_MAC = new Set([
  "terminal", "iterm2", "alacritty", "wezterm-gui", "kitty",
  "hyper", "tabby", "warp", "ghostty",
]);
const TERMINAL_NAMES_LINUX = new Set([
  "gnome-terminal", "kgx", "konsole", "xfce4-terminal", "tilix",
  "alacritty", "wezterm", "wezterm-gui", "kitty", "ghostty",
  "xterm", "lxterminal", "terminator", "tabby", "hyper", "warp",
]);

const SYSTEM_BOUNDARY_WIN = new Set(["explorer.exe", "services.exe", "winlogon.exe", "svchost.exe"]);
const SYSTEM_BOUNDARY_MAC = new Set(["launchd", "init", "systemd"]);
const SYSTEM_BOUNDARY_LINUX = new Set(["systemd", "init"]);

const EDITOR_MAP_WIN = { "code.exe": "code", "cursor.exe": "cursor" };
const EDITOR_MAP_MAC = { "code": "code", "cursor": "cursor" };
const EDITOR_MAP_LINUX = { "code": "code", "cursor": "cursor", "code-insiders": "code" };

function resolveMapping(eventMap, hookEvent) {
  const mapped = eventMap[hookEvent];
  if (!mapped) return null;
  if (typeof mapped === "string") return { state: mapped, event: hookEvent };
  return { state: mapped.state, event: mapped.event || hookEvent };
}

function createPidWalker(agentProcessNames, agentNodePattern, headlessPattern) {
  const isWin = process.platform === "win32";
  const isLinux = process.platform === "linux";

  const terminalNames = isWin ? TERMINAL_NAMES_WIN : (isLinux ? TERMINAL_NAMES_LINUX : TERMINAL_NAMES_MAC);
  const systemBoundary = isWin ? SYSTEM_BOUNDARY_WIN : (isLinux ? SYSTEM_BOUNDARY_LINUX : SYSTEM_BOUNDARY_MAC);
  const editorMap = isWin ? EDITOR_MAP_WIN : (isLinux ? EDITOR_MAP_LINUX : EDITOR_MAP_MAC);

  const rawAgentNames = isWin
    ? (agentProcessNames.win || [])
    : (isLinux ? (agentProcessNames.linux || []) : (agentProcessNames.mac || []));
  const agentNameSet = rawAgentNames instanceof Set ? rawAgentNames : new Set(rawAgentNames);

  const nodePatterns = agentNodePattern
    ? (Array.isArray(agentNodePattern) ? agentNodePattern : [agentNodePattern])
    : null;

  let _stablePid = null;
  let _detectedEditor = null;
  let _agentPid = null;
  let _pidChain = [];
  let _isHeadless = false;

  function getStablePid() {
    if (_stablePid) return _stablePid;
    const { execSync } = require("child_process");
    let pid = process.ppid;
    let lastGoodPid = pid;
    let terminalPid = null;
    _pidChain = [];
    _detectedEditor = null;
    _agentPid = null;
    _isHeadless = false;

    for (let i = 0; i < 8; i++) {
      let name, parentPid;
      try {
        if (isWin) {
          const out = execSync(
            `wmic process where "ProcessId=${pid}" get Name,ParentProcessId /format:csv`,
            { encoding: "utf8", timeout: 1500, windowsHide: true }
          );
          const lines = out.trim().split("\n").filter(l => l.includes(","));
          if (!lines.length) break;
          const parts = lines[lines.length - 1].split(",");
          name = (parts[1] || "").trim().toLowerCase();
          parentPid = parseInt(parts[2], 10);
        } else {
          const cp = require("child_process");
          const ppidOut = cp.execSync(`ps -o ppid= -p ${pid}`, { encoding: "utf8", timeout: 1000 }).trim();
          const commOut = cp.execSync(`ps -o comm= -p ${pid}`, { encoding: "utf8", timeout: 1000 }).trim();
          name = require("path").basename(commOut).toLowerCase();
          if (!_detectedEditor) {
            const fullLower = commOut.toLowerCase();
            if (fullLower.includes("visual studio code")) _detectedEditor = "code";
            else if (fullLower.includes("cursor.app")) _detectedEditor = "cursor";
          }
          parentPid = parseInt(ppidOut, 10);
        }
      } catch { break; }

      _pidChain.push(pid);
      if (!_detectedEditor && editorMap[name]) _detectedEditor = editorMap[name];

      if (!_agentPid) {
        if (agentNameSet.has(name)) {
          _agentPid = pid;
        } else if (nodePatterns && (name === "node.exe" || name === "node")) {
          try {
            const cmdOut = isWin
              ? execSync(`wmic process where "ProcessId=${pid}" get CommandLine /format:csv`,
                  { encoding: "utf8", timeout: 500, windowsHide: true })
              : execSync(`ps -o command= -p ${pid}`, { encoding: "utf8", timeout: 500 });
            if (nodePatterns.some(p => cmdOut.includes(p))) _agentPid = pid;
          } catch {}
        }
      }

      if (systemBoundary.has(name)) break;
      if (terminalNames.has(name)) terminalPid = pid;
      lastGoodPid = pid;
      if (!parentPid || parentPid === pid || parentPid <= 1) break;
      pid = parentPid;
    }

    if (_agentPid && headlessPattern) {
      try {
        const cmdOut = isWin
          ? execSync(
              `wmic process where "ProcessId=${_agentPid}" get CommandLine /format:csv`,
              { encoding: "utf8", timeout: 500, windowsHide: true }
            )
          : execSync(`ps -o command= -p ${_agentPid}`, { encoding: "utf8", timeout: 500 });
        if (headlessPattern.test(cmdOut)) _isHeadless = true;
      } catch {}
    }

    _stablePid = terminalPid || lastGoodPid;
    return _stablePid;
  }

  return {
    getStablePid,
    get detectedEditor() { return _detectedEditor; },
    get agentPid() { return _agentPid; },
    get pidChain() { return _pidChain; },
    get isHeadless() { return _isHeadless; },
  };
}

function runHook(agentId, eventMap, options) {
  const {
    eventSource = "argv",
    sessionIdKeys = ["session_id"],
    agentProcessNames = {},
    agentNodePattern = null,
    preResolveEvent = null,
    remoteSupport = false,
    headlessPattern = null,
    backwardCompatPidKey = null,
    stateResolver = null,
    stdoutForEvent = null,
  } = options || {};

  let hookEvent;
  if (eventSource === "argv") {
    hookEvent = process.argv[2];
  }

  if (eventSource === "argv") {
    if (!resolveMapping(eventMap, hookEvent)) process.exit(0);
  }

  const walker = createPidWalker(agentProcessNames, agentNodePattern, headlessPattern);

  if (eventSource === "argv" && preResolveEvent && hookEvent === preResolveEvent && !process.env.CLAWD_REMOTE) {
    walker.getStablePid();
  }

  const chunks = [];
  let sent = false;
  let stdinTimer = null;

  process.stdin.on("data", (c) => chunks.push(c));
  process.stdin.on("end", () => {
    let payload = {};
    try {
      const raw = Buffer.concat(chunks).toString();
      if (raw.trim()) payload = JSON.parse(raw);
    } catch {}
    finish(payload);
  });

  stdinTimer = setTimeout(() => finish({}), 400);

  function finish(payload) {
    if (sent) return;
    sent = true;
    if (stdinTimer) clearTimeout(stdinTimer);

    if (eventSource !== "argv") {
      hookEvent = payload[eventSource.stdinKey] || "";
    }

    const mapping = resolveMapping(eventMap, hookEvent);

    if (!mapping) {
      if (stdoutForEvent) {
        process.stdout.write(stdoutForEvent(hookEvent) + "\n");
      }
      process.exit(0);
      return;
    }

    if (eventSource !== "argv" && preResolveEvent && hookEvent === preResolveEvent && !process.env.CLAWD_REMOTE) {
      walker.getStablePid();
    }

    let { state, event } = mapping;

    if (stateResolver) {
      state = stateResolver(state, hookEvent, payload);
    }

    let sessionId = "default";
    for (const key of sessionIdKeys) {
      if (payload[key]) { sessionId = payload[key]; break; }
    }

    const cwd = payload.cwd || "";

    const body = { state, session_id: sessionId, event };
    body.agent_id = agentId;
    if (cwd) body.cwd = cwd;

    if (remoteSupport && process.env.CLAWD_REMOTE) {
      body.host = readHostPrefix();
    } else {
      body.source_pid = walker.getStablePid();
      if (walker.detectedEditor) body.editor = walker.detectedEditor;
      if (walker.agentPid) {
        body.agent_pid = walker.agentPid;
        if (backwardCompatPidKey) body[backwardCompatPidKey] = walker.agentPid;
      }
      if (walker.pidChain.length) body.pid_chain = walker.pidChain;
      if (walker.isHeadless) body.headless = true;
    }

    const data = JSON.stringify(body);

    const onDone = () => {
      if (stdoutForEvent) {
        process.stdout.write(stdoutForEvent(hookEvent) + "\n");
      }
      process.exit(0);
    };

    postStateToRunningServer(data, { timeoutMs: 100 }, onDone);
  }
}

module.exports = { runHook };
