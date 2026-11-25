import { chromium, type Browser, type Page } from "playwright-core";
import type { BackendKind, BrowserResult, SnapshotElement, BrowserStatus } from "./types.js";

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
}

export interface PageProvider {
  getPage(): Promise<Page>;
  close(): Promise<void>;
}

/** Kết nối tới 1 Chrome đang chạy với --remote-debugging-port (1 profile per bot). */
export function createPageProvider(endpoint: string): PageProvider {
  let browser: Browser | null = null;
  let page: Page | null = null;
  return {
    async getPage(): Promise<Page> {
      // Stale reference guard: tab bị đóng / Chrome restart → kết nối lại.
      if (page && !page.isClosed() && browser?.isConnected()) return page;
      page = null;
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
      page = context.pages()[0] ?? (await context.newPage());
      return page;
    },
    async close(): Promise<void> {
      if (browser) {
        try {
          await browser.close();
        } catch {
          // đã đóng sẵn
        }
      }
      page = null;
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

function classifyStatus(http: number | undefined, title: string, url: string): BrowserStatus {
  if (http === 429) return "rate_limited";
  if (http === 403) return "blocked";
  if (http !== undefined && http >= 400) return "blocked";
  const hay = `${title} ${url}`.toLowerCase();
  if (/captcha|challenge|verify you are human|are you a robot/.test(hay)) return "captcha";
  const t = title.toLowerCase();
  if (/(sign in|log in|login|signin)/.test(t) && !/log out|logout/.test(t)) return "login_required";
  return "ok";
}

function resultOf(
  action: BrowserResult["action"],
  backend: BackendKind,
  status: BrowserStatus,
  extra: Partial<BrowserResult> = {},
): BrowserResult {
  return { ok: status === "ok", action, backend, switched: false, status, ...extra };
}

async function pageState(page: Page): Promise<{ url: string; title: string }> {
  return { url: page.url(), title: await page.title().catch(() => "") };
}

/**
 * Click/type/snapshot/extract chỉ surface CAPTCHA (dấu hiệu cần người); login/blocked giữ "ok"
 * để tránh router escalate → chạy lại action (double-click/type) hoặc làm CUA báo lỗi giả.
 */
function actionStatus(title: string, url: string): BrowserStatus {
  return classifyStatus(undefined, title, url) === "captcha" ? "captcha" : "ok";
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

/** ref DOM hợp lệ: r-<n>. Mọi thứ khác (kể cả "@x,y") không được đưa vào CSS selector. */
const SAFE_REF = /^r-\d+$/;
function isSafeRef(ref: string): boolean {
  return SAFE_REF.test(ref);
}

/** Parse ref dạng "@x,y" hoặc "x,y" → toạ độ (dùng cho CUA). */
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

/** DOM mode: locator-based, accessibility elements, đọc text. */
export class PlaywrightBackend implements BrowserBackend {
  readonly kind = "playwright" as const;
  constructor(private readonly provider: PageProvider) {}

  async navigate(url: string): Promise<BrowserResult> {
    try {
      const page = await this.provider.getPage();
      const response = await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 });
      const { title } = await pageState(page);
      const status = classifyStatus(response?.status(), title, page.url());
      return resultOf("navigate", this.kind, status, { http: response?.status(), url: page.url(), title });
    } catch (error) {
      return toErrorResult("navigate", this.kind, error);
    }
  }

  async snapshot(): Promise<BrowserResult> {
    try {
      const page = await this.provider.getPage();
      const elements = await extractElements(page);
      const state = await pageState(page);
      // Snapshot phải phản ánh trạng thái trang (login wall/captcha), không chỉ "có element = ok".
      const classified = classifyStatus(undefined, state.title, state.url);
      const status: BrowserStatus = classified === "ok" ? (elements.length ? "ok" : "empty") : classified;
      return resultOf("snapshot", this.kind, status, {
        ...state,
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
      const state = await pageState(page);
      return resultOf("click", this.kind, actionStatus(state.title, state.url), state);
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
      const state = await pageState(page);
      return resultOf("type", this.kind, actionStatus(state.title, state.url), state);
    } catch (error) {
      return toErrorResult("type", this.kind, error);
    }
  }

  async extract(goal: string): Promise<BrowserResult> {
    try {
      const page = await this.provider.getPage();
      const elements = await extractElements(page);
      const text = await page.evaluate(() => (document.body?.innerText ?? "").slice(0, 20_000));
      return resultOf("extract", this.kind, "ok", {
        ...(await pageState(page)),
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
      return resultOf("screenshot", this.kind, "ok", {
        ...(await pageState(page)),
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
      return resultOf("wait", this.kind, "ok", await pageState(page));
    } catch (error) {
      return toErrorResult("wait", this.kind, error);
    }
  }

  async goBack(): Promise<BrowserResult> {
    try {
      const page = await this.provider.getPage();
      await page.goBack({ timeout: 30_000 });
      return resultOf("go_back", this.kind, "ok", await pageState(page));
    } catch (error) {
      return toErrorResult("go_back", this.kind, error);
    }
  }

  async refresh(): Promise<BrowserResult> {
    try {
      const page = await this.provider.getPage();
      await page.reload({ timeout: 30_000 });
      return resultOf("refresh", this.kind, "ok", await pageState(page));
    } catch (error) {
      return toErrorResult("refresh", this.kind, error);
    }
  }

  async submit(): Promise<BrowserResult> {
    try {
      const page = await this.provider.getPage();
      await page.keyboard.press("Enter");
      return resultOf("submit", this.kind, "ok", await pageState(page));
    } catch (error) {
      return toErrorResult("submit", this.kind, error);
    }
  }
}

/**
 * Vision mode THẬT: click/type theo TOẠ ĐỘ (từ bbox của snapshot trước hoặc "@x,y"),
 * KHÔNG phụ thuộc DOM [data-dsh-ref]. Dùng chung page với Playwright.
 */
export class CuaBackend implements BrowserBackend {
  readonly kind = "cua" as const;
  private readonly boxes = new Map<string, [number, number, number, number]>();

  constructor(private readonly provider: PageProvider) {}

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
        // trang chặn goto — vẫn chụp trạng thái thực tế cho model nhìn
      }
      const elements = await extractElements(page);
      this.remember(elements);
      const image = (await page.screenshot({ fullPage: false })).toString("base64");
      const { title } = await pageState(page);
      // blocked/login vẫn trả "ok" (model NHÌN được ảnh là đích); chỉ captcha phải surfaced
      // để router trả needs_human thay vì để model tự click mò.
      const classified = classifyStatus(http, title, page.url());
      const status: BrowserStatus = classified === "captcha" ? "captcha" : "ok";
      return resultOf("navigate", this.kind, status, {
        http,
        url: page.url(),
        title,
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
      const state = await pageState(page);
      return resultOf("snapshot", this.kind, actionStatus(state.title, state.url), {
        ...state,
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
        const state = await pageState(page);
        return resultOf("click", this.kind, actionStatus(state.title, state.url), state);
      }
      const box = this.boxes.get(ref);
      if (!box) {
        return resultOf("click", this.kind, "locator_not_found", {
          hint: `CUA không có bbox cho ref "${ref}" — gọi browse_snapshot trước, hoặc dùng ref dạng "@x,y"`,
        });
      }
      const [x, y] = this.center(box);
      await page.mouse.click(x, y);
      const state = await pageState(page);
      return resultOf("click", this.kind, actionStatus(state.title, state.url), state);
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
      const state = await pageState(page);
      return resultOf("type", this.kind, actionStatus(state.title, state.url), state);
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
      const state = await pageState(page);
      return resultOf("extract", this.kind, actionStatus(state.title, state.url), {
        ...state,
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
      return resultOf("screenshot", this.kind, "ok", {
        ...(await pageState(page)),
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
      return resultOf("wait", this.kind, "ok", await pageState(page));
    } catch (error) {
      return toErrorResult("wait", this.kind, error);
    }
  }

  async goBack(): Promise<BrowserResult> {
    try {
      const page = await this.provider.getPage();
      await page.goBack({ timeout: 30_000 });
      return resultOf("go_back", this.kind, "ok", await pageState(page));
    } catch (error) {
      return toErrorResult("go_back", this.kind, error);
    }
  }

  async refresh(): Promise<BrowserResult> {
    try {
      const page = await this.provider.getPage();
      await page.reload({ timeout: 30_000 });
      return resultOf("refresh", this.kind, "ok", await pageState(page));
    } catch (error) {
      return toErrorResult("refresh", this.kind, error);
    }
  }

  async submit(): Promise<BrowserResult> {
    try {
      const page = await this.provider.getPage();
      await page.keyboard.press("Enter");
      return resultOf("submit", this.kind, "ok", await pageState(page));
    } catch (error) {
      return toErrorResult("submit", this.kind, error);
    }
  }
}
