const { postStateToRunningServer, readHostPrefix } = require("./server-config");

function runHook(agentId, eventMap) {
  let eventArg = process.argv[2];

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

  let _stablePid = null;
  let _detectedEditor = null;
  let _agentPid = null;
  let _pidChain = [];
  let _isHeadless = false;

  let agentNamesWin = new Set();
  let agentNamesMac = new Set();
  let agentNamesLinux = new Set();
  let nodeCmdFilters = [];

  if (agentId === "claude-code") {
    agentNamesWin = new Set(["claude.exe"]);
    agentNamesMac = new Set(["claude"]);
    agentNamesLinux = new Set(["claude"]);
    nodeCmdFilters = ["claude-code", "@anthropic-ai"];
  } else if (agentId === "copilot-cli") {
    agentNamesWin = new Set(["copilot.exe"]);
    agentNamesMac = new Set(["copilot"]);
    agentNamesLinux = new Set(["copilot"]);
    nodeCmdFilters = ["@github/copilot"];
  } else if (agentId === "gemini-cli") {
    agentNamesWin = new Set(["gemini.exe"]);
    agentNamesMac = new Set(["gemini"]);
    agentNamesLinux = new Set(["gemini"]);
  }

  function getStablePid() {
    if (_stablePid) return _stablePid;
    const { execSync } = require("child_process");
    const isWin = process.platform === "win32";
    const terminalNames = isWin ? TERMINAL_NAMES_WIN : (process.platform === "linux" ? TERMINAL_NAMES_LINUX : TERMINAL_NAMES_MAC);
    const systemBoundary = isWin ? SYSTEM_BOUNDARY_WIN : (process.platform === "linux" ? SYSTEM_BOUNDARY_LINUX : SYSTEM_BOUNDARY_MAC);
    const editorMap = isWin ? EDITOR_MAP_WIN : (process.platform === "linux" ? EDITOR_MAP_LINUX : EDITOR_MAP_MAC);
    const agentNames = isWin ? agentNamesWin : (process.platform === "linux" ? agentNamesLinux : agentNamesMac);
    
    let pid = process.ppid;
    let lastGoodPid = pid;
    let terminalPid = null;
    _pidChain = [];
    _detectedEditor = null;
    _agentPid = null;
    
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
        } else if ((name === "node.exe" || name === "node") && nodeCmdFilters.length > 0) {
          try {
            const cmdOut = isWin
              ? execSync(`wmic process where "ProcessId=${pid}" get CommandLine /format:csv`,
                  { encoding: "utf8", timeout: 500, windowsHide: true })
              : execSync(`ps -o command= -p ${pid}`, { encoding: "utf8", timeout: 500 });
            if (nodeCmdFilters.some(filter => cmdOut.includes(filter))) {
              _agentPid = pid;
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
    
    if (agentId === "claude-code" && _agentPid && !_isHeadless) {
      try {
        const { execSync } = require("child_process");
        const isWin = process.platform === "win32";
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

  function stdoutForEvent(hookName) {
    if (hookName === "BeforeTool") return JSON.stringify({ decision: "allow" });
    if (hookName === "BeforeAgent") return JSON.stringify({});
    return "{}";
  }

  if (agentId !== "gemini-cli") {
    const state = eventMap[eventArg];
    if (!state) process.exit(0);

    if ((eventArg === "SessionStart" || eventArg === "sessionStart") && !process.env.CLAWD_REMOTE) {
      getStablePid();
    }
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

    let state, event, sessionId, cwd, source;

    if (agentId === "gemini-cli") {
      const hookName = payload.hook_event_name || "";
      const mapped = eventMap[hookName];
      if (!mapped) {
        process.stdout.write(stdoutForEvent(hookName) + "\n");
        process.exit(0);
        return;
      }
      state = mapped.state;
      event = mapped.event;
      if (hookName === "SessionStart" && !process.env.CLAWD_REMOTE) getStablePid();
      sessionId = payload.session_id || "default";
      cwd = payload.cwd || "";
    } else {
      event = eventArg;
      state = eventMap[event];
      sessionId = payload.sessionId || payload.session_id || "default";
      cwd = payload.cwd || "";
      source = payload.source || payload.reason || "";
      
      if (agentId === "claude-code" && event === "SessionEnd" && source === "clear") {
        state = "sweeping";
      }
    }

    const body = { state, session_id: sessionId, event, agent_id: agentId };
    if (cwd) body.cwd = cwd;
    
    if (process.env.CLAWD_REMOTE) {
      if (typeof readHostPrefix === "function") {
        body.host = readHostPrefix();
      }
    } else {
      body.source_pid = getStablePid();
      if (_detectedEditor) body.editor = _detectedEditor;
      if (_agentPid) {
        body.agent_pid = _agentPid;
        if (agentId === "claude-code") body.claude_pid = _agentPid;
      }
      if (_pidChain.length) body.pid_chain = _pidChain;
      if (agentId === "claude-code" && _isHeadless) body.headless = true;
    }

    const data = JSON.stringify(body);
    postStateToRunningServer(
      data,
      { timeoutMs: 100 },
      () => {
        if (agentId === "gemini-cli") {
          process.stdout.write(stdoutForEvent(payload.hook_event_name || "") + "\n");
        }
        process.exit(0);
      }
    );
  }
}

module.exports = { runHook };
