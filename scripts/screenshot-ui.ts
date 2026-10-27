/**
 * Dev utility: screenshot the dashboard with a real Chrome instance.
 *
 *   npx tsx scripts/screenshot-ui.ts [url] [output.png]
 */
import { chromium } from "playwright-core";
import { CHROME_PATH } from "../src/config.js";

async function main(): Promise<void> {
  const url = process.argv[2] ?? "http://127.0.0.1:8787/";
  const output = process.argv[3] ?? "/tmp/opencode/virtual-browser-ui.png";
  if (!CHROME_PATH) throw new Error("Chrome not found; set CHROME_PATH");

  const browser = await chromium.launch({
    executablePath: CHROME_PATH,
    headless: true,
    args: ["--no-sandbox"],
  });
  const page = await browser.newPage({
    viewport: { width: 1440, height: 1000 },
    deviceScaleFactor: 1,
  });

  const errors: string[] = [];
  page.on("console", (msg) => {
    if (msg.type() === "error") errors.push(msg.text());
  });
  page.on("pageerror", (err) => errors.push(String(err)));

  try {
    await page.goto(url, { waitUntil: "networkidle" });
    await page.waitForTimeout(3500);
    await page.screenshot({ path: output, fullPage: true });
    console.log(`saved ${output}`);
    console.log(`cards: ${await page.locator(".card").count()}`);
    console.log(`states: ${JSON.stringify(await page.locator(".state-badge").allTextContents())}`);
    if (errors.length) {
      console.error(`console errors: ${JSON.stringify(errors, null, 2)}`);
      process.exitCode = 1;
    }
  } finally {
    await browser.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
