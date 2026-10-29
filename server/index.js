import express from "express";
import { createServer } from "http";
import { Server } from "socket.io";
import cors from "cors";
import crypto from "crypto";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app = express();
app.use(cors());

// ── Serve React static build in production ──
const distPath = path.join(__dirname, "..", "client", "dist");
app.use(express.static(distPath));

const httpServer = createServer(app);
const io = new Server(httpServer, {
  cors: { origin: "*", methods: ["GET", "POST"] },
  maxHttpBufferSize: 5e6, // 5 MB per message (relay chunk = 256 KB binary)
  pingTimeout: 60_000, // tolerate slow / inspecting proxies before declaring a peer dead
});

// How long a peer may be disconnected before its seat in the room is given up.
// Within this window it can reconnect and the transfer resumes where it stopped.
const RECONNECT_GRACE_MS = 5 * 60_000;
// How long the server waits for the other peer to acknowledge a relayed message.
const RELAY_ACK_TIMEOUT_MS = 30_000;

// Maps: code -> { sender, receiver, senderToken, receiverToken, transferMode, graceTimers }
const rooms = new Map();

function generateCode() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let code = "";
  const bytes = crypto.randomBytes(6);
  for (let i = 0; i < 6; i++) code += chars[bytes[i] % chars.length];
  return code;
}

const generateToken = () => crypto.randomBytes(16).toString("hex");
const otherRole = (role) => (role === "sender" ? "receiver" : "sender");

io.on("connection", (socket) => {
  console.log(`[+] ${socket.id}`);

  // ── Room management ──
  socket.on("create-room", (callback) => {
    let code;
    do { code = generateCode(); } while (rooms.has(code));
    const token = generateToken();
    rooms.set(code, {
      sender: socket.id, receiver: null,
      senderToken: token, receiverToken: null,
      transferMode: "webrtc", graceTimers: {},
    });
    socket.join(code);
    socket.data.code = code;
    socket.data.role = "sender";
    console.log(`[room] ${code} created by ${socket.id}`);
    callback({ code, token });
  });

  socket.on("join-room", (code, callback) => {
    const upper = code.toUpperCase().trim();
    const room = rooms.get(upper);
    if (!room) return callback({ error: "Invalid code. No active session found." });
    if (room.receiverToken) return callback({ error: "Session already has a receiver connected." });

    const token = generateToken();
    room.receiver = socket.id;
    room.receiverToken = token;
    socket.join(upper);
    socket.data.code = upper;
    socket.data.role = "receiver";
    io.to(room.sender).emit("peer-joined");
    console.log(`[room] ${upper} receiver joined: ${socket.id}`);
    callback({ ok: true, token });
  });

  // Reconnect after a dropped connection (new socket id, same seat in the room)
  socket.on("rejoin-room", ({ code, role, token } = {}, callback) => {
    const room = code && rooms.get(code);
    if (!room || !token || room[`${role}Token`] !== token) {
      return callback?.({ error: "Session expired." });
    }
    clearTimeout(room.graceTimers[role]);
    delete room.graceTimers[role];
    room[role] = socket.id;
    socket.join(code);
    socket.data.code = code;
    socket.data.role = role;
    console.log(`[room] ${code} ${role} rejoined: ${socket.id}`);

    const peerId = room[otherRole(role)];
    const peerPresent = !!(peerId && io.sockets.sockets.get(peerId));
    if (peerPresent) io.to(peerId).emit("peer-back");
    // A receiver that missed the switch while offline still needs to hear it
    if (role === "receiver" && room.transferMode === "relay") socket.emit("relay-mode");
    callback?.({ ok: true, peerPresent, transferMode: room.transferMode });
  });

  // ── WebRTC signaling relay ──
  socket.on("signal", (data) => {
    const code = socket.data.code;
    if (code) socket.to(code).emit("signal", data);
  });

  // ══════════════ SERVER RELAY (fallback) ══════════════

  socket.on("switch-to-relay", (callback) => {
    const code = socket.data.code;
    const room = code && rooms.get(code);
    if (!room) return callback?.({ error: "No room" });

    room.transferMode = "relay";
    console.log(`[relay] ${code} switched to relay mode`);
    if (room.receiver) io.to(room.receiver).emit("relay-mode");
    callback({ ok: true });
  });

  // Relay message: one peer → server → other peer, acknowledged END-TO-END.
  // The sender's ack only fires once the receiver has actually processed the
  // message, so the server never holds more than the sender's in-flight window
  // (instead of buffering the whole file while a slow receiver catches up).
  socket.on("relay", (msg, ack) => {
    if (typeof ack !== "function") return;
    const code = socket.data.code;
    const room = code && rooms.get(code);
    if (!room) return ack({ error: "no-room" });

    const peer = io.sockets.sockets.get(room[otherRole(socket.data.role)]);
    if (!peer) return ack({ error: "peer-away" });

    if (msg?.type !== "chunk") console.log(`[relay] ${code} ${msg?.type}`);
    peer.timeout(RELAY_ACK_TIMEOUT_MS).emit("relay", msg, (err, res) => {
      ack(err ? { error: "peer-timeout" } : res);
    });
  });

  // ── Disconnect: hold the seat for a grace period so the peer can reconnect ──
  socket.on("disconnect", (reason) => {
    const { code, role } = socket.data;
    const room = code && rooms.get(code);
    console.log(`[-] ${socket.id} (${reason})`);
    // Ignore stale sockets that were already replaced by a rejoin
    if (!room || room[role] !== socket.id) return;

    io.to(code).emit("peer-away");
    room.graceTimers[role] = setTimeout(() => {
      delete room.graceTimers[role];
      io.to(code).emit("peer-disconnected");
      if (role === "sender") {
        Object.values(room.graceTimers).forEach(clearTimeout);
        rooms.delete(code);
        console.log(`[room] ${code} destroyed (sender gone)`);
      } else {
        room.receiver = null;
        room.receiverToken = null;
        console.log(`[room] ${code} receiver seat released`);
      }
    }, RECONNECT_GRACE_MS);
  });
});

app.get("/health", (_, res) => res.json({ status: "ok", rooms: rooms.size }));

// SPA fallback
app.get("*", (req, res) => {
  res.sendFile(path.join(distPath, "index.html"));
});

const PORT = process.env.PORT || 3001;
httpServer.listen(PORT, "0.0.0.0", () => {
  console.log(`Signaling server listening on :${PORT}`);
});
