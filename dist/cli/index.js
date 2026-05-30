// src/cli/doctor.ts
import { readdirSync, statSync, existsSync as existsSync3 } from "fs";
import { join as join2 } from "path";

// src/mcp/http-client.ts
import { existsSync, readFileSync } from "fs";

// src/shared/paths.ts
import { homedir } from "os";
import { join } from "path";
function matchiHome() {
  return process.env.MATCHI_HOME ?? join(homedir(), ".matchi");
}
function daemonInfoPath() {
  return join(matchiHome(), "daemon.json");
}

// src/mcp/http-client.ts
function readDaemonInfoFromFs() {
  const p = daemonInfoPath();
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, "utf8"));
  } catch {
    return null;
  }
}

// src/daemon/lifecycle.ts
import { writeFileSync, readFileSync as readFileSync2, existsSync as existsSync2, unlinkSync, mkdirSync } from "fs";
import { dirname } from "path";
import { createServer } from "net";
function isDaemonAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// src/cli/doctor.ts
async function doctor() {
  const info = readDaemonInfoFromFs();
  let healthy = false;
  if (info && isDaemonAlive(info.pid)) {
    try {
      const r = await fetch(`http://127.0.0.1:${info.port}/healthz`);
      healthy = r.ok;
    } catch {
      healthy = false;
    }
  }
  console.log("matchi doctor");
  console.log("-------------");
  console.log(`MATCHI_HOME: ${matchiHome()}`);
  if (info) {
    const alive = isDaemonAlive(info.pid);
    console.log(`daemon:      pid=${info.pid} port=${info.port} version=${info.version}`);
    console.log(`uptime:      ${Math.floor((Date.now() - info.startedAt) / 1e3)}s`);
    console.log(`alive:       ${alive ? "yes" : "no (stale pid file)"}`);
    console.log(`healthy:     ${healthy ? "yes" : "no"}`);
  } else {
    console.log("daemon:      not running");
  }
  const wsRoot = join2(matchiHome(), "workspaces");
  console.log("workspaces:");
  if (!existsSync3(wsRoot)) {
    console.log("  (none)");
  } else {
    const entries = readdirSync(wsRoot).filter((e) => {
      try {
        return statSync(join2(wsRoot, e)).isDirectory();
      } catch {
        return false;
      }
    });
    if (entries.length === 0) {
      console.log("  (none)");
    } else {
      for (const e of entries) {
        const data = join2(wsRoot, e, "data.duckdb");
        if (existsSync3(data)) {
          const st = statSync(data);
          console.log(
            `  ${e}  size=${(st.size / 1024).toFixed(1)}KB  mtime=${st.mtime.toISOString()}`
          );
        } else {
          console.log(`  ${e}  (no data.duckdb)`);
        }
      }
    }
  }
  if (!info) return 0;
  return healthy ? 0 : 1;
}

// src/mcp/autospawn.ts
import { spawn } from "child_process";
import { setTimeout as sleep } from "timers/promises";
import { fileURLToPath } from "url";
import { dirname as dirname2, resolve } from "path";
import { existsSync as existsSync4 } from "fs";
var DAEMON_BIN = (() => {
  const here = dirname2(fileURLToPath(import.meta.url));
  return resolve(here, "..", "..", "bin", "matchi-daemon.js");
})();
async function healthOk(port) {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/healthz`);
    return r.ok;
  } catch {
    return false;
  }
}
async function ensureDaemon() {
  let info = readDaemonInfoFromFs();
  if (info && isDaemonAlive(info.pid) && await healthOk(info.port)) {
    return info;
  }
  const child = spawn(process.execPath, [DAEMON_BIN], {
    detached: true,
    stdio: "ignore",
    env: process.env
  });
  child.unref();
  for (let i = 0; i < 100; i++) {
    await sleep(100);
    info = readDaemonInfoFromFs();
    if (info && await healthOk(info.port)) return info;
  }
  throw new Error("matchi-daemon failed to start within 10s");
}

// src/cli/start.ts
async function start() {
  try {
    const info = await ensureDaemon();
    console.log(`daemon running: pid=${info.pid} port=${info.port} version=${info.version}`);
    return 0;
  } catch (e) {
    console.error(`failed to start daemon: ${e instanceof Error ? e.message : String(e)}`);
    return 1;
  }
}

// src/cli/stop.ts
import { setTimeout as sleep2 } from "timers/promises";
import { existsSync as existsSync5, unlinkSync as unlinkSync2 } from "fs";
async function stop() {
  const info = readDaemonInfoFromFs();
  if (!info) {
    console.log("not running");
    return 0;
  }
  if (!isDaemonAlive(info.pid)) {
    try {
      unlinkSync2(daemonInfoPath());
    } catch {
    }
    console.log("not running (cleared stale pid file)");
    return 0;
  }
  try {
    await fetch(`http://127.0.0.1:${info.port}/v1/shutdown`, { method: "POST" });
  } catch {
  }
  const p = daemonInfoPath();
  for (let i = 0; i < 50; i++) {
    const fileGone = !existsSync5(p);
    const procGone = !isDaemonAlive(info.pid);
    if (fileGone || procGone) {
      if (!fileGone && procGone) {
        try {
          unlinkSync2(p);
        } catch {
        }
      }
      console.log(`stopped (pid=${info.pid})`);
      return 0;
    }
    await sleep2(100);
  }
  console.error("daemon did not shut down within 5s");
  return 1;
}

