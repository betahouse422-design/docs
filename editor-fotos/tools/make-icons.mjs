// Genera los PNG de los iconos a partir de los SVG usando el Chromium de Playwright.
// Uso: node tools/make-icons.mjs
import { chromium } from 'playwright-core';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const exe = [process.env.CHROMIUM_PATH, '/opt/pw-browsers/chromium-1194/chrome-linux/chrome'].filter(Boolean).find(existsSync);
const browser = await chromium.launch({ executablePath: exe, args: ['--no-sandbox'] });
const page = await browser.newPage();
const jobs = [['icon.svg', 'icon-192.png', 192], ['icon.svg', 'icon-512.png', 512], ['icon-maskable.svg', 'icon-maskable-512.png', 512]];
for (const [svg, out, size] of jobs) {
  const data = readFileSync(`${root}/icons/${svg}`, 'utf8');
  await page.setViewportSize({ width: size, height: size });
  await page.setContent(`<style>html,body{margin:0}svg{width:${size}px;height:${size}px;display:block}</style>${data}`);
  writeFileSync(`${root}/icons/${out}`, await page.screenshot({ type: 'png', omitBackground: true }));
  console.log('icono', out);
}
await browser.close();
