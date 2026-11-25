import { readFileSync } from "node:fs";
import { isIP } from "node:net";
import { load as loadYaml } from "js-yaml";
import type { BackendKind, DomainRule, RouterConfig } from "./types.js";

export class RouterConfigError extends Error {}

export const DEFAULT_CONFIG: RouterConfig = {
  default_backend: "playwright",
  rules: [],
  escalation: {
    enabled: true,
    // KHÔNG có "captcha": captcha → needs_human (chờ người giải), không tự click mò.
    signals: ["blocked", "login_required", "empty", "locator_not_found", "timeout"],
  },
  cost_guard: { max_cua_steps: 8, max_cua_budget_tokens: 20_000 },
  require_approval_submit: true,
  allow_private_network: false,
  allow_data_urls: false,
};

function assertBackend(value: unknown): asserts value is BackendKind {
  if (value !== "playwright" && value !== "cua") {
    throw new RouterConfigError(`backend không hợp lệ: ${String(value)}`);
  }
}

function asRecord(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new RouterConfigError(`${field} phải là object`);
  }
  return value as Record<string, unknown>;
}

export function parseRouterConfig(raw: unknown): RouterConfig {
  const root = asRecord(raw, "router config");
  const browser = (root.browser ?? root) as Record<string, unknown>;
  const config: RouterConfig = structuredClone(DEFAULT_CONFIG);

  if (browser.default_backend !== undefined) {
    assertBackend(browser.default_backend);
    config.default_backend = browser.default_backend;
  }
  if (browser.rules !== undefined) {
    if (!Array.isArray(browser.rules)) throw new RouterConfigError("rules phải là mảng");
    config.rules = browser.rules.map((rule, i) => {
      const r = asRecord(rule, `rules[${i}]`);
      if (typeof r.match !== "string" || r.match.trim() === "") {
        throw new RouterConfigError(`rules[${i}].match phải là chuỗi không rỗng`);
      }
      assertBackend(r.backend);
      return { match: r.match, backend: r.backend };
    });
  }
  if (browser.escalation !== undefined) {
    const e = asRecord(browser.escalation, "escalation");
    config.escalation = {
      enabled: typeof e.enabled === "boolean" ? e.enabled : config.escalation.enabled,
      signals: Array.isArray(e.signals)
        ? (e.signals as RouterConfig["escalation"]["signals"])
        : config.escalation.signals,
    };
  }
  if (browser.cost_guard !== undefined) {
    const c = asRecord(browser.cost_guard, "cost_guard");
    if (c.max_cua_steps !== undefined) {
      if (typeof c.max_cua_steps !== "number" || c.max_cua_steps <= 0) {
        throw new RouterConfigError("cost_guard.max_cua_steps phải là số > 0");
      }
      config.cost_guard.max_cua_steps = c.max_cua_steps;
    }
    if (c.max_cua_budget_tokens !== undefined) {
      if (typeof c.max_cua_budget_tokens !== "number" || c.max_cua_budget_tokens <= 0) {
        throw new RouterConfigError("cost_guard.max_cua_budget_tokens phải là số > 0");
      }
      config.cost_guard.max_cua_budget_tokens = c.max_cua_budget_tokens;
    }
  }
  if (browser.require_approval_submit !== undefined) {
    if (typeof browser.require_approval_submit !== "boolean") {
      throw new RouterConfigError("require_approval_submit phải là boolean");
    }
    config.require_approval_submit = browser.require_approval_submit;
  }
  if (browser.allow_private_network !== undefined) {
    if (typeof browser.allow_private_network !== "boolean") {
      throw new RouterConfigError("allow_private_network phải là boolean");
    }
    config.allow_private_network = browser.allow_private_network;
  }
  if (browser.allow_data_urls !== undefined) {
    if (typeof browser.allow_data_urls !== "boolean") {
      throw new RouterConfigError("allow_data_urls phải là boolean");
    }
    config.allow_data_urls = browser.allow_data_urls;
  }
  return config;
}

export function loadRouterConfig(path: string): RouterConfig {
  return parseRouterConfig(loadYaml(readFileSync(path, "utf8")));
}

function isPrivateIpv4(ip: string): boolean {
  const parts = ip.split(".").map((part) => Number.parseInt(part, 10));
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return false;
  const [a, b] = parts as [number, number, number, number];
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 100 && b >= 64 && b <= 127)
  );
}

