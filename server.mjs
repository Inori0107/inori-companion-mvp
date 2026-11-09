import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { dirname, extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { apiHandler } from './dist/http.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), 'public');
const port = Number(process.env.PORT ?? 3000);
const host = process.env.HOST || '127.0.0.1';
const api = apiHandler();
const mime = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png',
  '.webmanifest': 'application/manifest+json',
};

createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? '/', 'http://local');
    if (url.pathname.startsWith('/api/')) return await api(req, res);
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405).end();
      return;
    }
    const path = url.pathname === '/' ? '/index.html' : decodeURIComponent(url.pathname);
    const file = resolve(root, '.' + path);
    if (!file.startsWith(root + sep) || !mime[extname(file)]) {
      res.writeHead(404).end();
      return;
    }
    const bytes = await readFile(file);
    res.writeHead(200, {
      'Content-Type': mime[extname(file)], 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-cache',
      'Referrer-Policy': 'no-referrer',
      'Content-Security-Policy': "default-src 'self'; img-src 'self' data:; object-src 'none'; frame-ancestors 'none'; base-uri 'none'",
    });
    res.end(req.method === 'HEAD' ? undefined : bytes);
  } catch {
    if (!res.headersSent) res.writeHead(404);
    res.end();
  }
}).listen(port, host, () => console.log(`INORI Companion · http://${host}:${port}`));
