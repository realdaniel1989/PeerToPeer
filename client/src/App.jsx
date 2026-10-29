import { useState, useRef, useCallback, useEffect } from "react";
import { io } from "socket.io-client";
import { motion, AnimatePresence } from "motion/react";
import JSZip from "jszip";
import { createPeerConnection } from "./webrtc.js";
import "./styles.css";

// ── Helpers ──
function formatBytes(b) {
  if (b === 0) return "0 B";
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB"];
  const i = Math.floor(Math.log(b) / Math.log(k));
  return (b / Math.pow(k, i)).toFixed(i > 0 ? 1 : 0) + " " + sizes[i];
}

function formatTime(sec) {
  if (!isFinite(sec) || sec < 0) return "—";
  if (sec < 60) return `${Math.ceil(sec)}s`;
  return `${Math.floor(sec / 60)}m ${Math.ceil(sec % 60)}s`;
}

function formatSpeed(bytesPerSec) {
  return formatBytes(bytesPerSec) + "/s";
}

const SIGNAL_URL =
  typeof window !== "undefined" && window.location.hostname === "localhost"
    ? "http://localhost:3001"
    : window.location.origin;

const SIZE_WARNING = 3 * 1024 * 1024 * 1024; // 3 GB

// ── Animation Config (Apple-style spring physics) ──
const springConfig = {
  type: "spring",
  stiffness: 400,
  damping: 30,
  mass: 1,
};

const springConfigGentle = {
  type: "spring",
  stiffness: 280,
  damping: 25,
  mass: 1,
};

