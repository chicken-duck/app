// Clawd Desktop Pet — shared hook logic
// Zero external dependencies, fast cold start
// Exports runHook(agentId, eventMap) for use by individual hook scripts

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

// Agent-specific configuration: binary process names and node.js command-line patterns
const AGENT_NAMES = {
  "claude-code": {
    win32: new Set(["claude.exe"]),
    darwin: new Set(["claude"]),
    linux: new Set(["claude"]),
    nodePatterns: ["claude-code", "@anthropic-ai"],
    headlessFlag: true,
  },
  "copilot-cli": {
    win32: new Set(["copilot.exe"]),
    darwin: new Set(["copilot"]),
    linux: new Set(["copilot"]),
    nodePatterns: ["@github/copilot"],
    headlessFlag: false,
  },
  "gemini-cli": {
    win32: new Set(["gemini.exe"]),
    darwin: new Set(["gemini"]),
    linux: new Set(["gemini"]),
    nodePatterns: [],
    headlessFlag: false,
  },
};

// Shared state across getStablePid calls
let _stablePid = null;
let _detectedEditor = null;
let _agentPid = null;
let _pidChain = [];
let _isHeadless = false;

function getAgentNames(agentId) {
  const cfg = AGENT_NAMES[agentId];
  if (!cfg) return { names: new Set(), nodePatterns: [], headlessFlag: false };
  const platform = process.platform;
  return {
    names: cfg[platform] || new Set(),
    nodePatterns: cfg.nodePatterns || [],
    headlessFlag: cfg.headlessFlag || false,
  };
}

function getStablePid(agentId) {
  if (_stablePid) return _stablePid;
  const { execSync } = require("child_process");
  const isWin = process.platform === "win32";
  const terminalNames = isWin ? TERMINAL_NAMES_WIN : (process.platform === "linux" ? TERMINAL_NAMES_LINUX : TERMINAL_NAMES_MAC);
  const systemBoundary = isWin ? SYSTEM_BOUNDARY_WIN : (process.platform === "linux" ? SYSTEM_BOUNDARY_LINUX : SYSTEM_BOUNDARY_MAC);
  const editorMap = isWin ? EDITOR_MAP_WIN : (process.platform === "linux" ? EDITOR_MAP_LINUX : EDITOR_MAP_MAC);
  const { names: agentNames, nodePatterns, headlessFlag } = getAgentNames(agentId);
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
      if (agentNames.has(name)) {
        _agentPid = pid;
      } else if (nodePatterns.length && (name === "node.exe" || name === "node")) {
        try {
          const cmdOut = isWin
            ? execSync(`wmic process where "ProcessId=${pid}" get CommandLine /format:csv`,
                { encoding: "utf8", timeout: 500, windowsHide: true })
            : execSync(`ps -o command= -p ${pid}`, { encoding: "utf8", timeout: 500 });
          for (const pattern of nodePatterns) {
            if (cmdOut.includes(pattern)) { _agentPid = pid; break; }
          }
        } catch {}
      }
    }
    if (systemBoundary.has(name)) break;
    if (terminalNames.has(name)) terminalPid = pid;
    lastGoodPid = pid;
    if (!parentPid || parentPid === pid || parentPid <= 1) break;
    pid = parentPid;
  }
  if (_agentPid && !_isHeadless && headlessFlag) {
    try {
      const cmdOut = isWin
        ? execSync(
            `wmic process where "ProcessId=${_agentPid}" get CommandLine /format:csv`,
            { encoding: "utf8", timeout: 500, windowsHide: true }
          )
        : execSync(`ps -o command= -p ${_agentPid}`, { encoding: "utf8", timeout: 500 });
      if (/\s(-p|--print)(\s|$)/.test(cmdOut)) _isHeadless = true;
    } catch {}
  }
  _stablePid = terminalPid || lastGoodPid;
  return _stablePid;
}

function buildBody(agentId, resolvedState, resolvedEvent, sessionId, cwd, source, extraFields) {
  const body = { state: resolvedState, session_id: sessionId, event: resolvedEvent };
  body.agent_id = agentId;
  if (cwd) body.cwd = cwd;
  if (source) body.source = source;
  if (process.env.CLAWD_REMOTE) {
    body.host = readHostPrefix();
  } else {
    body.source_pid = getStablePid(agentId);
    if (_detectedEditor) body.editor = _detectedEditor;
    if (_agentPid) body.agent_pid = _agentPid;
    if (_pidChain.length) body.pid_chain = _pidChain;
    if (_isHeadless) body.headless = true;
  }
  if (extraFields) {
    for (const key of Object.keys(extraFields)) {
      if (extraFields[key] !== undefined) body[key] = extraFields[key];
    }
  }
  return body;
}

