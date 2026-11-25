#!/usr/bin/env node
/**
 * Browser-Router MCP server (stdio) — v0.2.0.
 * Expose namespace `browse.*` cho dsh qua dsh-mcp-client.
 *
 * Env:
 *   CHROME_CDP              CDP endpoint của Chrome (mặc định http://127.0.0.1:9222)
 *   BROWSER_ROUTER_CONFIG   đường dẫn browser-router.yaml (mặc định: DEFAULT_CONFIG)
 *   CHROME_LOCK_PATH        lockdir dùng chung giữa các tiến trình trên cùng Chrome CDP
 *   DOWNLOAD_DIR            thư mục lưu file tải về khi dùng browse_download
 *   APPROVAL_DB_PATH        SQLite DB để kiểm approval_id cho thao tác mutation
 */
import { resolve } from "node:path";
import { createSqliteApprovalVerifier } from "./approval.js";
import { createPageProvider, CuaBackend, PlaywrightBackend, type PageProvider } from "./backends.js";
import { DEFAULT_CONFIG, loadRouterConfig } from "./config.js";
import { BrowserRouter } from "./router.js";
import type { BrowserActionName, BrowserResult } from "./types.js";

interface ToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  action: BrowserActionName;
  toParams: (args: Record<string, unknown>) => Record<string, unknown>;
}

const TOOLS: ToolDef[] = [
  {
    name: "browse_navigate",
    description: "Mở URL trong tab tạm cô lập của browser (không đè tab nền).",
    inputSchema: { type: "object", properties: { url: { type: "string" } }, required: ["url"] },
    action: "navigate",
    toParams: (args) => ({ url: args.url }),
  },
  {
    name: "browse_snapshot",
    description: "Đọc trạng thái trang (elements + text/ảnh tuỳ backend).",
    inputSchema: { type: "object", properties: {} },
    action: "snapshot",
    toParams: () => ({}),
  },
  {
    name: "browse_click",
    description:
      "Bấm phần tử theo ref (r-<n>) hoặc '@x,y'. Ở chế độ read_only/mutation-gate bắt buộc truyền approval_id đã duyệt.",
    inputSchema: {
      type: "object",
      properties: { ref: { type: "string" }, approval_id: { type: "string" } },
      required: ["ref"],
    },
    action: "click",
    toParams: (args) => ({ ref: args.ref, approval_id: args.approval_id }),
  },
  {
    name: "browse_type",
    description:
      "Gõ text vào phần tử theo ref (r-<n>) hoặc '@x,y'. Ở chế độ read_only/mutation-gate bắt buộc truyền approval_id đã duyệt.",
    inputSchema: {
      type: "object",
      properties: {
        ref: { type: "string" },
        text: { type: "string" },
        approval_id: { type: "string" },
      },
      required: ["ref", "text"],
    },
    action: "type",
    toParams: (args) => ({ ref: args.ref, text: args.text, approval_id: args.approval_id }),
  },
  {
    name: "browse_extract",
    description: "Trích xuất dữ liệu theo mục tiêu (goal) từ trang hiện tại.",
    inputSchema: { type: "object", properties: { goal: { type: "string" } }, required: ["goal"] },
    action: "extract",
    toParams: (args) => ({ goal: args.goal }),
  },
  {
    name: "browse_screenshot",
    description: "Chụp ảnh trang (base64).",
    inputSchema: { type: "object", properties: { full_page: { type: "boolean" } } },
    action: "screenshot",
    toParams: (args) => ({ full_page: args.full_page }),
  },
  {
    name: "browse_wait",
    description: "Chờ load / selector / text.",
    inputSchema: {
      type: "object",
      properties: { condition: { type: "string" }, value: { type: "string" }, timeout_ms: { type: "number" } },
    },
    action: "wait",
    toParams: (args) => ({ condition: args.condition, value: args.value, timeout_ms: args.timeout_ms }),
  },
  {
    name: "browse_go_back",
    description: "Quay lại trang trước.",
    inputSchema: { type: "object", properties: {} },
    action: "go_back",
    toParams: () => ({}),
  },
  {
    name: "browse_refresh",
    description: "Tải lại trang.",
    inputSchema: { type: "object", properties: {} },
    action: "refresh",
    toParams: () => ({}),
  },
  {
    name: "browse_submit",
    description: "Nộp form hiện tại (Enter). Cần approval_id hợp lệ khi bật require_approval_submit.",
    inputSchema: {
      type: "object",
      properties: { approval_id: { type: "string" } },
    },
    action: "submit",
    toParams: (args) => ({ approval_id: args.approval_id }),
  },
  {
    name: "browse_download",
    description: "Bấm nút Download/Export theo ref (r-<n>) và chờ file tải xong vào thư mục raw, trả path + sha256.",
    inputSchema: {
      type: "object",
      properties: {
        ref: { type: "string" },
        download_dir: { type: "string" },
        timeout_ms: { type: "number" },
      },
      required: ["ref"],
    },
    action: "download",
    toParams: (args) => ({ ref: args.ref, download_dir: args.download_dir, timeout_ms: args.timeout_ms }),
  },
  {
    name: "browse_close_tab",
    description: "Đóng ngay tab làm việc tạm của router (giữ nguyên mọi tab nền được bảo vệ).",
    inputSchema: { type: "object", properties: {} },
    action: "close_tab",
    toParams: () => ({}),
  },
];

