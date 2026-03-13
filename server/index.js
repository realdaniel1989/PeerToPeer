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
app.use(express.json({ limit: "5gb" }));
app.use(express.raw({ limit: "5gb", type: "application/octet-stream" }));

// ── Serve React static build in production ──
const distPath = path.join(__dirname, "..", "client", "dist");
app.use(express.static(distPath));

const httpServer = createServer(app);
const io = new Server(httpServer, {
  cors: { origin: "*", methods: ["GET", "POST"] },
  maxHttpBufferSize: 100e6, // 100 MB for large chunks
});

// Maps: code -> { sender: socketId, receiver: socketId | null, transferMode: "webrtc" | "relay" }
const rooms = new Map();

function generateCode() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no ambiguous chars
  let code = "";
  const bytes = crypto.randomBytes(6);
  for (let i = 0; i < 6; i++) {
    code += chars[bytes[i] % chars.length];
  }
  return code;
}

io.on("connection", (socket) => {
  console.log(`[+] ${socket.id}`);

  // Sender creates a room and gets a code
  socket.on("create-room", (callback) => {
    let code;
    do {
      code = generateCode();
    } while (rooms.has(code));

    rooms.set(code, { sender: socket.id, receiver: null, transferMode: "webrtc" });
    socket.join(code);
    socket.data.code = code;
    socket.data.role = "sender";
    console.log(`[room] ${code} created by ${socket.id}`);
    callback({ code });
  });

  // Receiver joins with a code
  socket.on("join-room", (code, callback) => {
    const upper = code.toUpperCase().trim();
    const room = rooms.get(upper);

    if (!room) {
      return callback({ error: "Invalid code. No active session found." });
    }
    if (room.receiver) {
      return callback({ error: "Session already has a receiver connected." });
    }

    room.receiver = socket.id;
    socket.join(upper);
    socket.data.code = upper;
    socket.data.role = "receiver";

    // Tell sender the receiver is here — sender initiates WebRTC
    io.to(room.sender).emit("peer-joined");
    console.log(`[room] ${upper} receiver joined: ${socket.id}`);
    callback({ ok: true });
  });

  // Relay WebRTC signaling (offer, answer, ice-candidate)
  socket.on("signal", (data) => {
    const code = socket.data.code;
    if (!code) return;
    // Forward to the other peer in the room
    socket.to(code).emit("signal", data);
  });

  // ── RELAY MODE: Fallback when WebRTC is blocked ──
  
  // Sender requests switch to relay mode
  socket.on("switch-to-relay", (callback) => {
    const code = socket.data.code;
    if (!code || !rooms.has(code)) return callback({ error: "No room" });
    
    const room = rooms.get(code);
    room.transferMode = "relay";
    console.log(`[room] ${code} switched to relay mode`);
    
    // Notify receiver to switch to relay mode
    io.to(room.receiver).emit("relay-mode");
    callback({ ok: true });
  });

  // Relay file manifest
  socket.on("relay-manifest", (manifest) => {
    const code = socket.data.code;
    if (!code) return;
    socket.to(code).emit("relay-manifest", manifest);
  });

  // Relay file chunk
  socket.on("relay-chunk", (data) => {
    const code = socket.data.code;
    if (!code) return;
    socket.to(code).emit("relay-chunk", data);
  });

  // Relay file complete signal
  socket.on("relay-file-complete", (index) => {
    const code = socket.data.code;
    if (!code) return;
    socket.to(code).emit("relay-file-complete", index);
  });

  // Relay transfer complete signal
  socket.on("relay-transfer-complete", () => {
    const code = socket.data.code;
    if (!code) return;
    socket.to(code).emit("relay-transfer-complete");
  });

  socket.on("disconnect", () => {
    const code = socket.data.code;
    if (code && rooms.has(code)) {
      const room = rooms.get(code);
      // Notify the other peer
      socket.to(code).emit("peer-disconnected");
      // If the sender leaves, destroy the room
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

// ── SPA fallback: serve index.html for any non-API/non-asset route ──
app.get("*", (req, res) => {
  res.sendFile(path.join(distPath, "index.html"));
});

const PORT = process.env.PORT || 3001;
httpServer.listen(PORT, "0.0.0.0", () => {
  console.log(`Signaling server listening on :${PORT}`);
});
