/**
 * WebRTC peer-to-peer file transfer engine with server relay fallback.
 *
 * Transfer modes:
 * 1. WebRTC P2P (preferred) — direct browser-to-browser
 * 2. Server Relay (fallback) — chunks go through the signaling server via socket.io
 *
 * The relay kicks in automatically if the WebRTC DataChannel doesn't open
 * within WEBRTC_TIMEOUT ms (e.g. blocked by Zscaler / corporate firewalls),
 * or if the DataChannel dies in the middle of a transfer.
 *
 * IMPORTANT: Only the SENDER triggers the relay switch. The receiver passively
 * waits for the server to tell it to switch. This avoids duplicate listeners,
 * double sends, and corrupted files.
 *
 * Relay transfers are resumable: every relay message is acknowledged by the
 * receiver itself (not just the server), and the sender always starts by asking
 * the receiver how far it got. If the connection drops, the sender keeps
 * retrying and continues from the receiver's last confirmed byte once both
 * sides have reconnected — no need to start the upload over.
 */

const RTC_CHUNK_SIZE = 16 * 1024; // 16 KB DataChannel messages
const READ_BLOCK_SIZE = 256 * 1024; // bytes read from disk at a time (never the whole file)
const RELAY_CHUNK_SIZE = 256 * 1024; // 256 KB binary relay messages
const RELAY_WINDOW = 4; // relay chunks in flight before waiting for the receiver's ack
const RELAY_RPC_TIMEOUT = 45_000; // > server's RELAY_ACK_TIMEOUT_MS
const RELAY_RETRY_DELAY = 2_000;
const BUFFER_THRESHOLD = 1024 * 1024; // 1 MB DataChannel backpressure threshold
const BLOB_FLUSH_BYTES = 64 * 1024 * 1024; // merge received chunks into a Blob every 64 MB
const WEBRTC_TIMEOUT = 10_000; // 10 s

const ICE_SERVERS = [
  { urls: "stun:stun.l.google.com:19302" },
  { urls: "stun:stun1.l.google.com:19302" },
  { urls: "stun:stun2.l.google.com:19302" },
  { urls: "stun:stun3.l.google.com:19302" },
  { urls: "stun:stun4.l.google.com:19302" },
  { urls: "turn:openrelay.metered.ca:80", username: "openrelayproject", credential: "openrelayproject" },
  { urls: "turn:openrelay.metered.ca:443", username: "openrelayproject", credential: "openrelayproject" },
  { urls: "turn:openrelay.metered.ca:443?transport=tcp", username: "openrelayproject", credential: "openrelayproject" },
];

// ── Helpers ──
function delay(ms) { return new Promise((r) => setTimeout(r, ms)); }
function buildManifest(fileList) {
  return fileList.map((f) => ({ name: f.name, size: f.size, type: f.type, isText: !!f._isText }));
}

