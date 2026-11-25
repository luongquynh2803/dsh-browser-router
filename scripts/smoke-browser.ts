/**
 * Smoke test browser-router thật: cần 1 Chrome đang chạy với --remote-debugging-port.
 * Chạy: SMOKE_CDP=http://127.0.0.1:9333 npx tsx scripts/smoke-browser.ts
 */
import { createPageProvider, PlaywrightBackend, CuaBackend } from "../src/backends.js";
import { BrowserRouter } from "../src/router.js";
import { DEFAULT_CONFIG } from "../src/config.js";

const endpoint = process.env.SMOKE_CDP ?? "http://127.0.0.1:9333";
const provider = createPageProvider(endpoint);
const router = new BrowserRouter({ ...structuredClone(DEFAULT_CONFIG), allow_data_urls: true }, {
  playwright: new PlaywrightBackend(provider),
  cua: new CuaBackend(provider),
});

function fail(message: string): never {
  console.error(`FAIL: ${message}`);
  process.exit(1);
}

const html =
  "<html><head><title>Smoke</title></head><body><h1>Hello</h1>" +
  '<button id="btn">Click me</button><input id="inp" placeholder="Name"></body></html>';
const url = "data:text/html," + encodeURIComponent(html);

const nav = await router.execute("navigate", { url });
if (nav.status !== "ok") fail(`navigate status=${nav.status}`);
console.log("✓ navigate:", nav.status);

const snap = await router.execute("snapshot");
if (snap.status !== "ok") fail(`snapshot status=${snap.status}`);
const elements = (snap.content as { elements?: Array<{ ref: string; label: string }> }).elements ?? [];
if (elements.length === 0) fail("snapshot không có element");
console.log("✓ snapshot:", elements.length, "elements");

const button = elements.find((e) => /click me/i.test(e.label));
if (!button) fail("không tìm thấy nút 'Click me'");
const clicked = await router.execute("click", { ref: button.ref });
if (clicked.status !== "ok") fail(`click status=${clicked.status}`);
console.log("✓ click:", button.ref);

const shot = await router.execute("screenshot", { full_page: false });
if (shot.status !== "ok") fail("screenshot fail");
const image = (shot.content as { image?: string }).image ?? "";
if (image.length < 100) fail("screenshot rỗng");
console.log("✓ screenshot base64 length:", image.length);

await provider.close();
console.log("SMOKE BROWSER: PASS");
