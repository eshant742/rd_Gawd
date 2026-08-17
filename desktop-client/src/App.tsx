import { useEffect, useRef, useState, useCallback } from "react";
import { io, Socket } from "socket.io-client";
import { Key, MonitorPlay, XCircle, Copy, Check, Loader2, WifiOff, Wifi, Lock } from "lucide-react";

// ─── LOW-LATENCY ICE CONFIG ───
// Prioritize direct P2P, keep only UDP TURN as fallback, remove TCP TURN (head-of-line blocking)
const iceServers: RTCConfiguration = {
  iceServers: [
    { urls: "stun:stun.l.google.com:19302" },
    { urls: "stun:stun1.l.google.com:19302" },
    {
      urls: "turn:openrelay.metered.ca:80",
      username: "openrelayproject",
      credential: "openrelayproject"
    },
    {
      urls: "turn:openrelay.metered.ca:443",
      username: "openrelayproject",
      credential: "openrelayproject"
    }
  ],
  iceCandidatePoolSize: 10,
  iceTransportPolicy: 'all',     // Prefer direct P2P, TURN only as fallback
  bundlePolicy: 'max-bundle',    // Bundle all media into single transport (fewer round trips)
  rtcpMuxPolicy: 'require',      // Multiplex RTCP with RTP on same port
};

// Connection timeout in milliseconds
const CONNECTION_TIMEOUT = 20000;

