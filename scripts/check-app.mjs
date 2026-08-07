#!/usr/bin/env node
//
// Static checks for ProManage NZ. No dependencies, no build step — run it
// locally exactly as CI runs it:
//
//   node scripts/check-app.mjs
//   node scripts/check-app.mjs --base origin/main   # adds the cache-bump check
//
// This repo is the deploy root: whatever lands on main is served by GitHub
// Pages immediately. Every check below exists because the corresponding
// failure has either happened or would ship silently — a blank app, a library
// that never loads, or a stale shell that reloading cannot shift.

import { readFileSync, existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => readFileSync(join(ROOT, rel), 'utf8');

const failures = [];
const fail = (check, detail) => failures.push({ check, detail });
const ok = (check, detail) => console.log(`  ok    ${check}${detail ? ' — ' + detail : ''}`);

const baseIndex = process.argv.indexOf('--base');
const BASE_REF = baseIndex !== -1 ? process.argv[baseIndex + 1] : null;

const indexHtml = read('index.html');
const swJs = read('sw.js');

/* ------------------------------------------------------------------ *
 * 1. Both inline <script> blocks parse.
 *
 * The whole app is two inline blocks. A syntax error in either one is a
 * blank app for every user, and there is no build step that would have
 * caught it. This is the manual ritual from CLAUDE.md, made non-optional.
 * ------------------------------------------------------------------ */
{
  const blocks = [...indexHtml.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)];

  if (blocks.length === 0) {
    fail('inline scripts parse', 'found no inline <script> blocks — has the markup changed shape?');
  } else {
    const dir = mkdtempSync(join(tmpdir(), 'promanage-check-'));
    blocks.forEach((match, i) => {
      // Keep the block at its original line offset so node --check reports a
      // line number that maps straight back to index.html.
      const line = indexHtml.slice(0, match.index).split('\n').length;
      const file = join(dir, `block${i}.js`);
      writeFileSync(file, '\n'.repeat(line - 1) + match[1]);
      try {
        execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' });
        ok(`inline script block ${i} parses`, `index.html line ${line}`);
      } catch (err) {
        // node --check points at the temp file; rewrite it back to index.html
        // so the reported line number is directly clickable. Drop the internal
        // stack trace — it describes node's loader, not the app.
        const out = (err.stderr || err.stdout || '')
          .toString()
          .replaceAll(file, 'index.html')
          .split('\n')
          .filter((l) => !/^\s+at /.test(l) && !/^Node\.js v/.test(l))
          .join('\n')
          .trim();
        fail(`inline script block ${i} parses`, out.replace(/\n/g, '\n    '));
      }
    });
  }
}

/* ------------------------------------------------------------------ *
 * 2. Every <script src> actually exists on disk.
 *
 * The vendored libraries are plain <script src> tags that fail
 * independently and silently. A missing one took the whole app down once
 * already — see CLAUDE.md, "Top-level code in the script block".
 * ------------------------------------------------------------------ */
const scriptSrcs = [...indexHtml.matchAll(/<script[^>]*\bsrc=["']([^"']+)["']/g)].map((m) => m[1]);

if (scriptSrcs.length === 0) {
  fail('<script src> tags present', 'found none — the vendored libraries should be here');
} else {
  for (const src of scriptSrcs) {
    if (existsSync(join(ROOT, src))) ok('vendored file exists', src);
    else fail('vendored file exists', `index.html references ${src}, which is not in the repo`);
  }
}

