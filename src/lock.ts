import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const STALE_NO_PID_GRACE_MS = 5000;

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EPERM") return true;
    return false;
  }
}

function readPid(lockDir: string): number | null {
  try {
    const raw = readFileSync(join(lockDir, "pid"), "utf8").trim();
    const pid = Number.parseInt(raw, 10);
    return Number.isFinite(pid) ? pid : null;
  } catch {
    return null;
  }
}

function lockAgeMs(lockDir: string): number | null {
  try {
    return Date.now() - statSync(lockDir).mtimeMs;
  } catch {
    return null;
  }
}

export interface ChromeLockHandle {
  lockDir: string;
  release(): void;
}

/**
 * Cross-language (Node + Python) atomic lockdir with stale PID recovery.
 * Coordinates shared Chrome debug profiles (e.g. port 9224) across cron jobs and MCP calls.
 */
export async function acquireChromeLock(
  lockDir: string,
  timeoutMs = 15_000,
  pollMs = 150,
): Promise<ChromeLockHandle> {
  mkdirSync(dirname(lockDir), { recursive: true });
  const deadline = Date.now() + timeoutMs;

  while (true) {
    try {
      mkdirSync(lockDir);
      writeFileSync(join(lockDir, "pid"), String(process.pid), "utf8");
      return {
        lockDir,
        release: () => {
          try {
            rmSync(lockDir, { recursive: true, force: true });
          } catch {
            // ignore cleanup errors
          }
        },
      };
    } catch {
      const pid = readPid(lockDir);
      const stale =
        pid !== null
          ? !isPidAlive(pid)
          : (() => {
              const age = lockAgeMs(lockDir);
              return age !== null && age >= STALE_NO_PID_GRACE_MS;
            })();
      if (stale) {
        try {
          rmSync(lockDir, { recursive: true, force: true });
        } catch {
          // another waiter may have removed it
        }
        continue;
      }
      if (Date.now() >= deadline) {
        throw new Error(`Chrome lock bận sau ${timeoutMs}ms (${lockDir}${pid !== null ? `, pid=${pid}` : ""})`);
      }
      await new Promise((r) => setTimeout(r, pollMs));
    }
  }
}

export async function withChromeLock<T>(
  lockDir: string | undefined,
  fn: () => Promise<T>,
  timeoutMs = 15_000,
): Promise<T> {
  if (!lockDir) return fn();
  const handle = await acquireChromeLock(lockDir, timeoutMs);
  try {
    return await fn();
  } finally {
    handle.release();
  }
}
