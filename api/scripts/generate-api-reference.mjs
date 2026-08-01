#!/usr/bin/env node
/**
 * generate-api-reference.mjs — regenerate FleetOS-Playbook/12-API/API_Reference.md
 * straight from the NestJS controllers, with zero runtime dependencies.
 *
 * Why hand-rolled instead of @nestjs/swagger: the API is pinned to Nest 10 and
 * pulling in @nestjs/swagger drags peer ranges that conflict with the pinned
 * @nestjs/common@10.4.x. This walks the source with a small tolerant parser
 * instead — it never imports or executes the app.
 *
 * What it does:
 *   1. Recursively finds every api/src/**\/*.controller.ts.
 *   2. Reads the @Controller({ path, version }) base + version (VERSION_NEUTRAL
 *      => unversioned, e.g. /health; everything else mounts under /v1 because
 *      main.ts enables URI versioning with defaultVersion '1' and sets no
 *      global prefix).
 *   3. Extracts each handler's HTTP method + path from @Get/@Post/@Put/@Patch/
 *      @Delete, and its required permission from @RequirePermission /
 *      @RequireAdminPermission (resolved to the real capability string via the
 *      permission catalogs), or falls back to @AuthenticatedOnly /
 *      @AdminAuthenticatedOnly / @Public / class-level @Public.
 *   4. Emits a stable, grouped-by-controller Markdown reference sorted by base
 *      path then method, with an accurate summary line.
 *
 * Deterministic: same source in => byte-identical Markdown out.
 */

import { readdirSync, readFileSync, writeFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve, relative, sep } from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const API_DIR = resolve(__dirname, '..');
const SRC_DIR = join(API_DIR, 'src');
const REPO_ROOT = resolve(API_DIR, '..');
const OUT_FILE = join(REPO_ROOT, 'FleetOS-Playbook', '12-API', 'API_Reference.md');
const PERMISSION_CATALOG = join(SRC_DIR, 'common', 'permissions', 'permission-catalog.ts');
const ADMIN_PERMISSION_CATALOG = join(SRC_DIR, 'common', 'permissions', 'admin-permission-catalog.ts');

const METHOD_DECORATORS = ['Get', 'Post', 'Put', 'Patch', 'Delete'];
const METHOD_RANK = { GET: 0, POST: 1, PUT: 2, PATCH: 3, DELETE: 4 };

// ── tiny fs helpers ──────────────────────────────────────────────────────────

/** Recursively collect *.controller.ts under dir, skipping node_modules/dist. */
function findControllers(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'dist') continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...findControllers(full));
    } else if (entry.isFile() && entry.name.endsWith('.controller.ts')) {
      out.push(full);
    }
  }
  return out;
}

// ── source scanning ──────────────────────────────────────────────────────────

/**
 * Blank out // and /* *\/ comments while preserving newlines and string
 * contents, so decorator/handler parsing never trips on commented-out code
 * (e.g. the `@RequireAdminPermission()` mentioned inside a docstring).
 */
function stripComments(src) {
  let out = '';
  let i = 0;
  const n = src.length;
  let state = 'code'; // code | line | block | squote | dquote | tquote
  while (i < n) {
    const c = src[i];
    const next = i + 1 < n ? src[i + 1] : '';
    if (state === 'code') {
      if (c === '/' && next === '/') { state = 'line'; out += '  '; i += 2; continue; }
      if (c === '/' && next === '*') { state = 'block'; out += '  '; i += 2; continue; }
      if (c === "'") { state = 'squote'; out += c; i++; continue; }
      if (c === '"') { state = 'dquote'; out += c; i++; continue; }
      if (c === '`') { state = 'tquote'; out += c; i++; continue; }
      out += c; i++; continue;
    }
    if (state === 'line') {
      if (c === '\n') { state = 'code'; out += c; i++; continue; }
      out += c === '\t' ? '\t' : ' '; i++; continue;
    }
    if (state === 'block') {
      if (c === '*' && next === '/') { state = 'code'; out += '  '; i += 2; continue; }
      out += c === '\n' ? '\n' : c === '\t' ? '\t' : ' '; i++; continue;
    }
    // string states: copy verbatim, honour escapes, exit on matching quote
    out += c;
    if (c === '\\') { if (i + 1 < n) { out += src[i + 1]; i += 2; continue; } }
    if (state === 'squote' && c === "'") state = 'code';
    else if (state === 'dquote' && c === '"') state = 'code';
    else if (state === 'tquote' && c === '`') state = 'code';
    i++;
  }
  return out;
}

