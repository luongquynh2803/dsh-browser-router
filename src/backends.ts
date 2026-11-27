import crypto from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { chromium, type Browser, type Page } from "playwright-core";
import type { BackendKind, BrowserResult, BrowserStatus, SnapshotElement } from "./types.js";

export interface BrowserBackend {
  readonly kind: BackendKind;
  navigate(url: string): Promise<BrowserResult>;
  snapshot(): Promise<BrowserResult>;
  click(ref: string): Promise<BrowserResult>;
  type(ref: string, text: string): Promise<BrowserResult>;
  extract(goal: string): Promise<BrowserResult>;
  screenshot(fullPage: boolean): Promise<BrowserResult>;
  wait(condition?: string, value?: string, timeoutMs?: number): Promise<BrowserResult>;
  goBack(): Promise<BrowserResult>;
  refresh(): Promise<BrowserResult>;
  submit(): Promise<BrowserResult>;
  download?(ref: string, downloadDir: string, timeoutMs?: number): Promise<BrowserResult>;
  closeTab?(): Promise<BrowserResult>;
}

export interface PageProvider {
  getPage(): Promise<Page>;
  closeTab(): Promise<boolean>;
  close(): Promise<void>;
}

export interface PageProviderOptions {
  /** Mở tab tạm riêng thay vì đè lên tab đầu tiên của Chrome (mặc định true). */
  isolatedTab?: boolean;
  /** Các host được bảo vệ — khi isolatedTab=false cũng không chọn tab thuộc host này. */
  protectedHosts?: string[];
  /** Tự động đóng tab tạm sau N ms nhàn rỗi (0 = tắt). */
  idleTabCloseMs?: number;
}

function isProtectedUrl(url: string, protectedHosts: string[]): boolean {
  const lower = (url || "").toLowerCase();
  return protectedHosts.some((h) => h && lower.includes(h.toLowerCase()));
}

/**
 * Kết nối tới Chrome đang chạy --remote-debugging-port.
 * v0.2.0: mặc định isolatedTab=true → mở 1 tab tạm riêng, KHÔNG đè tab nền có sẵn
 * (như Seller Central, Helium 10, hay DSH Web UI), và đóng sạch tab tạm khi closeTab()/close().
 */
export function createPageProvider(endpoint: string, options: PageProviderOptions = {}): PageProvider {
  const isolatedTab = options.isolatedTab ?? true;
  const protectedHosts = options.protectedHosts ?? [];
  const idleTabCloseMs = options.idleTabCloseMs ?? 0;

  let browser: Browser | null = null;
  let page: Page | null = null;
  let ownsPage = false;
  let idleTimer: ReturnType<typeof setTimeout> | undefined;

  function bumpIdleTimer(): void {
    if (idleTimer) clearTimeout(idleTimer);
    if (idleTabCloseMs > 0 && ownsPage && page && !page.isClosed()) {
      idleTimer = setTimeout(() => {
        void closeOwnedTab();
      }, idleTabCloseMs);
      idleTimer.unref();
    }
  }

  async function closeOwnedTab(): Promise<boolean> {
    if (idleTimer) {
      clearTimeout(idleTimer);
      idleTimer = undefined;
    }
    if (!page || !ownsPage) {
      page = null;
      return false;
    }
    const target = page;
    page = null;
    ownsPage = false;
    try {
      if (!target.isClosed()) {
        await target.close();
        return true;
      }
    } catch {
      // tab đã đóng
    }
    return false;
  }

  return {
    async getPage(): Promise<Page> {
      if (page && !page.isClosed() && browser?.isConnected()) {
        bumpIdleTimer();
        return page;
      }
      page = null;
      ownsPage = false;
      if (browser) {
        try {
          await browser.close();
        } catch {
          // đã đóng sẵn
        }
        browser = null;
      }
      browser = await chromium.connectOverCDP(endpoint, { timeout: 10_000 });
      const context = browser.contexts()[0] ?? (await browser.newContext());

      if (isolatedTab) {
        // Luôn mở tab tạm mới — tuyệt đối không ghi đè tab nền của user.
        page = await context.newPage();
        ownsPage = true;
      } else {
        const reusable = context.pages().find((p) => !isProtectedUrl(p.url(), protectedHosts));
        if (reusable) {
          page = reusable;
          ownsPage = false;
        } else {
          page = await context.newPage();
          ownsPage = true;
        }
      }
      bumpIdleTimer();
      return page;
    },

    async closeTab(): Promise<boolean> {
      return closeOwnedTab();
    },

    async close(): Promise<void> {
      await closeOwnedTab();
      if (browser) {
        try {
          await browser.close();
        } catch {
          // đã đóng sẵn
        }
      }
      browser = null;
    },
  };
}

