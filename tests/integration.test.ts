import { test } from "node:test";
import assert from "node:assert/strict";
import { buildMcpServerEntry, toYaml, toolName } from "../src/integration.js";

test("buildMcpServerEntry: đúng shape dsh-mcp-client", () => {
  const entry = buildMcpServerEntry({
    projectRoot: "/proj",
    chromeCdp: "http://127.0.0.1:9222",
    configPath: "/proj/examples/browser-router.yaml",
  });
  assert.equal(entry.id, "mcp-browser-router");
  assert.equal(entry.name, "@deepseek-ai/dsh-mcp-client");
  assert.equal(entry.config.serverName, "browser_router");
  assert.equal(entry.config.transport, "stdio");
  assert.equal(entry.config.command, "npx");
  assert.deepEqual(entry.config.args, ["tsx", "/proj/src/mcp.ts"]);
  assert.equal(entry.config.env.CHROME_CDP, "http://127.0.0.1:9222");
  assert.equal(entry.config.env.BROWSER_ROUTER_CONFIG, "/proj/examples/browser-router.yaml");
});

test("buildMcpServerEntry: không có configPath thì không set env", () => {
  const entry = buildMcpServerEntry({ projectRoot: "/proj", chromeCdp: "http://127.0.0.1:9222" });
  assert.equal(entry.config.env.BROWSER_ROUTER_CONFIG, undefined);
});

test("toYaml: ra YAML list đúng id", () => {
  const yaml = toYaml(buildMcpServerEntry({ projectRoot: "/proj", chromeCdp: "http://127.0.0.1:9222" }));
  assert.match(yaml, /- id: mcp-browser-router/);
  assert.match(yaml, /name: '@deepseek-ai\/dsh-mcp-client'/);
});

test("toolName: mcp__server__raw", () => {
  assert.equal(toolName("browser_router", "browse_navigate"), "mcp__browser_router__browse_navigate");
});
