# Thiết kế Browser-Router MCP — dsh dùng browser thông minh hơn

> Thiết kế cấp độ **hợp đồng + luồng** (chưa phải code triển khai).
> Là thiết kế con của [dsh-team-architecture.md](./dsh-team-architecture.md) — mảnh "não" cho toàn bộ web access của Team Engine.
> Mục tiêu dài hạn: đóng gói thành **skill tái dùng** cho mọi dự án dsh (xem mục 11).

---

## 1. Bài toán & nguyên tắc

Bot cần truy cập web bằng 2 công cụ có bản chất trái ngược:

| | Playwright/CDP | CUA (computer-use) |
|---|---|---|
| Bản chất | DOM-level (locator, auto-wait) | Vision-level (screenshot → click toạ độ) |
| Độ "mượt" với site khó | Thấp — vỡ khi anti-bot/no-API/login wall | Cao — vào được mọi site như người |
| Chi phí | Rẻ, nhanh, tất định | Đắt (tốn token ảnh), chậm |

**Nguyên tắc gốc: "rẻ trước, đắt sau"** — Playwright/CDP là mặc định, CUA chỉ khi có tín hiệu cần.

**Yêu cầu**: model KHÔNG cần biết phía sau là backend nào. Nó chỉ gọi 1 namespace tool `browse.*`; router tự chọn + tự leo thang.

---

## 2. Vị trí kiến trúc

```text
dsh (agent-loop)
 ├── system prompt / AGENTS.md        ← "dùng browse.* để lên web"
 ├── dsh-mcp-client
 │     └── browser-router MCP         ← 1 MCP server, 1 namespace browse.*
 │           ├── Playwright Adapter   → connectOverCDP → Chrome (profile per bot)
 │           └── CUA Adapter          → Playwright vision mode / cua-driver
 └── tool result (status chuẩn hóa)   ← tín hiệu để router leo thang
```

Nằm trong field `toolbox` của Bot Spec: `mcp: ["browser-router"]`.

---

## 3. Hợp đồng tool — model gọi gì (backend-agnostic)

| Action | Ý nghĩa |
|---|---|
| `browse.navigate(url)` | Mở URL |
| `browse.snapshot()` | Đọc trạng thái trang (DOM/accessibility nếu Playwright; screenshot+vision nếu CUA) |
| `browse.click(ref)` | Bấm phần tử (`ref` = selector hoặc mô tả "nút Đăng nhập") |
| `browse.type(ref, text)` | Gõ text |
| `browse.extract(goal)` | Trả dữ liệu có cấu trúc ("lấy bảng giá", "lấy danh sách bài viết") |
| `browse.screenshot()` | Chụp ảnh |
| `browse.wait(cond)` | Chờ điều kiện |
| `browse.go_back()` / `refresh()` | Điều hướng phụ |
| `browse.submit()` | Nộp form (đi qua approval gate) |

Model **không nói** "dùng Playwright" — chỉ nói "điều hướng / bấm / trích xuất". Chọn backend là việc của router.

### 3.1 Chi tiết từng action ✅

| Action | Params | Content trả về |
|---|---|---|
| `navigate` | `{ url, wait_until? }` | `{ final_url, title }` |
| `snapshot` | `{ mode?: "ax"\|"visual" }` | `{ type, elements: [{ref, role, label}], text?, image? }` |
| `click` | `{ ref }` | `{ url, title }` (tự snapshot lại) |
| `type` | `{ ref, text, submit? }` | như `click` |
| `extract` | `{ goal, schema? }` | `{ data, source_urls[] }` |
| `screenshot` | `{ full_page? }` | `{ image }` |
| `wait` | `{ condition, value?, timeout_ms? }` | `{ status }` |
| `go_back` / `refresh` | — | `{ url, title }` |
| `submit` | `{ confirm? }` | `{ url, title }` (qua approval gate) |

**`ref` — trục trung gian che giấu backend:**
- Playwright: `ref` = AX-node-id.
- CUA: `ref` = "label + toạ độ".
- Model chỉ nói `click(ref=...)`, không cần biết ref là selector hay toạ độ.

**Ví dụ `snapshot()` — 2 backend, 1 khuôn:**

```jsonc
// Playwright
{ "type": "accessibility_tree",
  "elements": [
    { "ref": "ax-1", "role": "button", "label": "Đăng nhập" },
    { "ref": "ax-2", "role": "textbox", "label": "Email" }
  ],
  "text": "Trang chủ — Đăng nhập | Email: [ ] | ..." }

// CUA
{ "type": "visual",
  "image": "<screenshot>",
  "elements": [
    { "ref": "v-1", "role": "button", "label": "Đăng nhập", "bbox": [0,0,0,0] },
    { "ref": "v-2", "role": "textbox", "label": "Email", "bbox": [0,0,0,0] }
  ],
  "ocr_text": "Đăng nhập / Email / Mật khẩu" }
```

