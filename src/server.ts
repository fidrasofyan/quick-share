import type { BunRequest } from 'bun';
import { DateTime, Settings } from 'luxon';
import packageJson from '../package.json';
import indexHtml from './index.html';

declare module 'bun' {
  interface Env {
    ENV: string;
    HOST: string;
    PORT: string;
  }
}

Settings.defaultZone = 'Asia/Jakarta';
Settings.defaultLocale = 'id-ID';

function getDatetime() {
  return DateTime.now().toFormat(
    'yyyy-MM-dd HH:mm:ss ZZZZ',
  );
}

function readEnv(name: string) {
  if (!Bun.env[name]) {
    console.error(`Env ${name} not found`);
    process.exit(1);
  }

  return Bun.env[name];
}

const config = {
  ENV: readEnv('ENV'),
  HOST: readEnv('HOST'),
  PORT: Number.parseInt(readEnv('PORT')),
  ICE_SERVERS: readEnv('ICE_SERVERS')
    .split(',')
    .map((val) => {
      const result = val.split('@');
      const credentials = result[0].split(':');

      return {
        urls: result[1],
        username: credentials[0],
        credential: credentials[1],
      };
    }),
};

const rooms = new Map<
  string,
  {
    users: Set<string>;
  }
>();

type WebSocketData = {
  roomId: string;
  userId: string;
};

const server = Bun.serve<WebSocketData, any>({
  development: config.ENV === 'development',
  hostname: config.HOST,
  port: config.PORT,
  routes: {
    '/': indexHtml,
    '/ice-servers': (_req: BunRequest<'/ice-servers'>) => {
      return Response.json(config.ICE_SERVERS, {
        status: 200,
      });
    },
    '/rooms/:id': (req: BunRequest<'/rooms/:id'>) => {
      const roomId = req.params.id;
      const room = rooms.get(roomId);

      if (!room) {
        return Response.json(
          {
            valid: false,
            full: false,
          },
          { status: 200 },
        );
      }

      return Response.json(
        {
          valid: true,
          full: room.users.size >= 2,
        },
        { status: 200 },
      );
    },
    '/stats': (_req: BunRequest<'/stats'>) => {
      return Response.json(
        {
          totalRooms: rooms.size,
          activeUsers: Array.from(rooms.values()).reduce(
            (acc, room) => acc + room.users.size,
            0,
          ),
        },
        { status: 200 },
      );
    },
  },
  fetch(req, server) {
    const url = new URL(req.url);

    // WebSocket
    if (url.pathname === '/socket') {
      const headers = req.headers
        .get('Sec-WebSocket-Protocol')
        ?.split(',');

      if (!headers || headers.length !== 2) {
        return Response.json(
          {
            message: 'Invalid headers',
          },
          { status: 400 },
        );
      }

      const roomId = headers[0];
      const userId = headers[1];

      if (!roomId) {
        return Response.json(
          {
            message: 'Room ID is required',
          },
          { status: 400 },
        );
      }

      if (!userId) {
        return Response.json(
          {
            message: 'User ID is required',
          },
          { status: 400 },
        );
      }

      const serverUpgrade = server.upgrade(req, {
        data: {
          roomId: roomId.trim(),
          userId: userId.trim(),
        },
      });

      if (serverUpgrade) {
        return new Response(null);
      }

      return Response.json(
        {
          message: 'Upgrade failed',
        },
        { status: 500 },
      );
    }

    // Not found
    return Response.json(
      {
        message: 'Not found',
      },
      { status: 404 },
    );
  },
  // @ts-ignore
  websocket: {
    open(ws) {
      const room = rooms.get(ws.data.roomId);

      if (room && room.users.size >= 2) {
        ws.close(1008, 'full');
        return;
      }

      ws.subscribe(ws.data.roomId);

      if (room) {
        room.users.add(ws.data.userId);
      } else {
        rooms.set(ws.data.roomId, {
          users: new Set([ws.data.userId]),
        });
      }

      console.log(
        `${getDatetime()} # WS: ${ws.data.userId} connected to room ${ws.data.roomId}`,
      );
    },
    message(ws, message) {
      const room = rooms.get(ws.data.roomId);

      if (room && !room.users.has(ws.data.userId)) {
        ws.close(1008, 'Not in room');
        return;
      }

      server.publish(ws.data.roomId, message);
    },
    close(ws) {
      const room = rooms.get(ws.data.roomId);

      if (room?.users.has(ws.data.userId)) {
        room.users.delete(ws.data.userId);

        if (room.users.size === 0) {
          rooms.delete(ws.data.roomId);
        }
      }

      console.log(
        `${getDatetime()} # WS: ${ws.data.userId} disconnected from room ${ws.data.roomId}`,
      );
    },
  },
});

console.log(
  `${getDatetime()} # Bun: v${Bun.version} - env: ${config.ENV} - version: v${packageJson.version}`,
);

console.log(
  `${getDatetime()} # server running at ${server.url}`,
);

// Graceful shutdown
process.on('SIGINT', () => {
  shutdown();
});

process.on('SIGTERM', () => {
  shutdown();
});

process.on('SIGKILL', () => {
  shutdown();
});

function shutdown() {
  server.stop();
  console.log(`${getDatetime()} # server stopped`);
  process.exit(0);
}
