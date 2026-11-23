// serve.ts — a tiny static server for game/ (Node 22, standard library
// only), so the game can be played locally without a build step:
//
//   node serve.ts                 serves game/ on http://localhost:8080
//   node serve.ts --port 9000     serves game/ on http://localhost:9000
//   node serve.ts --host 0.0.0.0  listens on every interface instead
//
// It sends the MIME types a browser game needs, refuses any path outside
// game/, logs each request with its status and time, and otherwise does
// nothing clever: this is a development convenience, not a web server for
// the internet.
import { createReadStream, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('./game', import.meta.url)));
const args = process.argv.slice(2);

function flagValue(flag: string, fallback: string): string {
  const i = args.indexOf(flag);
  return i === -1 || i + 1 >= args.length ? fallback : args[i + 1];
}

const wantedPort = Number(flagValue('--port', '8080'));
const port = Number.isInteger(wantedPort) && wantedPort > 0 && wantedPort < 65536
  ? wantedPort
  : 8080;
const host = flagValue('--host', '127.0.0.1');

if (args.includes('--help') || args.includes('-h')) {
  console.log('usage: node serve.ts [--port <n>] [--host <addr>]');
  console.log('serves game/ on http://<host>:<port> (defaults 127.0.0.1:8080)');
  process.exit(0);
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.glb': 'model/gltf-binary',
  '.gltf': 'model/gltf+json',
  '.bin': 'application/octet-stream',
  '.wasm': 'application/wasm',
  '.wav': 'audio/wav',
  '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg',
  '.txt': 'text/plain; charset=utf-8',
};

// One log line per request: method, path, status, milliseconds. The clock
// line is written the moment the response finishes, so slow files show up.
function logRequest(method: string, path: string, status: number, startedAt: number) {
  const ms = Date.now() - startedAt;
  const stamp = new Date().toISOString().slice(11, 19);
  console.log(`[${stamp}] ${method} ${path} -> ${status} (${ms}ms)`);
}

createServer((request, response) => {
  const startedAt = Date.now();
  const method = request.method ?? 'GET';
  const url = new URL(request.url ?? '/', 'http://localhost');
  let pathname: string;
  try {
    pathname = decodeURIComponent(url.pathname);
  } catch {
    response.writeHead(400).end('bad request');
    logRequest(method, url.pathname, 400, startedAt);
    return;
  }
  if (pathname.endsWith('/')) pathname += 'index.html';
  const file = resolve(join(root, normalize(pathname)));
  if (file !== root && !file.startsWith(root + sep)) {
    response.writeHead(403).end('forbidden');
    logRequest(method, pathname, 403, startedAt);
    return;
  }
  let size: number;
  try {
    const stats = statSync(file);
    if (!stats.isFile()) throw new Error('not a file');
    size = stats.size;
  } catch {
    response.writeHead(404).end('not found');
    logRequest(method, pathname, 404, startedAt);
    return;
  }
  response.writeHead(200, {
    'content-type': MIME[extname(file).toLowerCase()] ?? 'application/octet-stream',
    'content-length': size,
    'cache-control': 'no-store',
  });
  response.on('finish', () => logRequest(method, pathname, 200, startedAt));
  createReadStream(file).pipe(response);
}).listen(port, host, () => {
  console.log(`game/ is on http://${host}:${port}`);
});