/* ------------------------------------------------------------------ *
 * 2b. Vendored files loaded from JS rather than a <script src> exist too.
 *
 * heic2any is 1.32 MB and is fetched on demand by FindingsReport instead of
 * blocking the first paint, so check 2 above can no longer see it — there is
 * no tag to find. Without this, renaming or re-versioning the file would pass
 * every check here and only surface as a failed HEIC conversion, months later,
 * on the one inspection that happened to be photographed with an iPhone.
 *
 * Matches any "vendor/…" string literal in the file, so a new lazily-loaded
 * library is covered the moment its path is written, with nothing to remember.
 * ------------------------------------------------------------------ */
{
  const tagged = new Set(
    [...indexHtml.matchAll(/<script[^>]*\bsrc=["']([^"']+)["']/g)].map((m) => m[1])
  );
  const referenced = [
    ...new Set([...indexHtml.matchAll(/["'](vendor\/[A-Za-z0-9._-]+\.js)["']/g)].map((m) => m[1]))
  ].filter((p) => !tagged.has(p));

  if (referenced.length === 0) {
    ok('lazily-loaded vendor files exist', 'none referenced from JS');
  } else {
    for (const src of referenced) {
      if (existsSync(join(ROOT, src))) ok('lazily-loaded vendor file exists', src);
      else fail('lazily-loaded vendor file exists', `index.html loads ${src} at runtime, which is not in the repo`);
    }
  }
}

/* ------------------------------------------------------------------ *
 * 3. sw.js SHELL_FILES covers those scripts, and every entry exists.
 *
 * A vendored file that index.html loads but SHELL_FILES omits is not
 * pre-cached, so the app is only whole while online — which defeats the
 * point of an offline-first PWA and shows up as a library that "sometimes"
 * fails to load.
 * ------------------------------------------------------------------ */
const shellMatch = swJs.match(/const SHELL_FILES = \[([\s\S]*?)\];/);

if (!shellMatch) {
  fail('sw.js SHELL_FILES found', 'could not locate the SHELL_FILES array in sw.js');
} else {
  const shellFiles = [...shellMatch[1].matchAll(/['"]([^'"]+)['"]/g)].map((m) => m[1]);
  const normalise = (p) => p.replace(/^\.\//, '');
  const shellSet = new Set(shellFiles.map(normalise));

  for (const file of shellFiles) {
    if (existsSync(join(ROOT, normalise(file)))) ok('shell file exists', file);
    else fail('shell file exists', `sw.js pre-caches ${file}, which is not in the repo`);
  }

  for (const src of scriptSrcs) {
    if (shellSet.has(normalise(src))) ok('shell file cached', src);
    else fail('shell file cached', `index.html loads ${src} but sw.js SHELL_FILES omits it — it will not be available offline`);
  }
}

/* ------------------------------------------------------------------ *
 * 4. No secret key in the served file.
 *
 * CONFIG.SUPABASE_KEY is meant to be a publishable key and is meant to be
 * here. A service-role key bypasses every RLS policy in schema.sql, and
 * committing one to this repo publishes it.
 * ------------------------------------------------------------------ */
{
  const secretPrefix = /\bsb_secret_[A-Za-z0-9_-]+/.exec(indexHtml);
  if (secretPrefix) {
    fail('no service-role key committed', `found a secret key (${secretPrefix[0].slice(0, 14)}…) in index.html`);
  }

  let serviceRoleJwt = null;
  for (const [, payload] of indexHtml.matchAll(/\beyJ[A-Za-z0-9_-]+\.([A-Za-z0-9_-]+)\.[A-Za-z0-9_-]+/g)) {
    try {
      const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
      if (claims.role === 'service_role') serviceRoleJwt = claims;
    } catch {
      // Not a JWT payload we can read — nothing to assert about it.
    }
  }
  if (serviceRoleJwt) {
    fail('no service-role key committed', 'found a JWT with role="service_role" in index.html — it bypasses every RLS policy');
  }

  if (!secretPrefix && !serviceRoleJwt) ok('no service-role key committed');
}

/* ------------------------------------------------------------------ *
 * 5. Changing a shell file bumps CACHE_NAME.
 *
 * Installed clients keep serving the cached shell until the cache name
 * changes. Shipping a fix without the bump means the users who already
 * have the app — i.e. all of them — do not receive it.
 *
 * Only runs when a base ref is available, since it needs a diff.
 * ------------------------------------------------------------------ */
if (BASE_REF) {
  const cacheName = (src) => (src.match(/const CACHE_NAME = ['"]([^'"]+)['"]/) || [])[1];

  let changed = [];
  let baseSw = null;
  try {
    changed = execFileSync('git', ['diff', '--name-only', `${BASE_REF}...HEAD`], { cwd: ROOT, stdio: 'pipe' })
      .toString().trim().split('\n').filter(Boolean);
    baseSw = execFileSync('git', ['show', `${BASE_REF}:sw.js`], { cwd: ROOT, stdio: 'pipe' }).toString();
  } catch {
    console.log(`  skip  cache bump — could not diff against ${BASE_REF}`);
  }

  if (baseSw !== null) {
    const shellPaths = (shellMatch ? [...shellMatch[1].matchAll(/['"]([^'"]+)['"]/g)].map((m) => m[1].replace(/^\.\//, '')) : []);
    const touched = changed.filter((f) => shellPaths.includes(f));

    if (touched.length === 0) {
      ok('cache bump not required', 'no shell files changed');
    } else if (cacheName(swJs) !== cacheName(baseSw)) {
      ok('cache bumped', `${cacheName(baseSw)} → ${cacheName(swJs)}`);
    } else {
      fail(
        'cache bumped',
        `${touched.join(', ')} changed but CACHE_NAME is still ${cacheName(swJs)} — installed clients will keep serving the old shell`
      );
    }
  }
}

/* ------------------------------------------------------------------ */

console.log('');
if (failures.length) {
  console.error(`FAILED — ${failures.length} check${failures.length === 1 ? '' : 's'}:\n`);
  for (const { check, detail } of failures) console.error(`  ✗ ${check}\n    ${detail}\n`);
  process.exit(1);
}
console.log('All checks passed.');