const INTERACTIVE_SELECTOR =
  "a,button,input,select,textarea,[role='button'],[role='link'],[role='textbox'],[contenteditable='true']";

interface RawElement {
  ref: string;
  role: string;
  label: string;
  bbox: [number, number, number, number];
}

async function extractElements(page: Page): Promise<SnapshotElement[]> {
  const raw = await page.evaluate((selector: string): RawElement[] => {
    document.querySelectorAll("[data-dsh-ref]").forEach((el) => el.removeAttribute("data-dsh-ref"));
    const nodes = Array.from(document.querySelectorAll(selector)).slice(0, 200);
    return nodes.map((el, index) => {
      const ref = `r-${index + 1}`;
      el.setAttribute("data-dsh-ref", ref);
      const tag = el.tagName.toLowerCase();
      const role = el.getAttribute("role") ?? (tag === "a" ? "link" : tag === "input" ? "textbox" : tag);
      const label =
        (el as HTMLElement).innerText?.trim().slice(0, 80) ||
        el.getAttribute("aria-label") ||
        el.getAttribute("placeholder") ||
        el.getAttribute("name") ||
        tag;
      const rect = el.getBoundingClientRect();
      return {
        ref,
        role,
        label,
        bbox: [rect.x, rect.y, rect.width, rect.height] as [number, number, number, number],
      };
    });
  }, INTERACTIVE_SELECTOR);
  return raw;
}

export function classifyPageStatus(
  http: number | undefined,
  title: string,
  url: string,
  bodySnippet = "",
  forbiddenMarkers: string[] = [],
): { status: BrowserStatus; reason?: string } {
  if (http === 429) return { status: "rate_limited" };
  if (http === 403) return { status: "blocked" };
  if (http !== undefined && http >= 400) return { status: "blocked" };

  const hay = `${title} ${url}`.toLowerCase();
  if (/captcha|challenge|verify you are human|are you a robot/.test(hay)) {
    return { status: "captcha", reason: "gặp CAPTCHA" };
  }
  if (/\/ap\/mfa|\/ap\/cvf|two-step verification|one-time password|enter otp|verification code/.test(`${hay} ${bodySnippet.toLowerCase()}`)) {
    return { status: "needs_human", reason: "gặp màn hình OTP / 2FA — cần con người xác thực thủ công" };
  }
  const t = title.toLowerCase();
  const u = url.toLowerCase();
  if (
    /\/ap\/signin|\/signin|\/login/.test(u) ||
    (/(sign in|log in|login|signin)/.test(t) && !/log out|logout/.test(t))
  ) {
    return { status: "login_required", reason: "phiên đăng nhập đã hết hạn — cần đăng nhập thủ công" };
  }

  if (forbiddenMarkers.length > 0 && bodySnippet) {
    const lowerBody = `${title} ${bodySnippet}`.toLowerCase();
    for (const marker of forbiddenMarkers) {
      if (marker && lowerBody.includes(marker.toLowerCase())) {
        return {
          status: "needs_human",
          reason: `phát hiện dấu hiệu sai tài khoản/phạm vi ("${marker}") — dừng để tránh thao tác nhầm`,
        };
      }
    }
  }
  return { status: "ok" };
}

function resultOf(
  action: BrowserResult["action"],
  backend: BackendKind,
  status: BrowserStatus,
  extra: Partial<BrowserResult> = {},
): BrowserResult {
  return { ok: status === "ok", action, backend, switched: false, status, ...extra };
}

