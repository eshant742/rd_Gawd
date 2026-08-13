import { useEffect, useRef, useState } from "react";
import { io, Socket } from "socket.io-client";
import { Key, MonitorPlay, XCircle } from "lucide-react";

const iceServers = {
  iceServers: [
    { urls: "stun:stun.l.google.com:19302" },
    { urls: "stun:global.stun.twilio.com:3478" },
    {
      urls: "turn:openrelay.metered.ca:80",
      username: "openrelayproject",
      credential: "openrelayproject"
    },
    {
      urls: "turn:openrelay.metered.ca:443",
      username: "openrelayproject",
      credential: "openrelayproject"
    },
    {
      urls: "turn:openrelay.metered.ca:443?transport=tcp",
      username: "openrelayproject",
      credential: "openrelayproject"
    }
  ],
};

function App() {
  const [socket, setSocket] = useState<Socket | null>(null);
  const [myId, setMyId] = useState<string>("");
  const [targetId, setTargetId] = useState<string>("");
  const [status, setStatus] = useState<"disconnected" | "connecting" | "connected">("disconnected");
  const [appMode, setAppMode] = useState<"host" | "viewer" | null>(null);
  const [errorMsg, setErrorMsg] = useState("");

  const peerConnection = useRef<RTCPeerConnection | null>(null);
  const dataChannel = useRef<RTCDataChannel | null>(null);
  const remoteVideoRef = useRef<HTMLVideoElement>(null);
  const localStream = useRef<MediaStream | null>(null);

  useEffect(() => {
    // Determine mode and setup automatically if host
    async function initMode() {
      let mode = 'viewer'; // Default to viewer if no Electron

      // Connect to signaling server
      const signalingUrl = import.meta.env.VITE_SIGNALING_URL || "http://localhost:3001";
      const newSocket = io(signalingUrl);
      setSocket(newSocket);

      // @ts-ignore
      if (window.electronAPI) {
        // @ts-ignore
        mode = await window.electronAPI.getMode();
        setAppMode(mode as "host" | "viewer");
        
        if (mode === 'host') {
          // @ts-ignore
          const permId = await window.electronAPI.getPermanentId();
          setMyId(permId);
          newSocket.emit('join-room', permId); // Host registers their permanent ID as a room
        }
      } else {
        setAppMode('viewer');
      }

      newSocket.on("offer", async (data: { sender: string; offer: RTCSessionDescriptionInit }) => {
        console.log("Received offer from", data.sender);
        if (mode === 'viewer') return; // Viewers don't accept offers in this setup

        setStatus("connecting");
        try {
          await setupPeerConnection(newSocket, data.sender, true);
          await peerConnection.current?.setRemoteDescription(new RTCSessionDescription(data.offer));
          
          // Add any queued candidates (if ICE candidates arrived before remote description was set)
          while (pendingCandidates.length > 0) {
            const candidate = pendingCandidates.shift();
            if (candidate) {
              try {
                await peerConnection.current?.addIceCandidate(new RTCIceCandidate(candidate));
              } catch (e) {
                console.error("Error adding queued ice candidate on host", e);
              }
            }
          }
          
          const answer = await peerConnection.current?.createAnswer();
          await peerConnection.current?.setLocalDescription(answer);
          
          newSocket.emit("answer", {
            target: data.sender,
            answer: answer
          });
        } catch (err) {
          console.error("Failed to handle offer", err);
          cleanupSession();
        }
      });

      const pendingCandidates: RTCIceCandidateInit[] = [];

      newSocket.on("answer", async (data: { sender: string; answer: RTCSessionDescriptionInit }) => {
        console.log("Received answer from", data.sender);
        await peerConnection.current?.setRemoteDescription(new RTCSessionDescription(data.answer));
        setStatus("connected");
        
        // Add any queued candidates
        while (pendingCandidates.length > 0) {
          const candidate = pendingCandidates.shift();
          if (candidate) {
            try {
              await peerConnection.current?.addIceCandidate(new RTCIceCandidate(candidate));
            } catch (e) {
              console.error("Error adding queued ice candidate", e);
            }
          }
        }
      });

      newSocket.on("ice-candidate", async (data: { sender: string; candidate: RTCIceCandidateInit }) => {
        console.log("Received ICE candidate");
        if (!peerConnection.current || !peerConnection.current.remoteDescription) {
          console.log("Queueing ICE candidate because remote description is not set yet");
          pendingCandidates.push(data.candidate);
          return;
        }
        try {
          await peerConnection.current.addIceCandidate(new RTCIceCandidate(data.candidate));
        } catch (e) {
          console.error("Error adding ice candidate", e);
        }
      });
    }

    initMode();

    return () => {
      if (socket) socket.disconnect();
    };
  }, []);

  const setupPeerConnection = async (sock: Socket, target: string, asHost: boolean) => {
    const pc = new RTCPeerConnection(iceServers);
    peerConnection.current = pc;

    pc.onicecandidate = (event) => {
      if (event.candidate) {
        sock.emit("ice-candidate", {
          target: target,
          candidate: event.candidate,
        });
      }
    };

    pc.onconnectionstatechange = () => {
      console.log("Connection state:", pc.connectionState);
      if (pc.connectionState === "disconnected" || pc.connectionState === "failed") {
        cleanupSession();
      }
    };

    if (asHost) {
      try {
        // @ts-ignore
        const sources = await window.electronAPI.getSources();
        const primaryScreen = sources.find((s: any) => s.id.startsWith('screen')) || sources[0];
        
        const stream = await navigator.mediaDevices.getUserMedia({
          audio: false,
          video: {
            mandatory: {
              chromeMediaSource: 'desktop',
              chromeMediaSourceId: primaryScreen.id,
              maxFrameRate: 60
            }
          } as any
        });
        
        localStream.current = stream;
        stream.getTracks().forEach((track) => {
          pc.addTrack(track, stream);
        });

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
        };
      } catch (err) {
        console.error("Error getting display media", err);
        throw err;
      }
    } else {
      pc.ontrack = (event) => {
        console.log("Received remote track");
        if (remoteVideoRef.current && event.streams[0]) {
          remoteVideoRef.current.srcObject = event.streams[0];
        }
      };

      const dc = pc.createDataChannel("control");
      dataChannel.current = dc;
    }
  };

  const handleRemoteCommand = (cmd: any) => {
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
      }
    } catch (e) {
      console.error("Failed to execute command", e);
    }
  };

  const connectToPeer = async () => {
    if (!socket || !targetId) return;
    setStatus("connecting");
    
    try {
      // Connect to the host's room first so they get our signals (if needed by signaling logic, or we just emit directly)
      // Actually our signaling server relays by socket.id. But if host is in a room named targetId, 
      // we need the signaling server to route to that room.
      // Wait, our signaling server routes 'offer' to `target`. If target is a room ID, socket.to(target) works!
      await setupPeerConnection(socket, targetId, false);
      const offer = await peerConnection.current?.createOffer();
      await peerConnection.current?.setLocalDescription(offer);
      
      socket.emit("offer", {
        target: targetId,
        offer: offer
      });
    } catch (err) {
      console.error("Connection failed", err);
      setErrorMsg("Failed to connect.");
      cleanupSession();
    }
  };

  const cleanupSession = () => {
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
    
    // If we were a viewer, go back to disconnected. If host, go back to listening
    setStatus(appMode === 'host' ? "connected" : "disconnected");
    if (appMode === 'host') setStatus("disconnected");
  };

  const sendControl = (cmd: any) => {
    if (dataChannel.current && dataChannel.current.readyState === "open") {
      dataChannel.current.send(JSON.stringify(cmd));
    }
  };

  const handleMouseMove = (e: React.MouseEvent<HTMLVideoElement>) => {
    if (!remoteVideoRef.current) return;
    const rect = remoteVideoRef.current.getBoundingClientRect();
    const video = remoteVideoRef.current;
    
    const scaleX = video.videoWidth / rect.width;
    const scaleY = video.videoHeight / rect.height;
    
    const x = Math.round((e.clientX - rect.left) * scaleX);
    const y = Math.round((e.clientY - rect.top) * scaleY);
    
    sendControl({ type: "mousemove", x, y });
  };

  const handleMouseClick = (e: React.MouseEvent<HTMLVideoElement>, type: "down" | "up") => {
    let button = "left";
    if (e.button === 1) button = "middle";
    if (e.button === 2) button = "right";
    sendControl({ type: "mouse" + type, button });
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    e.preventDefault();
    sendControl({ type: "keydown", key: e.key });
  };

  const handleKeyUp = (e: React.KeyboardEvent) => {
    e.preventDefault();
    sendControl({ type: "keyup", key: e.key });
  };

  if (appMode === 'host') {
    return (
      <div className="w-screen h-screen bg-black text-white flex flex-col items-center justify-center p-8">
         <h1 className="text-3xl font-bold mb-4 text-primary">Antigravity Host</h1>
         <p className="text-xl mb-8">Running invisibly in the system tray.</p>
         <div className="bg-surface p-6 rounded-xl border border-slate-700">
           <p className="text-slate-400 mb-2">Your Permanent ID (also on Desktop):</p>
           <p className="text-4xl font-mono tracking-widest font-bold text-white selection:bg-primary/30">
             {myId || "Generating..."}
           </p>
         </div>
         <p className="text-sm text-slate-500 mt-8">You can close this window. The host will stay active in the tray.</p>
      </div>
    );
  }

  if (status === "connected" && appMode === "viewer") {
    return (
      <div className="w-screen h-screen bg-black flex flex-col relative" tabIndex={0} onKeyDown={handleKeyDown} onKeyUp={handleKeyUp}>
        <div className="absolute top-0 left-1/2 -translate-x-1/2 z-50 glass-panel px-6 py-2 rounded-b-xl flex gap-4 items-center opacity-0 hover:opacity-100 transition-opacity duration-300">
           <span className="text-sm font-medium">Viewing Remote Desk</span>
           <button onClick={cleanupSession} className="bg-red-500/20 text-red-400 hover:bg-red-500 hover:text-white p-2 rounded-full transition-colors">
             <XCircle size={20} />
           </button>
        </div>

        <video
          ref={remoteVideoRef}
          autoPlay
          playsInline
          onMouseMove={handleMouseMove}
          onMouseDown={(e) => handleMouseClick(e, "down")}
          onMouseUp={(e) => handleMouseClick(e, "up")}
          onContextMenu={(e) => e.preventDefault()}
          className="w-full h-full object-contain cursor-crosshair"
        />
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-background flex flex-col items-center justify-center p-6 relative">
      <div className="absolute top-[-10%] left-[-10%] w-[40%] h-[40%] bg-primary/20 rounded-full blur-[120px] pointer-events-none"></div>
      <div className="absolute bottom-[-10%] right-[-10%] w-[40%] h-[40%] bg-purple-500/20 rounded-full blur-[120px] pointer-events-none"></div>

      <div className="glass-panel rounded-2xl shadow-2xl p-8 w-full max-w-md relative z-10 flex flex-col">
          <div className="flex items-center justify-center gap-3 mb-8">
            <MonitorPlay className="text-primary" size={32} />
            <h2 className="text-3xl font-bold">Connect</h2>
          </div>
          
          <div className="bg-surface rounded-xl p-6 border border-slate-700/50 flex flex-col justify-center">
             <p className="text-secondary text-sm font-medium mb-3 text-center">Enter the Remote Desk ID</p>
             <div className="relative mb-6">
               <div className="absolute inset-y-0 left-0 pl-4 flex items-center pointer-events-none">
                 <Key size={20} className="text-slate-400" />
               </div>
               <input 
                 type="text" 
                 value={targetId}
                 onChange={(e) => setTargetId(e.target.value)}
                 className="w-full bg-slate-900/50 border-2 border-slate-600 rounded-lg py-4 pl-12 pr-4 text-white text-xl tracking-widest text-center focus:outline-none focus:ring-2 focus:ring-primary focus:border-transparent transition-all font-mono"
                 placeholder="123456789"
                 maxLength={9}
               />
             </div>
             
             {errorMsg && <p className="text-red-400 text-sm mb-4 text-center">{errorMsg}</p>}

             <button 
                onClick={connectToPeer}
                disabled={status === "connecting" || targetId.length < 5}
                className="w-full bg-primary hover:bg-blue-600 disabled:bg-slate-700 disabled:text-slate-400 text-white font-semibold py-4 rounded-lg shadow-lg hover:shadow-primary/20 transition-all active:scale-[0.98] text-lg tracking-wide"
             >
               {status === "connecting" ? "Connecting..." : "Start Controlling"}
             </button>
          </div>
      </div>
      <p className="text-secondary text-sm mt-8 opacity-70">Antigravity Remote Desktop</p>
    </div>
  );
}

export default App;
