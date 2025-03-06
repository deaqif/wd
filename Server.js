const express = require('express');
const http = require('http');
const socketIO = require('socket.io');
const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode');
const cors = require('cors');

// Initialize Express app
const app = express();
app.use(cors());
app.use(express.json());

// Create HTTP server
const server = http.createServer(app);

// Initialize Socket.IO
const io = socketIO(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

// Store active WhatsApp clients
const clients = {};

// Socket.IO connection
io.on('connection', (socket) => {
  console.log('New client connected:', socket.id);

  // Generate QR code for new WhatsApp session
  socket.on('generateQR', async (sessionId) => {
    console.log('Generating QR for session:', sessionId);
    
    // Create new WhatsApp client
    const client = new Client({
      authStrategy: new LocalAuth({ clientId: sessionId }),
      puppeteer: {
        args: ['--no-sandbox', '--disable-setuid-sandbox']
      }
    });

    clients[sessionId] = client;

    client.on('qr', (qr) => {
      qrcode.toDataURL(qr, (err, url) => {
        socket.emit('qrCode', { sessionId, qrCode: url });
      });
    });

    client.on('ready', () => {
      console.log('Client is ready:', sessionId);
      socket.emit('ready', { sessionId });
    });

    client.on('authenticated', () => {
      console.log('Client authenticated:', sessionId);
      socket.emit('authenticated', { sessionId });
    });

    client.on('auth_failure', (msg) => {
      console.error('Authentication failure:', msg);
      socket.emit('authFailure', { sessionId, error: msg });
    });

    client.on('disconnected', (reason) => {
      console.log('Client disconnected:', sessionId, reason);
      socket.emit('disconnected', { sessionId, reason });
      client.destroy();
      delete clients[sessionId];
    });

    // Initialize client
    client.initialize();
  });

  // Logout from WhatsApp
  socket.on('logout', async (sessionId) => {
    console.log('Logging out session:', sessionId);
    
    if (clients[sessionId]) {
      try {
        await clients[sessionId].logout();
        clients[sessionId].destroy();
        delete clients[sessionId];
        socket.emit('logoutSuccess', { sessionId });
      } catch (error) {
        console.error('Logout error:', error);
        socket.emit('logoutError', { sessionId, error: error.message });
      }
    } else {
      socket.emit('logoutError', { sessionId, error: 'Session not found' });
    }
  });

  // Disconnect event
  socket.on('disconnect', () => {
    console.log('Client disconnected:', socket.id);
  });
});

// Health check endpoint
app.get('/', (req, res) => {
  res.send('WhatsApp Web API Server is running');
});

// Start server
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
