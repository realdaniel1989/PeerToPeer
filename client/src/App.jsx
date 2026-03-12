import { useState, useRef, useCallback, useEffect } from "react";
import { io } from "socket.io-client";
import { motion, AnimatePresence } from "motion/react";
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

// ── App ──
export default function App() {
  const [view, setView] = useState("home"); // home | send | receive
  const [code, setCode] = useState("");
  const [inputCode, setInputCode] = useState("");
  const [status, setStatus] = useState("idle"); // idle | waiting | connected | transferring | done | error
  const [error, setError] = useState("");
  const [files, setFiles] = useState([]);
  const [fileProgress, setFileProgress] = useState({}); // { [index]: { sent, total, speed, eta } }
  const [receivedFiles, setReceivedFiles] = useState([]); // [{ name, blob }]
  const [manifest, setManifest] = useState(null);
  const [currentFileIndex, setCurrentFileIndex] = useState(-1);
  const [connectionState, setConnectionState] = useState("");
  const [overallDone, setOverallDone] = useState(false);
  const [sizeWarning, setSizeWarning] = useState(false);

  const socketRef = useRef(null);
  const peerRef = useRef(null);
  const fileInputRef = useRef(null);

  // Cleanup on unmount or view change
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
    setCurrentFileIndex(-1);
    setConnectionState("");
    setOverallDone(false);
    setSizeWarning(false);
  };

  // ── SENDER FLOW ──
  const handleSelectFiles = (e) => {
    const selected = Array.from(e.target.files);
    if (!selected.length) return;

    const hasLarge = selected.some((f) => f.size > SIZE_WARNING);
    if (hasLarge) setSizeWarning(true);

    setFiles(selected);
  };

  const handleStartSend = useCallback(() => {
    if (!files.length) return;

    const socket = io(SIGNAL_URL, { transports: ["websocket"] });
    socketRef.current = socket;

    socket.on("connect", () => {
      socket.emit("create-room", (res) => {
        if (res.code) {
          setCode(res.code);
          setStatus("waiting");
          setView("send");
        }
      });
    });

    socket.on("peer-joined", () => {
      setStatus("connected");

      const peer = createPeerConnection(socket, "sender", {
        onConnectionState: (s) => setConnectionState(s),
        onChannelOpen: () => {
          setStatus("transferring");
          peer.sendFiles(files);
        },
        onChannelClose: () => {},
        onSendFileStart: (idx, name, size) => {
          setCurrentFileIndex(idx);
        },
        onSendProgress: (idx, sent, total, speed, eta) => {
          setFileProgress((prev) => ({
            ...prev,
            [idx]: { sent, total, speed, eta },
          }));
        },
        onSendFileComplete: (idx) => {
          setFileProgress((prev) => ({
            ...prev,
            [idx]: { ...prev[idx], sent: prev[idx].total, done: true },
          }));
        },
        onAllSendComplete: () => {
          setStatus("done");
          setOverallDone(true);
        },
      });
      peerRef.current = peer;
    });

    socket.on("peer-disconnected", () => {
      if (status !== "done") {
        setError("Receiver disconnected.");
        setStatus("error");
      }
    });

    socket.on("connect_error", () => {
      setError("Cannot reach signaling server.");
      setStatus("error");
    });
  }, [files, status]);

  // ── RECEIVER FLOW ──
  const handleJoin = useCallback(() => {
    if (inputCode.length < 6) return;

    const socket = io(SIGNAL_URL, { transports: ["websocket"] });
    socketRef.current = socket;

    socket.on("connect", () => {
      socket.emit("join-room", inputCode.toUpperCase(), (res) => {
        if (res.error) {
          setError(res.error);
          setStatus("error");
          return;
        }
        setStatus("connected");
        setView("receive");

        const peer = createPeerConnection(socket, "receiver", {
          onConnectionState: (s) => setConnectionState(s),
          onChannelOpen: () => setStatus("transferring"),
          onChannelClose: () => {},
          onManifest: (m) => setManifest(m),
          onReceiveFileStart: (idx, name, size) => {
            setCurrentFileIndex(idx);
          },
          onReceiveProgress: (idx, received, total, speed, eta) => {
            setFileProgress((prev) => ({
              ...prev,
              [idx]: { sent: received, total, speed, eta },
            }));
          },
          onReceiveFileComplete: (idx, name, blob) => {
            setReceivedFiles((prev) => [...prev, { name, blob }]);
            setFileProgress((prev) => ({
              ...prev,
              [idx]: { ...prev[idx], sent: prev[idx].total, done: true },
            }));
          },
          onAllReceiveComplete: () => {
            setStatus("done");
            setOverallDone(true);
          },
        });
        peerRef.current = peer;
      });
    });

    socket.on("peer-disconnected", () => {
      if (status !== "done") {
        setError("Sender disconnected.");
        setStatus("error");
      }
    });

    socket.on("connect_error", () => {
      setError("Cannot reach signaling server.");
      setStatus("error");
    });
  }, [inputCode, status]);

  const downloadFile = (name, blob) => {
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = name;
    a.click();
    URL.revokeObjectURL(url);
  };

  // ── RENDER ──
  return (
    <div className="app">
      <div className="noise" />
      <div className="grid-bg" />

      <header className="header">
        <motion.h1
          className="logo"
          onClick={reset}
          initial={{ opacity: 0, y: -20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.5 }}
        >
          DROP<span className="logo-dot">.</span>
        </motion.h1>
        <p className="tagline">browser-to-browser · no cloud · no limits</p>
      </header>

      <main className="main">
        <AnimatePresence mode="wait">
          {/* ── HOME ── */}
          {view === "home" && (
            <motion.div
              key="home"
              className="panel home-panel"
              initial={{ opacity: 0, scale: 0.95 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.95 }}
              transition={{ duration: 0.35 }}
            >
              <div className="home-grid">
                {/* SEND */}
                <motion.div
                  className="home-card send-card"
                  whileHover={{ y: -4 }}
                  transition={{ type: "spring", stiffness: 400, damping: 25 }}
                >
                  <div className="card-icon">↑</div>
                  <h2>Send</h2>
                  <p>Select files and get a code to share</p>

                  <input
                    type="file"
                    multiple
                    ref={fileInputRef}
                    onChange={handleSelectFiles}
                    className="file-input-hidden"
                  />

                  {files.length === 0 ? (
                    <button
                      className="btn btn-primary"
                      onClick={() => fileInputRef.current?.click()}
                    >
                      Choose Files
                    </button>
                  ) : (
                    <div className="selected-files">
                      <div className="file-list-compact">
                        {files.map((f, i) => (
                          <div key={i} className="file-tag">
                            <span className="file-tag-name">{f.name}</span>
                            <span className="file-tag-size">{formatBytes(f.size)}</span>
                          </div>
                        ))}
                      </div>
                      {sizeWarning && (
                        <div className="warning-badge">
                          ⚠ File(s) over 3 GB — may strain browser memory
                        </div>
                      )}
                      <div className="file-actions">
                        <button className="btn btn-ghost" onClick={() => { setFiles([]); setSizeWarning(false); }}>
                          Clear
                        </button>
                        <button className="btn btn-primary" onClick={handleStartSend}>
                          Get Code →
                        </button>
                      </div>
                    </div>
                  )}
                </motion.div>

                {/* RECEIVE */}
                <motion.div
                  className="home-card receive-card"
                  whileHover={{ y: -4 }}
                  transition={{ type: "spring", stiffness: 400, damping: 25 }}
                >
                  <div className="card-icon">↓</div>
                  <h2>Receive</h2>
                  <p>Enter the 6-character code</p>
                  <div className="code-input-group">
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
                    <button
                      className="btn btn-primary"
                      onClick={handleJoin}
                      disabled={inputCode.length < 6}
                    >
                      Connect →
                    </button>
                  </div>
                  {error && status === "error" && view === "home" && (
                    <div className="error-msg">{error}</div>
                  )}
                </motion.div>
              </div>

              <div className="features">
                <div className="feature"><span>🔒</span> End-to-end encrypted (DTLS)</div>
                <div className="feature"><span>☁️</span> No cloud storage</div>
                <div className="feature"><span>⚡</span> Direct P2P transfer</div>
                <div className="feature"><span>🚫</span> No accounts needed</div>
              </div>
            </motion.div>
          )}

          {/* ── SEND VIEW ── */}
          {view === "send" && (
            <motion.div
              key="send"
              className="panel transfer-panel"
              initial={{ opacity: 0, x: 40 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: -40 }}
              transition={{ duration: 0.35 }}
            >
              {status === "waiting" && (
                <div className="code-display">
                  <p className="code-label">Share this code with the receiver</p>
                  <div className="code-big">
                    {code.split("").map((ch, i) => (
                      <motion.span
                        key={i}
                        className="code-char"
                        initial={{ opacity: 0, y: 20 }}
                        animate={{ opacity: 1, y: 0 }}
                        transition={{ delay: i * 0.07 }}
                      >
                        {ch}
                      </motion.span>
                    ))}
                  </div>
                  <button
                    className="btn btn-ghost copy-btn"
                    onClick={() => navigator.clipboard.writeText(code)}
                  >
                    Copy Code
                  </button>
                  <div className="pulse-dot" />
                  <p className="waiting-text">Waiting for receiver…</p>
                </div>
              )}

              {(status === "connected" || status === "transferring" || status === "done") && (
                <div className="transfer-progress">
                  <div className="transfer-header">
                    <h2>{overallDone ? "Transfer Complete ✓" : "Sending…"}</h2>
                    {connectionState && (
                      <span className={`conn-badge conn-${connectionState}`}>
                        {connectionState}
                      </span>
                    )}
                  </div>

                  <div className="file-progress-list">
                    {files.map((f, i) => {
                      const p = fileProgress[i];
                      const pct = p ? Math.round((p.sent / p.total) * 100) : 0;
                      const isActive = i === currentFileIndex && !p?.done;
                      return (
                        <div key={i} className={`file-progress-item ${isActive ? "active" : ""} ${p?.done ? "done" : ""}`}>
                          <div className="fp-header">
                            <span className="fp-name">{f.name}</span>
                            <span className="fp-size">{formatBytes(f.size)}</span>
                          </div>
                          <div className="progress-bar-track">
                            <motion.div
                              className="progress-bar-fill"
                              initial={{ width: 0 }}
                              animate={{ width: `${pct}%` }}
                              transition={{ ease: "linear", duration: 0.15 }}
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
                            {p?.done && <span className="done-label">✓ Sent</span>}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}

              {status === "error" && (
                <div className="error-panel">
                  <p className="error-msg">{error}</p>
                </div>
              )}

              <button className="btn btn-ghost back-btn" onClick={reset}>
                ← Back
              </button>
            </motion.div>
          )}

          {/* ── RECEIVE VIEW ── */}
          {view === "receive" && (
            <motion.div
              key="receive"
              className="panel transfer-panel"
              initial={{ opacity: 0, x: 40 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: -40 }}
              transition={{ duration: 0.35 }}
            >
              <div className="transfer-progress">
                <div className="transfer-header">
                  <h2>{overallDone ? "All Files Received ✓" : "Receiving…"}</h2>
                  {connectionState && (
                    <span className={`conn-badge conn-${connectionState}`}>
                      {connectionState}
                    </span>
                  )}
                </div>

                {manifest && (
                  <div className="file-progress-list">
                    {manifest.map((f, i) => {
                      const p = fileProgress[i];
                      const pct = p ? Math.round((p.sent / p.total) * 100) : 0;
                      const isActive = i === currentFileIndex && !p?.done;
                      const received = receivedFiles.find((r) => r.name === f.name);
                      return (
                        <div key={i} className={`file-progress-item ${isActive ? "active" : ""} ${p?.done ? "done" : ""}`}>
                          <div className="fp-header">
                            <span className="fp-name">{f.name}</span>
                            <span className="fp-size">{formatBytes(f.size)}</span>
                          </div>
                          <div className="progress-bar-track">
                            <motion.div
                              className="progress-bar-fill"
                              initial={{ width: 0 }}
                              animate={{ width: `${pct}%` }}
                              transition={{ ease: "linear", duration: 0.15 }}
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
                              <button
                                className="btn btn-sm btn-download"
                                onClick={() => downloadFile(received.name, received.blob)}
                              >
                                ↓ Download
                              </button>
                            )}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}

                {!manifest && status === "connected" && (
                  <div className="waiting-manifest">
                    <div className="pulse-dot" />
                    <p>Connected — waiting for file transfer to begin…</p>
                  </div>
                )}
              </div>

              {status === "error" && (
                <div className="error-panel">
                  <p className="error-msg">{error}</p>
                </div>
              )}

              <button className="btn btn-ghost back-btn" onClick={reset}>
                ← Back
              </button>
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
