import { chromium } from "playwright-core";
import { CHROME_PATH } from "../src/config.js";

const browser = await chromium.launch({
  executablePath: CHROME_PATH!,
  headless: true,
  args: ["--no-sandbox"],
});

async function firstErrorToast(page: import("playwright-core").Page): Promise<string> {
  const handle = await page.waitForFunction(
    () => {
      const nodes = [...document.querySelectorAll(".toast.error")];
      const text = nodes.map((n) => n.textContent?.trim() ?? "").filter(Boolean).join(" | ");
      return text || null;
    },
    undefined,
    { timeout: 10_000 },
  );
  return String(await handle.jsonValue());
}

try {
  // 1. No token at all -> toast explains how to open the dashboard.
  const page = await browser.newPage();
  await page.goto("http://127.0.0.1:8812/", { waitUntil: "networkidle" });
  const noToken = await firstErrorToast(page);
  console.log("no token  :", noToken);
  if (!noToken.includes("/?token=")) throw new Error("missing token hint");

  // 2. Wrong token -> invalid-token message.
  await page.evaluate(() => localStorage.setItem("vb_token", "wrong"));
  await page.reload({ waitUntil: "networkidle" });
  const badToken = await firstErrorToast(page);
  console.log("bad token :", badToken);
  if (!badToken.includes("không hợp lệ")) throw new Error("missing invalid-token hint");

  // 3. Correct token via ?token= -> dashboard loads, token stripped from URL.
  const good = await browser.newPage();
  await good.goto("http://127.0.0.1:8812/?token=secret-token", { waitUntil: "networkidle" });
  await good.waitForTimeout(1200);
  const url = good.url();
  const errors = await good.$$eval(".toast.error", (nodes) => nodes.map((n) => n.textContent));
  console.log("good token:", url, "| error toasts:", JSON.stringify(errors));
  if (url.includes("token=")) throw new Error("token not stripped from URL");
  if (errors.length) throw new Error(`unexpected error with valid token: ${errors.join(" | ")}`);

  console.log("\nOK: token UI messages verified.");
} finally {
  await browser.close();
}
