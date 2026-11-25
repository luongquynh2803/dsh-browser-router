import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseRouterConfig,
  matchRule,
  validateNavigateUrl,
  RouterConfigError,
} from "../src/config.js";

test("parse config: rules + defaults", () => {
  const cfg = parseRouterConfig({
    browser: {
      default_backend: "playwright",
      rules: [
        { match: "*.amazon.com", backend: "playwright" },
        { match: "*.linkedin.com", backend: "cua" },
      ],
      cost_guard: { max_cua_steps: 5 },
    },
  });
  assert.equal(cfg.default_backend, "playwright");
  assert.equal(cfg.rules.length, 2);
  assert.equal(cfg.cost_guard.max_cua_steps, 5);
  assert.equal(cfg.cost_guard.max_cua_budget_tokens, 20_000);
});

test("matchRule: *.amazon.com khớp cả subdomain lẫn apex", () => {
  const rules = [{ match: "*.amazon.com", backend: "playwright" as const }];
  assert.equal(matchRule("https://www.amazon.com/foo", rules), "playwright");
  assert.equal(matchRule("https://amazon.com/foo", rules), "playwright");
  assert.equal(matchRule("https://evil.com", rules), undefined);
});

test("matchRule: pattern có path", () => {
  const rules = [{ match: "*.google.com/recaptcha*", backend: "cua" as const }];
  assert.equal(matchRule("https://www.google.com/recaptcha/api", rules), "cua");
  assert.equal(matchRule("https://www.google.com/search", rules), undefined);
});

test("matchRule: rule đầu tiên thắng", () => {
  const rules = [
    { match: "*.example.com", backend: "cua" as const },
    { match: "*.example.com", backend: "playwright" as const },
  ];
  assert.equal(matchRule("https://a.example.com", rules), "cua");
});

test("backend không hợp lệ → RouterConfigError", () => {
  assert.throws(() => parseRouterConfig({ browser: { default_backend: "nope" } }), RouterConfigError);
});

test("cost_guard âm → RouterConfigError", () => {
  assert.throws(
    () => parseRouterConfig({ browser: { cost_guard: { max_cua_steps: -1 } } }),
    RouterConfigError,
  );
});

test("matchRule: chống giả mạo domain qua pathname và hỗ trợ URL có :port", () => {
  const rules = [
    { match: "*.amazon.com", backend: "cua" as const },
    { match: "example.com", backend: "cua" as const },
    { match: "api.example.org:8443", backend: "cua" as const },
  ];
  assert.equal(matchRule("https://evil.com/phish.amazon.com", rules), undefined);
  assert.equal(matchRule("https://notamazon.com/foo", rules), undefined);
  assert.equal(matchRule("http://example.com:8080/path", rules), "cua");
  assert.equal(matchRule("https://www.amazon.com:8443/dp/B001", rules), "cua");
  assert.equal(matchRule("https://api.example.org:8443/v1", rules), "cua");
  assert.equal(matchRule("https://api.example.org:9443/v1", rules), undefined);
});

test("validateNavigateUrl: chặn file://, javascript:, chrome:// và địa chỉ nội bộ SSRF", () => {
  assert.equal(validateNavigateUrl("https://example.com/a").ok, true);
  assert.equal(validateNavigateUrl("file:///etc/passwd").ok, false);
  assert.equal(validateNavigateUrl("javascript:alert(1)").ok, false);
  assert.equal(validateNavigateUrl("chrome://settings").ok, false);
  assert.equal(validateNavigateUrl("data:text/html,<h1>hi</h1>").ok, false);
  assert.equal(validateNavigateUrl("data:text/html,<h1>hi</h1>", { allowDataUrls: true }).ok, true);

  assert.equal(validateNavigateUrl("http://127.0.0.1:9222/json/version").ok, false);
  assert.equal(validateNavigateUrl("http://localhost:3081").ok, false);
  assert.equal(validateNavigateUrl("http://169.254.169.254/latest/meta-data").ok, false);
  assert.equal(validateNavigateUrl("http://[::1]:9222").ok, false);
  assert.equal(validateNavigateUrl("http://[::ffff:127.0.0.1]:9222").ok, false);
  assert.equal(validateNavigateUrl("http://192.168.1.10/admin").ok, false);
  assert.equal(validateNavigateUrl("http://10.0.0.8/internal").ok, false);
  assert.equal(validateNavigateUrl("http://127.0.0.1:8080", { allowPrivateNetwork: true }).ok, true);
});
