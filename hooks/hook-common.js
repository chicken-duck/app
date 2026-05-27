const { postStateToRunningServer, readHostPrefix } = require("./server-config");

// 公共的终端、系统边界和编辑器映射
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

// 状态
let _stablePid = null;
let _detectedEditor = null;
let _agentPid = null;
let _pidChain = [];
let _isHeadless = false;

function getStablePid(agentNames = {}) {
  if (_stablePid) return _stablePid;
  const { execSync } = require("child_process");
  const isWin = process.platform === "win32";
  const terminalNames = isWin ? TERMINAL_NAMES_WIN : (process.platform === "linux" ? TERMINAL_NAMES_LINUX : TERMINAL_NAMES_MAC);
  const systemBoundary = isWin ? SYSTEM_BOUNDARY_WIN : (process.platform === "linux" ? SYSTEM_BOUNDARY_LINUX : SYSTEM_BOUNDARY_MAC);
  const editorMap = isWin ? EDITOR_MAP_WIN : (process.platform === "linux" ? EDITOR_MAP_LINUX : EDITOR_MAP_MAC);
  let pid = process.ppid;
  let lastGoodPid = pid;
  let terminalPid = null;
  _pidChain = [];
  _detectedEditor = null;
  _agentPid = null;
  const agentNameSet = isWin ? agentNames.win : (process.platform === "linux" ? agentNames.linux : agentNames.mac);
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
    // 检测 agent 进程
    if (!_agentPid) {
      if (agentNameSet && agentNameSet.has(name)) {
        _agentPid = pid;
      } else if (name === "node.exe" || name === "node") {
        try {
          const cmdOut = isWin
            ? execSync(`wmic process where "ProcessId=${pid}" get CommandLine /format:csv`,
                { encoding: "utf8", timeout: 500, windowsHide: true })
            : execSync(`ps -o command= -p ${pid}`, { encoding: "utf8", timeout: 500 });
          if (agentNames.nodeCommandCheck && agentNames.nodeCommandCheck(cmdOut)) _agentPid = pid;
        } catch {}
      }
    }
    if (systemBoundary.has(name)) break;
    if (terminalNames.has(name)) terminalPid = pid;
    lastGoodPid = pid;
    if (!parentPid || parentPid === pid || parentPid <= 1) break;
    pid = parentPid;
  }
  // 检查是否是 headless 模式
  if (_agentPid && !_isHeadless) {
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

// 读取 stdin 并处理
function readStdin(callback) {
  const chunks = [];
  let done = false;
  const timeout = setTimeout(() => finish({}), 400);
  function finish(payload) {
    if (done) return;
    done = true;
    clearTimeout(timeout);
    callback(payload);
  }
  process.stdin.on("data", (c) => chunks.push(c));
  process.stdin.on("end", () => {
    let payload = {};
    try {
      const raw = Buffer.concat(chunks).toString();
      if (raw.trim()) payload = JSON.parse(raw);
    } catch {}
    finish(payload);
  });
}

// 主函数：runHook
function runHook(config) {
  const {
    agentId,
    eventMap,
    agentNames = {},
    startEvent,
    headlessCheck = false,
    remoteSupport = false,
    stdoutHandler,
    stateResolver,
  } = config;

  // 读取事件
  let event;
  let mappedState;
  if (typeof eventMap === "function") {
    // Gemini 风格的处理
    readStdin((payload) => {
      const hookName = (payload && payload.hook_event_name) || "";
      const mapped = eventMap(hookName);
      if (!mapped) {
        if (stdoutHandler) process.stdout.write(stdoutHandler(hookName) + "\n");
        process.exit(0);
        return;
      }
      const { state, event: resolvedEvent } = mapped;
      event = resolvedEvent;
      mappedState = state;
      // 处理 SessionStart 事件
      if (hookName === "SessionStart" && !process.env.CLAWD_REMOTE) getStablePid(agentNames);
      handlePayload(payload, hookName);
    });
  } else {
    // Claude/Copilot 风格的处理
    event = process.argv[2];
    mappedState = eventMap[event];
    if (!mappedState) process.exit(0);
    if (startEvent && event === startEvent && !process.env.CLAWD_REMOTE) getStablePid(agentNames);
    readStdin((payload) => handlePayload(payload));
  }

  function handlePayload(payload, hookName) {
    // 提取 sessionId 和 cwd
    const sessionId = (payload.session_id || payload.sessionId || "default");
    const cwd = payload.cwd || "";
    const source = payload.source || payload.reason || "";

    // 构建请求体
    const body = {
      state: stateResolver ? stateResolver(event, mappedState, source) : mappedState,
      session_id: sessionId,
      event,
    };
    body.agent_id = agentId;
    if (cwd) body.cwd = cwd;
    if (remoteSupport && process.env.CLAWD_REMOTE) {
      body.host = readHostPrefix();
    } else {
      body.source_pid = getStablePid(agentNames);
      if (_detectedEditor) body.editor = _detectedEditor;
      if (_agentPid) {
        body.agent_pid = _agentPid;
        body.claude_pid = _agentPid; // 向后兼容
      }
      if (_pidChain.length) body.pid_chain = _pidChain;
      if (headlessCheck && _isHeadless) body.headless = true;
    }

    const data = JSON.stringify(body);

    // 发送到服务器
    postStateToRunningServer(
      data,
      { timeoutMs: 100 },
      () => {
        if (stdoutHandler && hookName) {
          process.stdout.write(stdoutHandler(hookName) + "\n");
        }
        process.exit(0);
      }
    );
  }
}

module.exports = {
  getStablePid,
  readStdin,
  runHook,
};
