import { existsSync } from "node:fs";
import { spawn, type ChildProcess } from "node:child_process";

export interface ChromeOptions {
  port: number;
  userDataDir: string;
  headless?: boolean;
  chromeBin?: string;
  timeoutMs?: number;
}

export interface ChromeHandle {
  port: number;
  cdpUrl: string;
  close(): Promise<void>;
}

const DARWIN_BIN = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const WIN_BIN = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const LINUX_CANDIDATES = [
  "google-chrome-stable",
  "google-chrome",
  "chromium",
  "chromium-browser",
];

/** Tìm Chrome binary theo platform (macOS / Windows / Linux), ưu tiên env CHROME_BIN. */
export function resolveChromeBin(): string {
  const fromEnv = process.env.CHROME_BIN;
  if (fromEnv && existsSync(fromEnv)) return fromEnv;
  if (process.platform === "darwin" && existsSync(DARWIN_BIN)) return DARWIN_BIN;
  if (process.platform === "win32" && existsSync(WIN_BIN)) return WIN_BIN;
  for (const candidate of LINUX_CANDIDATES) {
    const found = findOnPath(candidate);
    if (found) return found;
  }
  // fallback: để spawn báo lỗi rõ ràng
  return LINUX_CANDIDATES[0] ?? "google-chrome";
}

function findOnPath(name: string): string | null {
  const pathEnv = process.env.PATH ?? "";
  for (const dir of pathEnv.split(":")) {
    const full = `${dir}/${name}`;
    if (dir && existsSync(full)) return full;
  }
  return null;
}

/** Chờ CDP endpoint sẵn sàng (GET /json/version trả 200). */
export async function waitForCdp(port: number, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (response.ok) return;
    } catch {
      // Chrome chưa lên — thử lại
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Chrome CDP không lên sau ${timeoutMs}ms (port ${port})`);
}

/**
 * Bật 1 Chrome riêng cho bot với CDP port riêng + profile riêng.
 * Mỗi bot = 1 profile (cookie/session tách biệt) như thiết kế mục 8.
 * CDP chỉ bind 127.0.0.1 (không lộ ra mạng LAN).
 */
export async function launchChrome(options: ChromeOptions): Promise<ChromeHandle> {
  const bin = options.chromeBin ?? resolveChromeBin();
  const args = [
    `--remote-debugging-port=${options.port}`,
    "--remote-debugging-address=127.0.0.1",
    `--user-data-dir=${options.userDataDir}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-dev-shm-usage",
    ...(options.headless ? ["--headless=new", "--disable-gpu"] : []),
    "about:blank",
  ];
  const child: ChildProcess = spawn(bin, args, { stdio: "ignore" });
  // ENOENT (sai bin) phải reject rõ thay vì unhandled 'error' làm sập process.
  const spawnError = new Promise<never>((_, reject) => {
    child.on("error", (error) => reject(new Error(`Chrome spawn lỗi (${bin}): ${error.message}`)));
  });
  spawnError.catch(() => {
    // 'error' nổ sau khi race đã xong → nuốt, tránh unhandled rejection.
  });
  try {
    await Promise.race([waitForCdp(options.port, options.timeoutMs ?? 15_000), spawnError]);
  } catch (error) {
    try {
      child.kill();
    } catch {
      // đã chết
    }
    throw error;
  }
  return {
    port: options.port,
    cdpUrl: `http://127.0.0.1:${options.port}`,
    async close(): Promise<void> {
      try {
        child.kill();
      } catch {
        // đã chết
      }
    },
  };
}
