#!/usr/bin/env node
// Records the live page running a paid job, with scene marks (ms from recording start) for build.py.
//   REPLAYCHECK_CHROME=… node docs/video/record.mjs [http://127.0.0.1:8746]
// Output: docs/video/out/raw.webm + marks.json
import { chromium } from 'playwright';
import { mkdirSync, writeFileSync, renameSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const base = process.argv[2] || 'http://127.0.0.1:8746';
const out = new URL('./out/', import.meta.url).pathname;
mkdirSync(out, { recursive: true });
const size = { width: 1440, height: 900 };
const b = await chromium.launch({ executablePath: process.env.REPLAYCHECK_CHROME, args: ['--no-sandbox', '--force-device-scale-factor=1'] });
const ctx = await b.newContext({ viewport: size, recordVideo: { dir: out, size }, deviceScaleFactor: 1 });
const page = await ctx.newPage();
const t0 = Date.now();
const marks = [];
const mark = (name) => { marks.push({ name, t: Date.now() - t0 }); console.error(`[rec] ${name} @ ${((Date.now() - t0) / 1000).toFixed(1)}s`); };
// Every console message is kept in-page (a MutationObserver), so a fast run cannot skip past a mark.
async function installLog() {
  await page.evaluate(() => { window.__log = []; const c = document.querySelector('#console'); new MutationObserver(() => window.__log.push(c.innerText)).observe(c, { childList: true, subtree: true, characterData: true }); });
}
async function waitConsole(re, timeout = 6 * 60e3) {
  const t = Date.now();
  while (Date.now() - t < timeout) { const log = await page.evaluate(() => window.__log || []); if (log.some((s) => re.test(s))) return; await page.waitForTimeout(250); }
  throw new Error('timeout waiting for ' + re);
}

mark('hero');
await page.goto(base + '/', { waitUntil: 'networkidle' });
await installLog();
await page.waitForTimeout(5000);
// pointer glide to the button, then click
await page.mouse.move(700, 500); await page.waitForTimeout(300);
const btn = page.locator('#run'); const bb = await btn.boundingBox();
await page.mouse.move(bb.x + bb.width / 2, bb.y + bb.height / 2, { steps: 24 }); await page.waitForTimeout(500);
mark('run'); await btn.click();
await waitConsole(/funded/); mark('posted');
await waitConsole(/accepted/); mark('accepted');
await waitConsole(/replaying/); mark('renting');
await waitConsole(/PASS|FAIL|ERROR/); mark('task1');
await waitConsole(/delivered ·/); mark('delivered');
await page.waitForTimeout(6000);
// the report the hash refers to
const reportHref = await page.locator('#console a[href*="/reports/"]').first().getAttribute('href');
mark('report');
await page.goto(reportHref, { waitUntil: 'networkidle' }); await page.waitForTimeout(3500);
await page.mouse.wheel(0, 900); await page.waitForTimeout(3500);
await page.mouse.wheel(0, 900); await page.waitForTimeout(3000);
// back to the books
mark('books');
await page.goto(base + '/#books', { waitUntil: 'networkidle' }); await page.waitForTimeout(600);
await page.evaluate(() => document.querySelector('#books').scrollIntoView({ block: 'start' }));
await page.waitForTimeout(6000);
mark('end');
await page.evaluate(() => scrollTo({ top: 0 })); await page.waitForTimeout(2500);
const video = page.video();
await ctx.close();
const p = await video.path();
renameSync(p, join(out, 'raw.webm'));
writeFileSync(join(out, 'marks.json'), JSON.stringify({ t0, size, marks }, null, 2));
await b.close();
console.error('[rec] saved', join(out, 'raw.webm'), readdirSync(out));
