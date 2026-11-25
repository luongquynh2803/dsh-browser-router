# dsh-browser-router

Smart **Browser-Router MCP Server** for AI agents — cheap DOM-first (**Playwright/CDP**) with automatic escalation to Vision/Coordinate mode (**CUA**), cost guard, probe-downgrade, SSRF protection, and human-in-the-loop approval gates.

## Core Idea: "Cheap First, Vision Only When Needed"

Models only call a single backend-agnostic namespace (`browse_*`). They never need to know whether Playwright DOM or CUA Vision executes behind the scenes:

- **Playwright (DOM)** by default — fast, deterministic, zero image tokens.
- **Automatic Escalation → CUA (Vision + `@x,y` coordinates)** on structured failure signals (`blocked`, `login_required`, `empty`, `locator_not_found`, `timeout`).
- **Probe-Downgrade & Anti-Flap** — automatically probes Playwright on subsequent turns to drop back to cheap DOM mode; pins CUA if a domain escalates ≥ 2 times.
- **Cost Guard** — hard caps on `max_cua_steps` and estimated `max_cua_budget_tokens` (`budget_exhausted`).
- **Human-in-the-Loop Gates**:
  - `CAPTCHA` → returns `status: "needs_human"` (never blindly clicks).
  - `browse_submit` → blocked by default (`require_approval_submit: true`) with `status: "needs_human"`.
- **SSRF & Scheme Protection** — blocks `file://`, `javascript:`, `chrome://`, `data:` (opt-in), and loopback/private/metadata IPs (`127.0.0.0/8`, `localhost`, `[::1]`, `[::ffff:127.0.0.1]`, `169.254.169.254`, RFC1918, RFC4193) before touching Chrome.
- **Per-Bot Chrome Isolation** — connects over CDP (`--remote-debugging-port` bound to `127.0.0.1`) with separate Chrome profiles per agent.

## Exposed MCP Tools

| Tool | Description |
|---|---|
| `browse_navigate` | Open URL (validated for scheme + SSRF + domain-map routing) |
| `browse_snapshot` | Read page state (DOM elements or screenshot + element bboxes) |
| `browse_click` | Click element by ref (`r-<n>`) or CUA coordinates (`@x,y`) |
| `browse_type` | Fill/type text into ref (`r-<n>`) or coordinates (`@x,y`) |
| `browse_extract` | Extract page text / structured elements (or visual capture in CUA) |
| `browse_screenshot` | Capture screenshot (returned as standard MCP `image` content block) |
| `browse_wait` | Wait for load state, CSS selector, or text |
| `browse_go_back` | Navigate back |
| `browse_refresh` | Reload current page |
| `browse_submit` | Submit active form (gated by `require_approval_submit`) |

## Requirements

- **Node.js >= 22.5**
- Chrome / Chromium (for live CDP sessions)

## Install & Verify

```bash
npm install
npm run typecheck
npm test
npm run build
```

## Quick Start

### 1. Start Chrome with CDP (or use the wire script)

```bash
npx tsx scripts/wire-browser-router.ts \
  --port 9222 \
  --config examples/browser-router.yaml \
  --launch-chrome \
  --headless
```

### 2. Run the MCP Server (stdio)

```bash
BROWSER_ROUTER_CONFIG=examples/browser-router.yaml \
CHROME_CDP=http://127.0.0.1:9222 \
npm start
```

### 3. Wire into DeepSeek Harness (`dsh`)

`npm run wire` generates `browser-router.mcp.yml` matching `@deepseek-ai/dsh-mcp-client`:

```yaml
- id: mcp-browser-router
  name: '@deepseek-ai/dsh-mcp-client'
  config:
    serverName: browser_router
    transport: stdio
    command: npx
    args:
      - tsx
      - <path-to-repo>/src/mcp.ts
    env:
      CHROME_CDP: 'http://127.0.0.1:9222'
      BROWSER_ROUTER_CONFIG: '<path-to-repo>/examples/browser-router.yaml'
```

### 4. Domain-Map Configuration (`examples/browser-router.yaml`)

```yaml
browser:
  default_backend: playwright
  rules:
    - match: "*.amazon.com"
      backend: playwright
    - match: "*.linkedin.com"
      backend: cua
    - match: "*.google.com/recaptcha*"
      backend: cua
  escalation:
    enabled: true
    signals: [blocked, login_required, empty, locator_not_found, timeout]
  cost_guard:
    max_cua_steps: 8
    max_cua_budget_tokens: 20000
  require_approval_submit: true
  allow_private_network: false
  allow_data_urls: false
```

## Architecture & Design

See [docs/design.md](./docs/design.md) for the full architecture, result contract, escalation state machine, and multi-bot isolation model.

## License

MIT
