import { matchRule, validateNavigateUrl } from "./config.js";
import type { BrowserBackend } from "./backends.js";
import type {
  BackendKind,
  BrowserActionName,
  BrowserActionParams,
  BrowserResult,
  RouterConfig,
} from "./types.js";

type Dispatch = (backend: BrowserBackend, params: BrowserActionParams) => Promise<BrowserResult>;

function required(value: string | undefined, field: string): string {
  if (!value) throw new Error(`thiếu tham số: ${field}`);
  return value;
}

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
};

export interface BrowserRouterState {
  backend: BackendKind;
  cuaSteps: number;
  /** Số lần escalate cho từng domain — anti-flap: >= 2 thì ghim CUA. */
  escalateCount: Record<string, number>;
  /** Token ảnh ước lượng đã dùng (base64 length / 3 ≈ tokens). */
  cuaTokensUsed: number;
  /** Domain hiện tại (cập nhật khi navigate) — dùng cho probe/anti-flap. */
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

  constructor(
    private readonly config: RouterConfig,
    private readonly backends: Record<BackendKind, BrowserBackend>,
    state?: BrowserRouterState,
  ) {
    this.state = state ?? {
      backend: config.default_backend,
      cuaSteps: 0,
      escalateCount: {},
      cuaTokensUsed: 0,
      currentDomain: "",
    };
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

  /** Ước lượng token ảnh: 1 token ≈ 3 ký tự base64. */
  private countCuaTokens(result: BrowserResult): void {
    const content = result.content as { image?: unknown } | null | undefined;
    const image = content?.image;
    if (typeof image === "string" && image.length > 100) {
      this.state.cuaTokensUsed += Math.ceil(image.length / 3);
    }
  }

  async execute(action: BrowserActionName, params: BrowserActionParams = {}): Promise<BrowserResult> {
    // 0. Submit cần phê duyệt con người (chốt chặn rõ ràng).
    if (action === "submit" && this.config.require_approval_submit) {
      return this.needsHuman(
        action,
        this.state.backend,
        "thao tác submit (gửi form/thanh toán/xoá) cần phê duyệt con người — không tự động thực hiện",
      );
    }

    // 0b. Chặn sớm giao thức nguy hiểm (file://, javascript:, chrome://) và SSRF nội bộ trước khi chạm Chrome/escalate.
    if (action === "navigate" && params.url !== undefined) {
      const check = validateNavigateUrl(params.url, {
        allowPrivateNetwork: this.config.allow_private_network,
        allowDataUrls: this.config.allow_data_urls,
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

    // 1. Chọn backend (domain-map chỉ cho navigate; còn lại giữ backend hiện tại).
    let backend: BackendKind = this.state.backend;
    if (action === "navigate" && params.url) {
      backend = matchRule(params.url, this.config.rules) ?? this.config.default_backend;
      this.state.currentDomain = domainOf(params.url);
    }
    if (backend === "cua" && this.overBudget()) return this.budgetResult(action, backend);

    // 2. Chạy.
    let result = await dispatch[action](this.backends[backend], params);
    const landedDomain = domainOf(result.url ?? "");
    if (landedDomain) this.state.currentDomain = landedDomain;

    // 3. CAPTCHA → dừng, cần con người (KHÔNG tự click mò để tránh khóa tài khoản).
    if (result.status === "captcha") {
      return this.needsHuman(
        action,
        backend,
        "gặp CAPTCHA — cần con người giải trên profile Chrome rồi resume; không tự động click",
      );
    }

    let finalBackend: BackendKind = backend;

    // 4. Escalation: Playwright gặp tín hiệu xấu → chạy lại bằng CUA.
    const shouldEscalate =
      backend === "playwright" &&
      this.config.escalation.enabled &&
      this.config.escalation.signals.includes(result.status);

    if (shouldEscalate) {
      if (this.overBudget()) return this.budgetResult(action, backend);
      result = await dispatch[action](this.backends.cua, params);
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
    } else if (backend === "cua") {
      this.countCuaTokens(result);
      this.state.cuaSteps += 1;
    }

    this.state.backend = finalBackend;

    // 5. Probe-downgrade: chỉ ở lượt CUA SAU lượt escalate (KHÔNG ngay lượt escalate —
    // lúc đó trang vẫn đang ở trạng thái xấu), và chỉ cho domain đã từng escalate
    // (domain-map chọn CUA sẵn thì tôn trọng rule). Anti-flap: escalateCount >= 2 → ghim CUA.
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

  /** Dùng ngoài luồng execute khi cần ép hạ thang (vd: sau khi người giải CAPTCHA). */
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
