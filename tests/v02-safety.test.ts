import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createSqliteApprovalVerifier } from "../src/approval.js";
import { classifyPageStatus, type BrowserBackend } from "../src/backends.js";
import { DEFAULT_CONFIG, parseRouterConfig, validateNavigateUrl } from "../src/config.js";
import { acquireChromeLock, withChromeLock } from "../src/lock.js";
import { BrowserRouter } from "../src/router.js";
import type { BackendKind, BrowserResult } from "../src/types.js";

function makeStubBackend(kind: BackendKind, overrides: Partial<BrowserBackend> = {}): BrowserBackend & { calls: string[] } {
  const calls: string[] = [];
  const ok = (action: BrowserResult["action"], extra: Partial<BrowserResult> = {}): BrowserResult => ({
    ok: true,
    action,
    backend: kind,
    switched: false,
    status: "ok",
    ...extra,
  });
  return {
    kind,
    calls,
    navigate: async (url) => {
      calls.push(`navigate:${url}`);
      return ok("navigate", { url });
    },
    snapshot: async () => {
      calls.push("snapshot");
      return ok("snapshot");
    },
    click: async (ref) => {
      calls.push(`click:${ref}`);
      return ok("click");
    },
    type: async (ref, text) => {
      calls.push(`type:${ref}:${text}`);
      return ok("type");
    },
    extract: async () => {
      calls.push("extract");
      return ok("extract");
    },
    screenshot: async () => {
      calls.push("screenshot");
      return ok("screenshot");
    },
    wait: async () => {
      calls.push("wait");
      return ok("wait");
    },
    goBack: async () => {
      calls.push("go_back");
      return ok("go_back");
    },
    refresh: async () => {
      calls.push("refresh");
      return ok("refresh");
    },
    submit: async () => {
      calls.push("submit");
      return ok("submit");
    },
    download: async (ref, dir) => {
      calls.push(`download:${ref}:${dir}`);
      return ok("download", { content: { type: "download", path: `${dir}/report.csv`, bytes: 120, sha256: "abc" } });
    },
    closeTab: async () => {
      calls.push("close_tab");
      return ok("close_tab", { content: { closed: true } });
    },
    ...overrides,
  };
}

