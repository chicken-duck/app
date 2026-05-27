const path = require("path");
const { execSync } = require("child_process");
const { postStateToRunningServer, readHostPrefix } = require("./server-config");

const TERMINAL_NAMES = {
  win32: new Set([
    "windowsterminal.exe", "cmd.exe", "powershell.exe", "pwsh.exe",
    "code.exe", "alacritty.exe", "wezterm-gui.exe", "mintty.exe",
    "conemu64.exe", "conemu.exe", "hyper.exe", "tabby.exe",
    "antigravity.exe", "warp.exe", "iterm.exe", "ghostty.exe",
  ]),
  darwin: new Set([
    "terminal", "iterm2", "alacritty", "wezterm-gui", "kitty",
    "hyper", "tabby", "warp", "ghostty",
  ]),
  linux: new Set([
    "gnome-terminal", "kgx", "konsole", "xfce4-terminal", "tilix",
    "alacritty", "wezterm", "wezterm-gui", "kitty", "ghostty",
    "xterm", "lxterminal", "terminator", "tabby", "hyper", "warp",
  ]),
};

const SYSTEM_BOUNDARY = {
  win32: new Set(["explorer.exe", "services.exe", "winlogon.exe", "svchost.exe"]),
  darwin: new Set(["launchd", "init", "systemd"]),
  linux: new Set(["systemd", "init"]),
};

const EDITOR_MAP = {
  win32: { "code.exe": "code", "cursor.exe": "cursor" },
  darwin: { code: "code", cursor: "cursor" },
  linux: { code: "code", cursor: "cursor", "code-insiders": "code" },
};

const AGENT_PROFILES = {
  "claude-code": {
    binaryNames: {
      win32: new Set(["claude.exe"]),
      darwin: new Set(["claude"]),
      linux: new Set(["claude"]),
    },
    nodeCommandMarkers: ["claude-code", "@anthropic-ai"],
    prewarmEvents: new Set(["SessionStart"]),
    remoteHost: true,
    legacyPidField: "claude_pid",
    detectHeadless: true,
    resolveState(event, state, payload) {
      const source = payload.source || payload.reason || "";
      return event === "SessionEnd" && source === "clear" ? "sweeping" : state;
    },
  },
  "copilot-cli": {
    binaryNames: {
      win32: new Set(["copilot.exe"]),
      darwin: new Set(["copilot"]),
      linux: new Set(["copilot"]),
    },
    nodeCommandMarkers: ["@github/copilot"],
    prewarmEvents: new Set(["sessionStart"]),
  },
  "gemini-cli": {
    binaryNames: {
      win32: new Set(["gemini.exe"]),
      darwin: new Set(["gemini"]),
      linux: new Set(["gemini"]),
    },
    prewarmEvents: new Set(["SessionStart"]),
    remoteHost: true,
  },
};

function platformValue(values, fallback) {
  return values[process.platform] || fallback;
}

function getCommandLine(pid) {
  const isWin = process.platform === "win32";
  return isWin
    ? execSync(`wmic process where "ProcessId=${pid}" get CommandLine /format:csv`, {
        encoding: "utf8",
        timeout: 500,
        windowsHide: true,
      })
    : execSync(`ps -o command= -p ${pid}`, { encoding: "utf8", timeout: 500 });
}

function getProcessInfo(pid) {
  const isWin = process.platform === "win32";
  if (isWin) {
    const out = execSync(
      `wmic process where "ProcessId=${pid}" get Name,ParentProcessId /format:csv`,
      { encoding: "utf8", timeout: 1500, windowsHide: true }
    );
    const lines = out.trim().split("\n").filter((line) => line.includes(","));
    if (!lines.length) return null;
    const parts = lines[lines.length - 1].split(",");
    return {
      name: (parts[1] || "").trim().toLowerCase(),
      fullName: (parts[1] || "").trim(),
      parentPid: parseInt(parts[2], 10),
    };
  }

  const parentOut = execSync(`ps -o ppid= -p ${pid}`, { encoding: "utf8", timeout: 1000 }).trim();
  const commOut = execSync(`ps -o comm= -p ${pid}`, { encoding: "utf8", timeout: 1000 }).trim();
  return {
    name: path.basename(commOut).toLowerCase(),
    fullName: commOut,
    parentPid: parseInt(parentOut, 10),
  };
}

