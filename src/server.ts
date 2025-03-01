import packageJson from "../package.json";
import type { BunRequest } from "bun";
import indexHtml from "./index.html";

declare module "bun" {
  interface Env {
    ENV: string;
    HOST: string;
    PORT: string;
  }
}

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
  development: Bun.env.ENV === "development",
  hostname: Bun.env.HOST || "localhost",
  port: Number.parseInt(Bun.env.PORT) || 3000,
  routes: {
    "/": indexHtml,
    "/rooms/:id": (req: BunRequest<"/rooms/:id">) => {
      const roomId = req.params.id;
      const room = rooms.get(roomId);

      if (!room) {
        return Response.json(
          {
            valid: false,
            full: false,
          },
          { status: 200 }
        );
      }

      return Response.json(
        {
          valid: true,
          full: room.users.size >= 2,
        },
        { status: 200 }
      );
    },
  },
  fetch(req, server) {
    const url = new URL(req.url);

    // WebSocket
    if (url.pathname === "/socket") {
      const headers = req.headers.get("Sec-WebSocket-Protocol")?.split(",");

      if (!headers || headers.length !== 2) {
        return new Response("Invalid headers", {
          status: 400,
        });
      }

      const roomId = headers[0];
      const userId = headers[1];

      if (!roomId) {
        return new Response("Room ID is required", { status: 400 });
      }

      if (!userId) {
        return new Response("User ID is required", { status: 400 });
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

      return new Response("Upgrade failed", { status: 500 });
    }

    // Not found
    return new Response("Not found", { status: 404 });
  },
  // @ts-ignore
  websocket: {
    open(ws) {
      const room = rooms.get(ws.data.roomId);

      if (room && room.users.size >= 2) {
        ws.close(1008, "full");
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
    },
    message(ws, message) {
      const room = rooms.get(ws.data.roomId);
      if (room && !room.users.has(ws.data.userId)) {
        ws.close(1008, "Not in room");
        return;
      }

      server.publish(ws.data.roomId, message);
    },
    close(ws) {
      const room = rooms.get(ws.data.roomId);

      if (room && room.users.has(ws.data.userId)) {
        room.users.delete(ws.data.userId);

        if (room.users.size === 0) {
          rooms.delete(ws.data.roomId);
        }
      }
    },
  },
});

console.log(
  `Bun: v${Bun.version} - env: ${Bun.env.ENV} - version: v${packageJson.version}`
);

console.log(`server running at ${server.url}`);

// Graceful shutdown
process.on("SIGINT", () => {
  shutdown();
});

process.on("SIGTERM", () => {
  shutdown();
});

process.on("SIGKILL", () => {
  shutdown();
});

function shutdown() {
  server.stop();
  console.log("server stopped");
  process.exit(0);
}
