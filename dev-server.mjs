// Local preview: node dev-server.mjs  ->  http://localhost:3000
// Serves the static app and runs the /api/*.js handlers the same way Vercel does (req.query, req.body, res.status().json()).
// Reads GEMINI_API_KEY etc. from the environment or from a local .env file.
import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));
if (existsSync(path.join(root, '.env'))) for (const l of readFileSync(path.join(root, '.env'), 'utf8').split('\n')) { const m = /^\s*([A-Z_]+)\s*=\s*(.*)\s*$/.exec(l); if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, ''); }
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png' };

http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname.startsWith('/api/')) {
    const file = path.join(root, 'api', path.basename(url.pathname) + '.js');
    if (!existsSync(file)) { res.writeHead(404).end('{"ok":false}'); return; }
    let body = ''; for await (const c of req) body += c;
    const r = { method: req.method, query: Object.fromEntries(url.searchParams), headers: req.headers, body: body ? (() => { try { return JSON.parse(body); } catch { return body; } })() : undefined };
    const s = { statusCode: 200, headers: {}, status(c) { this.statusCode = c; return this; }, setHeader(k, v) { this.headers[k] = v; }, json(o) { this.headers['content-type'] = 'application/json'; this.send(JSON.stringify(o)); }, send(t) { res.writeHead(this.statusCode, this.headers).end(t); } };
    try { const mod = await import(pathToFileURL(file).href); await mod.default(r, s); } catch (e) { res.writeHead(500).end(JSON.stringify({ ok: false, error: String(e) })); }
    return;
  }
  let p = path.join(root, decodeURIComponent(url.pathname));
  if (!p.startsWith(root)) { res.writeHead(403).end(); return; }
  try { if ((await stat(p)).isDirectory()) p = path.join(p, 'index.html'); const data = await readFile(p); res.writeHead(200, { 'content-type': TYPES[path.extname(p)] || 'application/octet-stream' }).end(data); }
  catch { res.writeHead(404).end('not found'); }
}).listen(process.env.PORT || 3000, () => console.log(`Growth Center on http://localhost:${process.env.PORT || 3000}`));