async function pageState(page: Page, withSnippet = false): Promise<{ url: string; title: string; snippet: string }> {
  const title = await page.title().catch(() => "");
  const snippet = withSnippet
    ? await page.evaluate(() => (document.body?.innerText ?? "").slice(0, 1500)).catch(() => "")
    : "";
  return { url: page.url(), title, snippet };
}

function actionStatus(title: string, url: string, snippet = "", forbiddenMarkers: string[] = []): { status: BrowserStatus; reason?: string } {
  const c = classifyPageStatus(undefined, title, url, snippet, forbiddenMarkers);
  if (c.status === "captcha" || c.status === "needs_human") return c;
  return { status: "ok" };
}

function notFound(ref: string): Error {
  return Object.assign(new Error(`không tìm thấy ref ${ref}`), { code: "locator_not_found" });
}

function toErrorResult(action: BrowserResult["action"], backend: BackendKind, error: unknown): BrowserResult {
  const message = error instanceof Error ? error.message : String(error);
  const code = (error as { code?: string } | null)?.code;
  const status: BrowserStatus =
    code === "locator_not_found" ? "locator_not_found" : /timeout/i.test(message) ? "timeout" : "error";
  return resultOf(action, backend, status, { hint: message });
}

const SAFE_REF = /^r-\d+$/;
function isSafeRef(ref: string): boolean {
  return SAFE_REF.test(ref);
}

function parsePoint(ref: string): [number, number] | null {
  const match = /^@?(\d+(?:\.\d+)?)\s*,\s*(\d+(?:\.\d+)?)$/.exec(ref.trim());
  if (!match) return null;
  return [Number(match[1]), Number(match[2])];
}

async function runWait(page: Page, condition?: string, value?: string, timeoutMs = 10_000): Promise<void> {
  if (condition === "selector" && value) await page.waitForSelector(value, { timeout: timeoutMs });
  else if (condition === "text" && value) await page.getByText(value).waitFor({ timeout: timeoutMs });
  else await page.waitForLoadState("domcontentloaded", { timeout: timeoutMs });
}

async function waitForDownloadedFile(
  downloadDir: string,
  beforeFiles: Set<string>,
  timeoutMs: number,
): Promise<{ path: string; filename: string; bytes: number; sha256: string } | null> {
  const deadline = Date.now() + timeoutMs;
  let seen: { name: string; size: number } | null = null;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 500));
    let entries: string[];
    try {
      entries = readdirSync(downloadDir);
    } catch {
      continue;
    }
    const candidates = entries.filter(
      (name) => !beforeFiles.has(name) && !/\.(crdownload|part|tmp)$/i.test(name),
    );
    for (const name of candidates) {
      const full = join(downloadDir, name);
      try {
        const st = statSync(full);
        if (!st.isFile() || st.size === 0) continue;
        if (seen && seen.name === name && seen.size === st.size) {
          const sha256 = crypto.createHash("sha256").update(readFileSync(full)).digest("hex");
          return { path: full, filename: name, bytes: st.size, sha256 };
        }
        seen = { name, size: st.size };
      } catch {
        // file still moving
      }
    }
  }
  return null;
}

/** DOM mode: locator-based, accessibility elements, đọc text. */
export class PlaywrightBackend implements BrowserBackend {
  readonly kind = "playwright" as const;
  private readonly forbiddenMarkers: string[];

  constructor(private readonly provider: PageProvider, options: { forbiddenMarkers?: string[] } = {}) {
    this.forbiddenMarkers = options.forbiddenMarkers ?? [];
  }

