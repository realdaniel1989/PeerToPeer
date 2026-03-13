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
  maxHttpBufferSize: 5e6, // 5 MB per message (base64 chunk ≈ 22 KB)
});

// Maps: code -> { sender, receiver, transferMode }
const rooms = new Map();

function generateCode() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let code = "";
  const bytes = crypto.randomBytes(6);
  for (let i = 0; i < 6; i++) code += chars[bytes[i] % chars.length];
  return code;
}

io.on("connection", (socket) => {
  console.log(`[+] ${socket.id}`);

  // ── Room management ──
  socket.on("create-room", (callback) => {
    let code;
    do { code = generateCode(); } while (rooms.has(code));
    rooms.set(code, { sender: socket.id, receiver: null, transferMode: "webrtc" });
    socket.join(code);
    socket.data.code = code;
    socket.data.role = "sender";
    console.log(`[room] ${code} created by ${socket.id}`);
    callback({ code });
  });

  socket.on("join-room", (code, callback) => {
    const upper = code.toUpperCase().trim();
    const room = rooms.get(upper);
    if (!room) return callback({ error: "Invalid code. No active session found." });
    if (room.receiver) return callback({ error: "Session already has a receiver connected." });

    room.receiver = socket.id;
    socket.join(upper);
    socket.data.code = upper;
    socket.data.role = "receiver";
    io.to(room.sender).emit("peer-joined");
    console.log(`[room] ${upper} receiver joined: ${socket.id}`);
    callback({ ok: true });
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
    io.to(room.receiver).emit("relay-mode");
    callback({ ok: true });
  });

  // Manifest: sender → server → receiver
  socket.on("relay-manifest", (manifest) => {
    const code = socket.data.code;
    if (code) {
      console.log(`[relay] ${code} manifest: ${manifest.length} file(s)`);
      socket.to(code).emit("relay-manifest", manifest);
    }
  });

  // File-start: sender → server → receiver (carries name, size, mimeType)
  socket.on("relay-file-start", (info) => {
    const code = socket.data.code;
    if (code) {
      console.log(`[relay] ${code} file-start: ${info.name} (${info.size} bytes)`);
      socket.to(code).emit("relay-file-start", info);
    }
  });

  // Chunk: sender → server → receiver (with ack back to sender)
  socket.on("relay-chunk", (data, ack) => {
    const code = socket.data.code;
    if (code) {
      socket.to(code).emit("relay-chunk", data);
    }
    // Acknowledge to sender so it can send next chunk (backpressure)
    if (typeof ack === "function") ack();
  });

  // File-complete: sender → server → receiver
  socket.on("relay-file-complete", (index, ack) => {
    const code = socket.data.code;
    if (code) {
      console.log(`[relay] ${code} file-complete: index=${index}`);
      socket.to(code).emit("relay-file-complete", index);
    }
    if (typeof ack === "function") ack();
  });

  // Transfer-complete: sender → server → receiver
  socket.on("relay-transfer-complete", () => {
    const code = socket.data.code;
    if (code) {
      console.log(`[relay] ${code} transfer-complete`);
      socket.to(code).emit("relay-transfer-complete");
    }
  });

  // ── Disconnect cleanup ──
  socket.on("disconnect", () => {
    const code = socket.data.code;
    if (code && rooms.has(code)) {
      const room = rooms.get(code);
      socket.to(code).emit("peer-disconnected");
      if (socket.data.role === "sender") {
        rooms.delete(code);
        console.log(`[room] ${code} destroyed (sender left)`);
      } else {
        room.receiver = null;
      }
    }
    console.log(`[-] ${socket.id}`);
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
