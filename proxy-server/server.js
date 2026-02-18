// AccessAI Proxy Server
// Securely proxies OpenAI API requests so the API key never touches the extension.
//
// Deploy this on Render, Railway, Fly.io, or any Node hosting.
// Set OPENAI_API_KEY in environment variables on the host.

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const { WebSocketServer, WebSocket } = require('ws');
const http = require('http');

const app = express();
const server = http.createServer(app);

const PORT = process.env.PORT || 3001;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

if (!OPENAI_API_KEY) {
  console.error('FATAL: OPENAI_API_KEY environment variable is not set.');
  process.exit(1);
}

// ------- Middleware -------
app.use(helmet());
app.use(express.json({ limit: '1mb' }));

// CORS: allow the Chrome extension and localhost dev
const allowedOrigins = (process.env.ALLOWED_ORIGINS || '')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);

app.use(cors({
  origin: (origin, callback) => {
    // Allow requests with no origin (extensions, curl, server-to-server)
    if (!origin) return callback(null, true);
    // Allow chrome-extension:// origins
    if (origin.startsWith('chrome-extension://')) return callback(null, true);
    // Allow explicitly listed origins
    if (allowedOrigins.includes(origin)) return callback(null, true);
    // Allow localhost for development
    if (origin.includes('localhost') || origin.includes('127.0.0.1')) return callback(null, true);
    callback(new Error('Not allowed by CORS'));
  }
}));

// Rate limiting: 60 requests per minute per IP
const limiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests. Please slow down.' }
});
app.use('/api/', limiter);

// ------- Health Check -------
app.get('/', (req, res) => {
  res.json({ status: 'ok', service: 'AccessAI Proxy' });
});

app.get('/health', (req, res) => {
  res.json({ status: 'healthy' });
});

// ------- OpenAI Chat Completions Proxy -------
app.post('/api/openai', async (req, res) => {
  const { model, messages, max_tokens, temperature } = req.body;

  if (!messages || !Array.isArray(messages)) {
    return res.status(400).json({ error: 'messages array is required' });
  }

  try {
    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${OPENAI_API_KEY}`
      },
      body: JSON.stringify({
        model: model || 'gpt-4o',
        messages,
        max_tokens: Math.min(max_tokens || 300, 1000), // Cap tokens
        temperature: temperature ?? 0.3
      })
    });

    const data = await response.json();

    if (!response.ok) {
      return res.status(response.status).json({
        error: data.error?.message || 'OpenAI API error'
      });
    }

    res.json(data);
  } catch (err) {
    console.error('OpenAI proxy error:', err.message);
    res.status(500).json({ error: 'Internal proxy error' });
  }
});

// ------- WebSocket: OpenAI Realtime API Proxy -------
const wss = new WebSocketServer({ server, path: '/api/realtime' });

wss.on('connection', (clientWs, req) => {
  console.log('Realtime client connected');

  // Connect to OpenAI Realtime API
  const openaiWs = new WebSocket(
    'wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview',
    {
      headers: {
        'Authorization': `Bearer ${OPENAI_API_KEY}`,
        'OpenAI-Beta': 'realtime=v1'
      }
    }
  );

  openaiWs.on('open', () => {
    console.log('Connected to OpenAI Realtime');
  });

  // Forward messages: client -> OpenAI
  clientWs.on('message', (data) => {
    if (openaiWs.readyState === WebSocket.OPEN) {
      openaiWs.send(data.toString());
    }
  });

  // Forward messages: OpenAI -> client
  openaiWs.on('message', (data) => {
    if (clientWs.readyState === WebSocket.OPEN) {
      clientWs.send(data.toString());
    }
  });

  // Handle disconnections
  clientWs.on('close', () => {
    console.log('Client disconnected');
    openaiWs.close();
  });

  openaiWs.on('close', () => {
    console.log('OpenAI Realtime disconnected');
    clientWs.close();
  });

  clientWs.on('error', (err) => {
    console.error('Client WS error:', err.message);
    openaiWs.close();
  });

  openaiWs.on('error', (err) => {
    console.error('OpenAI WS error:', err.message);
    clientWs.close();
  });
});

// ------- Start Server -------
server.listen(PORT, () => {
  console.log(`AccessAI proxy running on port ${PORT}`);
  console.log(`HTTP: http://localhost:${PORT}`);
  console.log(`WebSocket: ws://localhost:${PORT}/api/realtime`);
});
