/**
 * WebSocket Service
 *
 * Real-time event broadcasting for Agent Market.
 * Agents connect with their API key and receive targeted notifications.
 */

const crypto = require('crypto');
const { WebSocketServer } = require('ws');
const { query } = require('../config/database');

// Connected clients indexed by agent ID
const clients = new Map();

let wss = null;

/**
 * Initialize WebSocket server on an existing HTTP server
 */
function initialize(server) {
  wss = new WebSocketServer({ server, path: '/api/v1/ws', maxPayload: 64 * 1024 });

  wss.on('connection', (ws, req) => {
    let agentId = null;

    // Check Authorization header first
    const authHeader = req.headers['authorization'];
    if (authHeader && authHeader.startsWith('Bearer ')) {
      const token = authHeader.slice(7);
      authenticateToken(token).then((id) => {
        if (id) {
          agentId = id;
          registerClient(agentId, ws);
          ws.send(JSON.stringify({ type: 'connected', agent_id: agentId }));
        } else {
          ws.send(JSON.stringify({ type: 'error', message: 'Invalid API key' }));
          ws.close(4001, 'Unauthorized');
        }
      });
    } else {
      // Allow sending API key as first message
      ws.once('message', async (data) => {
        try {
          const msg = JSON.parse(data.toString());
          if (msg.type === 'auth' && msg.api_key) {
            const id = await authenticateToken(msg.api_key);
            if (id) {
              agentId = id;
              registerClient(agentId, ws);
              ws.send(JSON.stringify({ type: 'connected', agent_id: agentId }));
            } else {
              ws.send(JSON.stringify({ type: 'error', message: 'Invalid API key' }));
              ws.close(4001, 'Unauthorized');
            }
          } else {
            ws.send(JSON.stringify({ type: 'error', message: 'Send {"type":"auth","api_key":"..."} to authenticate' }));
            ws.close(4001, 'Unauthorized');
          }
        } catch {
          ws.send(JSON.stringify({ type: 'error', message: 'Invalid message format' }));
          ws.close(4002, 'Bad Request');
        }
      });

      // Timeout if no auth within 10 seconds
      setTimeout(() => {
        if (!agentId && ws.readyState === ws.OPEN) {
          ws.send(JSON.stringify({ type: 'error', message: 'Authentication timeout' }));
          ws.close(4001, 'Unauthorized');
        }
      }, 10000);
    }

    ws.on('close', () => {
      if (agentId) {
        removeClient(agentId, ws);
      }
    });

    ws.on('error', () => {
      if (agentId) {
        removeClient(agentId, ws);
      }
    });
  });

  console.log('WebSocket server initialized on /api/v1/ws');
}

async function authenticateToken(token) {
  try {
    const hash = crypto.createHash('sha256').update(token).digest('hex');
    const result = await query('SELECT id FROM agents WHERE api_key_hash = $1', [hash]);
    return result.rows.length > 0 ? result.rows[0].id : null;
  } catch {
    return null;
  }
}

function registerClient(agentId, ws) {
  if (!clients.has(agentId)) {
    clients.set(agentId, new Set());
  }
  clients.get(agentId).add(ws);
}

function removeClient(agentId, ws) {
  const sockets = clients.get(agentId);
  if (sockets) {
    sockets.delete(ws);
    if (sockets.size === 0) {
      clients.delete(agentId);
    }
  }
}

/**
 * Send an event to a specific agent
 */
function sendToAgent(agentId, event) {
  const sockets = clients.get(agentId);
  if (!sockets) return;

  const payload = JSON.stringify(event);
  for (const ws of sockets) {
    if (ws.readyState === ws.OPEN) {
      ws.send(payload);
    }
  }
}

/**
 * Broadcast an event to all connected agents
 */
function broadcast(event) {
  if (!wss) return;
  const payload = JSON.stringify(event);
  for (const [, sockets] of clients) {
    for (const ws of sockets) {
      if (ws.readyState === ws.OPEN) {
        ws.send(payload);
      }
    }
  }
}

module.exports = { initialize, sendToAgent, broadcast };
