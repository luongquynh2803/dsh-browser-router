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
  | "submit"
  | "download"
  | "close_tab";

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
  /** Allowlist domain được phép navigate (rỗng = không giới hạn ngoài SSRF). */
  allowed_domains: string[];
  /** Các host/URL nền được bảo vệ — không bao giờ bị ghi đè hay đóng tab. */
  protected_hosts: string[];
  /** Mở tab tạm riêng thay vì đè lên tab đầu tiên của Chrome profile (mặc định true). */
  isolated_tab: boolean;
  /** Tự động đóng tab tạm sau N ms nhàn rỗi (0 = tắt). */
  idle_tab_close_ms: number;
  /** Chế độ chỉ đọc: chặn click/type/submit nếu không có approval_id hợp lệ. */
  read_only: boolean;
  /** Bắt buộc approval_id hợp lệ cho mọi thao tác mutation (click/type/submit). */
  require_approval_mutation: boolean;
  /** Gặp login/2FA/OTP dừng ngay trả needs_human (không escalate CUA). */
  stop_on_login: boolean;
  /** Chuỗi cấm xuất hiện trong trang (ví dụ tên tài khoản khác để tránh thao tác nhầm). */
  forbidden_page_markers: string[];
  /** Thư mục mặc định lưu file khi gọi browse_download. */
  download_dir?: string;
  /** Đường dẫn lockdir chung để phối hợp nhiều tiến trình trên cùng Chrome CDP. */
  lock_path?: string;
  /** Đường dẫn SQLite DB để kiểm tra approval_id (pending_confirmations / recommendation). */
  approval_db_path?: string;
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
  approval_id?: string;
  download_dir?: string;
}