/** Kiểm tra hostname thuộc loopback, link-local, metadata hoặc mạng nội bộ RFC1918/RFC4193. */
export function isPrivateOrLoopbackHost(rawHostname: string): boolean {
  const host = rawHostname.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
  if (!host) return true;
  if (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host.endsWith(".local") ||
    host === "metadata.google.internal"
  ) {
    return true;
  }
  const ipVer = isIP(host);
  if (ipVer === 4) return isPrivateIpv4(host);
  if (ipVer === 6) {
    if (host === "::1" || host === "::" || host.startsWith("fe8") || host.startsWith("fe9") || host.startsWith("fea") || host.startsWith("feb") || host.startsWith("fc") || host.startsWith("fd")) {
      return true;
    }
    if (host.startsWith("::ffff:")) {
      const tail = host.slice("::ffff:".length);
      if (isIP(tail) === 4) return isPrivateIpv4(tail);
      // WHATWG URL chuẩn hoá ::ffff:127.0.0.1 → ::ffff:7f00:1 (2 nhóm hex 16-bit).
      const hexMatch = /^([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(tail);
      if (hexMatch) {
        const hi = Number.parseInt(hexMatch[1]!, 16);
        const lo = Number.parseInt(hexMatch[2]!, 16);
        const ipv4 = `${(hi >> 8) & 0xff}.${hi & 0xff}.${(lo >> 8) & 0xff}.${lo & 0xff}`;
        return isPrivateIpv4(ipv4);
      }
      return true;
    }
  }
  return false;
}

/**
 * Kiểm tra an toàn URL trước khi navigate: chỉ cho phép http/https (hoặc data: khi bật cấu hình),
 * chặn file://, chrome://, javascript: và chặn địa chỉ loopback/nội bộ (chống SSRF/đọc CDP).
 */
export function validateNavigateUrl(
  rawUrl: string,
  options: { allowPrivateNetwork?: boolean; allowDataUrls?: boolean } = {},
): { ok: true } | { ok: false; reason: string } {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return { ok: false, reason: `URL không hợp lệ: "${rawUrl}"` };
  }
  if (parsed.protocol === "data:") {
    if (options.allowDataUrls) return { ok: true };
    return { ok: false, reason: "giao thức data: bị chặn theo mặc định" };
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return {
      ok: false,
      reason: `giao thức "${parsed.protocol}" bị chặn (chỉ cho phép http: hoặc https:)`,
    };
  }
  if (!options.allowPrivateNetwork && isPrivateOrLoopbackHost(parsed.hostname)) {
    return {
      ok: false,
      reason: `địa chỉ nội bộ/loopback "${parsed.hostname}" bị chặn bởi chính sách chống SSRF`,
    };
  }
  return { ok: true };
}

function escapeRegex(value: string): string {
  return value.replace(/[.+^${}()|[\]\\]/g, "\\$&");
}

function matchHost(hostname: string, hostPattern: string): boolean {
  const cleanHostPattern = hostPattern.replace(/\.$/, "");
  if (cleanHostPattern === "*") return true;
  if (cleanHostPattern.startsWith("*.")) {
    const base = cleanHostPattern.slice(2);
    if (!base.includes("*")) {
      return hostname === base || hostname.endsWith(`.${base}`);
    }
    const baseRx = new RegExp("^" + escapeRegex(base).replace(/\*/g, "[^.]+") + "$");
    if (baseRx.test(hostname)) return true;
    const subRx = new RegExp("^(?:[^.]+\\.)+" + escapeRegex(base).replace(/\*/g, "[^.]+") + "$");
    return subRx.test(hostname);
  }
  const rx = new RegExp("^" + escapeRegex(cleanHostPattern).replace(/\*/g, "[^.]*") + "$");
  return rx.test(hostname);
}

function matchPath(pathname: string, pathPattern: string): boolean {
  if (!pathPattern) return true;
  if (pathPattern.includes("*")) {
    const rx = new RegExp("^" + escapeRegex(pathPattern).replace(/\*/g, ".*") + "$");
    return rx.test(pathname);
  }
  const rx = new RegExp("^" + escapeRegex(pathPattern) + "(?:/.*)?$");
  return rx.test(pathname);
}

function matchSingleRule(parsed: URL, rawPattern: string): boolean {
  const clean = rawPattern.trim().toLowerCase().replace(/^https?:\/\//, "");
  if (!clean) return false;
  const slashIdx = clean.indexOf("/");
  const hostPort = slashIdx >= 0 ? clean.slice(0, slashIdx) : clean;
  const pathPattern = slashIdx >= 0 ? clean.slice(slashIdx) : "";

  let hostPattern = hostPort;
  let expectedPort: string | undefined;
  const colonIdx = hostPort.lastIndexOf(":");
  if (colonIdx > 0 && !hostPort.endsWith("]")) {
    hostPattern = hostPort.slice(0, colonIdx);
    expectedPort = hostPort.slice(colonIdx + 1);
  }
  if (expectedPort !== undefined) {
    const effectivePort = parsed.port || (parsed.protocol === "https:" ? "443" : parsed.protocol === "http:" ? "80" : "");
    if (effectivePort !== expectedPort) return false;
  }

  const hostname = parsed.hostname.toLowerCase().replace(/\.$/, "");
  const pathname = parsed.pathname.toLowerCase();
  return matchHost(hostname, hostPattern) && matchPath(pathname, pathPattern);
}

/** Trả về backend theo rule đầu tiên khớp domain (+ path nếu có); undefined nếu không khớp. */
export function matchRule(url: string, rules: DomainRule[]): BackendKind | undefined {
  let parsed: URL;
  try {
    parsed = new URL(url.includes("://") ? url : `https://${url}`);
  } catch {
    return undefined;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return undefined;
  for (const rule of rules) {
    if (matchSingleRule(parsed, rule.match)) return rule.backend;
  }
  return undefined;
}