  async navigate(url: string): Promise<BrowserResult> {
    try {
      const page = await this.provider.getPage();
      const response = await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 });
      const { title, snippet } = await pageState(page, true);
      const { status, reason } = classifyPageStatus(response?.status(), title, page.url(), snippet, this.forbiddenMarkers);
      return resultOf("navigate", this.kind, status, {
        http: response?.status(),
        url: page.url(),
        title,
        ...(reason ? { hint: reason } : {}),
      });
    } catch (error) {
      return toErrorResult("navigate", this.kind, error);
    }
  }

  async snapshot(): Promise<BrowserResult> {
    try {
      const page = await this.provider.getPage();
      const elements = await extractElements(page);
      const state = await pageState(page, true);
      const classified = classifyPageStatus(undefined, state.title, state.url, state.snippet, this.forbiddenMarkers);
      const status: BrowserStatus = classified.status === "ok" ? (elements.length ? "ok" : "empty") : classified.status;
      return resultOf("snapshot", this.kind, status, {
        url: state.url,
        title: state.title,
        ...(classified.reason ? { hint: classified.reason } : {}),
        content: { type: "accessibility_tree", elements },
      });
    } catch (error) {
      return toErrorResult("snapshot", this.kind, error);
    }
  }

  async click(ref: string): Promise<BrowserResult> {
    try {
      if (!isSafeRef(ref)) {
        return resultOf("click", this.kind, "locator_not_found", {
          hint: `ref không hợp lệ cho Playwright: "${ref}" (chỉ nhận r-<n>; toạ độ "@x,y" chỉ dùng cho CUA)`,
        });
      }
      const page = await this.provider.getPage();
      const locator = page.locator(`[data-dsh-ref="${ref}"]`);
      if ((await locator.count()) === 0) throw notFound(ref);
      await locator.first().click({ timeout: 10_000 });
      const state = await pageState(page, true);
      const check = actionStatus(state.title, state.url, state.snippet, this.forbiddenMarkers);
      return resultOf("click", this.kind, check.status, {
        url: state.url,
        title: state.title,
        ...(check.reason ? { hint: check.reason } : {}),
      });
    } catch (error) {
      return toErrorResult("click", this.kind, error);
    }
  }

  async type(ref: string, text: string): Promise<BrowserResult> {
    try {
      if (!isSafeRef(ref)) {
        return resultOf("type", this.kind, "locator_not_found", {
          hint: `ref không hợp lệ cho Playwright: "${ref}" (chỉ nhận r-<n>; toạ độ "@x,y" chỉ dùng cho CUA)`,
        });
      }
      const page = await this.provider.getPage();
      const locator = page.locator(`[data-dsh-ref="${ref}"]`);
      if ((await locator.count()) === 0) throw notFound(ref);
      await locator.first().fill(text, { timeout: 10_000 });
      const state = await pageState(page, true);
      const check = actionStatus(state.title, state.url, state.snippet, this.forbiddenMarkers);
      return resultOf("type", this.kind, check.status, {
        url: state.url,
        title: state.title,
        ...(check.reason ? { hint: check.reason } : {}),
      });
    } catch (error) {
      return toErrorResult("type", this.kind, error);
    }
  }

  async extract(goal: string): Promise<BrowserResult> {
    try {
      const page = await this.provider.getPage();
      const elements = await extractElements(page);
      const text = await page.evaluate(() => (document.body?.innerText ?? "").slice(0, 20_000));
      const state = await pageState(page);
      const check = classifyPageStatus(undefined, state.title, state.url, text.slice(0, 1500), this.forbiddenMarkers);
      return resultOf("extract", this.kind, check.status === "ok" ? "ok" : check.status, {
        url: state.url,
        title: state.title,
        ...(check.reason ? { hint: check.reason } : {}),
        content: { type: "dom_text", goal, text, elements },
      });
    } catch (error) {
      return toErrorResult("extract", this.kind, error);
    }
  }

  async screenshot(fullPage: boolean): Promise<BrowserResult> {
    try {
      const page = await this.provider.getPage();
      const image = (await page.screenshot({ fullPage })).toString("base64");
      const state = await pageState(page);
      return resultOf("screenshot", this.kind, "ok", {
        url: state.url,
        title: state.title,
        content: { type: "image", image },
      });
    } catch (error) {
      return toErrorResult("screenshot", this.kind, error);
    }
  }

  async wait(condition?: string, value?: string, timeoutMs = 10_000): Promise<BrowserResult> {
    try {
      const page = await this.provider.getPage();
      await runWait(page, condition, value, timeoutMs);
      const state = await pageState(page);
      return resultOf("wait", this.kind, "ok", { url: state.url, title: state.title });
    } catch (error) {
      return toErrorResult("wait", this.kind, error);
    }
  }

  async goBack(): Promise<BrowserResult> {
    try {
      const page = await this.provider.getPage();
      await page.goBack({ timeout: 30_000 });
      const state = await pageState(page);
      return resultOf("go_back", this.kind, "ok", { url: state.url, title: state.title });
    } catch (error) {
      return toErrorResult("go_back", this.kind, error);
    }
  }

  async refresh(): Promise<BrowserResult> {
    try {
      const page = await this.provider.getPage();
      await page.reload({ timeout: 30_000 });
      const state = await pageState(page);
      return resultOf("refresh", this.kind, "ok", { url: state.url, title: state.title });
    } catch (error) {
      return toErrorResult("refresh", this.kind, error);
    }
  }

  async submit(): Promise<BrowserResult> {
    try {
      const page = await this.provider.getPage();
      await page.keyboard.press("Enter");
      const state = await pageState(page);
      return resultOf("submit", this.kind, "ok", { url: state.url, title: state.title });
    } catch (error) {
      return toErrorResult("submit", this.kind, error);
    }
  }

  async download(ref: string, downloadDir: string, timeoutMs = 60_000): Promise<BrowserResult> {
    try {
      if (!isSafeRef(ref)) {
        return resultOf("download", this.kind, "locator_not_found", {
          hint: `ref không hợp lệ cho Playwright download: "${ref}"`,
        });
      }
      const absDir = resolve(downloadDir);
      mkdirSync(absDir, { recursive: true });
      const before = new Set(readdirSync(absDir));

      const page = await this.provider.getPage();
      const cdp = await page.context().newCDPSession(page);
      try {
        await cdp.send("Browser.setDownloadBehavior", {
          behavior: "allow",
          downloadPath: absDir,
          eventsEnabled: true,
        });
      } catch {
        // fallback for older CDP targets
        await cdp.send("Page.setDownloadBehavior", { behavior: "allow", downloadPath: absDir });
      } finally {
        await cdp.detach().catch(() => undefined);
      }

      const locator = page.locator(`[data-dsh-ref="${ref}"]`);
      if ((await locator.count()) === 0) throw notFound(ref);
      await locator.first().click({ timeout: 10_000 });

      const file = await waitForDownloadedFile(absDir, before, timeoutMs);
      const state = await pageState(page);
      if (!file) {
        return resultOf("download", this.kind, "timeout", {
          url: state.url,
          title: state.title,
          hint: `không thấy file tải xong trong ${absDir} sau ${timeoutMs}ms`,
        });
      }
      return resultOf("download", this.kind, "ok", {
        url: state.url,
        title: state.title,
        content: { type: "download", ...file },
      });
    } catch (error) {
      return toErrorResult("download", this.kind, error);
    }
  }

  async closeTab(): Promise<BrowserResult> {
    const closed = await this.provider.closeTab();
    return resultOf("close_tab", this.kind, "ok", {
      content: { closed },
      hint: closed ? "đã đóng tab làm việc tạm (tab nền được giữ nguyên)" : "không có tab tạm đang mở",
    });
  }
}

