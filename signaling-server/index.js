const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();

const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST']
  }
});

io.on('connection', (socket) => {
  console.log(`User connected: ${socket.id}`);

  // When a peer joins, they can specify a room (or their own ID as a room to receive connections)
  socket.on('join-room', (roomId) => {
    socket.join(roomId);
    console.log(`Socket ${socket.id} joined room ${roomId}`);
    // Notify others in the room
    socket.to(roomId).emit('user-joined', socket.id);
  });

  // Relay WebRTC offer
  socket.on('offer', (data) => {
    const { target, offer } = data;
    console.log(`Relaying offer from ${socket.id} to ${target}`);
    socket.to(target).emit('offer', {
      sender: socket.id,
      offer
    });
  });

  // Relay WebRTC answer
  socket.on('answer', (data) => {
    const { target, answer } = data;
    console.log(`Relaying answer from ${socket.id} to ${target}`);
    socket.to(target).emit('answer', {
      sender: socket.id,
      answer
    });
  });

  // Relay ICE candidates
  socket.on('ice-candidate', (data) => {
    const { target, candidate } = data;
    console.log(`Relaying ICE candidate from ${socket.id} to ${target}`);
    socket.to(target).emit('ice-candidate', {
      sender: socket.id,
      candidate
    });
  });
  
  // Custom remote control commands (mouse, keyboard) if we want to relay them via signaling 
  // (though ideally this should go over WebRTC Data Channels for lower latency)
  // We'll leave this as a fallback.
  socket.on('control-command', (data) => {
    const { target, command } = data;
    socket.to(target).emit('control-command', {
      sender: socket.id,
      command
    });
  });

  socket.on('disconnect', () => {
    console.log(`User disconnected: ${socket.id}`);
  });
});

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
  console.log(`Signaling server running on port ${PORT}`);
});
