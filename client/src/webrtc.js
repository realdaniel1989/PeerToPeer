/**
 * WebRTC peer-to-peer file transfer engine with server relay fallback.
 *
 * Transfer modes:
 * 1. WebRTC P2P (preferred) — direct browser-to-browser
 * 2. Server Relay (fallback) — chunks go through the signaling server via socket.io
 *
 * The relay kicks in automatically if the WebRTC DataChannel doesn't open
 * within WEBRTC_TIMEOUT ms (e.g. blocked by Zscaler / corporate firewalls).
 *
 * IMPORTANT: Only the SENDER triggers the relay switch. The receiver passively
 * waits for the server to tell it to switch. This avoids duplicate listeners,
 * double sends, and corrupted files.
 */

const CHUNK_SIZE = 16 * 1024; // 16 KB chunks
const BUFFER_THRESHOLD = 1024 * 1024; // 1 MB backpressure threshold
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
function ab2b64(buffer) {
  const bytes = new Uint8Array(buffer);
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}
function b642ab(base64) {
  const bin = atob(base64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes.buffer;
}
function delay(ms) { return new Promise((r) => setTimeout(r, ms)); }

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
  let relaySwitchDone = false;

  function doSwitchToRelay() {
    if (relaySwitchDone || transferMode === "relay" || role !== "sender") return;
    relaySwitchDone = true;
    transferMode = "relay";
    clearTimeout(webrtcTimer);

    // Tear down WebRTC quietly
    try { dc?.close(); } catch (_) {}
    try { pc.close(); } catch (_) {}

    socket.emit("switch-to-relay", (res) => {
      if (res?.ok) {
        console.log("[relay] Sender: relay mode active");
        callbacks.onConnectionState?.("relay");
        callbacks.onChannelOpen?.();
      }
    });
  }

  // ═══════════════════ RELAY: receiver listeners ═══════════════
  // These only do anything when transferMode === "relay"
  let manifestData = null; // [{name, size, type}, …]
  let relayRecv = { chunks: [], receivedBytes: 0, startTime: 0, fileIndex: -1 };

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

  const onRelayManifest = (files) => {
    if (transferMode !== "relay") return;
    manifestData = files;
    callbacks.onManifest?.(files);
  };

  const onRelayFileStart = (info) => {
    if (transferMode !== "relay") return;
    relayRecv = { chunks: [], receivedBytes: 0, startTime: performance.now(), fileIndex: info.index };
    callbacks.onReceiveFileStart?.(info.index, info.name, info.size);
  };

  const onRelayChunk = (data) => {
    if (transferMode !== "relay") return;
    const buf = b642ab(data.data);
    relayRecv.chunks.push(buf);
    relayRecv.receivedBytes += buf.byteLength;

    const fileMeta = manifestData?.[data.fileIndex];
    const totalSize = fileMeta?.size ?? relayRecv.receivedBytes;
    const elapsed = (performance.now() - relayRecv.startTime) / 1000 || 0.001;
    const speed = relayRecv.receivedBytes / elapsed;
    const remaining = totalSize > relayRecv.receivedBytes ? (totalSize - relayRecv.receivedBytes) / speed : 0;
    callbacks.onReceiveProgress?.(data.fileIndex, relayRecv.receivedBytes, totalSize, speed, remaining);
  };

  const onRelayFileComplete = (index) => {
    if (transferMode !== "relay") return;
    const fileMeta = manifestData?.[index];
    const blob = new Blob(relayRecv.chunks, { type: fileMeta?.type || "application/octet-stream" });
    console.log(`[relay] File complete: ${fileMeta?.name} — ${blob.size} bytes (expected ${fileMeta?.size})`);
    callbacks.onReceiveFileComplete?.(index, fileMeta?.name ?? `file-${index}`, blob);
    relayRecv = { chunks: [], receivedBytes: 0, startTime: 0, fileIndex: -1 };
  };

  const onRelayTransferComplete = () => {
    if (transferMode !== "relay") return;
    callbacks.onAllReceiveComplete?.();
  };

  // Register relay listeners only for receiver
  if (role === "receiver") {
    socket.on("relay-mode", onRelayMode);
    socket.on("relay-manifest", onRelayManifest);
    socket.on("relay-file-start", onRelayFileStart);
    socket.on("relay-chunk", onRelayChunk);
    socket.on("relay-file-complete", onRelayFileComplete);
    socket.on("relay-transfer-complete", onRelayTransferComplete);
  }

  // ═══════════════════════ SEND FILES ═════════════════════════
  async function sendFiles(files) {
    if (transferMode === "relay") return sendFilesViaRelay(files);

    // ── WebRTC path ──
    if (!dc || dc.readyState !== "open") throw new Error("DataChannel not open");
    const fileList = Array.from(files);
    const manifest = fileList.map((f) => ({ name: f.name, size: f.size, type: f.type, isText: !!f._isText }));
    dc.send(JSON.stringify({ type: "manifest", files: manifest }));

    for (let fi = 0; fi < fileList.length; fi++) {
      const file = fileList[fi];
      callbacks.onSendFileStart?.(fi, file.name, file.size);
      const buffer = await file.arrayBuffer();
      const totalChunks = Math.ceil(buffer.byteLength / CHUNK_SIZE);
      dc.send(JSON.stringify({ type: "file-start", index: fi, name: file.name, size: file.size, mimeType: file.type, totalChunks }));

      let sentBytes = 0;
      const t0 = performance.now();
      for (let c = 0; c < totalChunks; c++) {
        const start = c * CHUNK_SIZE;
        const chunk = buffer.slice(start, Math.min(start + CHUNK_SIZE, buffer.byteLength));
        while (dc.bufferedAmount > BUFFER_THRESHOLD) await delay(20);
        dc.send(chunk);
        sentBytes += chunk.byteLength;
        const elapsed = (performance.now() - t0) / 1000 || 0.001;
        callbacks.onSendProgress?.(fi, sentBytes, file.size, sentBytes / elapsed, (file.size - sentBytes) / (sentBytes / elapsed));
      }
      dc.send(JSON.stringify({ type: "file-end", index: fi }));
      callbacks.onSendFileComplete?.(fi);
    }
    dc.send(JSON.stringify({ type: "transfer-complete" }));
    callbacks.onAllSendComplete?.();
  }

  // ── Relay send path (sender only) ──
  async function sendFilesViaRelay(files) {
    const fileList = Array.from(files);

    // 1. Manifest
    const manifest = fileList.map((f) => ({ name: f.name, size: f.size, type: f.type, isText: !!f._isText }));
    socket.emit("relay-manifest", manifest);
    await delay(200); // receiver needs time to process manifest

    for (let fi = 0; fi < fileList.length; fi++) {
      const file = fileList[fi];
      callbacks.onSendFileStart?.(fi, file.name, file.size);

      // 2. File-start
      socket.emit("relay-file-start", { index: fi, name: file.name, size: file.size, mimeType: file.type });
      await delay(100); // receiver needs time to init state

      const buffer = await file.arrayBuffer();
      const totalChunks = Math.ceil(buffer.byteLength / CHUNK_SIZE);
      let sentBytes = 0;
      const t0 = performance.now();

      for (let c = 0; c < totalChunks; c++) {
        const start = c * CHUNK_SIZE;
        const end = Math.min(start + CHUNK_SIZE, buffer.byteLength);
        const chunk = buffer.slice(start, end);

        // Emit with ack-based backpressure
        await new Promise((resolve) => {
          socket.emit("relay-chunk", {
            fileIndex: fi, chunkIndex: c, totalChunks, data: ab2b64(chunk),
          }, () => resolve());
          setTimeout(resolve, 5000); // safety fallback
        });

        sentBytes += chunk.byteLength;
        const elapsed = (performance.now() - t0) / 1000 || 0.001;
        const speed = sentBytes / elapsed;
        callbacks.onSendProgress?.(fi, sentBytes, file.size, speed, (file.size - sentBytes) / speed);
      }

      // 3. File-end with ack
      await new Promise((resolve) => {
        socket.emit("relay-file-complete", fi, () => resolve());
        setTimeout(resolve, 5000);
      });
      callbacks.onSendFileComplete?.(fi);
    }

    socket.emit("relay-transfer-complete");
    callbacks.onAllSendComplete?.();
  }

  // ═════════════════ WebRTC RECEIVE ═════════════════
  let rtcRecv = { currentFile: null, chunks: [], receivedBytes: 0, startTime: 0 };

  function handleRtcMessage(evt) {
    if (typeof evt.data === "string") {
      const msg = JSON.parse(evt.data);
      if (msg.type === "manifest") {
        callbacks.onManifest?.(msg.files);
      } else if (msg.type === "file-start") {
        rtcRecv = { currentFile: msg, chunks: [], receivedBytes: 0, startTime: performance.now() };
        callbacks.onReceiveFileStart?.(msg.index, msg.name, msg.size);
      } else if (msg.type === "file-end") {
        const blob = new Blob(rtcRecv.chunks, { type: rtcRecv.currentFile.mimeType || "application/octet-stream" });
        callbacks.onReceiveFileComplete?.(msg.index, rtcRecv.currentFile.name, blob);
        rtcRecv = { currentFile: null, chunks: [], receivedBytes: 0, startTime: 0 };
      } else if (msg.type === "transfer-complete") {
        callbacks.onAllReceiveComplete?.();
      }
    } else {
      rtcRecv.chunks.push(evt.data);
      rtcRecv.receivedBytes += evt.data.byteLength;
      const elapsed = (performance.now() - rtcRecv.startTime) / 1000 || 0.001;
      const speed = rtcRecv.receivedBytes / elapsed;
      callbacks.onReceiveProgress?.(rtcRecv.currentFile.index, rtcRecv.receivedBytes, rtcRecv.currentFile.size, speed, (rtcRecv.currentFile.size - rtcRecv.receivedBytes) / speed);
    }
  }

  // ═══════════════════════ CLEANUP ════════════════════════════════
  function destroy() {
    destroyed = true;
    clearTimeout(webrtcTimer);
    socket.off("signal", handleSignal);
    if (role === "receiver") {
      socket.off("relay-mode", onRelayMode);
      socket.off("relay-manifest", onRelayManifest);
      socket.off("relay-file-start", onRelayFileStart);
      socket.off("relay-chunk", onRelayChunk);
      socket.off("relay-file-complete", onRelayFileComplete);
      socket.off("relay-transfer-complete", onRelayTransferComplete);
    }
    try { dc?.close(); } catch (_) {}
    try { pc.close(); } catch (_) {}
  }

  return { pc, sendFiles, destroy };
}