/** Vision mode: click/type theo toạ độ, dùng chung tab tạm với Playwright. */
export class CuaBackend implements BrowserBackend {
  readonly kind = "cua" as const;
  private readonly boxes = new Map<string, [number, number, number, number]>();
  private readonly forbiddenMarkers: string[];

  constructor(private readonly provider: PageProvider, options: { forbiddenMarkers?: string[] } = {}) {
    this.forbiddenMarkers = options.forbiddenMarkers ?? [];
  }

  private remember(elements: SnapshotElement[]): void {
    this.boxes.clear();
    for (const el of elements) {
      if (el.bbox) this.boxes.set(el.ref, el.bbox);
    }
  }

  private center(box: [number, number, number, number]): [number, number] {
    return [box[0] + box[2] / 2, box[1] + box[3] / 2];
  }

  async navigate(url: string): Promise<BrowserResult> {
    try {
      const page = await this.provider.getPage();
      let http: number | undefined;
      try {
        const response = await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 });
        http = response?.status();
      } catch {
        // trang chặn goto — vẫn chụp trạng thái thực tế
      }
      const elements = await extractElements(page);
      this.remember(elements);
      const image = (await page.screenshot({ fullPage: false })).toString("base64");
      const { title, snippet } = await pageState(page, true);
      const classified = classifyPageStatus(http, title, page.url(), snippet, this.forbiddenMarkers);
      const status: BrowserStatus =
        classified.status === "captcha" || classified.status === "needs_human" ? classified.status : "ok";
      return resultOf("navigate", this.kind, status, {
        http,
        url: page.url(),
        title,
        ...(classified.reason && status !== "ok" ? { hint: classified.reason } : {}),
        content: { type: "visual", image, elements },
      });
    } catch (error) {
      return toErrorResult("navigate", this.kind, error);
    }
  }

  async snapshot(): Promise<BrowserResult> {
    try {
      const page = await this.provider.getPage();
      const elements = await extractElements(page);
      this.remember(elements);
      const image = (await page.screenshot({ fullPage: false })).toString("base64");
      const state = await pageState(page, true);
      const check = actionStatus(state.title, state.url, state.snippet, this.forbiddenMarkers);
      return resultOf("snapshot", this.kind, check.status, {
        url: state.url,
        title: state.title,
        ...(check.reason ? { hint: check.reason } : {}),
        content: { type: "visual", image, elements },
      });
    } catch (error) {
      return toErrorResult("snapshot", this.kind, error);
    }
  }

  async click(ref: string): Promise<BrowserResult> {
    try {
      const page = await this.provider.getPage();
      const point = parsePoint(ref);
      if (point) {
        await page.mouse.click(point[0], point[1]);
      } else {
        const box = this.boxes.get(ref);
        if (!box) {
          return resultOf("click", this.kind, "locator_not_found", {
            hint: `CUA không có bbox cho ref "${ref}" — gọi browse_snapshot trước, hoặc dùng ref "@x,y"`,
          });
        }
        const [x, y] = this.center(box);
        await page.mouse.click(x, y);
      }
      const state = await pageState(page, true);
      const check = actionStatus(state.title, state.url, state.snippet, this.forbiddenMarkers);
      return resultOf("click", this.kind, check.status, {
        url: state.url,
        title: state.title,
        ...(check.reason ? { hint: check.reason } : {}),
      });
    } catch (error) {
      return toErrorResult("click", this.kind, error);
    }
  }

  async type(ref: string, text: string): Promise<BrowserResult> {
    try {
      const page = await this.provider.getPage();
      const point = parsePoint(ref);
      if (point) {
        await page.mouse.click(point[0], point[1]);
      } else {
        const box = this.boxes.get(ref);
        if (!box) {
          return resultOf("type", this.kind, "locator_not_found", {
            hint: `CUA không có bbox cho ref "${ref}" — gọi browse_snapshot trước, hoặc dùng ref "@x,y"`,
          });
        }
        const [x, y] = this.center(box);
        await page.mouse.click(x, y);
      }
      await page.keyboard.type(text);
      const state = await pageState(page, true);
      const check = actionStatus(state.title, state.url, state.snippet, this.forbiddenMarkers);
      return resultOf("type", this.kind, check.status, {
        url: state.url,
        title: state.title,
        ...(check.reason ? { hint: check.reason } : {}),
      });
    } catch (error) {
      return toErrorResult("type", this.kind, error);
    }
  }

  async extract(goal: string): Promise<BrowserResult> {
    try {
      const page = await this.provider.getPage();
      const elements = await extractElements(page);
      this.remember(elements);
      const image = (await page.screenshot({ fullPage: false })).toString("base64");
      const state = await pageState(page, true);
      const check = actionStatus(state.title, state.url, state.snippet, this.forbiddenMarkers);
      return resultOf("extract", this.kind, check.status, {
        url: state.url,
        title: state.title,
        ...(check.reason ? { hint: check.reason } : {}),
        content: { type: "visual", goal, image, elements },
      });
    } catch (error) {
      return toErrorResult("extract", this.kind, error);
    }
  }

  async screenshot(fullPage: boolean): Promise<BrowserResult> {
    try {
      const page = await this.provider.getPage();
      const image = (await page.screenshot({ fullPage })).toString("base64");
      const state = await pageState(page);
      return resultOf("screenshot", this.kind, "ok", {
        url: state.url,
        title: state.title,
        content: { type: "image", image },
      });
    } catch (error) {
      return toErrorResult("screenshot", this.kind, error);
    }
  }

  async wait(condition?: string, value?: string, timeoutMs = 10_000): Promise<BrowserResult> {
    try {
      const page = await this.provider.getPage();
      await runWait(page, condition, value, timeoutMs);
      const state = await pageState(page);
      return resultOf("wait", this.kind, "ok", { url: state.url, title: state.title });
    } catch (error) {
      return toErrorResult("wait", this.kind, error);
    }
  }

  async goBack(): Promise<BrowserResult> {
    try {
      const page = await this.provider.getPage();
      await page.goBack({ timeout: 30_000 });
      const state = await pageState(page);
      return resultOf("go_back", this.kind, "ok", { url: state.url, title: state.title });
    } catch (error) {
      return toErrorResult("go_back", this.kind, error);
    }
  }

  async refresh(): Promise<BrowserResult> {
    try {
      const page = await this.provider.getPage();
      await page.reload({ timeout: 30_000 });
      const state = await pageState(page);
      return resultOf("refresh", this.kind, "ok", { url: state.url, title: state.title });
    } catch (error) {
      return toErrorResult("refresh", this.kind, error);
    }
  }

  async submit(): Promise<BrowserResult> {
    try {
      const page = await this.provider.getPage();
      await page.keyboard.press("Enter");
      const state = await pageState(page);
      return resultOf("submit", this.kind, "ok", { url: state.url, title: state.title });
    } catch (error) {
      return toErrorResult("submit", this.kind, error);
    }
  }

  async download(ref: string, downloadDir: string, timeoutMs = 60_000): Promise<BrowserResult> {
    try {
      const absDir = resolve(downloadDir);
      mkdirSync(absDir, { recursive: true });
      const before = new Set(readdirSync(absDir));

      const page = await this.provider.getPage();
      const cdp = await page.context().newCDPSession(page);
      try {
        await cdp.send("Browser.setDownloadBehavior", {
          behavior: "allow",
          downloadPath: absDir,
          eventsEnabled: true,
        });
      } catch {
        await cdp.send("Page.setDownloadBehavior", { behavior: "allow", downloadPath: absDir });
      } finally {
        await cdp.detach().catch(() => undefined);
      }

      const point = parsePoint(ref);
      if (point) {
        await page.mouse.click(point[0], point[1]);
      } else {
        const box = this.boxes.get(ref);
        if (!box) return resultOf("download", this.kind, "locator_not_found", { hint: `không có bbox cho ${ref}` });
        const [x, y] = this.center(box);
        await page.mouse.click(x, y);
      }

      const file = await waitForDownloadedFile(absDir, before, timeoutMs);
      const state = await pageState(page);
      if (!file) {
        return resultOf("download", this.kind, "timeout", {
          url: state.url,
          title: state.title,
          hint: `không thấy file tải xong trong ${absDir} sau ${timeoutMs}ms`,
        });
      }
      return resultOf("download", this.kind, "ok", {
        url: state.url,
        title: state.title,
        content: { type: "download", ...file },
      });
    } catch (error) {
      return toErrorResult("download", this.kind, error);
    }
  }

  async closeTab(): Promise<BrowserResult> {
    const closed = await this.provider.closeTab();
    return resultOf("close_tab", this.kind, "ok", {
      content: { closed },
      hint: closed ? "đã đóng tab làm việc tạm (tab nền được giữ nguyên)" : "không có tab tạm đang mở",
    });
  }
}
