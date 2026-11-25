export type BackendKind = "playwright" | "cua";

export type BrowserStatus =
  | "ok"
  | "empty"
  | "blocked"
  | "captcha"
  | "login_required"
  | "rate_limited"
  | "locator_not_found"
  | "timeout"
  | "budget_exhausted"
  | "needs_human"
  | "error";

export type BrowserActionName =
  | "navigate"
  | "snapshot"
  | "click"
  | "type"
  | "extract"
  | "screenshot"
  | "wait"
  | "go_back"
  | "refresh"
  | "submit";

export interface BrowserResult {
  ok: boolean;
  action: BrowserActionName;
  backend: BackendKind;
  switched: boolean;
  status: BrowserStatus;
  http?: number;
  url?: string;
  title?: string;
  content?: unknown;
  hint?: string;
}

export interface SnapshotElement {
  ref: string;
  role: string;
  label: string;
  bbox?: [number, number, number, number];
}

export interface DomainRule {
  match: string;
  backend: BackendKind;
}

export interface EscalationConfig {
  enabled: boolean;
  signals: BrowserStatus[];
}

export interface CostGuard {
  max_cua_steps: number;
  max_cua_budget_tokens: number;
}

export interface RouterConfig {
  default_backend: BackendKind;
  rules: DomainRule[];
  escalation: EscalationConfig;
  cost_guard: CostGuard;
  /** submit (gửi form/thanh toán/xoá) phải có phê duyệt con người — mặc định true. */
  require_approval_submit: boolean;
  /** Cho phép truy cập loopback / mạng nội bộ (127.0.0.0/8, localhost, RFC1918...) — mặc định false (chống SSRF/CDP). */
  allow_private_network: boolean;
  /** Cho phép giao thức data: (phục vụ smoke test) — mặc định false. */
  allow_data_urls: boolean;
}

export interface BrowserActionParams {
  url?: string;
  ref?: string;
  text?: string;
  goal?: string;
  full_page?: boolean;
  condition?: string;
  value?: string;
  timeout_ms?: number;
}