// ── App ──
export default function App() {
  const [view, setView] = useState("home"); // home | send | receive
  const [code, setCode] = useState("");
  const [inputCode, setInputCode] = useState("");
  const [status, setStatus] = useState("idle"); // idle | waiting | connected | transferring | done | error
  const [error, setError] = useState("");
  const [files, setFiles] = useState([]);
  const [fileProgress, setFileProgress] = useState({});
  const [receivedFiles, setReceivedFiles] = useState([]);
  const [manifest, setManifest] = useState(null);
  const [currentFileIndex, setCurrentFileIndex] = useState(-1);
  const [connectionState, setConnectionState] = useState("");
  const [overallDone, setOverallDone] = useState(false);
  const [sizeWarning, setSizeWarning] = useState(false);
  const [isDragOver, setIsDragOver] = useState(false);
  const [copied, setCopied] = useState(false);
  const [zipping, setZipping] = useState(false);
  const [sendMode, setSendMode] = useState("files"); // "files" | "text"
  const [textContent, setTextContent] = useState("");
  const [receivedText, setReceivedText] = useState(null); // null | string
  const [textCopied, setTextCopied] = useState(false);
  const [reconnecting, setReconnecting] = useState(false);

  const socketRef = useRef(null);
  const peerRef = useRef(null);
  const fileInputRef = useRef(null);
  const manifestRef = useRef(null);
  // Socket handlers live for the whole session, so they read status through a ref
  const statusRef = useRef(status);
  statusRef.current = status;

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      peerRef.current?.destroy();
      socketRef.current?.disconnect();
    };
  }, []);

  const reset = () => {
    peerRef.current?.destroy();
    socketRef.current?.disconnect();
    peerRef.current = null;
    socketRef.current = null;
    setView("home");
    setCode("");
    setInputCode("");
    setStatus("idle");
    setError("");
    setFiles([]);
    setFileProgress({});
    setReceivedFiles([]);
    setManifest(null);
    manifestRef.current = null;
    setCurrentFileIndex(-1);
    setConnectionState("");
    setOverallDone(false);
    setSizeWarning(false);
    setIsDragOver(false);
    setCopied(false);
    setSendMode("files");
    setTextContent("");
    setReceivedText(null);
    setTextCopied(false);
    setReconnecting(false);
  };

  // Keep the session alive across dropped connections (proxy timeouts, network
  // blips): on reconnect we reclaim our seat in the room instead of starting over,
  // and the relay transfer resumes from the receiver's last confirmed byte.
  const attachReconnectHandlers = (socket, role, getSession) => {
    const isActive = () => statusRef.current !== "done" && statusRef.current !== "error";
    const fail = (msg) => {
      if (!isActive()) return;
      peerRef.current?.destroy();
      setReconnecting(false);
      setError(msg);
      setStatus("error");
    };

    socket.on("disconnect", () => { if (isActive()) setReconnecting(true); });
    socket.on("peer-away", () => { if (isActive()) setReconnecting(true); });
    socket.on("peer-back", () => setReconnecting(false));
    socket.on("peer-disconnected", () => fail(role === "sender" ? "Receiver disconnected." : "Sender disconnected."));

    // Returns true if this "connect" was a reconnect that has been handled
    return () => {
      const session = getSession();
      if (!session) return false;
      socket.emit("rejoin-room", { ...session, role }, (res) => {
        if (res?.error) return fail(`Connection lost: ${res.error}`);
        setReconnecting(!res.peerPresent && isActive());
      });
      return true;
    };
  };

  // ── FILE HANDLING ──
  const addFiles = useCallback((newFiles) => {
    if (!newFiles.length) return;
    const allFiles = [...files, ...newFiles];
    const hasLarge = allFiles.some((f) => f.size > SIZE_WARNING);
    if (hasLarge) setSizeWarning(true);
    setFiles(allFiles);
  }, [files]);

  const handleSelectFiles = (e) => {
    const selected = Array.from(e.target.files);
    addFiles(selected);
    e.target.value = "";
  };

  const handleDrop = useCallback((e) => {
    e.preventDefault();
    setIsDragOver(false);
    const dropped = Array.from(e.dataTransfer.files);
    addFiles(dropped);
  }, [addFiles]);

  const handleDragOver = useCallback((e) => {
    e.preventDefault();
    setIsDragOver(true);
  }, []);

  const handleDragLeave = useCallback((e) => {
    e.preventDefault();
    setIsDragOver(false);
  }, []);

  const removeFile = (index) => {
    const newFiles = files.filter((_, i) => i !== index);
    const hasLarge = newFiles.some((f) => f.size > SIZE_WARNING);
    if (!hasLarge) setSizeWarning(false);
    setFiles(newFiles);
  };

  const handleCopyCode = async () => {
    await navigator.clipboard.writeText(code);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const handleCopyText = async () => {
    try {
      await navigator.clipboard.writeText(receivedText);
    } catch {
      const ta = document.createElement("textarea");
      ta.value = receivedText;
      ta.style.position = "fixed";
      ta.style.left = "-9999px";
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      document.body.removeChild(ta);
    }
    setTextCopied(true);
    setTimeout(() => setTextCopied(false), 2000);
  };

  // ── SENDER FLOW ──
  const startSend = useCallback((fileList) => {
    const socket = io(SIGNAL_URL, { transports: ["websocket"] });
    socketRef.current = socket;
    let session = null; // { code, token } once the room exists
    const rejoin = attachReconnectHandlers(socket, "sender", () => session);

    socket.on("connect", () => {
      if (rejoin()) return;
      socket.emit("create-room", (res) => {
        if (res.code) {
          session = { code: res.code, token: res.token };
          setCode(res.code);
          setStatus("waiting");
          setView("send");
        }
      });
    });

    socket.on("peer-joined", () => {
      setStatus("connected");
      setReconnecting(false);
      peerRef.current?.destroy();

      const peer = createPeerConnection(socket, "sender", {
        onConnectionState: (s) => setConnectionState(s),
        onChannelOpen: () => {
          setStatus("transferring");
          peer.sendFiles(fileList);
        },
        onChannelClose: () => {},
        onSendFileStart: (idx) => setCurrentFileIndex(idx),
        onSendProgress: (idx, sent, total, speed, eta) => {
          setFileProgress((prev) => ({ ...prev, [idx]: { sent, total, speed, eta } }));
        },
        onSendFileComplete: (idx, size) => {
          setFileProgress((prev) => ({
            ...prev,
            [idx]: { ...prev[idx], sent: size, total: size, done: true },
          }));
        },
        onAllSendComplete: () => {
          setStatus("done");
          setOverallDone(true);
          setReconnecting(false);
        },
      });
      peerRef.current = peer;
    });

    socket.on("connect_error", () => {
      // During a session socket.io keeps retrying on its own; only the first connect is fatal
      if (session) return;
      setError("Cannot reach signaling server.");
      setStatus("error");
    });
  }, []);

  const handleStartSend = useCallback(() => {
    if (!files.length) return;
    startSend(files);
  }, [files, startSend]);

  const handleStartSendText = useCallback(() => {
    if (!textContent.trim()) return;
    const blob = new Blob([textContent], { type: "text/plain" });
    const file = new File([blob], "shared-text.txt", { type: "text/plain" });
    file._isText = true;
    startSend([file]);
  }, [textContent, startSend]);

  // ── RECEIVER FLOW ──
  const handleJoin = useCallback(() => {
    if (inputCode.length < 6) return;

    const socket = io(SIGNAL_URL, { transports: ["websocket"] });
    socketRef.current = socket;
    const roomCode = inputCode.toUpperCase().trim();
    let session = null; // { code, token } once joined
    const rejoin = attachReconnectHandlers(socket, "receiver", () => session);

    socket.on("connect", () => {
      if (rejoin()) return;
      socket.emit("join-room", roomCode, (res) => {
        if (res.error) {
          setError(res.error);
          setStatus("error");
          return;
        }
        session = { code: roomCode, token: res.token };
        setStatus("connected");
        setView("receive");

        const peer = createPeerConnection(socket, "receiver", {
          onConnectionState: (s) => setConnectionState(s),
          onChannelOpen: () => setStatus("transferring"),
          onChannelClose: () => {},
          onManifest: (m) => {
            manifestRef.current = m;
            setManifest(m);
          },
          onReceiveFileStart: (idx) => setCurrentFileIndex(idx),
          onReceiveProgress: (idx, received, total, speed, eta) => {
            setFileProgress((prev) => ({ ...prev, [idx]: { sent: received, total, speed, eta } }));
          },
          onReceiveFileComplete: async (idx, name, blob) => {
            const m = manifestRef.current;
            const isTextFile = m?.[idx]?.isText || m?.[0]?.isText;
            if (isTextFile) {
              const text = await blob.text();
              setReceivedText(text);
            }
            setReceivedFiles((prev) => [...prev, { name, blob }]);
            setFileProgress((prev) => ({
              ...prev,
              [idx]: { ...prev[idx], sent: blob.size, total: blob.size, done: true },
            }));
          },
          onAllReceiveComplete: () => {
            setStatus("done");
            setOverallDone(true);
            setReconnecting(false);
          },
        });
        peerRef.current = peer;
      });
    });

    socket.on("connect_error", () => {
      // During a session socket.io keeps retrying on its own; only the first connect is fatal
      if (session) return;
      setError("Cannot reach signaling server.");
      setStatus("error");
    });
  }, [inputCode]);

  const downloadFile = (name, blob) => {
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = name;
    a.click();
    // Delay revocation so the browser has time to initiate the download
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
  };

  const downloadAll = async () => {
    setZipping(true);
    try {
      const zip = new JSZip();
      const nameCount = {};
      receivedFiles.forEach(({ name, blob }) => {
        let finalName = name;
        if (nameCount[name]) {
          const ext = name.includes(".") ? "." + name.split(".").pop() : "";
          const base = name.includes(".") ? name.slice(0, name.lastIndexOf(".")) : name;
          finalName = `${base} (${nameCount[name]})${ext}`;
        }
        nameCount[name] = (nameCount[name] || 0) + 1;
        zip.file(finalName, blob);
      });
      const zipBlob = await zip.generateAsync({ type: "blob" });
      const url = URL.createObjectURL(zipBlob);
      const a = document.createElement("a");
      a.href = url;
      a.download = "dropp-files.zip";
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
    } finally {
      setZipping(false);
    }
  };

  // ── RENDER ──
  const badgeState = reconnecting ? "reconnecting" : connectionState;
  return (
    <div className="app">
      <div className="noise" />
      <div className="grid-bg" />

      <header className="header">
        <motion.h1
          className="logo"
          onClick={reset}
          initial={{ opacity: 0, y: -16 }}
          animate={{ opacity: 1, y: 0 }}
          transition={springConfigGentle}
          whileTap={{ scale: 0.97 }}
        >
          DROP<span className="logo-dot">.</span>
        </motion.h1>
        <motion.p
          className="tagline"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ delay: 0.2, duration: 0.5 }}
        >
          browser-to-browser · no cloud · no limits
        </motion.p>
      </header>

      <main className="main">
        <AnimatePresence mode="wait">
          {/* ── HOME ── */}
          {view === "home" && (
            <motion.div
              key="home"
              className="panel home-panel"
              initial={{ opacity: 0, y: 16 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -16 }}
              transition={springConfigGentle}
            >
              <div className="home-grid">
                {/* SEND CARD */}
                <motion.div
                  className="home-card send-card"
                  initial={{ opacity: 0, y: 20 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ ...springConfig, delay: 0.1 }}
                  whileHover={{ y: -4, transition: { duration: 0.2 } }}
                >
                  <motion.div
                    className="card-icon"
                    initial={{ scale: 0.8, opacity: 0 }}
                    animate={{ scale: 1, opacity: 1 }}
                    transition={{ ...springConfig, delay: 0.2 }}
                  >
                    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                      <polyline points="17 8 12 3 7 8" />
                      <line x1="12" y1="3" x2="12" y2="15" />
                    </svg>
                  </motion.div>
                  <motion.h2
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    transition={{ delay: 0.25 }}
                  >
                    Send
                  </motion.h2>
                  <motion.p
                    className="send-description"
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    transition={{ delay: 0.3 }}
                  >
                    {sendMode === "files" ? "Select files and get a code to share" : "Paste text and get a code to share"}
                  </motion.p>

                  {/* Mode Toggle */}
                  <motion.div
                    className="mode-toggle"
                    initial={{ opacity: 0, y: 8 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ delay: 0.32 }}
                  >
                    <button
                      className={`mode-toggle-btn ${sendMode === "files" ? "active" : ""}`}
                      onClick={() => setSendMode("files")}
                    >
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                        <polyline points="14 2 14 8 20 8" />
                      </svg>
                      Files
                    </button>
                    <button
                      className={`mode-toggle-btn ${sendMode === "text" ? "active" : ""}`}
                      onClick={() => setSendMode("text")}
                    >
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <polyline points="4 7 4 4 20 4 20 7" />
                        <line x1="9" y1="20" x2="15" y2="20" />
                        <line x1="12" y1="4" x2="12" y2="20" />
                      </svg>
                      Text
                    </button>
                  </motion.div>

                  <input
                    type="file"
                    multiple
                    ref={fileInputRef}
                    onChange={handleSelectFiles}
                    className="file-input-hidden"
                  />

                  {sendMode === "files" ? (
                    <>
                      {files.length === 0 ? (
                        <motion.div
                          className="drop-zone"
                          onDrop={handleDrop}
                          onDragOver={handleDragOver}
                          onDragLeave={handleDragLeave}
                          onClick={() => fileInputRef.current?.click()}
                          initial={{ opacity: 0 }}
                          animate={{ opacity: 1 }}
                          transition={{ delay: 0.35 }}
                          whileHover={{ borderColor: "var(--accent)" }}
                        >
                          <div className="drop-zone-icon">
                            <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                              <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                              <polyline points="14 2 14 8 20 8" />
                              <line x1="12" y1="18" x2="12" y2="12" />
                              <line x1="9" y1="15" x2="15" y2="15" />
                            </svg>
                          </div>
                          <p className="drop-zone-text">Drop files here or click to browse</p>
                          <p className="drop-zone-hint">Any file type, any size</p>
                        </motion.div>
                      ) : (
                        <motion.div
                          className="selected-files"
                          initial={{ opacity: 0 }}
                          animate={{ opacity: 1 }}
                          transition={{ delay: 0.1 }}
                        >
                          <div className="file-list-compact">
                            <AnimatePresence>
                              {files.map((f, i) => (
                                <motion.div
                                  key={f.name + i}
                                  className="file-tag"
                                  initial={{ opacity: 0, scale: 0.8 }}
                                  animate={{ opacity: 1, scale: 1 }}
                                  exit={{ opacity: 0, scale: 0.8 }}
                                  transition={springConfig}
                                >
                                  <span className="file-tag-name">{f.name}</span>
                                  <span className="file-tag-size">{formatBytes(f.size)}</span>
                                  <button
                                    className="file-tag-remove"
                                    onClick={(e) => { e.stopPropagation(); removeFile(i); }}
                                    title="Remove file"
                                  >
                                    ×
                                  </button>
                                </motion.div>
                              ))}
                            </AnimatePresence>
                          </div>
                          <div className="file-summary">
                            {files.length} file{files.length !== 1 ? "s" : ""} · {formatBytes(files.reduce((sum, f) => sum + f.size, 0))}
                          </div>
                          {sizeWarning && (
                            <motion.div
                              className="warning-badge"
                              initial={{ opacity: 0, y: -8 }}
                              animate={{ opacity: 1, y: 0 }}
                            >
                              Large files may strain browser memory
                            </motion.div>
                          )}
                          <div className="file-actions">
                            <button className="btn btn-ghost" onClick={() => fileInputRef.current?.click()}>
                              Add More
                            </button>
                            <button className="btn btn-ghost" onClick={() => { setFiles([]); setSizeWarning(false); }}>
                              Clear
                            </button>
                            <button className="btn btn-primary" onClick={handleStartSend}>
                              Get Code
                            </button>
                          </div>
                        </motion.div>
                      )}
                    </>
                  ) : (
                    <motion.div
                      className="text-send-section"
                      initial={{ opacity: 0, y: 12 }}
                      animate={{ opacity: 1, y: 0 }}
                      transition={{ delay: 0.1 }}
                    >
                      <textarea
                        className="text-input-area"
                        value={textContent}
                        onChange={(e) => setTextContent(e.target.value)}
                        placeholder="Type or paste text to share…"
                        spellCheck={false}
                      />
                      <div className="text-meta">
                        {textContent.length > 0 && (
                          <>
                            <span>{textContent.length.toLocaleString()} character{textContent.length !== 1 ? "s" : ""}</span>
                            <span>·</span>
                            <span>{textContent.split("\n").length} line{textContent.split("\n").length !== 1 ? "s" : ""}</span>
                            {textContent.length > 1_000_000 && (
                              <>
                                <span>·</span>
                                <span className="text-meta-warning">Large text — consider using file mode</span>
                              </>
                            )}
                          </>
                        )}
                      </div>
                      <button
                        className="btn btn-primary"
                        onClick={handleStartSendText}
                        disabled={!textContent.trim()}
                      >
                        Get Code
                      </button>
                    </motion.div>
                  )}
                </motion.div>

                {/* RECEIVE CARD */}
                <motion.div
                  className="home-card receive-card"
                  initial={{ opacity: 0, y: 20 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ ...springConfig, delay: 0.2 }}
                  whileHover={{ y: -4, transition: { duration: 0.2 } }}
                >
                  <motion.div
                    className="card-icon"
                    initial={{ scale: 0.8, opacity: 0 }}
                    animate={{ scale: 1, opacity: 1 }}
                    transition={{ ...springConfig, delay: 0.3 }}
                    style={{ color: "var(--cyan)" }}
                  >
                    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                      <polyline points="7 10 12 15 17 10" />
                      <line x1="12" y1="15" x2="12" y2="3" />
                    </svg>
                  </motion.div>
                  <motion.h2
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    transition={{ delay: 0.35 }}
                  >
                    Receive
                  </motion.h2>
                  <motion.p
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    transition={{ delay: 0.4 }}
                  >
                    Enter the 6-character code
                  </motion.p>
                  <motion.div
                    className="code-input-group"
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    transition={{ delay: 0.45 }}
                  >
                    <input
                      type="text"
                      maxLength={6}
                      value={inputCode}
                      onChange={(e) => setInputCode(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, ""))}
                      onKeyDown={(e) => e.key === "Enter" && handleJoin()}
                      placeholder="ABC123"
                      className="code-input"
                      spellCheck={false}
                      autoComplete="off"
                    />
                    <motion.button
                      className="btn btn-primary"
                      onClick={handleJoin}
                      disabled={inputCode.length < 6}
                      whileHover={{ scale: inputCode.length >= 6 ? 1.02 : 1 }}
                      whileTap={{ scale: inputCode.length >= 6 ? 0.98 : 1 }}
                    >
                      Connect
                    </motion.button>
                  </motion.div>
                  <AnimatePresence>
                    {error && status === "error" && view === "home" && (
                      <motion.div
                        className="error-msg"
                        initial={{ opacity: 0, y: -8 }}
                        animate={{ opacity: 1, y: 0 }}
                        exit={{ opacity: 0, y: -8 }}
                      >
                        {error}
                      </motion.div>
                    )}
                  </AnimatePresence>
                </motion.div>
              </div>

              {/* Features */}
              <motion.div
                className="features"
                initial={{ opacity: 0, y: 16 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: 0.5, duration: 0.4 }}
              >
                <div className="feature">
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
                    <path d="M7 11V7a5 5 0 0 1 10 0v4" />
                  </svg>
                  End-to-end encrypted
                </div>
                <div className="feature">
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <line x1="2" y1="12" x2="22" y2="12" />
                    <line x1="12" y1="2" x2="12" y2="22" />
                    <circle cx="12" cy="12" r="10" />
                  </svg>
                  No cloud storage
                </div>
                <div className="feature">
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2" />
                  </svg>
                  Direct P2P transfer
                </div>
                <div className="feature">
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <circle cx="12" cy="12" r="10" />
                    <line x1="4.93" y1="4.93" x2="19.07" y2="19.07" />
                  </svg>
                  No accounts needed
                </div>
              </motion.div>
            </motion.div>
          )}

          {/* ── SEND VIEW ── */}
          {view === "send" && (
            <motion.div
              key="send"
              className="panel transfer-panel"
              initial={{ opacity: 0, x: 32 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: -32 }}
              transition={springConfigGentle}
            >
              {status === "waiting" && (
                <motion.div
                  className="code-display"
                  initial={{ opacity: 0, scale: 0.95 }}
                  animate={{ opacity: 1, scale: 1 }}
                  transition={springConfig}
                >
                  <p className="code-label">Share this code</p>
                  <div className="code-big">
                    {code.split("").map((ch, i) => (
                      <motion.span
                        key={i}
                        className="code-char"
                        initial={{ opacity: 0, y: 24, rotateX: -90 }}
                        animate={{ opacity: 1, y: 0, rotateX: 0 }}
                        transition={{
                          ...springConfig,
                          delay: i * 0.08,
                        }}
                      >
                        {ch}
                      </motion.span>
                    ))}
                  </div>
                  <motion.button
                    className="btn btn-ghost copy-btn"
                    onClick={handleCopyCode}
                    whileHover={{ scale: 1.02 }}
                    whileTap={{ scale: 0.98 }}
                  >
                    {copied ? "Copied!" : "Copy Code"}
                  </motion.button>
                  <motion.div
                    className="pulse-dot"
                    initial={{ scale: 0 }}
                    animate={{ scale: 1 }}
                    transition={{ delay: 0.6 }}
                  />
                  <p className="waiting-text">Waiting for receiver…</p>
                </motion.div>
              )}

              {(status === "connected" || status === "transferring" || status === "done") && (
                <motion.div
                  className="transfer-progress"
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  transition={{ duration: 0.3 }}
                >
                  <div className="transfer-header">
                    <h2>
                      {overallDone ? (
                        <motion.span
                          initial={{ opacity: 0 }}
                          animate={{ opacity: 1 }}
                          style={{ color: "var(--accent)" }}
                        >
                          Transfer Complete
                        </motion.span>
                      ) : (
                        "Sending…"
                      )}
                    </h2>
                    {badgeState && (
                      <span className={`conn-badge conn-${badgeState}`}>
                        {badgeState}
                      </span>
                    )}
                  </div>

                  <div className="file-progress-list">
                    {files.map((f, i) => {
                      const p = fileProgress[i];
                      const pct = p ? Math.round((p.sent / p.total) * 100) : 0;
                      const isActive = i === currentFileIndex && !p?.done;
                      return (
                        <motion.div
                          key={i}
                          className={`file-progress-item ${isActive ? "active" : ""} ${p?.done ? "done" : ""}`}
                          initial={{ opacity: 0, y: 16 }}
                          animate={{ opacity: 1, y: 0 }}
                          transition={{ delay: i * 0.05 }}
                        >
                          <div className="fp-header">
                            <span className="fp-name">{f.name}</span>
                            <span className="fp-size">{formatBytes(f.size)}</span>
                          </div>
                          <div className="progress-bar-track">
                            <motion.div
                              className="progress-bar-fill"
                              initial={{ width: 0 }}
                              animate={{ width: `${pct}%` }}
                              transition={{ ease: "easeOut", duration: 0.2 }}
                            />
                          </div>
                          <div className="fp-stats">
                            <span>{pct}%</span>
                            {p && !p.done && (
                              <>
                                <span>{formatSpeed(p.speed)}</span>
                                <span>ETA {formatTime(p.eta)}</span>
                              </>
                            )}
                            {p?.done && (
                              <motion.span
                                className="done-label"
                                initial={{ opacity: 0, scale: 0.8 }}
                                animate={{ opacity: 1, scale: 1 }}
                              >
                                Sent
                              </motion.span>
                            )}
                          </div>
                        </motion.div>
                      );
                    })}
                  </div>
                </motion.div>
              )}

              {status === "error" && (
                <motion.div
                  className="error-panel"
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                >
                  <p className="error-msg">{error}</p>
                </motion.div>
              )}

              <motion.button
                className="btn btn-ghost back-btn"
                onClick={reset}
                whileHover={{ x: -4 }}
              >
                ← Back
              </motion.button>
            </motion.div>
          )}

          {/* ── RECEIVE VIEW ── */}
          {view === "receive" && (
            <motion.div
              key="receive"
              className="panel transfer-panel"
              initial={{ opacity: 0, x: 32 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: -32 }}
              transition={springConfigGentle}
            >
              <div className="transfer-progress">
                <div className="transfer-header">
                  <h2>
                    {overallDone && receivedText !== null ? (
                      <motion.span
                        initial={{ opacity: 0 }}
                        animate={{ opacity: 1 }}
                        style={{ color: "var(--accent)" }}
                      >
                        Text Received
                      </motion.span>
                    ) : overallDone ? (
                      <motion.span
                        initial={{ opacity: 0 }}
                        animate={{ opacity: 1 }}
                        style={{ color: "var(--accent)" }}
                      >
                        All Files Received
                      </motion.span>
                    ) : (
                      "Receiving…"
                    )}
                  </h2>
                  {badgeState && (
                    <span className={`conn-badge conn-${badgeState}`}>
                      {badgeState}
                    </span>
                  )}
                </div>

                {/* Text receive view */}
                {overallDone && receivedText !== null && (
                  <motion.div
                    className="text-received-section"
                    initial={{ opacity: 0, y: 16 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ delay: 0.1 }}
                  >
                    <div className="received-text-container">
                      <pre className="received-text-content">{receivedText}</pre>
                    </div>
                    <div className="text-meta">
                      <span>{receivedText.length.toLocaleString()} character{receivedText.length !== 1 ? "s" : ""}</span>
                      <span>·</span>
                      <span>{receivedText.split("\n").length} line{receivedText.split("\n").length !== 1 ? "s" : ""}</span>
                    </div>
                    <motion.button
                      className={`btn btn-primary copy-text-btn ${textCopied ? "copied" : ""}`}
                      onClick={handleCopyText}
                      whileHover={{ scale: textCopied ? 1 : 1.02 }}
                      whileTap={{ scale: textCopied ? 1 : 0.98 }}
                    >
                      {textCopied ? (
                        <>
                          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                            <polyline points="20 6 9 17 4 12" />
                          </svg>
                          Copied!
                        </>
                      ) : (
                        <>
                          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                            <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
                            <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
                          </svg>
                          Copy Text
                        </>
                      )}
                    </motion.button>
                  </motion.div>
                )}

                {/* File receive view (only shown when not a text transfer) */}
                {manifest && receivedText === null && (
                  <div className="file-progress-list">
                    {manifest.map((f, i) => {
                      const p = fileProgress[i];
                      const pct = p ? Math.round((p.sent / p.total) * 100) : 0;
                      const isActive = i === currentFileIndex && !p?.done;
                      const received = receivedFiles.find((r) => r.name === f.name);
                      return (
                        <motion.div
                          key={i}
                          className={`file-progress-item ${isActive ? "active" : ""} ${p?.done ? "done" : ""}`}
                          initial={{ opacity: 0, y: 16 }}
                          animate={{ opacity: 1, y: 0 }}
                          transition={{ delay: i * 0.05 }}
                        >
                          <div className="fp-header">
                            <span className="fp-name">{f.name}</span>
                            <span className="fp-size">{formatBytes(f.size)}</span>
                          </div>
                          <div className="progress-bar-track">
                            <motion.div
                              className="progress-bar-fill"
                              initial={{ width: 0 }}
                              animate={{ width: `${pct}%` }}
                              transition={{ ease: "easeOut", duration: 0.2 }}
                            />
                          </div>
                          <div className="fp-stats">
                            <span>{pct}%</span>
                            {p && !p.done && (
                              <>
                                <span>{formatSpeed(p.speed)}</span>
                                <span>ETA {formatTime(p.eta)}</span>
                              </>
                            )}
                            {received && (
                              <motion.button
                                className="btn btn-sm btn-download"
                                onClick={() => downloadFile(received.name, received.blob)}
                                initial={{ opacity: 0, scale: 0.8 }}
                                animate={{ opacity: 1, scale: 1 }}
                                whileHover={{ scale: 1.05 }}
                                whileTap={{ scale: 0.95 }}
                              >
                                Download
                              </motion.button>
                            )}
                          </div>
                        </motion.div>
                      );
                    })}
                  </div>
                )}

                {!manifest && status === "connected" && (
                  <motion.div
                    className="waiting-manifest"
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                  >
                    <div className="pulse-dot" />
                    <p>Connected — waiting for transfer…</p>
                  </motion.div>
                )}
              </div>

              {overallDone && receivedText === null && receivedFiles.length > 1 && (
                <motion.div
                  style={{ marginTop: "1rem", display: "flex", justifyContent: "center" }}
                  initial={{ opacity: 0, y: 16 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ delay: 0.3 }}
                >
                  <motion.button
                    className="btn btn-primary"
                    onClick={downloadAll}
                    disabled={zipping}
                    whileHover={zipping ? {} : { scale: 1.02 }}
                    whileTap={zipping ? {} : { scale: 0.98 }}
                  >
                    {zipping ? "Zipping files…" : "Download All"}
                  </motion.button>
                </motion.div>
              )}

              {status === "error" && (
                <motion.div
                  className="error-panel"
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                >
                  <p className="error-msg">{error}</p>
                </motion.div>
              )}

              <motion.button
                className="btn btn-ghost back-btn"
                onClick={reset}
                whileHover={{ x: -4 }}
              >
                ← Back
              </motion.button>
            </motion.div>
          )}
        </AnimatePresence>
      </main>

      <footer className="footer">
        <p>Files never leave your browser. Transfer is peer-to-peer over WebRTC.</p>
      </footer>
    </div>
  );
}
