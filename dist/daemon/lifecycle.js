// src/daemon/lifecycle.ts
import { writeFileSync, readFileSync, existsSync, unlinkSync, mkdirSync } from "fs";
import { dirname } from "path";
import { createServer } from "net";

// src/shared/paths.ts
import { homedir } from "os";
import { join } from "path";
function matchiHome() {
  return process.env.MATCHI_HOME ?? join(homedir(), ".matchi");
}
function daemonInfoPath() {
  return join(matchiHome(), "daemon.json");
}

// src/daemon/lifecycle.ts
function writeDaemonInfo(info) {
  const p = daemonInfoPath();
  mkdirSync(dirname(p), { recursive: true });
  mkdirSync(matchiHome(), { recursive: true });
  writeFileSync(p, JSON.stringify(info, null, 2));
}
function readDaemonInfo() {
  const p = daemonInfoPath();
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, "utf8"));
  } catch {
    return null;
  }
}
function clearDaemonInfo() {
  const p = daemonInfoPath();
  if (existsSync(p)) unlinkSync(p);
}
function isDaemonAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
function pickPort() {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.unref();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      if (addr && typeof addr === "object") {
        const port = addr.port;
        srv.close(() => resolve(port));
      } else {
        srv.close(() => reject(new Error("no port")));
      }
    });
  });
}
function startIdleTimer(registry, idleMs, onIdle) {
  const check = () => {
    if (registry.msSinceLastActivity() > idleMs) onIdle();
  };
  const handle = setInterval(check, Math.min(6e4, idleMs));
  handle.unref();
  return handle;
}
export {
  clearDaemonInfo,
  isDaemonAlive,
  pickPort,
  readDaemonInfo,
  startIdleTimer,
  writeDaemonInfo
};
//# sourceMappingURL=lifecycle.js.map