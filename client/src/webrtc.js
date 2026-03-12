/**
 * WebRTC peer-to-peer file transfer engine.
 * Handles connection setup, chunked file sending with backpressure,
 * and reassembly on the receive side.
 */

const CHUNK_SIZE = 16 * 1024; // 16 KB chunks
const BUFFER_THRESHOLD = 1024 * 1024; // 1 MB — pause sending when buffered > this

const ICE_SERVERS = [
  { urls: "stun:stun.l.google.com:19302" },
  { urls: "stun:stun1.l.google.com:19302" },
  { urls: "stun:stun2.l.google.com:19302" },
];

export function createPeerConnection(socket, role, callbacks) {
  const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
  let dc = null; // DataChannel

  // ── ICE candidate relay ──
  pc.onicecandidate = (e) => {
    if (e.candidate) {
      socket.emit("signal", { type: "ice-candidate", candidate: e.candidate });
    }
  };

  pc.onconnectionstatechange = () => {
    callbacks.onConnectionState?.(pc.connectionState);
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

  // ── Sender: create DataChannel + offer ──
  if (role === "sender") {
    dc = pc.createDataChannel("file-transfer", { ordered: true });
    dc.binaryType = "arraybuffer";
    dc.onopen = () => callbacks.onChannelOpen?.();
    dc.onclose = () => callbacks.onChannelClose?.();

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
      dc.onopen = () => callbacks.onChannelOpen?.();
      dc.onclose = () => callbacks.onChannelClose?.();
      dc.onmessage = (evt) => handleIncomingMessage(evt, callbacks);
    };
  }

  // ── Send files sequentially ──
  async function sendFiles(files) {
    if (!dc || dc.readyState !== "open") {
      throw new Error("DataChannel not open");
    }

    const fileList = Array.from(files);

    // Send manifest: total count + metadata
    const manifest = fileList.map((f) => ({ name: f.name, size: f.size, type: f.type }));
    dc.send(JSON.stringify({ type: "manifest", files: manifest }));

    for (let fi = 0; fi < fileList.length; fi++) {
      const file = fileList[fi];
      callbacks.onSendFileStart?.(fi, file.name, file.size);

      // Read entire file into ArrayBuffer (browser limitation)
      const buffer = await file.arrayBuffer();
      const totalChunks = Math.ceil(buffer.byteLength / CHUNK_SIZE);

      // Send file header
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

        // Backpressure: wait if buffer is full
        while (dc.bufferedAmount > BUFFER_THRESHOLD) {
          await new Promise((r) => setTimeout(r, 20));
        }

        dc.send(chunk);
        sentBytes += chunk.byteLength;

        const elapsed = (performance.now() - startTime) / 1000;
        const speed = sentBytes / elapsed; // bytes/sec
        const remaining = (file.size - sentBytes) / speed;

        callbacks.onSendProgress?.(fi, sentBytes, file.size, speed, remaining);
      }

      dc.send(JSON.stringify({ type: "file-end", index: fi }));
      callbacks.onSendFileComplete?.(fi);
    }

    dc.send(JSON.stringify({ type: "transfer-complete" }));
    callbacks.onAllSendComplete?.();
  }

  // ── Receive-side state machine ──
  let recvState = { currentFile: null, chunks: [], receivedBytes: 0, startTime: 0 };

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

  function destroy() {
    socket.off("signal", handleSignal);
    dc?.close();
    pc.close();
  }

  return { pc, sendFiles, destroy };
}
