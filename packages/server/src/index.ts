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
import { existsSync } from 'node:fs';
import path from 'node:path';
import sirv from 'sirv';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import type { WebSocket } from 'ws';
import { RoomManager } from './manager';
import type { Conn } from './room';
import type { ServerMessage } from '@quori/protocol';

const PORT = Number(process.env.PORT ?? 5174);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLIENT_DIST = process.env.CLIENT_DIST ?? path.resolve(HERE, '../../client/dist');

// Created lazily so the server still starts (and recovers) when the client
// isn't built yet — sirv scans the directory tree when constructed.
let serveClient: ReturnType<typeof sirv> | null = null;

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
  if (!serveClient && existsSync(path.join(CLIENT_DIST, 'index.html'))) {
    serveClient = sirv(CLIENT_DIST, {
      single: true, // SPA fallback to index.html
      etag: true,
      setHeaders(res, pathname) {
        // Vite's content-hashed output only — index.html must stay fresh.
        if (pathname.startsWith('/assets/')) {
          res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
        }
      },
    });
  }
  if (!serveClient) {
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('Client not built. Run: pnpm --filter @quori/client build');
    return;
  }
  serveClient(req, res);
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

// keepalive: terminate dead sockets so disconnect grace actually starts
const HEARTBEAT_MS = 30_000;
const alive = new WeakMap<WebSocket, boolean>();

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
