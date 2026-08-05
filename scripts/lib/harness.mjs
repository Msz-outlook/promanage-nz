// Shared boot harness for scripts/smoke-test.mjs and scripts/test.mjs.
//
// Both need the same thing: the repo served over http (a service worker needs
// a secure context, and localhost counts as one) with the app loaded in a real
// browser. Neither can use file:// — the service worker would not register and
// the fetch handler would never run.

import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, extname, dirname, resolve, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

const TYPES = {
  '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript',
  '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml',
  '.webmanifest': 'application/manifest+json'
};

export async function startServer(root = ROOT) {
  const server = createServer(async (req, res) => {
    const rel = normalize(decodeURIComponent(new URL(req.url, 'http://x').pathname))
      .replace(/^(\.\.[/\\])+/, '');
    const path = join(root, rel === '/' ? 'index.html' : rel);
    try {
      const body = await readFile(path);
      res.writeHead(200, { 'Content-Type': TYPES[extname(path)] || 'application/octet-stream' });
      res.end(body);
    } catch {
      res.writeHead(404).end('not found');
    }
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return {
    origin: `http://127.0.0.1:${server.address().port}`,
    close: () => new Promise((r) => server.close(r))
  };
}

// CHROMIUM_PATH lets an environment with a pre-installed browser point at it
// rather than downloading a second copy. CI leaves it unset and uses whatever
// `npx playwright install chromium` put in the default location.
export function launchBrowser() {
  return chromium.launch(
    process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}
  );
}

// Boots the app and returns the page plus whatever errors it produced on the
// way up. Callers decide whether those errors matter.
export async function openApp({ settleMs = 2500 } = {}) {
  const server = await startServer();
  const browser = await launchBrowser();
  const page = await browser.newPage();

  const pageErrors = [];
  const consoleErrors = [];
  page.on('pageerror', (err) => pageErrors.push(err.message));
  page.on('console', (msg) => {
    // The browser requests /favicon.ico on its own and the repo has no such
    // file — a permanent, meaningless 404 that would otherwise sit in every
    // failure report.
    if (msg.type() === 'error' && !msg.location()?.url?.endsWith('/favicon.ico')) {
      consoleErrors.push(msg.text());
    }
  });

  await page.goto(server.origin, { waitUntil: 'load' });
  await page.waitForTimeout(settleMs); // let DOMContentLoaded and SW registration settle

  return {
    page,
    pageErrors,
    consoleErrors,
    close: async () => { await browser.close(); await server.close(); }
  };
}
