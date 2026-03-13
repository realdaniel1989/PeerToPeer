/**
 * WebRTC peer-to-peer file transfer engine with server relay fallback.
 *
 * Transfer modes:
 * 1. WebRTC P2P (preferred) — direct browser-to-browser
 * 2. Server Relay (fallback) — chunks go through the signaling server via socket.io
 *
 * The relay kicks in automatically if the WebRTC DataChannel doesn't open
 * within WEBRTC_TIMEOUT ms (e.g. blocked by Zscaler / corporate firewalls).
 */

const CHUNK_SIZE = 16 * 1024; // 16 KB chunks
const BUFFER_THRESHOLD = 1024 * 1024; // 1 MB — pause sending when buffered > this
const WEBRTC_TIMEOUT = 10_000; // 10 s to wait for DataChannel

const ICE_SERVERS = [
  { urls: "stun:stun.l.google.com:19302" },
  { urls: "stun:stun1.l.google.com:19302" },
  { urls: "stun:stun2.l.google.com:19302" },
  { urls: "stun:stun3.l.google.com:19302" },
  { urls: "stun:stun4.l.google.com:19302" },
  {
    urls: "turn:openrelay.metered.ca:80",
    username: "openrelayproject",
    credential: "openrelayproject",
  },
  {
    urls: "turn:openrelay.metered.ca:443",
    username: "openrelayproject",
    credential: "openrelayproject",
  },
  {
    urls: "turn:openrelay.metered.ca:443?transport=tcp",
    username: "openrelayproject",
    credential: "openrelayproject",
  },
];

// ── Helpers ──
function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

function base64ToArrayBuffer(base64) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

