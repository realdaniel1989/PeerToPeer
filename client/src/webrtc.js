/**
 * WebRTC peer-to-peer file transfer engine with server relay fallback.
 * Handles connection setup, chunked file sending with backpressure,
 * and reassembly on the receive side.
 * 
 * Transfer modes:
 * 1. WebRTC P2P (preferred) - direct browser-to-browser
 * 2. Server Relay (fallback) - chunks go through signaling server
 */

const CHUNK_SIZE = 16 * 1024; // 16 KB chunks
const BUFFER_THRESHOLD = 1024 * 1024; // 1 MB — pause sending when buffered > this
const WEBRTC_TIMEOUT = 10000; // 10 seconds to wait for WebRTC DataChannel

// Free public TURN servers for firewall traversal
const ICE_SERVERS = [
  // STUN servers for initial connection discovery
  { urls: "stun:stun.l.google.com:19302" },
  { urls: "stun:stun1.l.google.com:19302" },
  { urls: "stun:stun2.l.google.com:19302" },
  { urls: "stun:stun3.l.google.com:19302" },
  { urls: "stun:stun4.l.google.com:19302" },

  // Free public TURN servers (relay) for firewall traversal
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

export function createPeerConnection(socket, role, callbacks) {
  const pc = new RTCPeerConnection({
    iceServers: ICE_SERVERS,
    iceCandidatePoolSize: 10,
    bundlePolicy: "max-bundle",
    rtcpMuxPolicy: "require",
  });
  
  let dc = null; // DataChannel
  let transferMode = "webrtc"; // "webrtc" or "relay"
  let webrtcTimeout = null;
  let filesToSend = null;

  // ── ICE candidate relay ──
  pc.onicecandidate = (e) => {
    if (e.candidate) {
      socket.emit("signal", { type: "ice-candidate", candidate: e.candidate });
    }
  };

  pc.onconnectionstatechange = () => {
    callbacks.onConnectionState?.(pc.connectionState);
    
    // If connection fails, switch to relay
    if (pc.connectionState === "failed") {
      console.log("[webrtc] Connection failed, switching to relay");
      switchToRelay();
    }
  };

  // ── Signaling message handler ──
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

  // ── Relay mode handler (receiver) ──
  socket.on("relay-mode", () => {
    console.log("[relay] Switched to relay mode");
    transferMode = "relay";
    callbacks.onChannelOpen?.();
  });

  // ── Relay message handlers ──
  socket.on("relay-manifest", (manifest) => {
    if (transferMode === "relay") {
      callbacks.onManifest?.(manifest);
    }
  });

  socket.on("relay-chunk", (data) => {
    if (transferMode === "relay") {
      handleRelayChunk(data, callbacks);
    }
  });

  socket.on("relay-file-complete", (index) => {
    if (transferMode === "relay") {
      const blob = new Blob(relayState.chunks, { type: relayState.currentFile?.mimeType || "application/octet-stream" });
      callbacks.onReceiveFileComplete?.(index, relayState.currentFile?.name, blob);
      relayState = { currentFile: null, chunks: [], receivedBytes: 0, startTime: 0 };
    }
  });

  socket.on("relay-transfer-complete", () => {
    if (transferMode === "relay") {
      callbacks.onAllReceiveComplete?.();
    }
  });

  // ── Sender: create DataChannel + offer ──
  if (role === "sender") {
    dc = pc.createDataChannel("file-transfer", { ordered: true });
    dc.binaryType = "arraybuffer";
    dc.onopen = () => {
      clearTimeout(webrtcTimeout);
      callbacks.onChannelOpen?.();
    };
    dc.onclose = () => callbacks.onChannelClose?.();
    dc.onerror = () => {
      console.log("[webrtc] DataChannel error, switching to relay");
      switchToRelay();
    };

    // Set timeout for WebRTC connection
    webrtcTimeout = setTimeout(() => {
      if (dc.readyState !== "open") {
        console.log("[webrtc] Timeout, switching to relay");
        switchToRelay();
      }
    }, WEBRTC_TIMEOUT);

    (async () => {
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      socket.emit("signal", { type: "offer", offer });
    })();
  }

  // ── Receiver: accept DataChannel ──
  if (role === "receiver") {
    pc.ondatachannel = (e) => {
      dc = e.channel;
      dc.binaryType = "arraybuffer";
      dc.onopen = () => {
        clearTimeout(webrtcTimeout);
        callbacks.onChannelOpen?.();
      };
      dc.onclose = () => callbacks.onChannelClose?.();
      dc.onerror = () => {
        console.log("[webrtc] DataChannel error, switching to relay");
        switchToRelay();
      };
      dc.onmessage = (evt) => handleIncomingMessage(evt, callbacks);
    };

    // Set timeout for receiver too
    webrtcTimeout = setTimeout(() => {
      if (!dc || dc.readyState !== "open") {
        console.log("[webrtc] Receiver timeout, waiting for relay mode");
      }
    }, WEBRTC_TIMEOUT);
  }

  // ── Switch to relay mode ──
  function switchToRelay() {
    if (transferMode === "relay") return;
    transferMode = "relay";
    
    // Close WebRTC connection
    dc?.close();
    pc.close();
    
    if (role === "sender") {
      socket.emit("switch-to-relay", (res) => {
        if (res.ok) {
          callbacks.onChannelOpen?.();
          // If we have files queued, send them now
          if (filesToSend) {
            sendFilesViaRelay(filesToSend);
          }
        }
      });
    }
  }

  // ── Send files (chooses mode automatically) ──
  async function sendFiles(files) {
    filesToSend = files;
    
    if (transferMode === "relay") {
      return sendFilesViaRelay(files);
    }
    
    // WebRTC mode
    if (!dc || dc.readyState !== "open") {
      throw new Error("DataChannel not open");
    }

    const fileList = Array.from(files);
    const manifest = fileList.map((f) => ({ name: f.name, size: f.size, type: f.type }));
    dc.send(JSON.stringify({ type: "manifest", files: manifest }));

    for (let fi = 0; fi < fileList.length; fi++) {
      const file = fileList[fi];
      callbacks.onSendFileStart?.(fi, file.name, file.size);

      const buffer = await file.arrayBuffer();
      const totalChunks = Math.ceil(buffer.byteLength / CHUNK_SIZE);

      dc.send(JSON.stringify({
        type: "file-start",
        index: fi,
        name: file.name,
        size: file.size,
        mimeType: file.type,
        totalChunks,
      }));

      let sentBytes = 0;
      const startTime = performance.now();

      for (let c = 0; c < totalChunks; c++) {
        const start = c * CHUNK_SIZE;
        const end = Math.min(start + CHUNK_SIZE, buffer.byteLength);
        const chunk = buffer.slice(start, end);

        while (dc.bufferedAmount > BUFFER_THRESHOLD) {
          await new Promise((r) => setTimeout(r, 20));
        }

        dc.send(chunk);
        sentBytes += chunk.byteLength;

        const elapsed = (performance.now() - startTime) / 1000;
        const speed = sentBytes / elapsed;
        const remaining = (file.size - sentBytes) / speed;

        callbacks.onSendProgress?.(fi, sentBytes, file.size, speed, remaining);
      }

      dc.send(JSON.stringify({ type: "file-end", index: fi }));
      callbacks.onSendFileComplete?.(fi);
    }

    dc.send(JSON.stringify({ type: "transfer-complete" }));
    callbacks.onAllSendComplete?.();
  }

  // ── Send files via server relay ──
  async function sendFilesViaRelay(files) {
    const fileList = Array.from(files);
    
    // Send manifest
    const manifest = fileList.map((f) => ({ name: f.name, size: f.size, type: f.type }));
    socket.emit("relay-manifest", manifest);

    for (let fi = 0; fi < fileList.length; fi++) {
      const file = fileList[fi];
      callbacks.onSendFileStart?.(fi, file.name, file.size);

      const buffer = await file.arrayBuffer();
      const totalChunks = Math.ceil(buffer.byteLength / CHUNK_SIZE);
      let sentBytes = 0;
      const startTime = performance.now();

      for (let c = 0; c < totalChunks; c++) {
        const start = c * CHUNK_SIZE;
        const end = Math.min(start + CHUNK_SIZE, buffer.byteLength);
        const chunk = buffer.slice(start, end);

        // Send chunk as base64 (socket.io doesn't handle binary well in all cases)
        const chunkData = {
          fileIndex: fi,
          chunkIndex: c,
          totalChunks,
          data: arrayBufferToBase64(chunk),
        };
        
        socket.emit("relay-chunk", chunkData);
        sentBytes += chunk.byteLength;

        const elapsed = (performance.now() - startTime) / 1000;
        const speed = sentBytes / elapsed;
        const remaining = (file.size - sentBytes) / speed;

        callbacks.onSendProgress?.(fi, sentBytes, file.size, speed, remaining);

        // Small delay to prevent overwhelming the server
        await new Promise((r) => setTimeout(r, 5));
      }

      socket.emit("relay-file-complete", fi);
      callbacks.onSendFileComplete?.(fi);
    }

    socket.emit("relay-transfer-complete");
    callbacks.onAllSendComplete?.();
  }

  // ── Receive-side state machine ──
  let recvState = { currentFile: null, chunks: [], receivedBytes: 0, startTime: 0 };
  let relayState = { currentFile: null, chunks: [], receivedBytes: 0, startTime: 0 };

  function handleIncomingMessage(evt, cb) {
    if (typeof evt.data === "string") {
      const msg = JSON.parse(evt.data);

      if (msg.type === "manifest") {
        cb.onManifest?.(msg.files);
      } else if (msg.type === "file-start") {
        recvState = {
          currentFile: msg,
          chunks: [],
          receivedBytes: 0,
          startTime: performance.now(),
        };
        cb.onReceiveFileStart?.(msg.index, msg.name, msg.size);
      } else if (msg.type === "file-end") {
        const blob = new Blob(recvState.chunks, {
          type: recvState.currentFile.mimeType || "application/octet-stream",
        });
        cb.onReceiveFileComplete?.(msg.index, recvState.currentFile.name, blob);
        recvState = { currentFile: null, chunks: [], receivedBytes: 0, startTime: 0 };
      } else if (msg.type === "transfer-complete") {
        cb.onAllReceiveComplete?.();
      }
    } else {
      // Binary chunk
      recvState.chunks.push(evt.data);
      recvState.receivedBytes += evt.data.byteLength;

      const elapsed = (performance.now() - recvState.startTime) / 1000;
      const speed = recvState.receivedBytes / elapsed;
      const remaining = (recvState.currentFile.size - recvState.receivedBytes) / speed;

      cb.onReceiveProgress?.(
        recvState.currentFile.index,
        recvState.receivedBytes,
        recvState.currentFile.size,
        speed,
        remaining,
      );
    }
  }

  // ── Handle relay chunks (receiver) ──
  function handleRelayChunk(data, cb) {
    if (!relayState.currentFile || relayState.currentFile.index !== data.fileIndex) {
      // New file starting
      relayState = {
        currentFile: { index: data.fileIndex, totalChunks: data.totalChunks },
        chunks: [],
        receivedBytes: 0,
        startTime: performance.now(),
      };
    }

    // Convert base64 back to array buffer
    const chunk = base64ToArrayBuffer(data.data);
    relayState.chunks.push(chunk);
    relayState.receivedBytes += chunk.byteLength;

    // We don't have full file info in relay mode, so estimate
    const elapsed = (performance.now() - relayState.startTime) / 1000;
    const speed = relayState.receivedBytes / elapsed;

    cb.onReceiveProgress?.(
      data.fileIndex,
      relayState.receivedBytes,
      relayState.receivedBytes, // Unknown total until manifest
      speed,
      0,
    );
  }

  function destroy() {
    clearTimeout(webrtcTimeout);
    socket.off("signal", handleSignal);
    socket.off("relay-mode");
    socket.off("relay-manifest");
    socket.off("relay-chunk");
    socket.off("relay-file-complete");
    socket.off("relay-transfer-complete");
    dc?.close();
    pc.close();
  }

  return { pc, sendFiles, destroy, switchToRelay };
}

// ── Utility functions ──
function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

function base64ToArrayBuffer(base64) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes.buffer;
}
