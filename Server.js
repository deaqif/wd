// server.js
const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode');
const cors = require('cors');
const fs = require('fs');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

app.use(cors());
app.use(express.json());

// Store active clients
const clients = {};

// Create sessions directory if it doesn't exist
const sessionsDir = path.join(__dirname, 'sessions');
if (!fs.existsSync(sessionsDir)) {
  fs.mkdirSync(sessionsDir, { recursive: true });
}

// Socket.io connection
io.on('connection', (socket) => {
  console.log('New client connected:', socket.id);

  // Handle new WhatsApp session
  socket.on('create-session', async (data) => {
    console.log('Creating session:', data.sessionId);
    
    const client = new Client({
      authStrategy: new LocalAuth({
        clientId: data.sessionId
      }),
      puppeteer: {
        headless: true,
        args: ['--no-sandbox', '--disable-setuid-sandbox']
      }
    });

    clients[data.sessionId] = {
      client,
      qrCode: null,
      ready: false,
      socket
    };

    client.on('qr', async (qr) => {
      console.log('QR code received for session:', data.sessionId);
      
      // Generate QR code as data URL
      const qrDataURL = await qrcode.toDataURL(qr);
      clients[data.sessionId].qrCode = qrDataURL;
      
      // Send QR code to client
      socket.emit('qr', { sessionId: data.sessionId, qrCode: qrDataURL });
    });

    client.on('ready', () => {
      console.log('Client is ready for session:', data.sessionId);
      clients[data.sessionId].ready = true;
      socket.emit('ready', { sessionId: data.sessionId });
    });

    client.on('authenticated', () => {
      console.log('Client authenticated for session:', data.sessionId);
      socket.emit('authenticated', { sessionId: data.sessionId });
    });

    client.on('auth_failure', (msg) => {
      console.error('Authentication failure for session:', data.sessionId, msg);
      socket.emit('auth_failure', { sessionId: data.sessionId, error: msg });
    });

    client.on('disconnected', (reason) => {
      console.log('Client disconnected for session:', data.sessionId, reason);
      socket.emit('disconnected', { sessionId: data.sessionId, reason });
      client.destroy();
      delete clients[data.sessionId];
    });

    // Initialize client
    await client.initialize();
  });

  // Handle logout request
  socket.on('logout-session', async (data) => {
    const { sessionId } = data;
    
    if (clients[sessionId] && clients[sessionId].client) {
      try {
        await clients[sessionId].client.logout();
        console.log('Logged out session:', sessionId);
        socket.emit('logout-success', { sessionId });
      } catch (error) {
        console.error('Error logging out session:', sessionId, error);
        socket.emit('logout-error', { sessionId, error: error.message });
      }
    } else {
      socket.emit('logout-error', { sessionId, error: 'Session not found' });
    }
  });

  // Handle disconnect
  socket.on('disconnect', () => {
    console.log('Client disconnected:', socket.id);
    
    // Find and clean up any sessions associated with this socket
    Object.keys(clients).forEach(sessionId => {
      if (clients[sessionId].socket.id === socket.id) {
        if (clients[sessionId].client) {
          clients[sessionId].client.destroy();
        }
        delete clients[sessionId];
      }
    });
  });
});

// API endpoints
app.get('/api/sessions', (req, res) => {
  const sessionsList = Object.keys(clients).map(sessionId => ({
    id: sessionId,
    ready: clients[sessionId].ready
  }));
  
  res.json({ sessions: sessionsList });
});

// Start server
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});