// src/cli/gc.ts
import { readdirSync as readdirSync2, statSync as statSync2, existsSync as existsSync6, rmSync } from "fs";
import { join as join3 } from "path";
var UNIT_MS = {
  d: 864e5,
  w: 6048e5,
  m: 2592e6
};
function parseDuration(s) {
  const m = /^(\d+)(d|w|m)$/.exec(s);
  if (!m) throw new Error(`bad duration: ${s} (expected e.g. 30d, 2w, 1m)`);
  return Number(m[1]) * UNIT_MS[m[2]];
}
async function gc(args) {
  const info = readDaemonInfoFromFs();
  if (info && isDaemonAlive(info.pid)) {
    console.error("stop the daemon first (matchi stop)");
    return 1;
  }
  let thresholdMs = 30 * UNIT_MS.d;
  const idx = args.indexOf("--older-than");
  if (idx !== -1) {
    const val = args[idx + 1];
    if (!val) {
      console.error("--older-than requires a value (e.g. 30d, 2w, 1m)");
      return 1;
    }
    try {
      thresholdMs = parseDuration(val);
    } catch (e) {
      console.error(e instanceof Error ? e.message : String(e));
      return 1;
    }
  }
  const wsRoot = join3(matchiHome(), "workspaces");
  if (!existsSync6(wsRoot)) {
    console.log("no workspaces");
    return 0;
  }
  const cutoff = Date.now() - thresholdMs;
  let removed = 0;
  for (const e of readdirSync2(wsRoot)) {
    const dir = join3(wsRoot, e);
    let isDir = false;
    try {
      isDir = statSync2(dir).isDirectory();
    } catch {
      continue;
    }
    if (!isDir) continue;
    const data = join3(dir, "data.duckdb");
    let mtime = 0;
    if (existsSync6(data)) {
      mtime = statSync2(data).mtimeMs;
    } else {
      try {
        mtime = statSync2(dir).mtimeMs;
      } catch {
        continue;
      }
    }
    if (mtime < cutoff) {
      if (dir === wsRoot || dir === matchiHome()) continue;
      rmSync(dir, { recursive: true, force: true });
      console.log(`removed ${e} (mtime=${new Date(mtime).toISOString()})`);
      removed++;
    }
  }
  console.log(`gc complete: ${removed} workspace(s) removed`);
  return 0;
}

// src/cli/index.ts
function printHelp() {
  console.log(`matchi \u2014 local reconciliation daemon

Usage:
  matchi <command> [options]

Commands:
  doctor              Show daemon status, workspaces, and health.
  start               Start the matchi-daemon (no-op if already running).
  stop                Gracefully stop the daemon.
  gc [--older-than D] Remove workspaces older than D (default 30d). Units: d|w|m.
  help                Show this message.
`);
}
async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  switch (cmd) {
    case "doctor":
      return await doctor();
    case "start":
      return await start();
    case "stop":
      return await stop();
    case "gc":
      return await gc(rest);
    case void 0:
    case "help":
    case "--help":
    case "-h":
      printHelp();
      return 0;
    default:
      console.error(`unknown command: ${cmd}`);
      printHelp();
      return 1;
  }
}
main().then((code) => process.exit(code)).catch((e) => {
  console.error(e instanceof Error ? e.stack ?? e.message : String(e));
  process.exit(1);
});
//# sourceMappingURL=index.js.map