function App() {
  const [myId, setMyId] = useState<string>("");
  const [targetId, setTargetId] = useState<string>("");
  const [status, setStatus] = useState<"disconnected" | "connecting" | "connected">("disconnected");
  const [appMode, setAppMode] = useState<"host" | "viewer" | null>(null);
  const [errorMsg, setErrorMsg] = useState("");
  const [copied, setCopied] = useState(false);
  const [signalingConnected, setSignalingConnected] = useState(false);
  const [isControlEnabled, setIsControlEnabled] = useState(true);

  const socketRef = useRef<Socket | null>(null);
  const peerConnection = useRef<RTCPeerConnection | null>(null);
  const dataChannel = useRef<RTCDataChannel | null>(null);
  const remoteVideoRef = useRef<HTMLVideoElement>(null);
  const remoteStreamRef = useRef<MediaStream | null>(null);
  const localStream = useRef<MediaStream | null>(null);
  const connectionTimeout = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingCandidatesRef = useRef<RTCIceCandidateInit[]>([]);
  const modeRef = useRef<string>("viewer");
  const myIdRef = useRef<string>("");
  const lastMouseTime = useRef<number>(0);

  const cleanupSession = useCallback(() => {
    // Clear connection timeout
    if (connectionTimeout.current) {
      clearTimeout(connectionTimeout.current);
      connectionTimeout.current = null;
    }

    if (localStream.current) {
      localStream.current.getTracks().forEach(t => t.stop());
      localStream.current = null;
    }
    if (peerConnection.current) {
      peerConnection.current.close();
      peerConnection.current = null;
    }
    if (dataChannel.current) {
      dataChannel.current.close();
      dataChannel.current = null;
    }
    if (remoteVideoRef.current) {
      remoteVideoRef.current.srcObject = null;
    }
    remoteStreamRef.current = null;
    
    pendingCandidatesRef.current = [];
    setStatus("disconnected");
  }, []);

  const handleRemoteCommand = useCallback((cmd: any) => {
    // @ts-ignore
    if (!window.electronAPI) return;
    try {
      if (cmd.type === "mousemove") {
        // @ts-ignore
        window.electronAPI.mouseMove(cmd.x, cmd.y);
      } else if (cmd.type === "mousedown") {
        // @ts-ignore
        window.electronAPI.mouseDown(cmd.button);
      } else if (cmd.type === "mouseup") {
        // @ts-ignore
        window.electronAPI.mouseUp(cmd.button);
      } else if (cmd.type === "keydown") {
        // @ts-ignore
        window.electronAPI.keyDown(cmd.key);
      } else if (cmd.type === "keyup") {
        // @ts-ignore
        window.electronAPI.keyUp(cmd.key);
      } else if (cmd.type === "scroll") {
        // @ts-ignore
        window.electronAPI.scrollWheel(cmd.deltaX, cmd.deltaY);
      } else if (cmd.type === "special_key") {
        // @ts-ignore
        window.electronAPI.specialKey(cmd.command);
      }
    } catch (e) {
      console.error("Failed to execute command", e);
    }
  }, []);

  const setupPeerConnection = useCallback(async (sock: Socket, target: string, asHost: boolean) => {
    // Clean up any existing peer connection first
    if (peerConnection.current) {
      peerConnection.current.close();
      peerConnection.current = null;
    }

    const pc = new RTCPeerConnection(iceServers);
    peerConnection.current = pc;

    pc.ontrack = (event) => {
      console.log("Received remote track:", event.track.kind);
      
      // ─── AGGRESSIVE JITTER BUFFER ELIMINATION ───
      // Apply BOTH APIs to maximize chance of zero buffering
      if (event.receiver) {
        // playoutDelayHint: tells browser our desired playout delay in seconds (0 = instant)
        if ('playoutDelayHint' in event.receiver) {
          // @ts-ignore
          event.receiver.playoutDelayHint = 0;
        }
        // jitterBufferTarget: standard API to set target jitter buffer duration in ms (0 = minimal)
        if ('jitterBufferTarget' in event.receiver) {
          // @ts-ignore
          event.receiver.jitterBufferTarget = 0;
        }
      }

      if (event.track) {
        // Create a new stream from the track if event.streams is empty or reliable
        const stream = (event.streams && event.streams[0]) ? event.streams[0] : new MediaStream([event.track]);
        
        // Save the stream in a ref because the <video> element might not be mounted yet!
        // (It only mounts when ICE state becomes "connected")
        remoteStreamRef.current = stream;
        
        // If it IS mounted, set it immediately
        if (remoteVideoRef.current && remoteVideoRef.current.srcObject !== stream) {
          console.log("Setting remote video stream to video element immediately");
          remoteVideoRef.current.srcObject = stream;
        }
      }
    };

    pc.onicecandidate = (event) => {
      if (event.candidate) {
        sock.emit("ice-candidate", {
          target: target,
          candidate: event.candidate.toJSON(),
        });
      }
    };

    pc.oniceconnectionstatechange = () => {
      console.log("ICE connection state:", pc.iceConnectionState);
      if (pc.iceConnectionState === "connected" || pc.iceConnectionState === "completed") {
        // Clear the connection timeout — we're connected!
        if (connectionTimeout.current) {
          clearTimeout(connectionTimeout.current);
          connectionTimeout.current = null;
        }
        
        // ─── RE-ENFORCE ZERO JITTER BUFFER on all receivers once connected ───
        try {
          const receivers = pc.getReceivers();
          receivers.forEach(r => {
            if ('playoutDelayHint' in r) { (r as any).playoutDelayHint = 0; }
            if ('jitterBufferTarget' in r) { (r as any).jitterBufferTarget = 0; }
          });
        } catch (e) {
          console.warn("Could not re-enforce zero jitter buffer:", e);
        }
        
        setStatus("connected");
      } else if (pc.iceConnectionState === "failed") {
        console.error("ICE connection failed");
        setErrorMsg("Connection failed. The remote peer may be behind a strict firewall.");
        cleanupSession();
      } else if (pc.iceConnectionState === "disconnected") {
        console.warn("ICE disconnected — waiting for reconnection...");
        // Give it a few seconds to reconnect before cleaning up
        setTimeout(() => {
          if (pc.iceConnectionState === "disconnected" || pc.iceConnectionState === "failed") {
            console.error("ICE did not reconnect, cleaning up.");
            cleanupSession();
          }
        }, 5000);
      }
    };

    pc.onconnectionstatechange = () => {
      console.log("Connection state:", pc.connectionState);
      if (pc.connectionState === "failed") {
        setErrorMsg("Peer connection failed.");
        cleanupSession();
      }
    };

    if (asHost) {
      try {
        // @ts-ignore
        const sources = await window.electronAPI.getSources();
        
        if (!sources || sources.length === 0) {
          throw new Error("No screen sources found. Make sure screen recording permissions are granted.");
        }
        
        const primaryScreen = sources.find((s: any) => s.id.startsWith('screen')) || sources[0];
        console.log("Capturing screen:", primaryScreen.name, primaryScreen.id);
        
        const stream = await navigator.mediaDevices.getUserMedia({
          audio: false,
          video: {
            mandatory: {
              chromeMediaSource: 'desktop',
              chromeMediaSourceId: primaryScreen.id,
              maxWidth: 1920,
              maxHeight: 1080,
              maxFrameRate: 60
            }
          } as any
        });
        
        localStream.current = stream;
        
        // Verify we actually have video tracks
        const videoTracks = stream.getVideoTracks();
        if (videoTracks.length === 0) {
          throw new Error("No video tracks in captured stream");
        }
        console.log("Captured video track:", videoTracks[0].label, "enabled:", videoTracks[0].enabled);
        
        // Hint the encoder to prioritize sharpness of text/UI
        videoTracks.forEach(track => {
          if ('contentHint' in track) {
            track.contentHint = 'detail';
          }
        });
        
        stream.getTracks().forEach((track) => {
          pc.addTrack(track, stream);
        });

        // Set encoding parameters for better quality
        const senders = pc.getSenders();
        for (const sender of senders) {
          if (sender.track?.kind === 'video') {
            const params = sender.getParameters();
            if (!params.encodings || params.encodings.length === 0) {
              params.encodings = [{}];
            }
            params.encodings[0].maxBitrate = 8000000; // 8 Mbps — sweet spot for 1080p60 without network congestion
            params.encodings[0].maxFramerate = 60;
            // @ts-ignore
            params.degradationPreference = 'maintain-resolution'; // Drop frames instead of blurring the screen
            try {
              await sender.setParameters(params);
            } catch (e) {
              console.warn("Could not set encoding params:", e);
            }
          }
        }

        pc.ondatachannel = (event) => {
          const channel = event.channel;
          channel.onmessage = (e) => {
            try {
              const cmd = JSON.parse(e.data);
              handleRemoteCommand(cmd);
            } catch (err) {
              console.error("Error parsing command", err);
            }
          };
          channel.onopen = () => console.log("Data channel opened (host side)");
          channel.onclose = () => console.log("Data channel closed (host side)");
        };
      } catch (err) {
        console.error("Error getting display media", err);
        throw err;
      }
    } else {
      // Viewer side — the shared ontrack handler at line 118 already saves
      // the stream to remoteStreamRef, which is attached when the <video> mounts.
      // Do NOT overwrite pc.ontrack here.

      const dc = pc.createDataChannel("control", {
        ordered: false,
        maxRetransmits: 0
      });
      dataChannel.current = dc;
      
      dc.onopen = () => console.log("Data channel opened (viewer side)");
      dc.onclose = () => console.log("Data channel closed (viewer side)");
      dc.onerror = (err) => console.error("Data channel error:", err);
    }

    return pc;
  }, [cleanupSession, handleRemoteCommand]);

  useEffect(() => {
    let isMounted = true;

    async function initMode() {
      let mode = 'viewer'; // Default to viewer if no Electron

      // Connect to signaling server with reconnection
      const signalingUrl = import.meta.env.VITE_SIGNALING_URL || "http://localhost:3001";
      const newSocket = io(signalingUrl, {
        reconnection: true,
        reconnectionAttempts: Infinity,
        reconnectionDelay: 1000,
        reconnectionDelayMax: 5000,
        timeout: 30000,
        transports: ['websocket', 'polling'],  // WebSocket first — faster initial connection
      });
      
      socketRef.current = newSocket;

      newSocket.on("connect", () => {
        console.log("Connected to signaling server, socket id:", newSocket.id);
        if (isMounted) setSignalingConnected(true);
        
        // Re-join room on reconnect (important!)
        // Use myIdRef instead of myId to avoid stale closure
        if (modeRef.current === 'host' && myIdRef.current) {
          newSocket.emit('join-room', myIdRef.current);
        }
      });

      newSocket.on("disconnect", (reason) => {
        console.warn("Disconnected from signaling server:", reason);
        if (isMounted) setSignalingConnected(false);
      });

      newSocket.on("connect_error", (err) => {
        console.error("Signaling connection error:", err.message);
        if (isMounted) setSignalingConnected(false);
      });

      // @ts-ignore
      if (window.electronAPI) {
        // @ts-ignore
        mode = await window.electronAPI.getMode();
        modeRef.current = mode;
        if (isMounted) setAppMode(mode as "host" | "viewer");
        
        if (mode === 'host') {
          // @ts-ignore
          const permId = await window.electronAPI.getPermanentId();
          if (isMounted) {
            setMyId(permId);
            myIdRef.current = permId;
          }
          newSocket.emit('join-room', permId); // Host registers their permanent ID as a room
        }
      } else {
        modeRef.current = 'viewer';
        if (isMounted) setAppMode('viewer');
      }

      // Handle incoming offer (host receives this)
      newSocket.on("offer", async (data: { sender: string; offer: RTCSessionDescriptionInit }) => {
        console.log("Received offer from", data.sender);
        if (modeRef.current === 'viewer') return; // Viewers don't accept offers

        if (isMounted) setStatus("connecting");
        try {
          const pc = await setupPeerConnection(newSocket, data.sender, true);
          await pc.setRemoteDescription(new RTCSessionDescription(data.offer));
          
          // Add any queued candidates
          while (pendingCandidatesRef.current.length > 0) {
            const candidate = pendingCandidatesRef.current.shift();
            if (candidate) {
              try {
                await pc.addIceCandidate(new RTCIceCandidate(candidate));
              } catch (e) {
                console.error("Error adding queued ice candidate on host", e);
              }
            }
          }
          
          const answer = await pc.createAnswer();
          await pc.setLocalDescription(answer);
          
          newSocket.emit("answer", {
            target: data.sender,
            answer: answer
          });
        } catch (err) {
          console.error("Failed to handle offer", err);
          cleanupSession();
        }
      });

      // Handle incoming answer (viewer receives this)
      newSocket.on("answer", async (data: { sender: string; answer: RTCSessionDescriptionInit }) => {
        console.log("Received answer from", data.sender);
        try {
          await peerConnection.current?.setRemoteDescription(new RTCSessionDescription(data.answer));
          
          // Add any queued candidates
          while (pendingCandidatesRef.current.length > 0) {
            const candidate = pendingCandidatesRef.current.shift();
            if (candidate) {
              try {
                await peerConnection.current?.addIceCandidate(new RTCIceCandidate(candidate));
              } catch (e) {
                console.error("Error adding queued ice candidate", e);
              }
            }
          }
        } catch (err) {
          console.error("Error setting remote description from answer:", err);
        }
      });

      // Handle ICE candidates
      newSocket.on("ice-candidate", async (data: { sender: string; candidate: RTCIceCandidateInit }) => {
        if (!peerConnection.current || !peerConnection.current.remoteDescription) {
          console.log("Queueing ICE candidate because remote description is not set yet");
          pendingCandidatesRef.current.push(data.candidate);
          return;
        }
        try {
          await peerConnection.current.addIceCandidate(new RTCIceCandidate(data.candidate));
        } catch (e) {
          console.error("Error adding ice candidate", e);
        }
      });

      // Handle peer disconnection notification from server
      newSocket.on("user-left", (userId: string) => {
        console.log("Remote user left:", userId);
        if (peerConnection.current) {
          cleanupSession();
        }
      });
    }

    initMode();

    // Listen for Panic Key toggles (Host Mode)
    // @ts-ignore
    if (window.electronAPI && window.electronAPI.onControlStateChanged) {
      // @ts-ignore
      window.electronAPI.onControlStateChanged((enabled: boolean) => {
        setIsControlEnabled(enabled);
      });
    }

    return () => {
      isMounted = false;
      if (socketRef.current) {
        socketRef.current.disconnect();
        socketRef.current = null;
      }
      if (connectionTimeout.current) {
        clearTimeout(connectionTimeout.current);
      }
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const connectToPeer = async () => {
    if (!socketRef.current || !targetId) return;
    
    setStatus("connecting");
    setErrorMsg("");
    
    try {
      const pc = await setupPeerConnection(socketRef.current, targetId, false);
      
      // CRITICAL FIX: The viewer must explicitly tell WebRTC it wants to receive video.
      // Otherwise, the created offer has no media sections, and the Host's video track is ignored!
      pc.addTransceiver('video', { direction: 'recvonly' });
      
      // ─── FORCE H.264 HARDWARE CODEC ───
      // H.264 is hardware-accelerated via NVENC (NVIDIA), QuickSync (Intel), AMF (AMD)
      // VP8/VP9 are almost always software-encoded = higher latency
      try {
        const transceivers = pc.getTransceivers();
        const videoTransceiver = transceivers.find(t => {
          const recvTrack = t.receiver?.track;
          return recvTrack?.kind === 'video' || t.sender?.track?.kind === 'video';
        }) || transceivers[transceivers.length - 1];
        
        if (videoTransceiver) {
          const codecs = RTCRtpReceiver.getCapabilities('video')?.codecs || [];
          const h264Codecs = codecs.filter(c => c.mimeType === 'video/H264');
          const otherCodecs = codecs.filter(c => c.mimeType !== 'video/H264');
          if (h264Codecs.length > 0) {
            videoTransceiver.setCodecPreferences([...h264Codecs, ...otherCodecs]);
            console.log(`[Codec] Forced H.264 priority (${h264Codecs.length} H.264 profiles available)`);
          } else {
            console.warn('[Codec] No H.264 codecs available — falling back to default');
          }
        }
      } catch (e) {
        console.warn('[Codec] Could not set H.264 preference:', e);
      }
      
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      
      socketRef.current.emit("offer", {
        target: targetId,
        offer: offer
      });
      
      // Set a connection timeout
      // Check ICE state via ref instead of stale `status` closure
      connectionTimeout.current = setTimeout(() => {
        if (peerConnection.current && peerConnection.current.iceConnectionState !== "connected" && peerConnection.current.iceConnectionState !== "completed") {
          console.error("Connection timed out");
          setErrorMsg("Connection timed out. Make sure the host is online and the ID is correct.");
          cleanupSession();
        }
      }, CONNECTION_TIMEOUT);
      
    } catch (err) {
      console.error("Connection failed", err);
      setErrorMsg("Failed to connect. Please try again.");
      cleanupSession();
    }
  };

  const sendControl = useCallback((cmd: any) => {
    if (dataChannel.current && dataChannel.current.readyState === "open") {
      dataChannel.current.send(JSON.stringify(cmd));
    }
  }, []);

  // Convert mouse position from video element to host screen coordinates,
  // accounting for object-contain letterboxing/pillarboxing
  const getHostCoords = useCallback((e: React.MouseEvent<HTMLVideoElement>): {x: number, y: number} | null => {
    const video = remoteVideoRef.current;
    if (!video) return null;
    const rect = video.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0 || video.videoWidth === 0 || video.videoHeight === 0) return null;

    // Calculate actual rendered video dimensions inside the element (object-contain)
    const videoAspect = video.videoWidth / video.videoHeight;
    const elementAspect = rect.width / rect.height;
    let renderedW: number, renderedH: number, offsetX: number, offsetY: number;

    if (videoAspect > elementAspect) {
      // Video wider → fits width, letterboxed top/bottom
      renderedW = rect.width;
      renderedH = rect.width / videoAspect;
      offsetX = 0;
      offsetY = (rect.height - renderedH) / 2;
    } else {
      // Video taller → fits height, pillarboxed left/right
      renderedH = rect.height;
      renderedW = rect.height * videoAspect;
      offsetX = (rect.width - renderedW) / 2;
      offsetY = 0;
    }

    const relX = e.clientX - rect.left - offsetX;
    const relY = e.clientY - rect.top - offsetY;

    // Ignore clicks on the black bars
    if (relX < 0 || relX > renderedW || relY < 0 || relY > renderedH) return null;

    return {
      x: Math.round((relX / renderedW) * video.videoWidth),
      y: Math.round((relY / renderedH) * video.videoHeight)
    };
  }, []);

  const handleMouseMove = useCallback((e: React.MouseEvent<HTMLVideoElement>) => {
    const coords = getHostCoords(e);
    if (!coords) return;

    // ─── DIRECT ULTRA-LOW LATENCY SEND ───
    // Instead of waiting for requestAnimationFrame (which adds up to 16ms of delay),
    // we send the coordinates instantly. We cap it at 4ms (250Hz) to prevent
    // absolutely flooding the network, while keeping the feeling of 0ms latency.
    const now = performance.now();
    if (now - lastMouseTime.current >= 4) {
      sendControl({ type: "mousemove", ...coords });
      lastMouseTime.current = now;
    }
  }, [getHostCoords, sendControl]);

  const handleMouseClick = useCallback((e: React.MouseEvent<HTMLVideoElement>, type: "down" | "up") => {
    const coords = getHostCoords(e);
    if (coords) {
      // Send position synchronously to guarantee it arrives before the click
      sendControl({ type: "mousemove", ...coords });
    }
    let button = "left";
    if (e.button === 1) button = "middle";
    if (e.button === 2) button = "right";
    sendControl({ type: "mouse" + type, button });
  }, [getHostCoords, sendControl]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    e.preventDefault();
    sendControl({ type: "keydown", key: e.key });
  }, [sendControl]);

  const handleKeyUp = useCallback((e: React.KeyboardEvent) => {
    e.preventDefault();
    sendControl({ type: "keyup", key: e.key });
  }, [sendControl]);

  const handleWheel = useCallback((e: WheelEvent) => {
    e.preventDefault();
    sendControl({ type: "scroll", deltaX: e.deltaX, deltaY: e.deltaY });
  }, [sendControl]);

  const copyId = useCallback(() => {
    if (myId) {
      navigator.clipboard.writeText(myId).then(() => {
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
      }).catch(() => {
        // Fallback: select text
      });
    }
  }, [myId]);

  // Attach stream when video element mounts (must be before conditional returns per Rules of Hooks)
  useEffect(() => {
    if (status === "connected" && appMode === "viewer" && remoteVideoRef.current && remoteStreamRef.current) {
      if (remoteVideoRef.current.srcObject !== remoteStreamRef.current) {
        console.log("Setting remote video stream to video element on mount");
        remoteVideoRef.current.srcObject = remoteStreamRef.current;
        remoteVideoRef.current.play().catch(err => {
          console.warn("Auto-play on mount failed:", err);
        });
      }
    }
  }, [status, appMode]);

  // Attach non-passive wheel listener to prevent scrolling while controlling remote desktop
  useEffect(() => {
    const videoEl = remoteVideoRef.current;
    if (status === "connected" && appMode === "viewer" && videoEl) {
      videoEl.addEventListener('wheel', handleWheel, { passive: false });
      return () => {
        videoEl.removeEventListener('wheel', handleWheel);
      };
    }
  }, [status, appMode, handleWheel]);

  // ─── LATENCY MONITOR: requestVideoFrameCallback ───
  // Measures actual glass-to-glass frame delivery latency for debugging
  useEffect(() => {
    const video = remoteVideoRef.current;
    if (!video || status !== 'connected' || appMode !== 'viewer') return;
    
    let frameCount = 0;
    let active = true;
    
    const callback = (now: number, metadata: any) => {
      if (!active) return;
      frameCount++;
      // Log every 300th frame (~5 seconds at 60fps) to avoid console spam
      if (frameCount % 300 === 0 && metadata.captureTime) {
        const deliveryLatency = now - metadata.captureTime;
        console.log(`[Latency Monitor] Frame #${frameCount} delivery: ${deliveryLatency.toFixed(1)}ms`);
      }
      if (active) {
        video.requestVideoFrameCallback(callback);
      }
    };
    
    if ('requestVideoFrameCallback' in video) {
      (video as any).requestVideoFrameCallback(callback);
      console.log('[Latency Monitor] Frame callback registered — will report every ~5s');
    }
    
    return () => { active = false; };
  }, [status, appMode]);

  // ──── HOST VIEW ────
  if (appMode === 'host') {
    return (
      <div className="w-screen h-screen bg-black text-white flex flex-col items-center justify-center p-8">
        <div className="absolute top-[-10%] left-[-10%] w-[40%] h-[40%] bg-primary/20 rounded-full blur-[120px] pointer-events-none"></div>
        <div className="absolute bottom-[-10%] right-[-10%] w-[40%] h-[40%] bg-purple-500/20 rounded-full blur-[120px] pointer-events-none"></div>
        
        <h1 className="text-3xl font-bold mb-4 text-primary relative z-10">Omniscreen Host</h1>
        <p className="text-xl mb-8 text-slate-300 relative z-10">Running invisibly in the system tray.</p>
        
        <div className="glass-panel p-6 rounded-xl relative z-10">
          <p className="text-slate-400 mb-2">Your Permanent ID (also saved on Desktop):</p>
          <div className="flex items-center gap-3">
            <p className="text-4xl font-mono tracking-widest font-bold text-white selection:bg-primary/30">
              {myId || "Generating..."}
            </p>
            <button
              onClick={copyId}
              className="p-2 rounded-lg bg-slate-700/50 hover:bg-slate-600 transition-colors"
              title="Copy ID"
            >
              {copied ? <Check size={20} className="text-green-400" /> : <Copy size={20} className="text-slate-400" />}
            </button>
          </div>
        </div>
        
        <div className="flex items-center gap-2 mt-6 relative z-10">
          {signalingConnected ? (
            <><Wifi size={16} className="text-green-400" /><span className="text-sm text-green-400">Server connected</span></>
          ) : (
            <><WifiOff size={16} className="text-red-400" /><span className="text-sm text-red-400">Server disconnected — reconnecting...</span></>
          )}
        </div>
        
        {!isControlEnabled && (
          <div className="bg-red-500/20 text-red-400 border border-red-500/50 px-4 py-2 rounded-lg mt-4 font-bold flex items-center gap-2 relative z-10 animate-pulse">
            <XCircle size={18} />
            Remote Control Disabled (Ctrl+Alt+X)
          </div>
        )}
        
        <p className="text-sm text-slate-500 mt-8 relative z-10">You can close this window. The host will stay active in the tray.</p>
      </div>
    );
  }

  // ──── VIEWER - CONNECTED VIEW ────
  if (status === "connected" && appMode === "viewer") {
    return (
      <div
        className="w-screen h-screen bg-black flex flex-col relative"
        tabIndex={0}
        onKeyDown={handleKeyDown}
        onKeyUp={handleKeyUp}
      >
        <div className="absolute top-0 left-1/2 -translate-x-1/2 z-50 glass-panel px-6 py-2 rounded-b-xl flex gap-4 items-center opacity-0 hover:opacity-100 transition-opacity duration-300">
           <span className="text-sm font-medium text-white mr-4">Viewing Remote Desk</span>
           
           <button 
             onClick={() => sendControl({ type: "special_key", command: "lock" })}
             className="bg-slate-700/50 hover:bg-slate-600 text-white text-sm px-3 py-1.5 rounded-lg flex items-center gap-2 transition-colors"
             title="Send Win+L (Lock Remote PC)"
           >
             <Lock size={14} />
             Lock Host
           </button>

           <button onClick={cleanupSession} className="bg-red-500/20 text-red-400 hover:bg-red-500 hover:text-white p-2 rounded-full transition-colors ml-2" title="Disconnect">
             <XCircle size={20} />
           </button>
        </div>

        <video
          ref={remoteVideoRef}
          autoPlay
          playsInline
          muted
          disablePictureInPicture
          disableRemotePlayback
          onLoadedMetadata={() => {
            // Force play as a fallback for autoplay blocking
            remoteVideoRef.current?.play().catch(err => {
              console.warn("Play on metadata failed:", err);
            });
          }}
          onMouseMove={handleMouseMove}
          onMouseDown={(e) => handleMouseClick(e, "down")}
          onMouseUp={(e) => handleMouseClick(e, "up")}
          onContextMenu={(e) => e.preventDefault()}
          className="w-full h-full object-contain cursor-none"
          style={{ background: '#000', willChange: 'transform' }}  // GPU compositor layer promotion
        />
      </div>
    );
  }

  // ──── VIEWER - CONNECT FORM ────
  return (
    <div className="min-h-screen bg-background flex flex-col items-center justify-center p-6 relative">
      <div className="absolute top-[-10%] left-[-10%] w-[40%] h-[40%] bg-primary/20 rounded-full blur-[120px] pointer-events-none"></div>
      <div className="absolute bottom-[-10%] right-[-10%] w-[40%] h-[40%] bg-purple-500/20 rounded-full blur-[120px] pointer-events-none"></div>

      <div className="glass-panel rounded-2xl shadow-2xl p-8 w-full max-w-md relative z-10 flex flex-col">
          <div className="flex items-center justify-center gap-3 mb-8">
            <MonitorPlay className="text-primary" size={32} />
            <h2 className="text-3xl font-bold text-white">Connect</h2>
          </div>
          
          {/* Signaling server status */}
          <div className="flex items-center justify-center gap-2 mb-4">
            {signalingConnected ? (
              <><Wifi size={14} className="text-green-400" /><span className="text-xs text-green-400">Server connected</span></>
            ) : (
              <><WifiOff size={14} className="text-red-400" /><span className="text-xs text-red-400">Connecting to server...</span></>
            )}
          </div>
          
          <div className="bg-surface rounded-xl p-6 border border-slate-700/50 flex flex-col justify-center">
             <p className="text-secondary text-sm font-medium mb-3 text-center">Enter the Remote Desk ID</p>
             <div className="relative mb-6">
               <div className="absolute inset-y-0 left-0 pl-4 flex items-center pointer-events-none">
                 <Key size={20} className="text-slate-400" />
               </div>
               <input 
                 id="remote-id-input"
                 type="text" 
                 value={targetId}
                 onChange={(e) => {
                   setTargetId(e.target.value);
                   setErrorMsg("");
                 }}
                 className="w-full bg-slate-900/50 border-2 border-slate-600 rounded-lg py-4 pl-12 pr-4 text-white text-xl tracking-widest text-center focus:outline-none focus:ring-2 focus:ring-primary focus:border-transparent transition-all font-mono"
                 placeholder="123456789"
                 maxLength={9}
                 onKeyDown={(e) => {
                   if (e.key === 'Enter' && targetId.length >= 5 && status !== "connecting") {
                     connectToPeer();
                   }
                 }}
               />
             </div>
             
             {errorMsg && <p className="text-red-400 text-sm mb-4 text-center animate-pulse">{errorMsg}</p>}

             <button 
                id="connect-button"
                onClick={connectToPeer}
                disabled={status === "connecting" || targetId.length < 5 || !signalingConnected}
                className="w-full bg-primary hover:bg-blue-600 disabled:bg-slate-700 disabled:text-slate-400 text-white font-semibold py-4 rounded-lg shadow-lg hover:shadow-primary/20 transition-all active:scale-[0.98] text-lg tracking-wide flex items-center justify-center gap-2"
             >
               {status === "connecting" ? (
                 <><Loader2 size={20} className="animate-spin" /> Connecting...</>
               ) : (
                 "Start Controlling"
               )}
             </button>
          </div>
      </div>
      <p className="text-secondary text-sm mt-8 opacity-70">Omniscreen</p>
    </div>
  );
}

export default App;