/** Parse `KEY: 'value'` pairs out of a permission catalog object literal. */
function parseCatalog(path) {
  const map = new Map();
  let src;
  try {
    src = stripComments(readFileSync(path, 'utf8'));
  } catch {
    return map;
  }
  const re = /([A-Z0-9_]+)\s*:\s*'([^']+)'/g;
  let m;
  while ((m = re.exec(src)) !== null) map.set(m[1], m[2]);
  return map;
}

/**
 * Given the text inside a @Controller(...) decorator, return { base, versioned }.
 * Handles the object form `{ path: 'x', version: '1' | VERSION_NEUTRAL }`, the
 * string form `'x'`, and the empty form `()`.
 */
function parseControllerArg(argText) {
  const t = argText.trim();
  let base = '';
  let versioned = true; // main.ts defaultVersion '1' => unmarked controllers still mount under /v1
  if (t === '') return { base, versioned };
  if (t.startsWith('{')) {
    const pathM = t.match(/path\s*:\s*['"]([^'"]*)['"]/);
    if (pathM) base = pathM[1];
    const verM = t.match(/version\s*:\s*(VERSION_NEUTRAL|['"]([^'"]+)['"])/);
    if (verM) versioned = verM[1] !== 'VERSION_NEUTRAL';
  } else {
    const strM = t.match(/^['"]([^'"]*)['"]/);
    if (strM) base = strM[1];
  }
  return { base: base.replace(/^\/+|\/+$/g, ''), versioned };
}

