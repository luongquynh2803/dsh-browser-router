/**
 * Sinh MCP entry cho browser-router (dán vào dsh MCP config) và tuỳ chọn bật Chrome.
 *
 * Ví dụ:
 *   npx tsx scripts/wire-browser-router.ts --port 9222 --config examples/browser-router.yaml --launch-chrome
 */
import { writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { buildMcpServerEntry, toYaml } from "../src/integration.js";
import { launchChrome } from "../src/chrome.js";

function arg(name: string, fallback?: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

const projectRoot = resolve(arg("project", process.cwd())!);
const port = Number(arg("port", "9222"));
const configPath = arg("config");
const out = resolve(projectRoot, arg("out", "browser-router.mcp.yml") ?? "browser-router.mcp.yml");
const launch = process.argv.includes("--launch-chrome");
const headless = process.argv.includes("--headless");

const entry = buildMcpServerEntry({
  projectRoot,
  chromeCdp: `http://127.0.0.1:${port}`,
  configPath: configPath ? resolve(projectRoot, configPath) : undefined,
});

writeFileSync(out, toYaml(entry), "utf8");
console.log(`✅ ghi MCP entry: ${out}`);
console.log(`   serverName=${entry.config.serverName}`);
console.log(`   tool model thấy: mcp__${entry.config.serverName}__browse_navigate`);
console.log("   → dán entry này vào dsh MCP config (profile team) rồi reload.");

if (launch) {
  const chrome = await launchChrome({
    port,
    userDataDir: join(projectRoot, ".dsh", "chrome-profile"),
    headless,
  });
  console.log(`✅ Chrome: ${chrome.cdpUrl} — Ctrl+C để đóng`);
  const shutdown = async (): Promise<void> => {
    await chrome.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}
