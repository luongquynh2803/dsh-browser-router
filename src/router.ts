import { matchRule, validateNavigateUrl } from "./config.js";
import type { ApprovalVerifier } from "./approval.js";
import type { BrowserBackend } from "./backends.js";
import { withChromeLock } from "./lock.js";
import type {
  BackendKind,
  BrowserActionName,
  BrowserActionParams,
  BrowserResult,
  RouterConfig,
} from "./types.js";

type Dispatch = (backend: BrowserBackend, params: BrowserActionParams, config: RouterConfig) => Promise<BrowserResult>;

function required(value: string | undefined, field: string): string {
  if (!value) throw new Error(`thiếu tham số: ${field}`);
  return value;
}

const MUTATION_ACTIONS = new Set<BrowserActionName>(["click", "type", "submit"]);

const dispatch: Record<BrowserActionName, Dispatch> = {
  navigate: (backend, params) => backend.navigate(required(params.url, "url")),
  snapshot: (backend) => backend.snapshot(),
  click: (backend, params) => backend.click(required(params.ref, "ref")),
  type: (backend, params) => backend.type(required(params.ref, "ref"), required(params.text, "text")),
  extract: (backend, params) => backend.extract(params.goal ?? ""),
  screenshot: (backend, params) => backend.screenshot(params.full_page ?? false),
  wait: (backend, params) => backend.wait(params.condition, params.value, params.timeout_ms),
  go_back: (backend) => backend.goBack(),
  refresh: (backend) => backend.refresh(),
  submit: (backend) => backend.submit(),
  download: (backend, params, config) => {
    if (!backend.download) {
      return Promise.resolve({
        ok: false,
        action: "download",
        backend: backend.kind,
        switched: false,
        status: "error",
        hint: "backend không hỗ trợ download",
      });
    }
    const dir = params.download_dir ?? config.download_dir;
    if (!dir) {
      return Promise.resolve({
        ok: false,
        action: "download",
        backend: backend.kind,
        switched: false,
        status: "error",
        hint: "thiếu download_dir (truyền tham số hoặc cấu hình download_dir / DOWNLOAD_DIR)",
      });
    }
    return backend.download(required(params.ref, "ref"), dir, params.timeout_ms);
  },
  close_tab: (backend) => {
    if (!backend.closeTab) {
      return Promise.resolve({
        ok: true,
        action: "close_tab",
        backend: backend.kind,
        switched: false,
        status: "ok",
        content: { closed: false },
      });
    }
    return backend.closeTab();
  },
};

export interface BrowserRouterState {
  backend: BackendKind;
  cuaSteps: number;
  escalateCount: Record<string, number>;
  cuaTokensUsed: number;
  currentDomain: string;
}

function domainOf(value: string): string {
  if (!value) return "";
  try {
    return new URL(value).hostname.toLowerCase().replace(/\.$/, "");
  } catch {
    return "";
  }
}

export class BrowserRouter {
  private readonly state: BrowserRouterState;
  private readonly approvalVerifier?: ApprovalVerifier;

  constructor(
    private readonly config: RouterConfig,
    private readonly backends: Record<BackendKind, BrowserBackend>,
    state?: BrowserRouterState,
    options: { approvalVerifier?: ApprovalVerifier } = {},
  ) {
    this.state = state ?? {
      backend: config.default_backend,
      cuaSteps: 0,
      escalateCount: {},
      cuaTokensUsed: 0,
      currentDomain: "",
    };
    this.approvalVerifier = options.approvalVerifier;
  }

  get currentBackend(): BackendKind {
    return this.state.backend;
  }

  get cuaSteps(): number {
    return this.state.cuaSteps;
  }

  get cuaTokensUsed(): number {
    return this.state.cuaTokensUsed;
  }

  private overBudget(): boolean {
    return (
      this.state.cuaSteps >= this.config.cost_guard.max_cua_steps ||
      this.state.cuaTokensUsed >= this.config.cost_guard.max_cua_budget_tokens
    );
  }

  private budgetResult(action: BrowserActionName, backend: BackendKind): BrowserResult {
    return {
      ok: false,
      action,
      backend,
      switched: false,
      status: "budget_exhausted",
      hint: `hết ngân sách CUA (max_cua_steps=${this.config.cost_guard.max_cua_steps}, max_cua_budget_tokens=${this.config.cost_guard.max_cua_budget_tokens})`,
    };
  }

  private needsHuman(action: BrowserActionName, backend: BackendKind, reason: string): BrowserResult {
    return { ok: false, action, backend, switched: false, status: "needs_human", hint: reason };
  }

  private countCuaTokens(result: BrowserResult): void {
    const content = result.content as { image?: unknown } | null | undefined;
    const image = content?.image;
    if (typeof image === "string" && image.length > 100) {
      this.state.cuaTokensUsed += Math.ceil(image.length / 3);
    }
  }

  private isMutationApproved(approvalId: string | undefined): boolean {
    if (!approvalId || !approvalId.trim()) return false;
    if (!this.approvalVerifier) return false;
    return this.approvalVerifier(approvalId.trim());
  }

