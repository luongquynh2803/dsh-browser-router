import { dump } from "js-yaml";

/** Entry cấu hình `dsh-mcp-client` (đúng shape official: id/name/config). */
export interface McpServerEntry {
  id: string;
  name: string;
  config: {
    serverName: string;
    transport: "stdio";
    command: string;
    args: string[];
    env: Record<string, string>;
  };
}

export interface BuildMcpEntryOptions {
  projectRoot: string;
  chromeCdp: string;
  configPath?: string;
  serverName?: string;
  lockPath?: string;
  downloadDir?: string;
  approvalDbPath?: string;
}

/**
 * Sinh entry YAML để dán vào dsh MCP config:
 * tool model thấy sẽ có dạng `mcp__<serverName>__browse_navigate`.
 */
export function buildMcpServerEntry(options: BuildMcpEntryOptions): McpServerEntry {
  const serverName = options.serverName ?? "browser_router";
  const env: Record<string, string> = { CHROME_CDP: options.chromeCdp };
  if (options.configPath) env.BROWSER_ROUTER_CONFIG = options.configPath;
  if (options.lockPath) env.CHROME_LOCK_PATH = options.lockPath;
  if (options.downloadDir) env.DOWNLOAD_DIR = options.downloadDir;
  if (options.approvalDbPath) env.APPROVAL_DB_PATH = options.approvalDbPath;
  return {
    id: `mcp-${serverName.replace(/_/g, "-")}`,
    name: "@deepseek-ai/dsh-mcp-client",
    config: {
      serverName,
      transport: "stdio",
      command: "npx",
      args: ["tsx", `${options.projectRoot}/src/mcp.ts`],
      env,
    },
  };
}

export function toYaml(entry: McpServerEntry): string {
  return dump([entry], { lineWidth: -1 });
}

/** Tên tool mà model sẽ thấy. */
export function toolName(serverName: string, raw: string): string {
  return `mcp__${serverName}__${raw}`;
}
