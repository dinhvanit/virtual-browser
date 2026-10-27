/**
 * Dashboard data-menu smoke test: export/import JSON, backup/restore archive.
 *
 * Start a throwaway server first:
 *   VB_HEADLESS=1 VB_PORT=8799 VB_DATA_DIR=/tmp/opencode/vb-ui-data npm start
 *   npx tsx scripts/verify-ui-data.ts http://127.0.0.1:8799
 */
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { chromium } from "playwright-core";
import { CHROME_PATH } from "../src/config.js";

const base = (process.argv[2] ?? "http://127.0.0.1:8787").replace(/\/$/, "");
const token = process.env.VB_TOKEN ?? "";
const name = `UI data smoke ${Date.now().toString(36)}`;

function headers(extra: Record<string, string> = {}): Record<string, string> {
  return token ? { ...extra, "x-vb-token": token } : extra;
}

async function json(pathname: string, options: { method?: string; body?: unknown } = {}) {
  const response = await fetch(`${base}${pathname}`, {
    method: options.method ?? "GET",
    headers: headers(options.body === undefined ? {} : { "content-type": "application/json" }),
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  const text = await response.text();
  let data: any = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  if (!response.ok) throw new Error(`${pathname}: ${data?.error ?? response.status}`);
  return data;
}

async function main(): Promise<void> {
  if (!CHROME_PATH) throw new Error("Chrome not found; set CHROME_PATH");

  await json("/api/profiles", {
    method: "POST",
    body: { name, tags: ["ui-data"], osProfile: "native", startUrl: "https://example.com/" },
  });

  const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), "vb-ui-data-"));
  const exportPath = path.join(tmp, "export.json");
  const backupPath = path.join(tmp, "backup.tar.gz");

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

  try {
    await page.goto(token ? `${base}/?token=${encodeURIComponent(token)}` : `${base}/`, {
      waitUntil: "networkidle",
    });
    await page.waitForFunction(
      (value) => [...document.querySelectorAll(".card h3")].some((h) => h.textContent === value),
      name,
      { timeout: 15_000 },
    );

    await page.click("#data-btn");
    await page.waitForSelector("#data-menu:not(.hidden)");
    console.log("  ok  data menu opens");

    const [exportDownload] = await Promise.all([
      page.waitForEvent("download"),
      page.click("#export-json"),
    ]);
    await exportDownload.saveAs(exportPath);
    console.log("  ok  export JSON download");

    const beforeImport = await page.locator(".card").count();
    await page.click("#data-btn");
    const [importChooser] = await Promise.all([
      page.waitForEvent("filechooser"),
      page.click("#import-json"),
    ]);
    await importChooser.setFiles(exportPath);
    await page.waitForFunction(
      (count) => document.querySelectorAll(".card").length > count,
      beforeImport,
      { timeout: 20_000 },
    );
    console.log("  ok  import JSON via dashboard");

    await page.click("#data-btn");
    await page.click("#backup-all");
    await page.waitForSelector("#confirm-modal:not(.hidden)");
    const [backupDownload] = await Promise.all([
      page.waitForEvent("download"),
      page.click("#confirm-ok"),
    ]);
    await backupDownload.saveAs(backupPath);
    console.log("  ok  backup download via dashboard");

    const beforeRestore = await page.locator(".card").count();
    await page.click("#data-btn");
    const [restoreChooser] = await Promise.all([
      page.waitForEvent("filechooser"),
      page.click("#restore-backup"),
    ]);
    await restoreChooser.setFiles(backupPath);
    await page.waitForSelector("#confirm-modal:not(.hidden)");
    await page.click("#confirm-ok");
    await page.waitForFunction(
      (count) => document.querySelectorAll(".card").length >= count + 2,
      beforeRestore,
      { timeout: 30_000 },
    );
    console.log("  ok  restore archive via dashboard");

    if (errors.length) throw new Error(`console errors: ${JSON.stringify(errors)}`);
    console.log("\nOK: dashboard data flows verified.");
  } finally {
    await browser.close();
    const all = await json("/api/profiles").catch(() => ({ profiles: [] }));
    for (const profile of all.profiles ?? []) {
      if (profile.name === name) {
        await json(`/api/profiles/${profile.id}`, { method: "DELETE" }).catch(() => {});
      }
    }
    await fsp.rm(tmp, { recursive: true, force: true }).catch(() => {});
  }
}

main().catch((err) => {
  console.error("\nFAILED:", err);
  process.exit(1);
});