describe("dsh-browser-router v0.2.0 safety patches", () => {
  it("parses all v0.2.0 safety config fields", () => {
    const cfg = parseRouterConfig({
      browser: {
        allowed_domains: ["*.amazon.com", "advertising.amazon.com"],
        protected_hosts: ["sellercentral.amazon.com", "members.helium10.com"],
        isolated_tab: true,
        idle_tab_close_ms: 60000,
        read_only: true,
        require_approval_mutation: true,
        stop_on_login: true,
        forbidden_page_markers: ["OTHER_ACCOUNT"],
        download_dir: "/tmp/dl",
        lock_path: "/tmp/chrome.lock.d",
        approval_db_path: "/tmp/state.db",
      },
    });
    assert.deepEqual(cfg.allowed_domains, ["*.amazon.com", "advertising.amazon.com"]);
    assert.equal(cfg.protected_hosts.length, 2);
    assert.equal(cfg.isolated_tab, true);
    assert.equal(cfg.idle_tab_close_ms, 60000);
    assert.equal(cfg.read_only, true);
    assert.equal(cfg.require_approval_mutation, true);
    assert.equal(cfg.stop_on_login, true);
    assert.deepEqual(cfg.forbidden_page_markers, ["OTHER_ACCOUNT"]);
  });

  it("enforces allowed_domains allowlist before touching browser backend", async () => {
    const pw = makeStubBackend("playwright");
    const cua = makeStubBackend("cua");
    const cfg = { ...structuredClone(DEFAULT_CONFIG), allowed_domains: ["advertising.amazon.com", "*.sellercentral.amazon.com"] };
    const router = new BrowserRouter(cfg, { playwright: pw, cua });

    const denied = await router.execute("navigate", { url: "https://evil.example.com/phish" });
    assert.equal(denied.ok, false);
    assert.equal(denied.status, "blocked");
    assert.equal(pw.calls.length, 0);
    assert.equal(cua.calls.length, 0);

    const allowed = await router.execute("navigate", { url: "https://advertising.amazon.com/reports" });
    assert.equal(allowed.ok, true);
    assert.equal(pw.calls.length, 1);

    assert.equal(
      validateNavigateUrl("https://sellercentral.amazon.com/home", { allowedDomains: cfg.allowed_domains }).ok,
      true,
    );
  });

  it("blocks click/type/submit in read_only mode unless backed by valid SQLite approval_id", async () => {
    const dir = mkdtempSync(join(tmpdir(), "br-appr-"));
    const dbPath = join(dir, "state.db");
    const db = new DatabaseSync(dbPath);
    db.exec(`
      CREATE TABLE pending_confirmations (confirmation_id TEXT PRIMARY KEY, status TEXT);
      CREATE TABLE recommendation (id INTEGER PRIMARY KEY, status TEXT);
      INSERT INTO pending_confirmations VALUES ('om_1:ACT-01', 'COMMITTED');
      INSERT INTO pending_confirmations VALUES ('om_1:ACT-02', 'PENDING');
      INSERT INTO recommendation VALUES (42, 'approved');
      INSERT INTO recommendation VALUES (43, 'proposed');
    `);
    db.close();

    try {
      const pw = makeStubBackend("playwright");
      const cua = makeStubBackend("cua");
      const cfg = { ...structuredClone(DEFAULT_CONFIG), read_only: true };
      const router = new BrowserRouter(
        cfg,
        { playwright: pw, cua },
        undefined,
        { approvalVerifier: createSqliteApprovalVerifier(dbPath) },
      );

      // No approval_id -> needs_human
      const c1 = await router.execute("click", { ref: "r-1" });
      assert.equal(c1.status, "needs_human");
      const t1 = await router.execute("type", { ref: "r-2", text: "1.50" });
      assert.equal(t1.status, "needs_human");
      assert.equal(pw.calls.length, 0);

      // Pending (unapproved) approval_id -> needs_human
      const cPending = await router.execute("click", { ref: "r-1", approval_id: "om_1:ACT-02" });
      assert.equal(cPending.status, "needs_human");
      const recProposed = await router.execute("click", { ref: "r-1", approval_id: "rec_43" });
      assert.equal(recProposed.status, "needs_human");

      // Committed Lark confirmation -> allowed
      const cOk = await router.execute("click", { ref: "r-1", approval_id: "om_1:ACT-01" });
      assert.equal(cOk.ok, true);

      // Approved recommendation -> allowed
      const recOk = await router.execute("type", { ref: "r-2", text: "0.95", approval_id: "rec_42" });
      assert.equal(recOk.ok, true);
      assert.equal(pw.calls.length, 2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("stops with needs_human on login_required when stop_on_login=true (no CUA escalation)", async () => {
    const pw = makeStubBackend("playwright", {
      navigate: async (url) => ({
        ok: false,
        action: "navigate",
        backend: "playwright",
        switched: false,
        status: "login_required",
        url,
        hint: "session expired",
      }),
    });
    const cua = makeStubBackend("cua");
    const cfg = { ...structuredClone(DEFAULT_CONFIG), stop_on_login: true };
    const router = new BrowserRouter(cfg, { playwright: pw, cua });

    const res = await router.execute("navigate", { url: "https://advertising.amazon.com/reports" });
    assert.equal(res.status, "needs_human");
    assert.equal(cua.calls.length, 0);
  });

  it("classifies OTP/2FA, signin URLs, and forbidden account markers as needs_human/login_required", () => {
    assert.equal(classifyPageStatus(200, "Two-Step Verification", "https://www.amazon.com/ap/mfa").status, "needs_human");
    assert.equal(classifyPageStatus(200, "Verify", "https://www.amazon.com/ap/cvf/request").status, "needs_human");
    assert.equal(classifyPageStatus(200, "Amazon", "https://www.amazon.com/ap/signin").status, "login_required");
    assert.equal(
      classifyPageStatus(200, "Campaign Manager", "https://advertising.amazon.com/cm", "Advertiser: OTHER_BRAND", ["OTHER_BRAND"]).status,
      "needs_human",
    );
    assert.equal(
      classifyPageStatus(200, "Campaign Manager", "https://advertising.amazon.com/cm", "Advertiser: EXPECTED_BRAND", ["OTHER_BRAND"]).status,
      "ok",
    );
  });

  it("supports download and close_tab actions and coordinates shared Chrome lockdir", async () => {
    const dir = mkdtempSync(join(tmpdir(), "br-lock-"));
    const lockDir = join(dir, "chrome.lock.d");
    const dlDir = join(dir, "downloads");
    try {
      // Stale PID lock is recovered automatically
      mkdirSync(lockDir);
      writeFileSync(join(lockDir, "pid"), "99999999", "utf8");
      const handle = await acquireChromeLock(lockDir, 2000, 50);
      await assert.rejects(() => acquireChromeLock(lockDir, 200, 50), /Chrome lock bận/);
      handle.release();

      const ran = await withChromeLock(lockDir, async () => "done");
      assert.equal(ran, "done");

      const pw = makeStubBackend("playwright");
      const cua = makeStubBackend("cua");
      const cfg = { ...structuredClone(DEFAULT_CONFIG), download_dir: dlDir, lock_path: lockDir };
      const router = new BrowserRouter(cfg, { playwright: pw, cua });

      const dl = await router.execute("download", { ref: "r-5" });
      assert.equal(dl.ok, true);
      assert.equal((dl.content as { type: string }).type, "download");

      const closed = await router.execute("close_tab");
      assert.equal(closed.ok, true);
      assert.equal((closed.content as { closed: boolean }).closed, true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