// ════════════════════════════════════════════════════════════════
export function createPeerConnection(socket, role, callbacks) {
  const pc = new RTCPeerConnection({
    iceServers: ICE_SERVERS,
    iceCandidatePoolSize: 10,
    bundlePolicy: "max-bundle",
    rtcpMuxPolicy: "require",
  });

  let dc = null;
  let transferMode = "webrtc"; // "webrtc" | "relay"
  let webrtcTimer = null;
  let pendingFiles = null; // files queued before relay was ready
  let manifestData = null; // manifest received (relay), stored for file info lookups

  // ── Relay receive-side state ──
  let relayRecv = {
    chunks: [],
    receivedBytes: 0,
    startTime: 0,
    fileIndex: -1,
  };

  // ── WebRTC receive-side state ──
  let rtcRecv = {
    currentFile: null,
    chunks: [],
    receivedBytes: 0,
    startTime: 0,
  };

  // ────────────────────────────── ICE ──────────────────────────────
  pc.onicecandidate = (e) => {
    if (e.candidate) socket.emit("signal", { type: "ice-candidate", candidate: e.candidate });
  };

  pc.onconnectionstatechange = () => {
    callbacks.onConnectionState?.(pc.connectionState);
    if (pc.connectionState === "failed") {
      console.warn("[webrtc] ICE connection failed → relay");
      switchToRelay();
    }
  };

  // ────────────────────────── Signaling ────────────────────────────
  const handleSignal = async (data) => {
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

  // ────────────────── Sender: DataChannel + offer ──────────────────
  if (role === "sender") {
    dc = pc.createDataChannel("file-transfer", { ordered: true });
    dc.binaryType = "arraybuffer";
    dc.onopen = () => { clearTimeout(webrtcTimer); callbacks.onChannelOpen?.(); };
    dc.onclose = () => callbacks.onChannelClose?.();
    dc.onerror = () => switchToRelay();

    webrtcTimer = setTimeout(() => {
      if (!dc || dc.readyState !== "open") {
        console.warn("[webrtc] DataChannel timeout → relay");
        switchToRelay();
      }
    }, WEBRTC_TIMEOUT);

    (async () => {
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      socket.emit("signal", { type: "offer", offer });
    })();
  }

  // ────────────────── Receiver: accept DataChannel ─────────────────
  if (role === "receiver") {
    pc.ondatachannel = (e) => {
      dc = e.channel;
      dc.binaryType = "arraybuffer";
      dc.onopen = () => { clearTimeout(webrtcTimer); callbacks.onChannelOpen?.(); };
      dc.onclose = () => callbacks.onChannelClose?.();
      dc.onerror = () => {};
      dc.onmessage = (evt) => handleRtcMessage(evt);
    };

    webrtcTimer = setTimeout(() => {
      // Just log — receiver waits for sender to trigger relay
      if (!dc || dc.readyState !== "open") {
        console.warn("[webrtc] Receiver: DataChannel not open yet, waiting for relay…");
      }
    }, WEBRTC_TIMEOUT);
  }

  // ═══════════════════════ RELAY MODE SETUP ════════════════════════
  // Receiver: server tells us to switch
  socket.on("relay-mode", () => {
    console.log("[relay] Receiver switching to relay mode");
    transferMode = "relay";
    callbacks.onConnectionState?.("relay");
    callbacks.onChannelOpen?.();
  });

  // Receiver: manifest arrives
  socket.on("relay-manifest", (files) => {
    manifestData = files; // [{name, size, type}, …]
    callbacks.onManifest?.(files);
  });

  // Receiver: file-start (sent before first chunk of each file)
  socket.on("relay-file-start", (info) => {
    // info = { index, name, size, mimeType }
    relayRecv = { chunks: [], receivedBytes: 0, startTime: performance.now(), fileIndex: info.index };
    callbacks.onReceiveFileStart?.(info.index, info.name, info.size);
  });

  // Receiver: a chunk arrives
  socket.on("relay-chunk", (data) => {
    // data = { fileIndex, chunkIndex, totalChunks, data (base64) }
    const buf = base64ToArrayBuffer(data.data);
    relayRecv.chunks.push(buf);
    relayRecv.receivedBytes += buf.byteLength;

    // Look up total size from manifest
    const fileMeta = manifestData?.[data.fileIndex];
    const totalSize = fileMeta?.size ?? relayRecv.receivedBytes;
    const elapsed = (performance.now() - relayRecv.startTime) / 1000 || 0.001;
    const speed = relayRecv.receivedBytes / elapsed;
    const remaining = totalSize > relayRecv.receivedBytes
      ? (totalSize - relayRecv.receivedBytes) / speed
      : 0;

    callbacks.onReceiveProgress?.(data.fileIndex, relayRecv.receivedBytes, totalSize, speed, remaining);
  });

  // Receiver: one file finished
  socket.on("relay-file-complete", (index) => {
    const fileMeta = manifestData?.[index];
    const blob = new Blob(relayRecv.chunks, {
      type: fileMeta?.type || "application/octet-stream",
    });
    callbacks.onReceiveFileComplete?.(index, fileMeta?.name ?? `file-${index}`, blob);
    relayRecv = { chunks: [], receivedBytes: 0, startTime: 0, fileIndex: -1 };
  });

  // Receiver: all files finished
  socket.on("relay-transfer-complete", () => {
    callbacks.onAllReceiveComplete?.();
  });

  // ═══════════════════ SWITCH TO RELAY (sender) ═══════════════════
  function switchToRelay() {
    if (transferMode === "relay") return;
    transferMode = "relay";
    clearTimeout(webrtcTimer);

    try { dc?.close(); } catch (_) {}
    try { pc.close(); } catch (_) {}

    if (role === "sender") {
      socket.emit("switch-to-relay", (res) => {
        if (res?.ok) {
          console.log("[relay] Sender switched to relay mode");
          callbacks.onConnectionState?.("relay");
          callbacks.onChannelOpen?.();
          if (pendingFiles) sendFilesViaRelay(pendingFiles);
        }
      });
    }
  }

  // ═══════════════════════ SEND FILES ═════════════════════════════
  async function sendFiles(files) {
    pendingFiles = files;

    if (transferMode === "relay") return sendFilesViaRelay(files);

    // ── WebRTC path ──
    if (!dc || dc.readyState !== "open") throw new Error("DataChannel not open");

    const fileList = Array.from(files);
    const manifest = fileList.map((f) => ({ name: f.name, size: f.size, type: f.type }));
    dc.send(JSON.stringify({ type: "manifest", files: manifest }));

    for (let fi = 0; fi < fileList.length; fi++) {
      const file = fileList[fi];
      callbacks.onSendFileStart?.(fi, file.name, file.size);

      const buffer = await file.arrayBuffer();
      const totalChunks = Math.ceil(buffer.byteLength / CHUNK_SIZE);
      dc.send(JSON.stringify({
        type: "file-start", index: fi, name: file.name,
        size: file.size, mimeType: file.type, totalChunks,
      }));

      let sentBytes = 0;
      const t0 = performance.now();

      for (let c = 0; c < totalChunks; c++) {
        const start = c * CHUNK_SIZE;
        const chunk = buffer.slice(start, Math.min(start + CHUNK_SIZE, buffer.byteLength));
        while (dc.bufferedAmount > BUFFER_THRESHOLD) await delay(20);
        dc.send(chunk);
        sentBytes += chunk.byteLength;
        const elapsed = (performance.now() - t0) / 1000;
        callbacks.onSendProgress?.(fi, sentBytes, file.size, sentBytes / elapsed, (file.size - sentBytes) / (sentBytes / elapsed));
      }

      dc.send(JSON.stringify({ type: "file-end", index: fi }));
      callbacks.onSendFileComplete?.(fi);
    }

    dc.send(JSON.stringify({ type: "transfer-complete" }));
    callbacks.onAllSendComplete?.();
  }

  // ── Relay send path ──
  async function sendFilesViaRelay(files) {
    const fileList = Array.from(files);

    // 1. Manifest
    const manifest = fileList.map((f) => ({ name: f.name, size: f.size, type: f.type }));
    socket.emit("relay-manifest", manifest);
    await delay(100); // give receiver time to process manifest

    for (let fi = 0; fi < fileList.length; fi++) {
      const file = fileList[fi];
      callbacks.onSendFileStart?.(fi, file.name, file.size);

      // 2. File-start signal (so receiver can init state)
      socket.emit("relay-file-start", {
        index: fi,
        name: file.name,
        size: file.size,
        mimeType: file.type,
      });
      await delay(50);

      const buffer = await file.arrayBuffer();
      const totalChunks = Math.ceil(buffer.byteLength / CHUNK_SIZE);
      let sentBytes = 0;
      const t0 = performance.now();

      for (let c = 0; c < totalChunks; c++) {
        const start = c * CHUNK_SIZE;
        const end = Math.min(start + CHUNK_SIZE, buffer.byteLength);
        const chunk = buffer.slice(start, end);

        // Emit and wait for server ack before sending next chunk
        await new Promise((resolve) => {
          socket.emit("relay-chunk", {
            fileIndex: fi,
            chunkIndex: c,
            totalChunks,
            data: arrayBufferToBase64(chunk),
          }, () => resolve()); // server ack callback
          // Fallback: if server doesn't ack within 5s, continue anyway
          setTimeout(resolve, 5000);
        });

        sentBytes += chunk.byteLength;
        const elapsed = (performance.now() - t0) / 1000 || 0.001;
        const speed = sentBytes / elapsed;
        callbacks.onSendProgress?.(fi, sentBytes, file.size, speed, (file.size - sentBytes) / speed);
      }

      // 3. File-end
      await new Promise((resolve) => {
        socket.emit("relay-file-complete", fi, () => resolve());
        setTimeout(resolve, 5000);
      });
      callbacks.onSendFileComplete?.(fi);
    }

    // 4. All done
    socket.emit("relay-transfer-complete");
    callbacks.onAllSendComplete?.();
  }

  // ═════════════════ WebRTC RECEIVE (unchanged logic) ═════════════
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
      const remaining = (rtcRecv.currentFile.size - rtcRecv.receivedBytes) / speed;
      callbacks.onReceiveProgress?.(rtcRecv.currentFile.index, rtcRecv.receivedBytes, rtcRecv.currentFile.size, speed, remaining);
    }
  }

  // ═══════════════════════ CLEANUP ════════════════════════════════
  function destroy() {
    clearTimeout(webrtcTimer);
    socket.off("signal", handleSignal);
    socket.off("relay-mode");
    socket.off("relay-manifest");
    socket.off("relay-file-start");
    socket.off("relay-chunk");
    socket.off("relay-file-complete");
    socket.off("relay-transfer-complete");
    try { dc?.close(); } catch (_) {}
    try { pc.close(); } catch (_) {}
  }

  return { pc, sendFiles, destroy, switchToRelay };
}

function delay(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