let router: BrowserRouter | null = null;
let pageProvider: PageProvider | null = null;

function getRouter(): BrowserRouter {
  if (router) return router;
  const configPath = process.env.BROWSER_ROUTER_CONFIG;
  const config = configPath ? loadRouterConfig(resolve(configPath)) : structuredClone(DEFAULT_CONFIG);

  if (process.env.CHROME_LOCK_PATH) config.lock_path = process.env.CHROME_LOCK_PATH;
  if (process.env.DOWNLOAD_DIR) config.download_dir = process.env.DOWNLOAD_DIR;
  if (process.env.APPROVAL_DB_PATH) config.approval_db_path = process.env.APPROVAL_DB_PATH;

  const endpoint = process.env.CHROME_CDP ?? "http://127.0.0.1:9222";
  pageProvider = createPageProvider(endpoint, {
    isolatedTab: config.isolated_tab,
    protectedHosts: config.protected_hosts,
    idleTabCloseMs: config.idle_tab_close_ms,
  });

  const approvalVerifier = config.approval_db_path
    ? createSqliteApprovalVerifier(resolve(config.approval_db_path))
    : undefined;

  router = new BrowserRouter(
    config,
    {
      playwright: new PlaywrightBackend(pageProvider, { forbiddenMarkers: config.forbidden_page_markers }),
      cua: new CuaBackend(pageProvider, { forbiddenMarkers: config.forbidden_page_markers }),
    },
    undefined,
    { approvalVerifier },
  );
  return router;
}

function send(message: unknown): void {
  process.stdout.write(JSON.stringify(message) + "\n");
}

function toolByName(name: string): ToolDef | undefined {
  return TOOLS.find((t) => t.name === name);
}

function splitResult(result: BrowserResult): { text: string; image?: string } {
  const content = result.content as { image?: unknown } | null | undefined;
  const image = typeof content?.image === "string" ? content.image : undefined;
  if (!image) return { text: JSON.stringify(result, null, 2) };
  const trimmed = {
    ...result,
    content: { ...(content as object), image: `[image: ${image.length} chars base64 — xem block image kèm theo]` },
  };
  return { text: JSON.stringify(trimmed, null, 2), image };
}

async function handle(request: {
  id?: number | string;
  method?: string;
  params?: Record<string, unknown>;
}): Promise<void> {
  const { id, method, params } = request;
  try {
    if (method === "initialize") {
      const requested = (params?.protocolVersion as string | undefined) ?? "2024-11-05";
      send({
        jsonrpc: "2.0",
        id,
        result: {
          protocolVersion: requested,
          capabilities: { tools: {} },
          serverInfo: { name: "browser-router", version: "0.2.0" },
        },
      });
      return;
    }
    if (method === "notifications/initialized" || method === "initialized") return;
    if (method === "ping") {
      send({ jsonrpc: "2.0", id, result: {} });
      return;
    }
    if (method === "tools/list") {
      send({
        jsonrpc: "2.0",
        id,
        result: {
          tools: TOOLS.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })),
        },
      });
      return;
    }
    if (method === "tools/call") {
      const name = String(params?.name ?? "");
      const tool = toolByName(name);
      if (!tool) throw new Error(`tool không tồn tại: ${name}`);
      const args = (params?.arguments as Record<string, unknown> | undefined) ?? {};
      const result = await getRouter().execute(tool.action, tool.toParams(args));
      const { text, image } = splitResult(result);
      const blocks: Array<Record<string, unknown>> = [{ type: "text", text }];
      if (image) blocks.push({ type: "image", data: image, mimeType: "image/png" });
      send({
        jsonrpc: "2.0",
        id,
        result: { content: blocks, isError: result.ok === false },
      });
      return;
    }
    send({ jsonrpc: "2.0", id, error: { code: -32601, message: `method không hỗ trợ: ${method}` } });
  } catch (error) {
    send({
      jsonrpc: "2.0",
      id,
      error: { code: -32603, message: error instanceof Error ? error.message : String(error) },
    });
  }
}

let buffer = "";
let queue: Promise<void> = Promise.resolve();
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk: string) => {
  buffer += chunk;
  let newlineIndex: number;
  while ((newlineIndex = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, newlineIndex).trim();
    buffer = buffer.slice(newlineIndex + 1);
    if (!line) continue;
    let parsed: Parameters<typeof handle>[0];
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    queue = queue.then(() => handle(parsed)).catch(() => {
      /* lỗi đã bắn trong handle */
    });
  }
});

let closing = false;
function shutdownOnStdinClose(): void {
  if (closing) return;
  closing = true;
  void queue
    .catch(() => undefined)
    .then(() => pageProvider?.close())
    .catch(() => undefined)
    .finally(() => process.exit(0));
}
process.stdin.on("end", shutdownOnStdinClose);
process.stdin.on("close", shutdownOnStdinClose);
