import { createServer } from 'http';
import { Server } from 'socket.io';
import express from 'express';
import pino from 'pino';
import makeWASocket, {
  useMultiFileAuthState,
  DisconnectReason,
  makeCacheableSignalKeyStore
} from '@whiskeysockets/baileys';
import { Boom } from '@hapi/boom';
import { mkdir, writeFile } from 'fs/promises';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import QRCode from 'qrcode';

const __dirname = dirname(fileURLToPath(import.meta.url));
const logger = pino({ level: 'silent' });
const sessionsDir = join(__dirname, 'sessions');

// Create sessions directory if it doesn't exist
try {
  await mkdir(sessionsDir, { recursive: true });
} catch (err) {
  if (err.code !== 'EEXIST') {
    console.error('Failed to create sessions directory:', err);
  }
}

const app = express();
const server = createServer(app);
const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

// Store active connections
const connections = new Map();

async function connectToWhatsApp(accountId, socket) {
  const sessionDir = join(sessionsDir, `session_${accountId}`);
  
  try {
    await mkdir(sessionDir, { recursive: true });
    const { state, saveCreds } = await useMultiFileAuthState(sessionDir);
    
    const sock = makeWASocket({
      printQRInTerminal: false,
      auth: {
        creds: state.creds,
        keys: makeCacheableSignalKeyStore(state.keys, logger)
      },
      logger,
      generateHighQualityLinkPreview: true,
      browser: ['Chrome (Linux)', '', '']
    });

    connections.set(accountId, sock);

    sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        try {
          // Generate QR code as data URL
          const qrDataURL = await QRCode.toDataURL(qr, {
            margin: 3,
            scale: 8,
            errorCorrectionLevel: 'H',
            color: {
              dark: '#000000',
              light: '#ffffff'
            }
          });

          socket.emit('qrCode', {
            accountId,
            qr: qrDataURL
          });
        } catch (err) {
          console.error('Failed to generate QR code:', err);
          socket.emit('error', {
            accountId,
            error: 'Failed to generate QR code'
          });
        }
      }

      if (connection === 'close') {
        const shouldReconnect = (lastDisconnect?.error instanceof Boom)
          && lastDisconnect.error.output.statusCode !== DisconnectReason.loggedOut;
        
        if (shouldReconnect) {
          connectToWhatsApp(accountId, socket);
        } else {
          console.log('Connection closed. You are logged out.');
          socket.emit('disconnected', { accountId });
          connections.delete(accountId);
        }
      } else if (connection === 'open') {
        console.log('Connected to WhatsApp');
        socket.emit('connected', { accountId });
      }
    });

    sock.ev.on('creds.update', saveCreds);

    // Handle messages
    sock.ev.on('messages.upsert', async (m) => {
      if (m.type === 'notify') {
        for (const msg of m.messages) {
          if (!msg.key.fromMe) {
            socket.emit('message', {
              accountId,
              from: msg.key.remoteJid,
              message: msg.message?.conversation || msg.message?.extendedTextMessage?.text || '',
              timestamp: msg.messageTimestamp
            });
          }
        }
      }
    });

  } catch (err) {
    console.error('Failed to connect:', err);
    socket.emit('error', {
      accountId,
      error: 'Connection failed'
    });
  }
}

io.on('connection', (socket) => {
  console.log('Client connected');

  socket.on('requestQR', async ({ accountId }) => {
    if (!accountId) {
      socket.emit('error', { error: 'Account ID is required' });
      return;
    }

    // Remove existing connection if any
    if (connections.has(accountId)) {
      const existingConn = connections.get(accountId);
      existingConn?.end();
      connections.delete(accountId);
    }

    await connectToWhatsApp(accountId, socket);
  });

  socket.on('disconnect', () => {
    console.log('Client disconnected');
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