→ Cả hai đều cho ra **"danh sách phần tử có ref + nhãn"** → model đọc giống nhau.

---

## 4. Hợp đồng kết quả — trả về gì (chìa khóa "biết tối ưu")

Mọi action trả về **một khuôn duy nhất**:

```json
{
  "ok": true,
  "action": "navigate",
  "backend": "playwright",
  "switched": false,
  "status": "ok",
  "http": 200,
  "url": "https://...",
  "title": "...",
  "content": {},
  "hint": ""
}
```

**Bảng `status`** — tín hiệu duy nhất để router leo thang:

| `status` | Ý nghĩa | Router làm gì |
|---|---|---|
| `ok` | Thành công | giữ backend |
| `empty` | Trang trống / JS render không ra DOM | thử CUA (screenshot) |
| `blocked` | Anti-bot (403 / Cloudflare / "Access denied") | **leo thang → CUA** |
| `captcha` | Có CAPTCHA/challenge | **leo thang → CUA** |
| `login_required` | Chuyển hướng login / 401 | **leo thang → CUA** (cho bước login) |
| `rate_limited` | 429 | backoff, rồi cân nhắc CUA |
| `locator_not_found` | Không tìm thấy element để click/type | **leo thang → CUA** (click bằng mắt) |
| `timeout` | Quá thời gian | retry 1 lần, rồi CUA |
| `budget_exhausted` | Hết ngân sách CUA | trả hint, không đốt thêm |

> Nếu tool browser trả về chuỗi rỗng không có `status`, model KHÔNG phân biệt được "trang trống" với "bị chặn" → không thể tối ưu. **`status` có cấu trúc là bắt buộc.**

---

## 5. Cấu trúc bên trong router

```text
browser-router MCP
├── Policy Store        ← domain-map (allowlist/blocklist) từ team.yaml
├── Playwright Adapter  ← Playwright connectOverCDP → Chrome
├── CUA Adapter         ← Playwright vision mode / cua-driver → cùng Chrome
├── Router Engine       ← chọn backend + giữ session state
├── Escalation Engine   ← đọc status → leo thang / hạ thang
├── Result Normalizer   ← chuẩn hóa 2 backend về 1 khuôn kết quả
└── Cost Guard          ← giới hạn budget CUA (token ảnh)
```

---

## 6. Luồng quyết định (state machine)

```text
Session state: { backend: playwright|cua, domain, escalation_reason, budget_used }

browse.navigate(url):
  1. Tra Policy Store theo domain:
       allowlist        → backend = playwright
       blocklist        → backend = cua
       không rõ         → backend = playwright  (mặc định rẻ)
  2. Chạy action bằng backend đang chọn
  3. Chuẩn hóa kết quả → status
  4. Nếu status ∈ {blocked, captcha, login_required, empty,
                   locator_not_found, timeout} và backend == playwright:
       → escalate: chạy LẠI action đó bằng CUA, đánh dấu switched=true
  5. Nếu backend == cua và status == ok và budget còn:
       → probe downgrade: thử 1 snapshot bằng playwright; nếu ok → quay lại playwright
  6. Trả kết quả chuẩn hóa cho model
```

**Leo thang = "chạy lại đúng action đó bằng backend kia"** — model không làm gì thêm, chỉ nhận kết quả kèm cờ `switched`.

### 6.1 Probe-downgrade ✅

```text
1. TRIGGER: sau khi 1 action CUA trả về ok (đặc biệt sau login/captcha/blocked đã gỡ)
2. PROBE:   chạy ngay 1 playwright snapshot() trên trang hiện tại
3. DECIDE:
   - probe.status == ok  VÀ  AX tree không rỗng  →  downgrade → playwright
   - ngược lại                                     →  ở lại cua
```

- Nếu probe thành công, kết quả probe **chính là** cái trả cho model (không tốn thêm lượt).

**Anti-flap (chống ping-pong):**
- Đếm `escalate_count` cho từng (session, domain).
- Nếu `escalate_count >= 2` trong cùng session → **ghim backend = cua** cho domain đó (không probe nữa tới hết session/đổi domain).
- Sau downgrade thành công → cooldown N action trước khi probe lại.

---

## 7. Domain-map schema (override per workspace → `team.yaml`)