/** First string-literal argument of a decorator's inner text, or '' if none. */
function firstStringArg(inner) {
  const m = inner.match(/['"`]([^'"`]*)['"`]/);
  return m ? m[1] : '';
}

/**
 * Starting at line index `start` (a line whose trimmed form begins with '@'),
 * consume as many lines as needed to balance parentheses and return the full
 * decorator text plus the index of the next unconsumed line.
 */
function readDecorator(lines, start) {
  let text = '';
  let depth = 0;
  let seenParen = false;
  let i = start;
  for (; i < lines.length; i++) {
    const line = lines[i];
    for (const ch of line) {
      if (ch === '(') { depth++; seenParen = true; }
      else if (ch === ')') depth--;
    }
    text += (text ? '\n' : '') + line.trim();
    if (seenParen && depth <= 0) { i++; break; }
    if (!seenParen) { i++; break; } // decorator with no parens, e.g. bare @Foo
  }
  return { text, next: i };
}

/** Net paren depth change across a line. */
function parenDelta(line) {
  let d = 0;
  for (const ch of line) {
    if (ch === '(') d++;
    else if (ch === ')') d--;
  }
  return d;
}

/** Return the decorator name (identifier after '@'), or ''. */
function decoratorName(text) {
  const m = text.match(/^@\s*([A-Za-z_$][\w$]*)/);
  return m ? m[1] : '';
}

/** Return the text between the outermost parens of a decorator, or ''. */
function decoratorInner(text) {
  const open = text.indexOf('(');
  if (open === -1) return '';
  const close = text.lastIndexOf(')');
  if (close <= open) return '';
  return text.slice(open + 1, close);
}

// ── controller parsing ───────────────────────────────────────────────────────

function classify(decorators, classLevelPublic, perms, adminPerms) {
  const find = (name) => decorators.find((d) => decoratorName(d) === name);

  const adminPerm = find('RequireAdminPermission');
  if (adminPerm) {
    const inner = decoratorInner(adminPerm).trim();
    const km = inner.match(/ADMIN_PERMISSIONS\.([A-Z0-9_]+)/);
    const value = km && adminPerms.has(km[1]) ? adminPerms.get(km[1]) : inner || '?';
    return { label: '`' + value + '`', realm: 'admin' };
  }
  const perm = find('RequirePermission');
  if (perm) {
    const inner = decoratorInner(perm).trim();
    const km = inner.match(/PERMISSIONS\.([A-Z0-9_]+)/);
    const value = km && perms.has(km[1]) ? perms.get(km[1]) : inner || '?';
    return { label: '`' + value + '`', realm: 'customer' };
  }
  if (find('AdminAuthenticatedOnly')) return { label: 'admin authenticated', realm: 'admin' };
  if (find('AuthenticatedOnly')) return { label: 'authenticated', realm: 'customer' };
  if (find('Public')) return { label: 'public', realm: 'public' };
  if (classLevelPublic) return { label: 'public', realm: 'public' };
  return { label: 'unclassified', realm: 'unknown' };
}

function assemblePath(versioned, base, sub) {
  const segments = [];
  if (versioned) segments.push('v1');
  for (const part of [base, sub]) {
    if (!part) continue;
    for (const seg of part.split('/')) if (seg) segments.push(seg);
  }
  return '/' + segments.join('/');
}

function parseControllerFile(filePath, perms, adminPerms) {
  const stripped = stripComments(readFileSync(filePath, 'utf8'));

  // Locate the class + its @Controller decorator + any class-level decorators.
  const classM = stripped.match(/export\s+class\s+([A-Za-z_$][\w$]*)/);
  if (!classM) return null;
  const className = classM[1];
  const classIdx = classM.index;

  // Collect the contiguous decorator block immediately above `export class`.
  const before = stripped.slice(0, classIdx).split('\n');
  const classDecorators = [];
  for (let i = before.length - 1; i >= 0; i--) {
    const t = before[i].trim();
    if (t === '') { if (classDecorators.length === 0) continue; else break; }
    if (t.startsWith('@') || t.startsWith(')') || t.startsWith('}') || /^[\w'".:,\s{|-]+$/.test(t)) {
      // part of a (possibly multi-line) decorator argument or the decorator itself
      classDecorators.unshift(before[i]);
      if (t.startsWith('@')) {
        // reached the start of this decorator; keep going for earlier decorators
      }
    } else {
      break;
    }
  }
  const classDecoText = classDecorators.join('\n');

  // @Controller(...) — read balanced arg from the class-decorator region.
  const ctrlStart = classDecoText.indexOf('@Controller');
  let controllerArg = '';
  if (ctrlStart !== -1) {
    const open = classDecoText.indexOf('(', ctrlStart);
    if (open !== -1) {
      let depth = 0;
      for (let i = open; i < classDecoText.length; i++) {
        const ch = classDecoText[i];
        if (ch === '(') depth++;
        else if (ch === ')') { depth--; if (depth === 0) { controllerArg = classDecoText.slice(open + 1, i); break; } }
      }
    }
  }
  const { base, versioned } = parseControllerArg(controllerArg);

  const classLevelPublic = /(^|\n)\s*@Public\s*\(/.test(classDecoText);
  const featureM = classDecoText.match(/@RequireFeature\s*\(\s*['"]([^'"]+)['"]/);
  const featureFlagM = classDecoText.match(/@RequireFeatureFlag\s*\(\s*['"]([^'"]+)['"]/);

  // Walk the class body, grouping decorators with their handler method.
  const body = stripped.slice(classIdx);
  const lines = body.split('\n');
  const routes = [];
  let pending = [];
  let i = 0;
  while (i < lines.length) {
    const raw = lines[i];
    const t = raw.trim();
    if (t === '') { pending = []; i++; continue; }
    if (t.startsWith('@')) {
      const { text, next } = readDecorator(lines, i);
      pending.push(text);
      i = next;
      continue;
    }
    // A code line. If a HTTP-method decorator is pending, this is the handler.
    const httpDecos = pending.filter((d) => METHOD_DECORATORS.includes(decoratorName(d)));
    if (httpDecos.length > 0) {
      const cls = classify(pending, classLevelPublic, perms, adminPerms);
      for (const deco of httpDecos) {
        const method = decoratorName(deco).toUpperCase();
        const sub = firstStringArg(decoratorInner(deco));
        routes.push({ method, path: assemblePath(versioned, base, sub), permission: cls.label });
      }
      // Skip past the (possibly multi-line) method signature so its parameter
      // decorators don't leak into the next handler's pending list.
      let depth = parenDelta(raw);
      i++;
      while (depth > 0 && i < lines.length) { depth += parenDelta(lines[i]); i++; }
      pending = [];
      continue;
    }
    pending = [];
    i++;
  }

  const mountBase = assemblePath(versioned, base, '');
  return {
    className,
    file: relative(REPO_ROOT, filePath).split(sep).join('/'),
    mountBase,
    versioned,
    feature: featureM ? featureM[1] : null,
    featureFlag: featureFlagM ? featureFlagM[1] : null,
    routes,
  };
}

// ── markdown emission ────────────────────────────────────────────────────────

function sortRoutes(routes) {
  return [...routes].sort((a, b) => {
    if (a.path !== b.path) return a.path < b.path ? -1 : 1;
    const ra = METHOD_RANK[a.method] ?? 99;
    const rb = METHOD_RANK[b.method] ?? 99;
    if (ra !== rb) return ra - rb;
    return a.permission < b.permission ? -1 : a.permission > b.permission ? 1 : 0;
  });
}

function render(controllers, totalRoutes) {
  const lines = [];
  lines.push('# FleetOS API Reference (generated)');
  lines.push('');
  lines.push(
    '> Generated by `api/scripts/generate-api-reference.mjs` directly from the ' +
      'NestJS controllers. Do not edit by hand — run `npm run docs:api` (from `api/`) to regenerate. ' +
      `**${totalRoutes} routes across ${controllers.length} controllers.**`,
  );
  lines.push('');
  lines.push(
    'Every business route is versioned under `/v1` (URI versioning, `main.ts` — ' +
      'the `/health` liveness/readiness probes are deliberately version-neutral). ' +
      'Auth is a JWT bearer token unless the **Permission** column says `public`. ' +
      'That column is the exact capability the route requires (`<resource>:<action>`, ' +
      'see `14-Security/Permissions_Model.md`): a backticked value is a granted ' +
      'permission enforced server-side by `PermissionGuard` / `AdminPermissionGuard`; ' +
      '`authenticated` means any valid session with no specific permission ' +
      '(a caller-scoped self-service route); `admin authenticated` is the ' +
      'admin-platform equivalent; `public` is unauthenticated.',
  );
  lines.push('');

  for (const ctrl of controllers) {
    lines.push(`## ${ctrl.className} — \`${ctrl.mountBase}\``);
    lines.push('');
    lines.push(`Source: \`${ctrl.file}\``);
    if (ctrl.feature) {
      lines.push('');
      lines.push(`Requires paid plan feature \`${ctrl.feature}\` (controller-level \`@RequireFeature\`).`);
    }
    if (ctrl.featureFlag) {
      lines.push('');
      lines.push(`Requires feature flag \`${ctrl.featureFlag}\` (controller-level \`@RequireFeatureFlag\`).`);
    }
    lines.push('');
    if (ctrl.routes.length === 0) {
      lines.push('_No routes detected._');
      lines.push('');
      continue;
    }
    lines.push('| Method | Path | Permission |');
    lines.push('|---|---|---|');
    for (const r of sortRoutes(ctrl.routes)) {
      lines.push(`| ${r.method} | \`${r.path}\` | ${r.permission} |`);
    }
    lines.push('');
  }
  return lines.join('\n').replace(/\n+$/, '\n');
}

// ── main ─────────────────────────────────────────────────────────────────────

function main() {
  const perms = parseCatalog(PERMISSION_CATALOG);
  const adminPerms = parseCatalog(ADMIN_PERMISSION_CATALOG);

  const files = findControllers(SRC_DIR).sort();
  const controllers = [];
  for (const file of files) {
    const parsed = parseControllerFile(file, perms, adminPerms);
    if (parsed) controllers.push(parsed);
  }

  controllers.sort((a, b) => {
    if (a.mountBase !== b.mountBase) return a.mountBase < b.mountBase ? -1 : 1;
    return a.className < b.className ? -1 : a.className > b.className ? 1 : 0;
  });

  const totalRoutes = controllers.reduce((sum, c) => sum + c.routes.length, 0);
  const markdown = render(controllers, totalRoutes);
  writeFileSync(OUT_FILE, markdown, 'utf8');

  const emptyControllers = controllers.filter((c) => c.routes.length === 0).map((c) => c.className);
  console.log(`API reference generated: ${relative(REPO_ROOT, OUT_FILE).split(sep).join('/')}`);
  console.log(`  controllers found: ${controllers.length}`);
  console.log(`  routes found:      ${totalRoutes}`);
  console.log(`  permission keys:   ${perms.size} customer, ${adminPerms.size} admin`);
  if (emptyControllers.length > 0) {
    console.log(`  note: ${emptyControllers.length} controller(s) with no detected routes: ${emptyControllers.join(', ')}`);
  }
}

main();
