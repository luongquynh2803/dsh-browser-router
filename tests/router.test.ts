import { test } from "node:test";
import assert from "node:assert/strict";
import { BrowserRouter } from "../src/router.js";
import { parseRouterConfig } from "../src/config.js";
import type { BrowserBackend } from "../src/backends.js";
import type { BackendKind, BrowserResult, BrowserStatus } from "../src/types.js";

/** Fake backend tất định, chỉ dùng trong test (test double). */
class FakeBackend implements BrowserBackend {
  readonly calls: string[] = [];
  constructor(
    readonly kind: BackendKind,
    private status: BrowserStatus,
  ) {}

  setStatus(status: BrowserStatus): void {
    this.status = status;
  }

  private respond(action: BrowserResult["action"]): BrowserResult {
    this.calls.push(action);
    return { ok: this.status === "ok", action, backend: this.kind, switched: false, status: this.status };
  }

  async navigate(): Promise<BrowserResult> {
    return this.respond("navigate");
  }
  async snapshot(): Promise<BrowserResult> {
    return this.respond("snapshot");
  }
  async click(): Promise<BrowserResult> {
    return this.respond("click");
  }
  async type(): Promise<BrowserResult> {
    return this.respond("type");
  }
  async extract(): Promise<BrowserResult> {
    return this.respond("extract");
  }
  async screenshot(): Promise<BrowserResult> {
    return this.respond("screenshot");
  }
  async wait(): Promise<BrowserResult> {
    return this.respond("wait");
  }
  async goBack(): Promise<BrowserResult> {
    return this.respond("go_back");
  }
  async refresh(): Promise<BrowserResult> {
    return this.respond("refresh");
  }
  async submit(): Promise<BrowserResult> {
    return this.respond("submit");
  }
}

function setup(maxCuaSteps = 8) {
  const cfg = parseRouterConfig({
    browser: {
      default_backend: "playwright",
      escalation: { enabled: true },
      cost_guard: { max_cua_steps: maxCuaSteps },
    },
  });
  const playwright = new FakeBackend("playwright", "blocked");
  const cua = new FakeBackend("cua", "ok");
  return { cfg, playwright, cua, router: new BrowserRouter(cfg, { playwright, cua }) };
}

test("escalate playwright → cua khi status blocked", async () => {
  const { router, playwright, cua } = setup();
  const result = await router.execute("navigate", { url: "https://example.com" });
  assert.equal(result.backend, "cua");
  assert.equal(result.status, "ok");
  assert.equal(result.switched, true);
  assert.equal(router.currentBackend, "cua");
  assert.deepEqual(playwright.calls, ["navigate"]); // escalate: KHÔNG probe ngay lượt escalate
  assert.deepEqual(cua.calls, ["navigate"]);
});

test("lượt CUA sau escalate → probe tự hạ về playwright", async () => {
  const { router, playwright } = setup();
  await router.execute("navigate", { url: "https://example.com" }); // escalate → cua (escalateCount=1)
  assert.equal(router.currentBackend, "cua");
  playwright.setStatus("ok");
  const snap = await router.execute("snapshot", {}); // lượt CUA sau, switched=false → probe
  assert.equal(router.currentBackend, "playwright");
  assert.ok(snap.hint?.includes("probe-downgrade"));
});

test("không escalate khi status ok", async () => {
  const { router, playwright, cua } = setup();
  playwright.setStatus("ok");
  const result = await router.execute("navigate", { url: "https://example.com" });
  assert.equal(result.backend, "playwright");
  assert.equal(result.switched, false);
  assert.deepEqual(cua.calls, []);
});

test("domain-map chọn cua ngay từ đầu", async () => {
  const cfg = parseRouterConfig({
    browser: { rules: [{ match: "*.linkedin.com", backend: "cua" }] },
  });
  const playwright = new FakeBackend("playwright", "ok");
  const cua = new FakeBackend("cua", "ok");
  const router = new BrowserRouter(cfg, { playwright, cua });
  const result = await router.execute("navigate", { url: "https://www.linkedin.com/in/x" });
  assert.equal(result.backend, "cua");
  assert.deepEqual(playwright.calls, []);
});

test("cost guard: chặn escalation khi hết max_cua_steps", async () => {
  const { router } = setup(1);
  const first = await router.execute("navigate", { url: "https://a.com" });
  assert.equal(first.status, "ok");
  const second = await router.execute("navigate", { url: "https://b.com" });
  assert.equal(second.status, "budget_exhausted");
  assert.equal(second.ok, false);
});

test("captcha → needs_human, KHÔNG escalate sang CUA", async () => {
  const { router, playwright, cua } = setup();
  playwright.setStatus("captcha");
  const result = await router.execute("navigate", { url: "https://example.com" });
  assert.equal(result.status, "needs_human");
  assert.equal(result.ok, false);
  assert.deepEqual(cua.calls, []);
  assert.deepEqual(playwright.calls, ["navigate"]);
});

test("submit mặc định (require_approval_submit=true) → needs_human, không thực thi", async () => {
  const { router, playwright } = setup();
  const result = await router.execute("submit", {});
  assert.equal(result.status, "needs_human");
  assert.equal(result.ok, false);
  assert.deepEqual(playwright.calls, []);
});

test("submit với require_approval_submit=false → thực thi", async () => {
  const cfg = parseRouterConfig({
    browser: { default_backend: "playwright", require_approval_submit: false },
  });
  const playwright = new FakeBackend("playwright", "ok");
  const cua = new FakeBackend("cua", "ok");
  const router = new BrowserRouter(cfg, { playwright, cua });
  const result = await router.execute("submit", {});
  assert.equal(result.status, "ok");
  assert.deepEqual(playwright.calls, ["submit"]);
});

test("probe-downgrade: cua ok → playwright snapshot ok → chuyển về playwright", async () => {
  const { router, playwright } = setup();
  await router.execute("navigate", { url: "https://a.com" }); // → cua
  assert.equal(router.currentBackend, "cua");
  playwright.setStatus("ok");
  const probe = await router.probeDowngrade();
  assert.ok(probe);
  assert.equal(probe?.status, "ok");
  assert.equal(router.currentBackend, "playwright");
});

test("probe-downgrade: playwright vẫn blocked → giữ cua", async () => {
  const { router, playwright } = setup();
  await router.execute("navigate", { url: "https://a.com" }); // → cua
  playwright.setStatus("blocked");
  const probe = await router.probeDowngrade();
  assert.ok(probe);
  assert.equal(probe?.status, "blocked");
  assert.equal(router.currentBackend, "cua");
});

test("navigate chặn sớm file:// và loopback SSRF mà không gọi backend hay escalate sang CUA", async () => {
  const { router, playwright, cua } = setup();
  const localFile = await router.execute("navigate", { url: "file:///etc/passwd" });
  assert.equal(localFile.ok, false);
  assert.equal(localFile.status, "blocked");

  const localCdp = await router.execute("navigate", { url: "http://127.0.0.1:9222/json" });
  assert.equal(localCdp.ok, false);
  assert.equal(localCdp.status, "blocked");

  assert.deepEqual(playwright.calls, []);
  assert.deepEqual(cua.calls, []);
  assert.equal(router.cuaSteps, 0);
});