// ════════════════════════════════════════════════════════════════
export function createPeerConnection(socket, role, callbacks) {
  let transferMode = "webrtc"; // "webrtc" | "relay"
  let destroyed = false;

  // ─────────────── WebRTC setup ───────────────
  const pc = new RTCPeerConnection({
    iceServers: ICE_SERVERS,
    iceCandidatePoolSize: 10,
    bundlePolicy: "max-bundle",
    rtcpMuxPolicy: "require",
  });

  let dc = null;
  let webrtcTimer = null;

  pc.onicecandidate = (e) => {
    if (e.candidate) socket.emit("signal", { type: "ice-candidate", candidate: e.candidate });
  };

  pc.onconnectionstatechange = () => {
    // ONLY report WebRTC connection states while still in webrtc mode
    if (transferMode === "webrtc") {
      callbacks.onConnectionState?.(pc.connectionState);
    }
    // If ICE fails and we're the sender, trigger relay
    if (pc.connectionState === "failed" && role === "sender" && transferMode === "webrtc") {
      console.warn("[webrtc] ICE failed → switching to relay");
      doSwitchToRelay();
    }
    // Receiver does NOT call switchToRelay — it waits for server "relay-mode" event
  };

  // ─────────────── Signaling ───────────────
  const handleSignal = async (data) => {
    if (destroyed || transferMode === "relay") return;
    try {
      if (data.type === "offer") {
        await pc.setRemoteDescription(new RTCSessionDescription(data.offer));
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        socket.emit("signal", { type: "answer", answer });
      } else if (data.type === "answer") {
        await pc.setRemoteDescription(new RTCSessionDescription(data.answer));
      } else if (data.type === "ice-candidate") {
        await pc.addIceCandidate(new RTCIceCandidate(data.candidate));
      }
    } catch (err) {
      console.error("[signal]", err);
    }
  };
  socket.on("signal", handleSignal);

  // ─────────────── Sender: DataChannel + offer ───────────────
  if (role === "sender") {
    dc = pc.createDataChannel("file-transfer", { ordered: true });
    dc.binaryType = "arraybuffer";
    dc.onopen = () => {
      clearTimeout(webrtcTimer);
      if (transferMode === "webrtc") callbacks.onChannelOpen?.();
    };
    dc.onclose = () => {};
    dc.onerror = () => {
      if (transferMode === "webrtc") doSwitchToRelay();
    };

    webrtcTimer = setTimeout(() => {
      if (transferMode === "webrtc" && (!dc || dc.readyState !== "open")) {
        console.warn("[webrtc] DataChannel timeout → relay");
        doSwitchToRelay();
      }
    }, WEBRTC_TIMEOUT);

    (async () => {
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      socket.emit("signal", { type: "offer", offer });
    })();
  }

  // ─────────────── Receiver: accept DataChannel ───────────────
  if (role === "receiver") {
    pc.ondatachannel = (e) => {
      dc = e.channel;
      dc.binaryType = "arraybuffer";
      dc.onopen = () => {
        clearTimeout(webrtcTimer);
        if (transferMode === "webrtc") callbacks.onChannelOpen?.();
      };
      dc.onclose = () => {};
      dc.onerror = () => {};
      dc.onmessage = (evt) => {
        if (transferMode === "webrtc") handleRtcMessage(evt);
      };
    };
    // Receiver does NOT set a timeout that triggers relay.
    // It passively waits for the server's "relay-mode" event.
  }

  // ═══════════════════ RELAY: sender-only switch ═══════════════
  function doSwitchToRelay() {
    if (transferMode === "relay" || role !== "sender" || destroyed) return;
    transferMode = "relay";
    clearTimeout(webrtcTimer);

    // Tear down WebRTC quietly
    try { dc?.close(); } catch (_) {}
    try { pc.close(); } catch (_) {}

    // Emitted before any relay message, so the server/receiver switch first.
    // We don't wait for the reply: if the socket is down right now, the relay
    // send loop simply keeps retrying until the connection is back.
    socket.emit("switch-to-relay", () => {});
    console.log("[relay] Sender: relay mode active");
    callbacks.onConnectionState?.("relay");
    callbacks.onChannelOpen?.();
  }

  // ═══════════════════ RECEIVE STATE (shared by both transports) ═══════════════
  // Files arrive strictly in order. `completedCount` files are finished;
  // `current` is the file in progress, if any.
  let manifestData = null; // [{name, size, type, isText}, …]
  let completedCount = 0;
  let current = null;
  let allReceived = false;

  function recvManifest(files) {
    if (manifestData) return;
    manifestData = files;
    callbacks.onManifest?.(files);
  }

  function recvFileStart({ index, name, size, mimeType }) {
    if (index < completedCount) return; // already have it
    current = {
      index, name, size, mimeType,
      parts: [], pending: [], pendingBytes: 0, received: 0,
      speedT0: performance.now(), speedBytes0: 0,
    };
    callbacks.onReceiveFileStart?.(index, name, size);
  }

  function recvChunk(index, offset, data) {
    if (!current || current.index !== index) return { error: "unexpected-file" };
    if (offset < current.received) return { ok: true }; // duplicate after a resume
    if (offset > current.received) return { error: "gap" };

    current.pending.push(data);
    current.pendingBytes += data.byteLength;
    current.received += data.byteLength;
    // Fold chunks into a Blob periodically so the browser can page large files out of RAM
    if (current.pendingBytes >= BLOB_FLUSH_BYTES) {
      current.parts.push(new Blob(current.pending));
      current.pending = [];
      current.pendingBytes = 0;
    }

    const elapsed = (performance.now() - current.speedT0) / 1000 || 0.001;
    const speed = (current.received - current.speedBytes0) / elapsed;
    const remaining = current.size > current.received && speed > 0 ? (current.size - current.received) / speed : 0;
    callbacks.onReceiveProgress?.(index, current.received, current.size, speed, remaining);
    return { ok: true };
  }

  function recvFileEnd(index) {
    if (index < completedCount) return { ok: true }; // already finalized
    if (!current || current.index !== index) return { error: "unexpected-file" };
    if (current.received !== current.size) return { error: "incomplete" };

    const blob = new Blob([...current.parts, ...current.pending], {
      type: current.mimeType || manifestData?.[index]?.type || "application/octet-stream",
    });
    console.log(`[recv] File complete: ${current.name} — ${blob.size} bytes (expected ${current.size})`);
    const name = current.name;
    current = null;
    completedCount = index + 1;
    callbacks.onReceiveFileComplete?.(index, name, blob);
    return { ok: true };
  }

  function recvDone() {
    if (allReceived) return;
    allReceived = true;
    callbacks.onAllReceiveComplete?.();
  }

  function recvStatus() {
    // Speed restarts from here so a pause doesn't drag the average down
    if (current) { current.speedT0 = performance.now(); current.speedBytes0 = current.received; }
    return {
      ok: true,
      hasManifest: !!manifestData,
      completed: completedCount,
      offset: current && current.index === completedCount ? current.received : 0,
    };
  }

  // ═══════════════════ RELAY: receiver side ═══════════════
  const onRelayMode = () => {
    if (transferMode === "relay") return; // already switched, ignore duplicate
    console.log("[relay] Receiver: relay mode active");
    transferMode = "relay";
    clearTimeout(webrtcTimer);

    // Tear down WebRTC quietly on receiver side too
    try { dc?.close(); } catch (_) {}
    try { pc.close(); } catch (_) {}

    callbacks.onConnectionState?.("relay");
    callbacks.onChannelOpen?.();
  };

  const onRelayMessage = (msg, ack) => {
    if (typeof ack !== "function") return;
    if (destroyed) return ack({ error: "destroyed" });
    onRelayMode(); // any relay traffic means we're in relay mode

    let res = { ok: true };
    switch (msg?.type) {
      case "status": res = recvStatus(); break;
      case "manifest": recvManifest(msg.files); break;
      case "file-start": recvFileStart(msg); break;
      case "chunk": res = recvChunk(msg.index, msg.offset, msg.data); break;
      case "file-end": res = recvFileEnd(msg.index); break;
      case "done": recvDone(); break;
      default: res = { error: "unknown-message" };
    }
    ack(res);
  };

  // Register relay listeners only for receiver
  if (role === "receiver") {
    socket.on("relay-mode", onRelayMode);
    socket.on("relay", onRelayMessage);
  }

  // ═══════════════════════ SEND FILES ═════════════════════════
  let filesToSend = null;
  let sending = false;
  let sendFinished = false;
  const reportedComplete = new Set();

  function reportSendComplete(fi, file) {
    if (reportedComplete.has(fi)) return;
    reportedComplete.add(fi);
    callbacks.onSendFileComplete?.(fi, file.size);
  }

  // Safe to call more than once (e.g. again after a switch to relay):
  // only one send loop ever runs, and the relay loop resumes where it stopped.
  function sendFiles(files) {
    filesToSend = Array.from(files);
    runSender();
  }

  async function runSender() {
    if (sending || sendFinished || destroyed || !filesToSend) return;
    sending = true;
    const mode = transferMode;
    try {
      if (mode === "relay") await sendViaRelayWithResume(filesToSend);
      else await sendViaWebRTC(filesToSend);
      sendFinished = true;
      callbacks.onAllSendComplete?.();
    } catch (err) {
      if (destroyed) return;
      console.warn(`[send] ${mode} transfer interrupted: ${err.message}`);
      // DataChannel died mid-transfer → continue over the relay from the receiver's last byte
      if (mode === "webrtc") doSwitchToRelay();
    } finally {
      sending = false;
    }
    if (!sendFinished && !destroyed && transferMode !== mode) runSender();
  }

  // ── WebRTC path ──
  async function sendViaWebRTC(fileList) {
    const assertOpen = () => {
      if (destroyed || transferMode !== "webrtc" || !dc || dc.readyState !== "open") {
        throw new Error("DataChannel not open");
      }
    };
    assertOpen();
    dc.send(JSON.stringify({ type: "manifest", files: buildManifest(fileList) }));

    for (let fi = 0; fi < fileList.length; fi++) {
      const file = fileList[fi];
      callbacks.onSendFileStart?.(fi, file.name, file.size);
      dc.send(JSON.stringify({ type: "file-start", index: fi, name: file.name, size: file.size, mimeType: file.type }));

      let sentBytes = 0;
      const t0 = performance.now();
      for (let offset = 0; offset < file.size; offset += READ_BLOCK_SIZE) {
        const block = await file.slice(offset, Math.min(offset + READ_BLOCK_SIZE, file.size)).arrayBuffer();
        for (let p = 0; p < block.byteLength; p += RTC_CHUNK_SIZE) {
          while (dc.bufferedAmount > BUFFER_THRESHOLD) {
            assertOpen();
            await delay(20);
          }
          assertOpen();
          dc.send(block.slice(p, p + RTC_CHUNK_SIZE));
        }
        sentBytes += block.byteLength;
        const elapsed = (performance.now() - t0) / 1000 || 0.001;
        callbacks.onSendProgress?.(fi, sentBytes, file.size, sentBytes / elapsed, (file.size - sentBytes) / (sentBytes / elapsed));
      }
      dc.send(JSON.stringify({ type: "file-end", index: fi }));
      reportSendComplete(fi, file);
    }
    dc.send(JSON.stringify({ type: "transfer-complete" }));
    // Don't report "done" while data is still queued in the channel
    while (dc.bufferedAmount > 0) {
      assertOpen();
      await delay(50);
    }
  }

  // ── Relay path (sender only) ──

  // Send one relay message and wait for the RECEIVER's acknowledgement.
  function relayRpc(msg) {
    return new Promise((resolve, reject) => {
      if (destroyed) return reject(new Error("destroyed"));
      if (!socket.connected) return reject(new Error("offline"));
      const onDrop = () => reject(new Error("connection lost"));
      socket.once("disconnect", onDrop);
      socket.once("peer-away", onDrop);
      socket.timeout(RELAY_RPC_TIMEOUT).emit("relay", msg, (err, res) => {
        socket.off("disconnect", onDrop);
        socket.off("peer-away", onDrop);
        if (err) reject(new Error("timeout"));
        else if (res?.error) reject(new Error(res.error));
        else resolve(res);
      });
    });
  }

  async function sendViaRelayWithResume(fileList) {
    for (;;) {
      try {
        return await sendViaRelay(fileList);
      } catch (err) {
        if (destroyed) throw err;
        console.warn(`[relay] ${err.message} — resuming in ${RELAY_RETRY_DELAY / 1000}s`);
        await delay(RELAY_RETRY_DELAY);
      }
    }
  }

  async function sendViaRelay(fileList) {
    // Ask the receiver what it already has, then continue from there
    const state = await relayRpc({ type: "status" });
    callbacks.onConnectionState?.("relay");
    if (!state.hasManifest) await relayRpc({ type: "manifest", files: buildManifest(fileList) });
    // Files the receiver finished while we were cut off (their final ack was lost)
    for (let fi = 0; fi < state.completed; fi++) reportSendComplete(fi, fileList[fi]);

    for (let fi = state.completed; fi < fileList.length; fi++) {
      const file = fileList[fi];
      let offset = fi === state.completed ? state.offset : 0;
      callbacks.onSendFileStart?.(fi, file.name, file.size);
      if (offset === 0) {
        await relayRpc({ type: "file-start", index: fi, name: file.name, size: file.size, mimeType: file.type });
      }

      const resumedAt = offset;
      const t0 = performance.now();
      const inflight = [];
      while (offset < file.size || inflight.length) {
        // Keep a small window of chunks in flight; each waits for the receiver's ack
        while (offset < file.size && inflight.length < RELAY_WINDOW) {
          const end = Math.min(offset + RELAY_CHUNK_SIZE, file.size);
          const data = await file.slice(offset, end).arrayBuffer();
          const p = relayRpc({ type: "chunk", index: fi, offset, data }).then(() => end);
          p.catch(() => {}); // surfaced via the await below; avoid unhandled rejections
          inflight.push(p);
          offset = end;
        }
        const acked = await inflight.shift();
        const elapsed = (performance.now() - t0) / 1000 || 0.001;
        const speed = (acked - resumedAt) / elapsed;
        callbacks.onSendProgress?.(fi, acked, file.size, speed, speed > 0 ? (file.size - acked) / speed : 0);
      }

      await relayRpc({ type: "file-end", index: fi });
      reportSendComplete(fi, file);
    }

    await relayRpc({ type: "done" });
  }

  // ═════════════════ WebRTC RECEIVE ═════════════════
  function handleRtcMessage(evt) {
    if (typeof evt.data === "string") {
      const msg = JSON.parse(evt.data);
      if (msg.type === "manifest") recvManifest(msg.files);
      else if (msg.type === "file-start") recvFileStart(msg);
      else if (msg.type === "file-end") recvFileEnd(msg.index);
      else if (msg.type === "transfer-complete") recvDone();
    } else if (current) {
      recvChunk(current.index, current.received, evt.data);
    }
  }

  // ═══════════════════════ CLEANUP ════════════════════════════════
  function destroy() {
    destroyed = true;
    clearTimeout(webrtcTimer);
    socket.off("signal", handleSignal);
    if (role === "receiver") {
      socket.off("relay-mode", onRelayMode);
      socket.off("relay", onRelayMessage);
    }
    try { dc?.close(); } catch (_) {}
    try { pc.close(); } catch (_) {}
  }

  return { pc, sendFiles, destroy };
}