```yaml
browser:
  default_backend: playwright          # rẻ trước
  rules:
    - match: "*.amazon.com"            # allowlist
      backend: playwright
    - match: "*.linkedin.com"          # login-wall nặng
      backend: cua
    - match: "*.cloudflare.com"        # anti-bot
      backend: cua
    - match: "*.google.com/recaptcha*"
      backend: cua
  escalation:
    enabled: true
    signals: [blocked, captcha, login_required, empty, locator_not_found, timeout]
  cost_guard:
    max_cua_steps: 8                   # tối đa 8 action vision / task
    max_cua_budget_tokens: 20000       # trần token ảnh / task
```

`default_backend` + `rules` + `escalation` là **phần chung** (trong skill); domain-map cụ thể là **override per workspace** — khớp cơ chế "skeleton chung + override riêng" của Bot Spec.

---

## 8. Điểm mấu chốt: 1 Chrome profile dùng chung cho cả 2 backend

```text
Chrome (1 instance per bot)
  ├── user-data-dir: ~/.bot-chrome/bot-<id>     ← cookie/session/login
  ├── CDP port: 9222+<id>
  ├── Playwright Adapter → connectOverCDP → cùng Chrome này
  └── CUA Adapter        → screenshot + click → cũng cùng Chrome này
```

→ Login làm bằng CUA xong, **Playwright kế thừa luôn session** (cùng profile) để trích xuất nhanh/rẻ. Không bị "2 trình duyệt 2 thế giới".

---

## 9. Cost guard & safety

- **CUA tốn tiền** → `max_cua_steps` + `max_cua_budget_tokens` chặn cứng mỗi task; hết budget → `status: budget_exhausted` + hint.
- **Sau khi CUA giải quyết bước khó** → tự downgrade về Playwright để phần còn lại chạy rẻ.
- **Read-only mặc định**: `navigate`/`snapshot`/`click`/`type` an toàn; **`submit` / gửi form / thanh toán / xoá** → bắt buộc qua approval gate (`dsh-user-approval`).

---

## 10. Dây nối vào dsh

```text
Bot Spec (field toolbox)      →  mcp: [ "browser-router" ]
dsh-mcp-client                →  gắn MCP thành tool browse.*
system prompt / AGENTS.md     →  "dùng browse.* để lên web; không tự chọn backend"
team.yaml                     →  browser: {domain-map, escalation, cost_guard}
```

---

## 11. Lộ trình đóng gói thành Skill (tái dùng mọi dự án)

Phần này xứng đáng thành **skill** vì nó giúp bất kỳ bot dsh nào cũng dùng browser thông minh hơn — độc lập hoàn toàn với domain.

**Ranh giới skill (chung vs riêng):**

| Thành phần | Tầng chung (trong skill) | Override per dự án |
|---|---|---|
| `SKILL.md` (hướng dẫn dùng `browse.*` + policy + escalation rules) | ✅ | — |
| browser-router MCP server (code) | ✅ | — |
| Config mặc định (domain-map mẫu + escalation + cost_guard) | ✅ | domain-map riêng trong `team.yaml` |
| Chrome profile id | — | `~/.bot-chrome/bot-<id>` per bot |

**Cấu trúc skill dự kiến:**

```text
browser-router/                  ← skill (đặt ở $DSH_HOME/skills/)
├── SKILL.md                     ← hướng dẫn: khi nào dùng, policy, escalation rules
├── server/                      ← MCP server code
├── config/
│   └── default.yaml             ← domain-map + escalation + cost_guard mặc định
└── references/
    └── escalation-signals.md    ← bảng tín hiệu chi tiết (mục 4)
```

**Cách dùng ở dự án khác:** bot chỉ cần khai báo `toolbox: { mcp: ["browser-router"] }` + override domain-map trong `team.yaml` — toàn bộ logic "rẻ trước đắt sau" nằm sẵn trong skill.

---

## 12. Đã chốt hết (sẵn sàng dựng khung code) ✅

| # | Hạng mục | Quyết định |
|---|---|---|
| 1 | Contract từng action `browse.*` | ✅ Mục 3.1 (params + content + `ref` abstraction) |
| 2 | Probe-downgrade | ✅ Mục 6.1 (3 bước + anti-flap) |
| 3 | Backend CUA | ✅ **Playwright "vision mode"** (browser-only, mặc định) + **`cua-driver`** (app ngoài browser, opt-in). **DeepSeek V4.1 có vision** → bật **true pixel-vision CUA**, không cần model vision riêng. |
| 4 | Xvfb / headless | ✅ Dùng **`xvfb-run`** (display giả) cho CUA khi chạy headless/đóng nắp trên laptop Linux 24/7. |
| 5 | Skill packaging | ✅ Đặt ở **`$DSH_HOME/skills/browser-router/`** theo cấu trúc mục 11. |
