/**
 * UI smoke test with real Chrome (headless).
 *
 * Start a throwaway server first, e.g.:
 *   VB_HEADLESS=1 VB_PORT=8799 VB_DATA_DIR=/tmp/opencode/vb-ui npm start
 *   npx tsx scripts/verify-ui.ts http://127.0.0.1:8799
 *
 * Covers: create → search → edit → duplicate → delete, plus console errors.
 */
import { chromium } from "playwright-core";
import { CHROME_PATH } from "../src/config.js";

async function main(): Promise<void> {
  if (!CHROME_PATH) throw new Error("Chrome not found; set CHROME_PATH");
  const base = (process.argv[2] ?? "http://127.0.0.1:8787").replace(/\/$/, "");
  const token = process.env.VB_TOKEN;
  const stamp = Date.now().toString(36);
  const name = `UI smoke ${stamp}`;
  const renamed = `${name} edited`;

  const browser = await chromium.launch({
    executablePath: CHROME_PATH,
    headless: true,
    args: ["--no-sandbox"],
  });
  const page = await browser.newPage({ viewport: { width: 1400, height: 1000 } });
  const errors: string[] = [];
  page.on("console", (msg) => {
    if (msg.type() === "error") errors.push(msg.text());
  });
  page.on("pageerror", (err) => errors.push(String(err)));

  const cardByName = (text: string) => page.locator(".card").filter({ hasText: text });
  const waitForName = (text: string) =>
    page.waitForFunction(
      (value) =>
        [...document.querySelectorAll(".card h3")].some((h) => h.textContent === value),
      text,
      { timeout: 15_000 },
    );

  try {
    await page.goto(token ? `${base}/?token=${encodeURIComponent(token)}` : `${base}/`, {
      waitUntil: "networkidle",
    });

    // create
    await page.click("#new-profile-btn");
    await page.fill('input[name="name"]', name);
    await page.fill('input[name="tags"]', "smoke, ui-test");
    await page.selectOption('select[name="osProfile"]', "windows");
    await page.fill('input[name="startUrl"]', "https://example.com/");
    await page.click("#save-profile-btn");
    await page.waitForSelector("#profile-modal", { state: "hidden", timeout: 20_000 });
    await waitForName(name);
    console.log("  ok  create profile");

    // search
    await page.fill("#search", name);
    const visible = await page.locator(".card:not(.hidden)").count();
    if (visible !== 1) throw new Error(`search expected 1 card, got ${visible}`);
    await page.fill("#search", "");
    console.log("  ok  search");

    // edit
    await cardByName(name).locator('[data-action="edit"]').click();
    await page.fill('input[name="name"]', renamed);
    await page.click("#save-profile-btn");
    await page.waitForSelector("#profile-modal", { state: "hidden", timeout: 20_000 });
    await waitForName(renamed);
    console.log("  ok  edit profile");

    // duplicate
    const beforeDuplicate = await page.locator(".card").count();
    await cardByName(renamed).locator('[data-action="menu"]').click();
    await cardByName(renamed).locator('[data-action="duplicate"]').click();
    await page.waitForFunction(
      (count) => document.querySelectorAll(".card").length === count + 1,
      beforeDuplicate,
      { timeout: 20_000 },
    );
    console.log("  ok  duplicate profile");

    // delete both (duplicate name contains renamed + " (copy)")
    for (const text of [`${renamed} (copy)`, renamed]) {
      const card = cardByName(text).last();
      await card.locator('[data-action="menu"]').click();
      await card.locator('[data-action="delete"]').click();
      await page.click("#confirm-ok");
      await page.waitForFunction(
        (value) =>
          ![...document.querySelectorAll(".card h3")].some((h) => h.textContent === value),
        text,
        { timeout: 20_000 },
      );
      console.log(`  ok  delete "${text}"`);
    }

    if (errors.length) {
      throw new Error(`console errors: ${JSON.stringify(errors)}`);
    }

    console.log("\nOK: UI flow verified.");
  } finally {
    await browser.close();
  }
}

main().catch((err) => {
  console.error("\nFAILED:", err);
  process.exit(1);
});