function createProcessResolver(agentId) {
  const profile = AGENT_PROFILES[agentId] || {};
  let resolved = false;
  let stablePid = null;
  let detectedEditor = null;
  let agentPid = null;
  let pidChain = [];
  let headless = false;

  function resolve() {
    if (resolved) {
      return { stablePid, detectedEditor, agentPid, pidChain, headless };
    }

    resolved = true;
    const terminalNames = platformValue(TERMINAL_NAMES, new Set());
    const systemBoundary = platformValue(SYSTEM_BOUNDARY, new Set());
    const editorMap = platformValue(EDITOR_MAP, {});
    const binaryNames = platformValue(profile.binaryNames || {}, new Set());
    let pid = process.ppid;
    let lastGoodPid = pid;
    let terminalPid = null;

    pidChain = [];

    for (let i = 0; i < 8; i += 1) {
      let info;
      try {
        info = getProcessInfo(pid);
      } catch {
        break;
      }

      if (!info) break;
      pidChain.push(pid);

      const name = info.name;
      if (!detectedEditor && editorMap[name]) detectedEditor = editorMap[name];
      if (!detectedEditor && process.platform !== "win32") {
        const lowerFullName = info.fullName.toLowerCase();
        if (lowerFullName.includes("visual studio code")) detectedEditor = "code";
        else if (lowerFullName.includes("cursor.app")) detectedEditor = "cursor";
      }

      if (!agentPid) {
        if (binaryNames.has(name)) {
          agentPid = pid;
        } else if ((name === "node.exe" || name === "node") && Array.isArray(profile.nodeCommandMarkers) && profile.nodeCommandMarkers.length) {
          try {
            const commandLine = getCommandLine(pid);
            if (profile.nodeCommandMarkers.some((marker) => commandLine.includes(marker))) {
              agentPid = pid;
            }
          } catch {}
        }
      }

      if (systemBoundary.has(name)) break;
      if (terminalNames.has(name)) terminalPid = pid;
      lastGoodPid = pid;

      if (!info.parentPid || info.parentPid === pid || info.parentPid <= 1) break;
      pid = info.parentPid;
    }

    if (profile.detectHeadless && agentPid) {
      try {
        const commandLine = getCommandLine(agentPid);
        headless = /\s(-p|--print)(\s|$)/.test(commandLine);
      } catch {}
    }

    stablePid = terminalPid || lastGoodPid;
    return { stablePid, detectedEditor, agentPid, pidChain, headless };
  }

  return { resolve };
}

function getStdoutLine(payload, eventName) {
  if (!payload || typeof payload.hook_event_name !== "string") return null;
  if (eventName === "BeforeTool") return JSON.stringify({ decision: "allow" });
  if (eventName === "BeforeAgent") return JSON.stringify({});
  return "{}";
}

function normalizeMapping(eventName, value) {
  if (typeof value === "string") return { state: value, event: eventName };
  if (!value || typeof value !== "object" || typeof value.state !== "string") return null;
  return { state: value.state, event: value.event || eventName };
}

function runHook(agentId, eventMap) {
  const profile = AGENT_PROFILES[agentId] || {};
  const processResolver = createProcessResolver(agentId);
  const argvEvent = process.argv[2] || "";
  const shouldPrewarm = profile.prewarmEvents && profile.prewarmEvents.has(argvEvent);
  if (shouldPrewarm && !process.env.CLAWD_REMOTE) processResolver.resolve();

  const chunks = [];
  let finished = false;
  let stdinTimer = null;

  function finish(payload) {
    if (finished) return;
    finished = true;
    if (stdinTimer) clearTimeout(stdinTimer);

    const eventName = argvEvent || payload.hook_event_name || "";
    const mapped = normalizeMapping(eventName, eventMap[eventName]);
    const stdoutLine = getStdoutLine(payload, eventName);

    if (!mapped) {
      if (stdoutLine !== null) process.stdout.write(`${stdoutLine}\n`);
      process.exit(0);
      return;
    }

    if (!argvEvent && profile.prewarmEvents && profile.prewarmEvents.has(eventName) && !process.env.CLAWD_REMOTE) {
      processResolver.resolve();
    }

    const sessionId = payload.sessionId || payload.session_id || "default";
    const cwd = payload.cwd || "";
    const resolvedState = typeof profile.resolveState === "function"
      ? profile.resolveState(eventName, mapped.state, payload)
      : mapped.state;

    const body = {
      state: resolvedState,
      session_id: sessionId,
      event: mapped.event,
      agent_id: agentId,
    };

    if (cwd) body.cwd = cwd;

    if (process.env.CLAWD_REMOTE && profile.remoteHost) {
      body.host = readHostPrefix();
    } else {
      const metadata = processResolver.resolve();
      body.source_pid = metadata.stablePid;
      if (metadata.detectedEditor) body.editor = metadata.detectedEditor;
      if (metadata.agentPid) {
        body.agent_pid = metadata.agentPid;
        if (profile.legacyPidField) body[profile.legacyPidField] = metadata.agentPid;
      }
      if (metadata.pidChain.length) body.pid_chain = metadata.pidChain;
      if (metadata.headless) body.headless = true;
    }

    postStateToRunningServer(JSON.stringify(body), { timeoutMs: 100 }, () => {
      if (stdoutLine !== null) process.stdout.write(`${stdoutLine}\n`);
      process.exit(0);
    });
  }

  process.stdin.on("data", (chunk) => chunks.push(chunk));
  process.stdin.on("end", () => {
    let payload = {};
    try {
      const raw = Buffer.concat(chunks).toString();
      if (raw.trim()) payload = JSON.parse(raw);
    } catch {}
    finish(payload);
  });

  stdinTimer = setTimeout(() => finish({}), 400);
}

module.exports = { runHook };
