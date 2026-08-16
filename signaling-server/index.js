const express = require('express');
const cors = require('cors');
const http = require('http');
const { Server } = require('socket.io');

const app = express();

// Enable CORS for all routes — required for browser connections from Vercel
app.use(cors());

// Health check endpoint — critical for Render/Railway to keep the service alive
app.get('/', (req, res) => {
  res.status(200).json({
    status: 'ok',
    service: 'Omniscreen Signaling Server',
    uptime: process.uptime(),
    connections: io.engine.clientsCount || 0
  });
});

app.get('/health', (req, res) => {
  res.status(200).send('OK');
});

const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST'],
    credentials: false
  },
  allowEIO3: true,
  transports: ['polling', 'websocket'],
  // Increase timeouts for better stability
  pingTimeout: 60000,
  pingInterval: 25000
});

// Track which rooms each socket is in (for cleanup on disconnect)
const socketRooms = new Map();

io.on('connection', (socket) => {
  console.log(`User connected: ${socket.id}`);

  // When a peer joins, they can specify a room (or their own ID as a room to receive connections)
  socket.on('join-room', (roomId) => {
    if (!roomId || typeof roomId !== 'string') {
      console.warn(`Invalid room ID from ${socket.id}`);
      return;
    }
    
    socket.join(roomId);
    socketRooms.set(socket.id, roomId);
    console.log(`Socket ${socket.id} joined room ${roomId}`);
    // Notify others in the room
    socket.to(roomId).emit('user-joined', socket.id);
  });

  // Relay WebRTC offer
  socket.on('offer', (data) => {
    if (!data || !data.target || !data.offer) {
      console.warn(`Invalid offer from ${socket.id}`);
      return;
    }
    const { target, offer } = data;
    console.log(`Relaying offer from ${socket.id} to ${target}`);
    socket.to(target).emit('offer', {
      sender: socket.id,
      offer
    });
  });

  // Relay WebRTC answer
  socket.on('answer', (data) => {
    if (!data || !data.target || !data.answer) {
      console.warn(`Invalid answer from ${socket.id}`);
      return;
    }
    const { target, answer } = data;
    console.log(`Relaying answer from ${socket.id} to ${target}`);
    socket.to(target).emit('answer', {
      sender: socket.id,
      answer
    });
  });

  // Relay ICE candidates
  socket.on('ice-candidate', (data) => {
    if (!data || !data.target || !data.candidate) {
      console.warn(`Invalid ICE candidate from ${socket.id}`);
      return;
    }
    const { target, candidate } = data;
    socket.to(target).emit('ice-candidate', {
      sender: socket.id,
      candidate
    });
  });
  
  // Custom remote control commands (mouse, keyboard) if we want to relay them via signaling 
  // (though ideally this should go over WebRTC Data Channels for lower latency)
  // We'll leave this as a fallback.
  socket.on('control-command', (data) => {
    if (!data || !data.target || !data.command) return;
    const { target, command } = data;
    socket.to(target).emit('control-command', {
      sender: socket.id,
      command
    });
  });

  socket.on('disconnect', (reason) => {
    console.log(`User disconnected: ${socket.id} (reason: ${reason})`);
    
    // Notify the room that this user left
    const roomId = socketRooms.get(socket.id);
    if (roomId) {
      socket.to(roomId).emit('user-left', socket.id);
      socketRooms.delete(socket.id);
    }
  });

  // Handle errors
  socket.on('error', (err) => {
    console.error(`Socket error for ${socket.id}:`, err);
  });
});

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
  console.log(`Signaling server running on port ${PORT}`);
});
