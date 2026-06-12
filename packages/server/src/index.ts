/**
 * Quori Quest game server (M3).
 *
 * - WebSocket endpoint at /ws — rooms + authoritative Quoridor engine.
 * - /api/token — OAuth code exchange stub, completed in M4 (Discord Activity).
 * - Serves the built client (packages/client/dist) when present, so a single
 *   container/process hosts the whole game (the shape Discord's activity
 *   proxy expects: one origin, relative URLs only).
 */
import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import type { WebSocket } from 'ws';
import { RoomManager } from './manager';
import type { Conn } from './room';
import type { ServerMessage } from '@quori/protocol';

const PORT = Number(process.env.PORT ?? 5174);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLIENT_DIST = process.env.CLIENT_DIST ?? path.resolve(HERE, '../../client/dist');

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.json': 'application/json',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

const manager = new RoomManager();

const server = http.createServer((req, res) => {
  void handleHttp(req, res);
});

async function handleHttp(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://localhost');
  if (url.pathname === '/api/health') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, rooms: manager.roomCount() }));
    return;
  }
  if (url.pathname === '/api/token') {
    // M4: exchange the Discord OAuth code using DISCORD_CLIENT_SECRET here.
    res.writeHead(501, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'Discord auth lands in milestone M4' }));
    return;
  }
  // static client
  try {
    let filePath = path.join(CLIENT_DIST, decodeURIComponent(url.pathname));
    if (!filePath.startsWith(CLIENT_DIST)) {
      res.writeHead(403).end();
      return;
    }
    let s = await stat(filePath).catch(() => null);
    if (!s || s.isDirectory()) {
      filePath = path.join(CLIENT_DIST, 'index.html'); // SPA fallback
      s = await stat(filePath).catch(() => null);
      if (!s) {
        res.writeHead(404, { 'content-type': 'text/plain' });
        res.end('Client not built. Run: pnpm --filter @quori/client build');
        return;
      }
    }
    const body = await readFile(filePath);
    res.writeHead(200, { 'content-type': MIME[path.extname(filePath)] ?? 'application/octet-stream' });
    res.end(body);
  } catch {
    res.writeHead(500).end();
  }
}

const wss = new WebSocketServer({ server, path: '/ws' });

function wrap(ws: WebSocket): Conn {
  return {
    send(msg: ServerMessage) {
      if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
    },
    close() {
      try {
        ws.close();
      } catch {
        /* already closed */
      }
    },
  };
}

wss.on('connection', (ws) => {
  const session = manager.attach(wrap(ws));
  ws.on('message', (data) => {
    try {
      session.onMessage(data.toString());
    } catch (err) {
      console.error('[quori-server] message error', err);
    }
  });
  ws.on('close', () => session.onClose());
  ws.on('error', () => session.onClose());
});

// keepalive: terminate dead sockets so disconnect grace actually starts
const HEARTBEAT_MS = 30_000;
const alive = new WeakMap<WebSocket, boolean>();
wss.on('connection', (ws) => {
  alive.set(ws, true);
  ws.on('pong', () => alive.set(ws, true));
});
setInterval(() => {
  for (const ws of wss.clients) {
    if (alive.get(ws) === false) {
      ws.terminate();
      continue;
    }
    alive.set(ws, false);
    ws.ping();
  }
}, HEARTBEAT_MS).unref();

server.listen(PORT, () => {
  console.log(`[quori-server] listening on http://localhost:${PORT} (ws: /ws)`);
  console.log(`[quori-server] serving client from ${CLIENT_DIST}`);
});