function resolveMapping(eventMap, eventKey) {
  if (!eventKey) return null;
  const entry = eventMap[eventKey];
  if (!entry) return null;
  if (typeof entry === "string") {
    return { state: entry, event: eventKey };
  }
  if (entry && typeof entry === "object" && entry.state) {
    return { state: entry.state, event: entry.event || eventKey };
  }
  return null;
}

// Gemini gating hooks need stdout responses
function stdoutForGemini(hookName) {
  if (hookName === "BeforeTool") return JSON.stringify({ decision: "allow" });
  if (hookName === "BeforeAgent") return JSON.stringify({});
  return "{}";
}

function runHook(agentId, eventMap) {
  const argvEvent = process.argv[2];
  const argvMapped = resolveMapping(eventMap, argvEvent);
  const isGemini = (agentId === "gemini-cli");

  // Pre-resolve PID on session-start-like events while stdin buffers (synchronous, ~100ms)
  if (argvMapped && !process.env.CLAWD_REMOTE) {
    const eventKey = typeof eventMap[argvEvent] === "string" ? argvEvent : ((eventMap[argvEvent] && eventMap[argvEvent].event) || argvEvent);
    if (isSessionStartLike(eventKey)) getStablePid(agentId);
  }

  const chunks = [];
  let sent = false;

  process.stdin.on("data", (c) => chunks.push(c));
  process.stdin.on("end", () => {
    let payload = {};
    try {
      const raw = Buffer.concat(chunks).toString();
      if (raw.trim()) payload = JSON.parse(raw);
    } catch {}

    const hookName = (payload && payload.hook_event_name) || "";

    // For argv-based hooks (clawd/copilot), use the argv mapping directly.
    // For gemini (no argv event), resolve from stdin hook_event_name.
    let mapped = argvMapped;
    let resolvedKey = argvEvent;
    if (isGemini) {
      mapped = resolveMapping(eventMap, hookName);
      resolvedKey = hookName;
    }

    if (!mapped) {
      if (isGemini) {
        process.stdout.write(stdoutForGemini(hookName) + "\n");
      }
      process.exit(0);
      return;
    }

    const { state: resolvedState, event: resolvedEvent } = mapped;

    if (isGemini && !process.env.CLAWD_REMOTE) {
      if (hookName === "SessionStart") getStablePid(agentId);
    }

    // Session ID: try session_id first, then sessionId (Copilot uses camelCase)
    const sessionId = (payload && (payload.session_id || payload.sessionId)) || "default";
    const cwd = (payload && payload.cwd) || "";
    const source = (payload && (payload.source || payload.reason)) || "";

    // clawd-specific: /clear triggers sweeping instead of sleeping
    const finalState = (agentId === "claude-code" && resolvedState === "sleeping" && source === "clear")
      ? "sweeping"
      : resolvedState;

    const extraFields = {};
    if (agentId === "claude-code" && _agentPid) {
      extraFields.claude_pid = _agentPid;
    }

    const body = buildBody(agentId, finalState, resolvedEvent, sessionId, cwd, source, extraFields);

    if (isGemini) {
      const outLine = stdoutForGemini(hookName);
      send(body, () => {
        process.stdout.write(outLine + "\n");
        process.exit(0);
      });
    } else {
      send(body, () => process.exit(0));
    }
  });

  setTimeout(() => {
    if (sent) return;
    sent = true;

    if (isGemini) {
      process.stdout.write("{}" + "\n");
      process.exit(0);
      return;
    }

    const body = { state: "default", session_id: "default", event: "timeout", agent_id: agentId };
    postStateToRunningServer(
      JSON.stringify(body),
      { timeoutMs: 100 },
      () => process.exit(0)
    );
  }, 400);

  function send(body, callback) {
    if (sent) return;
    sent = true;
    const data = JSON.stringify(body);
    postStateToRunningServer(data, { timeoutMs: 100 }, callback);
  }
}

function isSessionStartLike(eventKey) {
  return eventKey === "SessionStart" || eventKey === "sessionStart";
}

module.exports = { runHook };