  async execute(action: BrowserActionName, params: BrowserActionParams = {}): Promise<BrowserResult> {
    // 0a. Mutation Approval Gate (v0.2.0: chặn click/type/submit ở chế độ read_only hoặc require_approval_mutation)
    if (MUTATION_ACTIONS.has(action)) {
      const mutationGated = this.config.read_only || this.config.require_approval_mutation;
      if (mutationGated && !this.isMutationApproved(params.approval_id)) {
        return this.needsHuman(
          action,
          this.state.backend,
          `thao tác "${action}" bị chặn bởi chính sách read_only/approval gate — cần approval_id đã được duyệt hợp lệ`,
        );
      }
      if (action === "submit" && this.config.require_approval_submit && !this.isMutationApproved(params.approval_id)) {
        return this.needsHuman(
          action,
          this.state.backend,
          "thao tác submit (gửi form/thanh toán/xoá) cần phê duyệt con người — không tự động thực hiện",
        );
      }
    }

    // 0b. Chặn sớm giao thức nguy hiểm, SSRF nội bộ, và domain ngoài allowed_domains
    if (action === "navigate" && params.url !== undefined) {
      const check = validateNavigateUrl(params.url, {
        allowPrivateNetwork: this.config.allow_private_network,
        allowDataUrls: this.config.allow_data_urls,
        allowedDomains: this.config.allowed_domains,
      });
      if (!check.ok) {
        return {
          ok: false,
          action,
          backend: this.state.backend,
          switched: false,
          status: "blocked",
          url: params.url,
          hint: check.reason,
        };
      }
    }

    return withChromeLock(this.config.lock_path, () => this.executeUnlocked(action, params));
  }

  private async executeUnlocked(action: BrowserActionName, params: BrowserActionParams): Promise<BrowserResult> {
    let backend: BackendKind = this.state.backend;
    if (action === "navigate" && params.url) {
      backend = matchRule(params.url, this.config.rules) ?? this.config.default_backend;
      this.state.currentDomain = domainOf(params.url);
    }
    if (backend === "cua" && this.overBudget()) return this.budgetResult(action, backend);

    let result = await dispatch[action](this.backends[backend], params, this.config);
    const landedDomain = domainOf(result.url ?? "");
    if (landedDomain) this.state.currentDomain = landedDomain;

    // CAPTCHA / OTP / Account mismatch → dừng, cần con người
    if (result.status === "captcha") {
      return this.needsHuman(
        action,
        backend,
        "gặp CAPTCHA — cần con người giải trên profile Chrome rồi resume; không tự động click",
      );
    }
    if (result.status === "needs_human") {
      return result;
    }
    if (result.status === "login_required" && this.config.stop_on_login) {
      return this.needsHuman(
        action,
        backend,
        result.hint ?? "phiên bị đăng xuất — dừng và báo người dùng (stop_on_login=true), không tự đăng nhập",
      );
    }

    let finalBackend: BackendKind = backend;

    const shouldEscalate =
      backend === "playwright" &&
      action !== "close_tab" &&
      this.config.escalation.enabled &&
      this.config.escalation.signals.includes(result.status);

    if (shouldEscalate) {
      if (this.overBudget()) return this.budgetResult(action, backend);
      result = await dispatch[action](this.backends.cua, params, this.config);
      const escalatedDomain = domainOf(result.url ?? "");
      if (escalatedDomain) this.state.currentDomain = escalatedDomain;
      this.countCuaTokens(result);
      result = { ...result, switched: true };
      finalBackend = "cua";
      this.state.cuaSteps += 1;
      const domain = this.state.currentDomain || domainOf(params.url ?? result.url ?? "");
      this.state.escalateCount[domain] = (this.state.escalateCount[domain] ?? 0) + 1;
      if (result.status === "captcha") {
        return this.needsHuman(
          action,
          "cua",
          "gặp CAPTCHA — cần con người giải trên profile Chrome rồi resume; không tự động click",
        );
      }
      if (result.status === "needs_human") return result;
    } else if (backend === "cua") {
      this.countCuaTokens(result);
      this.state.cuaSteps += 1;
    }

    this.state.backend = finalBackend;

    if (
      finalBackend === "cua" &&
      result.ok &&
      !result.switched &&
      (action === "navigate" || action === "snapshot" || action === "extract")
    ) {
      const domain = this.state.currentDomain || domainOf(result.url ?? "");
      const escalations = this.state.escalateCount[domain] ?? 0;
      if (escalations >= 1 && escalations < 2) {
        const probe = await this.backends.playwright.snapshot();
        if (probe.status === "ok") {
          this.state.backend = "playwright";
          result = {
            ...result,
            hint: `${result.hint ?? ""} probe-downgrade: quay lại Playwright`.trim(),
          };
        }
      }
    }

    return result;
  }

  async probeDowngrade(): Promise<BrowserResult | null> {
    if (this.state.backend !== "cua") return null;
    const probe = await this.backends.playwright.snapshot();
    if (probe.status === "ok") {
      this.state.backend = "playwright";
      return { ...probe, switched: true, hint: "probe-downgrade: quay lại Playwright" };
    }
    return probe;
  }
}
