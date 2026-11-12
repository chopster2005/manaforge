import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'dist');
const types = { '.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.json':'application/json','.webmanifest':'application/manifest+json','.svg':'image/svg+xml' };
const server = http.createServer((req,res) => {
  const pathname = decodeURIComponent(new URL(req.url || '/', 'http://localhost').pathname);
  let target = path.resolve(root, '.' + pathname);
  if (!target.startsWith(root)) { res.writeHead(403); res.end('Forbidden'); return; }
  if (fs.existsSync(target) && fs.statSync(target).isDirectory()) target = path.join(target, 'index.html');
  if (!fs.existsSync(target)) target = path.join(root, 'index.html');
  try { const data = fs.readFileSync(target); res.writeHead(200, { 'Content-Type': types[path.extname(target)] || 'application/octet-stream', 'Cache-Control':'no-cache' }); res.end(data); }
  catch { res.writeHead(404); res.end('Not found'); }
});
const port = Number(process.env.PORT || 8765);
server.listen(port, '0.0.0.0', () => console.log(`AetherForge MTG is running at http://localhost:${port}`));
