'use strict';

const express = require('express');
const crypto = require('crypto');
const https = require('https');
const http = require('http');
const path = require('path');

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
require('dotenv').config({ path: path.join(__dirname, '.env') });

const PORT            = parseInt(process.env.PORT || '3000', 10);
// 'llm'   → LLM relay only  (Server A, domestic bare IP)
// 'users' → user management only  (Server B, overseas domain)
const SERVER_ROLE     = process.env.SERVER_ROLE || 'users';
const USER_SERVER_URL = process.env.USER_SERVER_URL || '';  // llm role → points to Server B
const INTERNAL_SECRET = process.env.INTERNAL_SECRET || '';  // shared between Server A and B

const DEEPSEEK_API_KEY  = process.env.DEEPSEEK_API_KEY || '';
const DEEPSEEK_BASE_URL = process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com';

const CREDITS_PER_CHAT = parseInt(process.env.CREDITS_PER_CHAT || '20', 10);
const CLOUD_MODEL_ID   = process.env.CLOUD_MODEL_ID   || 'deepseek-chat';
const CLOUD_MODEL_NAME = process.env.CLOUD_MODEL_NAME || 'DeepSeek-V3';

// Rate limit: per device, max requests per window
const RATE_WINDOW_MS = 1000;
const RATE_MAX       = 5;

// ---------------------------------------------------------------------------
// Database (users role only)
// ---------------------------------------------------------------------------
let stmtGetUser, stmtInsertUser, stmtGetCredits, stmtDeduct, stmtAddCredits;
let stmtInsertOrder, stmtGetOrder, stmtPayOrder;
let HUPIJIAO_APP_ID, HUPIJIAO_APP_SECRET, HUPIJIAO_NOTIFY_URL;
let FREE_CREDITS, PACKAGES;

if (SERVER_ROLE === 'users') {
  const Database = require('better-sqlite3');
  HUPIJIAO_APP_ID     = process.env.HUPIJIAO_APP_ID || '';
  HUPIJIAO_APP_SECRET = process.env.HUPIJIAO_APP_SECRET || '';
  HUPIJIAO_NOTIFY_URL = process.env.HUPIJIAO_NOTIFY_URL || '';
  FREE_CREDITS        = parseInt(process.env.FREE_CREDITS || '10000', 10);
  PACKAGES = {
    pkg_10:  { amount: 10,  credits: 10_000,  label: 'UdiskAI 积分 · 10000' },
    pkg_30:  { amount: 30,  credits: 32_000,  label: 'UdiskAI 积分 · 32000' },
    pkg_100: { amount: 100, credits: 120_000, label: 'UdiskAI 积分 · 120000' },
  };

  const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'udiskai-server.sqlite');
  const db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');

  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      device_id  TEXT PRIMARY KEY,
      credits    INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS orders (
      order_id   TEXT PRIMARY KEY,
      device_id  TEXT NOT NULL,
      amount     REAL NOT NULL,
      credits    INTEGER NOT NULL,
      status     TEXT NOT NULL DEFAULT 'pending',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);

  stmtGetUser     = db.prepare('SELECT * FROM users WHERE device_id = ?');
  stmtInsertUser  = db.prepare('INSERT INTO users (device_id, credits) VALUES (?, ?)');
  stmtGetCredits  = db.prepare('SELECT credits FROM users WHERE device_id = ?');
  // unconditional deduct — allows overdraft (caller decides policy)
  stmtDeduct      = db.prepare('UPDATE users SET credits = credits - ? WHERE device_id = ?');
  stmtAddCredits  = db.prepare('UPDATE users SET credits = credits + ? WHERE device_id = ?');
  stmtInsertOrder = db.prepare(
    'INSERT INTO orders (order_id, device_id, amount, credits) VALUES (?, ?, ?, ?)'
  );
  stmtGetOrder    = db.prepare('SELECT * FROM orders WHERE order_id = ?');
  stmtPayOrder    = db.prepare("UPDATE orders SET status = 'paid' WHERE order_id = ?");
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
// Anthropic ↔ OpenAI format conversion helpers (for /v1/messages proxy)
// ---------------------------------------------------------------------------

/** Anthropic tools → OpenAI tools */
function convertToolsToOpenAI(anthropicTools) {
  if (!Array.isArray(anthropicTools) || anthropicTools.length === 0) return undefined;
  return anthropicTools.map(t => ({
    type: 'function',
    function: {
      name: t.name,
      description: t.description || '',
      parameters: t.input_schema || { type: 'object', properties: {} },
    },
  }));
}

/** Anthropic messages → OpenAI messages (handles tool_use / tool_result blocks) */
function convertMessagesToOpenAI(anthropicMessages, systemText) {
  const result = [];
  if (systemText) result.push({ role: 'system', content: systemText });

  for (const msg of anthropicMessages) {
    if (typeof msg.content === 'string') {
      result.push({ role: msg.role, content: msg.content });
      continue;
    }
    if (!Array.isArray(msg.content)) continue;

    if (msg.role === 'user') {
      const toolResults = msg.content.filter(b => b.type === 'tool_result');
      const textBlocks  = msg.content.filter(b => b.type === 'text');
      for (const tr of toolResults) {
        const content = Array.isArray(tr.content)
          ? tr.content.filter(b => b.type === 'text').map(b => b.text).join('')
          : (typeof tr.content === 'string' ? tr.content : '');
        result.push({ role: 'tool', tool_call_id: tr.tool_use_id, content });
      }
      if (textBlocks.length > 0) {
        result.push({ role: 'user', content: textBlocks.map(b => b.text).join('') });
      }
    } else if (msg.role === 'assistant') {
      const textBlocks    = msg.content.filter(b => b.type === 'text');
      const toolUseBlocks = msg.content.filter(b => b.type === 'tool_use');
      const openaiMsg = { role: 'assistant' };
      if (textBlocks.length > 0) openaiMsg.content = textBlocks.map(b => b.text).join('');
      if (toolUseBlocks.length > 0) {
        openaiMsg.tool_calls = toolUseBlocks.map(tu => ({
          id: tu.id,
          type: 'function',
          function: {
            name: tu.name,
            arguments: typeof tu.input === 'string' ? tu.input : JSON.stringify(tu.input || {}),
          },
        }));
      }
      result.push(openaiMsg);
    }
  }
  return result;
}

/** OpenAI non-streaming response → Anthropic response */
function convertResponseToAnthropic(openaiResp, modelName) {
  const message = openaiResp.choices?.[0]?.message;
  const content = [];
  if (message?.content) content.push({ type: 'text', text: message.content });
  if (Array.isArray(message?.tool_calls)) {
    for (const tc of message.tool_calls) {
      let input = {};
      try { input = JSON.parse(tc.function.arguments || '{}'); } catch {}
      content.push({ type: 'tool_use', id: tc.id, name: tc.function.name, input });
    }
  }
  const stopReason = message?.tool_calls?.length > 0 ? 'tool_use' : 'end_turn';
  return {
    id: `msg_${Date.now()}`,
    type: 'message',
    role: 'assistant',
    content,
    model: modelName,
    stop_reason: stopReason,
    stop_sequence: null,
    usage: {
      input_tokens: openaiResp.usage?.prompt_tokens || 0,
      output_tokens: openaiResp.usage?.completion_tokens || 0,
    },
  };
}

// ---------------------------------------------------------------------------
function validateDeviceId(id) {
  return typeof id === 'string' && id.length >= 8 && id.length <= 128 && /^[\w\-]+$/.test(id);
}

function md5(str) {
  return crypto.createHash('md5').update(str).digest('hex');
}

// Hupijiao signature: sort non-empty params by ASCII key, concat k=v&..., append SECRET directly, MD5 lowercase
function hupijiaoSign(params, secret) {
  const sorted = Object.keys(params)
    .filter(k => k !== 'hash' && params[k] !== '' && params[k] !== undefined)
    .sort();
  const str = sorted.map(k => `${k}=${params[k]}`).join('&') + secret;
  return md5(str);
}

// Simple in-memory rate limiter
const rateBuckets = new Map();
function checkRateLimit(deviceId) {
  const now = Date.now();
  const bucket = (rateBuckets.get(deviceId) || []).filter(t => now - t < RATE_WINDOW_MS);
  if (bucket.length >= RATE_MAX) return false;
  bucket.push(now);
  rateBuckets.set(deviceId, bucket);
  return true;
}
setInterval(() => {
  const now = Date.now();
  for (const [id, bucket] of rateBuckets) {
    const fresh = bucket.filter(t => now - t < RATE_WINDOW_MS);
    if (fresh.length === 0) rateBuckets.delete(id);
    else rateBuckets.set(id, fresh);
  }
}, 60_000);

// Post JSON to Hupijiao
function hupijiaoRequest(params) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(params);
    const url = new URL('https://api.xunhupay.com/payment/do.html');
    const options = {
      hostname: url.hostname,
      path: url.pathname,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
    };
    const req = https.request(options, res => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(new Error('Hupijiao response parse error: ' + data)); }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// ---------------------------------------------------------------------------
// deductCredits — llm role only, calls Server B /internal/deduct
// Returns the remaining credits, or null on failure.
// ---------------------------------------------------------------------------
async function deductCredits(deviceId) {
  if (!USER_SERVER_URL || !INTERNAL_SECRET) return null;
  try {
    const body = JSON.stringify({ deviceId, amount: CREDITS_PER_CHAT });
    const res = await fetch(`${USER_SERVER_URL}/internal/deduct`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${INTERNAL_SECRET}`,
      },
      body,
    });
    if (!res.ok) return null;
    const data = await res.json();
    return typeof data.credits === 'number' ? data.credits : null;
  } catch (err) {
    console.warn('[deductCredits] call to Server B failed:', err.message);
    return null;
  }
}

// ---------------------------------------------------------------------------
// App
// ---------------------------------------------------------------------------
const app = express();
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// CORS — clients are Electron (file://) or localhost
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Device-Id');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// ===========================================================================
// SKILLS DISTRIBUTION  (all roles)
// ===========================================================================
app.use('/skills', express.static(path.join(__dirname, 'skills')));

// ===========================================================================
// LLM ROLE ROUTES  (SERVER_ROLE === 'llm')
// ===========================================================================
if (SERVER_ROLE === 'llm') {

  // -------------------------------------------------------------------------
  // POST /chat  — proxy to DeepSeek, deduct after completion
  // -------------------------------------------------------------------------
  app.post('/chat', async (req, res) => {
    const { deviceId, messages, model, stream } = req.body;

    if (!validateDeviceId(deviceId)) {
      return res.status(400).json({ error: 'INVALID_DEVICE_ID' });
    }
    if (!Array.isArray(messages) || messages.length === 0) {
      return res.status(400).json({ error: 'INVALID_MESSAGES' });
    }
    if (!checkRateLimit(deviceId)) {
      return res.status(429).json({ error: 'RATE_LIMITED' });
    }

    const isStream = stream === true || stream === 'true';
    const targetModel = model || CLOUD_MODEL_ID;
    const payload = JSON.stringify({ model: targetModel, messages, stream: isStream });

    const dsUrl = new URL('/v1/chat/completions', DEEPSEEK_BASE_URL);
    const proto = dsUrl.protocol === 'https:' ? https : http;
    const options = {
      hostname: dsUrl.hostname,
      path: dsUrl.pathname,
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${DEEPSEEK_API_KEY}`,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
      },
      agent: false,
    };

    if (isStream) {
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('X-Accel-Buffering', 'no');

      const dsReq = proto.request(options, dsRes => {
        if (dsRes.statusCode !== 200) {
          let errBody = '';
          dsRes.on('data', c => { errBody += c; });
          dsRes.on('end', () => {
            res.write(`data: ${JSON.stringify({ error: 'UPSTREAM_ERROR', detail: errBody })}\n\n`);
            res.end();
          });
          return;
        }

        dsRes.on('data', chunk => { res.write(chunk); });

        dsRes.on('end', async () => {
          const remaining = await deductCredits(deviceId);
          if (remaining !== null) {
            res.write(`data: ${JSON.stringify({ credits_remaining: remaining })}\n\n`);
          }
          res.end();
          console.debug(`[chat/stream] deducted ${CREDITS_PER_CHAT} credits, remaining=${remaining}`);
        });
      });

      dsReq.on('error', err => {
        console.error('[chat/stream] DeepSeek request failed:', err);
        res.write(`data: ${JSON.stringify({ error: 'UPSTREAM_UNAVAILABLE' })}\n\n`);
        res.end();
      });

      dsReq.write(payload);
      dsReq.end();
      req.on('close', () => dsReq.destroy());

    } else {
      const dsReq = proto.request(options, dsRes => {
        let body = '';
        dsRes.on('data', c => { body += c; });
        dsRes.on('end', async () => {
          if (dsRes.statusCode !== 200) {
            return res.status(502).json({ error: 'UPSTREAM_ERROR', detail: body });
          }
          let parsed;
          try { parsed = JSON.parse(body); }
          catch { return res.status(502).json({ error: 'UPSTREAM_PARSE_ERROR' }); }

          const remaining = await deductCredits(deviceId);
          res.setHeader('X-Credits-Used', CREDITS_PER_CHAT);
          if (remaining !== null) res.setHeader('X-Credits-Remaining', remaining);
          res.json(parsed);
          console.debug(`[chat] deducted ${CREDITS_PER_CHAT} credits, remaining=${remaining}`);
        });
      });

      dsReq.on('error', err => {
        console.error('[chat] DeepSeek request failed:', err);
        res.status(502).json({ error: 'UPSTREAM_UNAVAILABLE' });
      });

      dsReq.write(payload);
      dsReq.end();
    }
  });

  // -------------------------------------------------------------------------
  // POST /v1/messages  — Anthropic-compatible endpoint for Claude Agent SDK
  // Authorization: Bearer <deviceId>
  // -------------------------------------------------------------------------
  app.post('/v1/messages', async (req, res) => {
    const authHeader = req.headers['authorization'] || '';
    const deviceId = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : '';

    if (!validateDeviceId(deviceId)) {
      return res.status(401).json({ type: 'error', error: { type: 'authentication_error', message: 'Invalid device ID' } });
    }
    if (!checkRateLimit(deviceId)) {
      return res.status(429).json({ type: 'error', error: { type: 'rate_limit_error', message: 'Rate limited' } });
    }

    const { messages: anthropicMessages = [], system, tools: anthropicTools, stream: isStream } = req.body;

    // Build system text
    const systemText = Array.isArray(system)
      ? system.filter(b => b.type === 'text').map(b => b.text).join('\n')
      : (typeof system === 'string' ? system : '');

    // Convert messages and tools to OpenAI format
    const openaiMessages = convertMessagesToOpenAI(anthropicMessages, systemText);
    const openaiTools = convertToolsToOpenAI(anthropicTools);

    const targetModel = CLOUD_MODEL_ID;
    const dsUrl = new URL('/v1/chat/completions', DEEPSEEK_BASE_URL);
    const proto = dsUrl.protocol === 'https:' ? https : http;

    if (isStream) {
      const streamBody = { model: targetModel, messages: openaiMessages, stream: true };
      if (openaiTools) streamBody.tools = openaiTools;
      const streamPayload = JSON.stringify(streamBody);
      const msgId = `msg_${Date.now()}`;

      const dsReq = proto.request({
        hostname: dsUrl.hostname,
        path: dsUrl.pathname,
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${DEEPSEEK_API_KEY}`,
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(streamPayload),
        },
        agent: false,
      }, dsRes => {
        console.log('[v1/messages/stream] upstream status:', dsRes.statusCode);
        dsRes.on('error', err => {
          console.error('[v1/messages/stream] upstream response stream error:', err.message);
          if (!res.writableEnded) {
            res.write(`event: error\ndata: ${JSON.stringify({ type: 'error', error: { type: 'api_error', message: 'Upstream stream interrupted' } })}\n\n`);
            res.end();
          }
        });

        if (dsRes.statusCode !== 200) {
          let errBody = '';
          dsRes.on('data', c => { errBody += c; });
          dsRes.on('end', () => {
            if (!res.headersSent) {
              res.status(502).json({ type: 'error', error: { type: 'api_error', message: `Upstream error: ${errBody}` } });
            }
          });
          return;
        }

        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('X-Accel-Buffering', 'no');
        res.write(`event: message_start\ndata: ${JSON.stringify({ type: 'message_start', message: { id: msgId, type: 'message', role: 'assistant', content: [], model: CLOUD_MODEL_NAME, stop_reason: null, stop_sequence: null, usage: { input_tokens: 0, output_tokens: 0 } } })}\n\n`);
        res.write(`event: ping\ndata: ${JSON.stringify({ type: 'ping' })}\n\n`);

        // State for converting OpenAI streaming tool_calls → Anthropic content_block events
        let textBlockStarted = false;
        let textBlockIndex = 0;
        // toolBlocks[openaiIndex] = { anthropicIndex, id, name, started, hasArgs }
        const toolBlocks = {};
        let nextBlockIndex = 0;
        let finalStopReason = 'end_turn';

        let buffer = '';
        dsRes.on('data', chunk => {
          buffer += chunk.toString();
          const lines = buffer.split('\n');
          buffer = lines.pop() ?? '';
          for (const line of lines) {
            if (!line.startsWith('data: ')) continue;
            const jsonStr = line.slice(6).trim();
            if (jsonStr === '[DONE]') continue;
            let delta;
            try {
              const parsed = JSON.parse(jsonStr);
              delta = parsed.choices?.[0]?.delta;
              const finishReason = parsed.choices?.[0]?.finish_reason;
              if (finishReason === 'tool_calls') finalStopReason = 'tool_use';
            } catch { /* skip malformed JSON */ }

            if (!delta) continue;

            // Text delta
            if (delta.content) {
              if (!textBlockStarted) {
                textBlockIndex = nextBlockIndex++;
                textBlockStarted = true;
                res.write(`event: content_block_start\ndata: ${JSON.stringify({ type: 'content_block_start', index: textBlockIndex, content_block: { type: 'text', text: '' } })}\n\n`);
              }
              res.write(`event: content_block_delta\ndata: ${JSON.stringify({ type: 'content_block_delta', index: textBlockIndex, delta: { type: 'text_delta', text: delta.content } })}\n\n`);
            }

            // Tool call deltas — separate from JSON parse try/catch so argument writes are never silently dropped
            if (Array.isArray(delta.tool_calls)) {
              for (const tc of delta.tool_calls) {
                const i = tc.index ?? 0;
                if (!toolBlocks[i]) {
                  // First chunk for this tool call: has id and name
                  const bIdx = nextBlockIndex++;
                  toolBlocks[i] = { anthropicIndex: bIdx, id: tc.id || `toolu_${i}`, name: tc.function?.name || '', started: true, hasArgs: false };
                  res.write(`event: content_block_start\ndata: ${JSON.stringify({ type: 'content_block_start', index: bIdx, content_block: { type: 'tool_use', id: toolBlocks[i].id, name: toolBlocks[i].name, input: {} } })}\n\n`);
                }
                if (tc.function?.arguments) {
                  toolBlocks[i].hasArgs = true;
                  res.write(`event: content_block_delta\ndata: ${JSON.stringify({ type: 'content_block_delta', index: toolBlocks[i].anthropicIndex, delta: { type: 'input_json_delta', partial_json: tc.function.arguments } })}\n\n`);
                }
              }
            }
          }
        });

        dsRes.on('end', async () => {
          if (res.writableEnded) return;
          deductCredits(deviceId).catch(() => {});
          // DeepSeek may send finish_reason: 'stop' even when making tool calls;
          // force tool_use if we collected any tool blocks
          if (Object.keys(toolBlocks).length > 0) finalStopReason = 'tool_use';
          // Warn if any tool block received no argument deltas — likely a model issue
          for (const tb of Object.values(toolBlocks)) {
            if (!tb.hasArgs) {
              console.warn(`[v1/messages/stream] tool call "${tb.name}" (${tb.id}) received no argument deltas — model may have generated empty params`);
            }
          }
          // Close all open blocks
          if (textBlockStarted) {
            res.write(`event: content_block_stop\ndata: ${JSON.stringify({ type: 'content_block_stop', index: textBlockIndex })}\n\n`);
          }
          for (const tb of Object.values(toolBlocks)) {
            res.write(`event: content_block_stop\ndata: ${JSON.stringify({ type: 'content_block_stop', index: tb.anthropicIndex })}\n\n`);
          }
          // If no blocks were opened at all (e.g. empty response), open+close a text block
          if (!textBlockStarted && Object.keys(toolBlocks).length === 0) {
            res.write(`event: content_block_start\ndata: ${JSON.stringify({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } })}\n\n`);
            res.write(`event: content_block_stop\ndata: ${JSON.stringify({ type: 'content_block_stop', index: 0 })}\n\n`);
          }
          res.write(`event: message_delta\ndata: ${JSON.stringify({ type: 'message_delta', delta: { stop_reason: finalStopReason, stop_sequence: null }, usage: { output_tokens: CREDITS_PER_CHAT } })}\n\n`);
          res.write(`event: message_stop\ndata: ${JSON.stringify({ type: 'message_stop' })}\n\n`);
          res.end();
          console.debug(`[v1/messages/stream] stop_reason=${finalStopReason}, tool_calls=${Object.keys(toolBlocks).length}`);
        });
      });

      dsReq.on('error', err => {
        console.error('[v1/messages/stream] upstream request failed:', err.message);
        if (!res.headersSent) {
          res.status(502).json({ type: 'error', error: { type: 'api_error', message: 'Upstream unavailable' } });
        } else if (!res.writableEnded) {
          res.write(`event: error\ndata: ${JSON.stringify({ type: 'error', error: { type: 'api_error', message: 'Upstream unavailable' } })}\n\n`);
          res.end();
        }
      });

      dsReq.write(streamPayload);
      dsReq.end();

    } else {
      const body = { model: targetModel, messages: openaiMessages, stream: false };
      if (openaiTools) body.tools = openaiTools;
      const payload = JSON.stringify(body);
      const options = {
        hostname: dsUrl.hostname,
        path: dsUrl.pathname,
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${DEEPSEEK_API_KEY}`,
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload),
        },
      };
      const dsReq = proto.request(options, dsRes => {
        let respBody = '';
        dsRes.on('data', c => { respBody += c; });
        dsRes.on('end', async () => {
          if (dsRes.statusCode !== 200) {
            return res.status(502).json({ type: 'error', error: { type: 'api_error', message: 'Upstream error' } });
          }
          let parsed;
          try { parsed = JSON.parse(respBody); } catch {
            return res.status(502).json({ type: 'error', error: { type: 'api_error', message: 'Upstream parse error' } });
          }
          deductCredits(deviceId).catch(() => {});
          const anthropicResp = convertResponseToAnthropic(parsed, CLOUD_MODEL_NAME);
          res.setHeader('X-Credits-Used', CREDITS_PER_CHAT);
          res.json(anthropicResp);
          console.debug(`[v1/messages] stop_reason=${anthropicResp.stop_reason}`);
        });
      });

      dsReq.on('error', err => {
        console.error('[v1/messages] upstream failed:', err);
        res.status(502).json({ type: 'error', error: { type: 'api_error', message: 'Upstream unavailable' } });
      });

      dsReq.write(payload);
      dsReq.end();
    }
  });
}

// ===========================================================================
// USERS ROLE ROUTES  (SERVER_ROLE === 'users')
// ===========================================================================
if (SERVER_ROLE === 'users') {

  // -------------------------------------------------------------------------
  // POST /auth/register
  // -------------------------------------------------------------------------
  app.post('/auth/register', (req, res) => {
    const { deviceId } = req.body;
    if (!validateDeviceId(deviceId)) {
      return res.status(400).json({ error: 'INVALID_DEVICE_ID' });
    }

    const existing = stmtGetUser.get(deviceId);
    if (existing) {
      return res.json({ deviceId, credits: existing.credits, isNew: false, modelId: CLOUD_MODEL_ID, modelName: CLOUD_MODEL_NAME });
    }

    stmtInsertUser.run(deviceId, FREE_CREDITS);
    console.log('[register] new device registered, credits=' + FREE_CREDITS);
    return res.json({ deviceId, credits: FREE_CREDITS, isNew: true, modelId: CLOUD_MODEL_ID, modelName: CLOUD_MODEL_NAME });
  });

  // -------------------------------------------------------------------------
  // GET /credits?deviceId=xxx
  // -------------------------------------------------------------------------
  app.get('/credits', (req, res) => {
    const { deviceId } = req.query;
    if (!validateDeviceId(deviceId)) {
      return res.status(400).json({ error: 'INVALID_DEVICE_ID' });
    }

    const row = stmtGetCredits.get(deviceId);
    if (!row) return res.status(404).json({ error: 'DEVICE_NOT_FOUND' });
    return res.json({ deviceId, credits: row.credits, modelId: CLOUD_MODEL_ID, modelName: CLOUD_MODEL_NAME });
  });

  // -------------------------------------------------------------------------
  // POST /pay/create
  // -------------------------------------------------------------------------
  app.post('/pay/create', async (req, res) => {
    const { deviceId, packageId, customAmount } = req.body;

    if (!validateDeviceId(deviceId)) {
      return res.status(400).json({ error: 'INVALID_DEVICE_ID' });
    }

    let pkg;
    if (packageId === 'pkg_custom') {
      const amt = Math.floor(Number(customAmount));
      if (!amt || amt < 1) return res.status(400).json({ error: 'INVALID_CUSTOM_AMOUNT' });
      pkg = { amount: amt, credits: amt * 1000, label: `UdiskAI 积分 · ${amt * 1000}` };
    } else {
      pkg = PACKAGES[packageId];
      if (!pkg) return res.status(400).json({ error: 'INVALID_PACKAGE' });
    }

    const user = stmtGetUser.get(deviceId);
    if (!user) return res.status(404).json({ error: 'DEVICE_NOT_FOUND' });

    const timestamp = Date.now();
    const orderId = `udiskai_${deviceId.slice(0, 8)}_${timestamp}`;
    stmtInsertOrder.run(orderId, deviceId, pkg.amount, pkg.credits);

    const nonceStr = crypto.randomBytes(8).toString('hex');
    const params = {
      appid: HUPIJIAO_APP_ID,
      trade_order_id: orderId,
      total_fee: pkg.amount.toFixed(2),
      title: pkg.label,
      notify_url: HUPIJIAO_NOTIFY_URL,
      nonce_str: nonceStr,
      time: Math.floor(timestamp / 1000),
    };
    params.hash = hupijiaoSign(params, HUPIJIAO_APP_SECRET);

    try {
      const result = await hupijiaoRequest(params);
      if (!result.url && !result.payUrl) {
        console.error('[pay/create] Hupijiao error:', result);
        return res.status(502).json({ error: 'PAYMENT_GATEWAY_ERROR', detail: result });
      }
      return res.json({
        orderId,
        payUrl: result.url || result.payUrl,
        amount: pkg.amount,
        credits: pkg.credits,
      });
    } catch (err) {
      console.error('[pay/create] failed:', err);
      return res.status(502).json({ error: 'PAYMENT_GATEWAY_UNAVAILABLE' });
    }
  });

  // -------------------------------------------------------------------------
  // POST /pay/notify  — called by Hupijiao server
  // -------------------------------------------------------------------------
  app.post('/pay/notify', (req, res) => {
    const params = req.body;

    const expectedHash = hupijiaoSign(params, HUPIJIAO_APP_SECRET);
    if (!params.hash || params.hash.toLowerCase() !== expectedHash) {
      console.warn('[pay/notify] signature mismatch, rejecting');
      return res.send('fail');
    }

    const orderId = params.trade_order_id;
    if (!orderId) return res.send('fail');

    const order = stmtGetOrder.get(orderId);
    if (!order) {
      console.warn('[pay/notify] unknown order:', orderId);
      return res.send('fail');
    }

    if (order.status === 'paid') return res.send('success');

    stmtAddCredits.run(order.credits, order.device_id);
    stmtPayOrder.run(orderId);
    console.log(`[pay/notify] order paid, added ${order.credits} credits to device`);

    return res.send('success');
  });

  // -------------------------------------------------------------------------
  // GET /pay/status?orderId=xxx
  // -------------------------------------------------------------------------
  app.get('/pay/status', (req, res) => {
    const { orderId } = req.query;
    if (!orderId) return res.status(400).json({ error: 'MISSING_ORDER_ID' });

    const order = stmtGetOrder.get(orderId);
    if (!order) return res.status(404).json({ error: 'ORDER_NOT_FOUND' });

    const payload = { orderId: order.order_id, status: order.status };
    if (order.status === 'paid') payload.credits = order.credits;
    return res.json(payload);
  });

  // -------------------------------------------------------------------------
  // POST /internal/deduct  — called by Server A after each LLM completion
  // Authorization: Bearer <INTERNAL_SECRET>
  // Body: { deviceId, amount }
  // -------------------------------------------------------------------------
  app.post('/internal/deduct', (req, res) => {
    const authHeader = req.headers['authorization'] || '';
    if (!INTERNAL_SECRET || authHeader !== `Bearer ${INTERNAL_SECRET}`) {
      return res.status(401).json({ error: 'UNAUTHORIZED' });
    }

    const { deviceId, amount } = req.body;
    if (!validateDeviceId(deviceId)) {
      return res.status(400).json({ error: 'INVALID_DEVICE_ID' });
    }
    const deductAmount = typeof amount === 'number' && amount > 0 ? amount : CREDITS_PER_CHAT;

    const user = stmtGetUser.get(deviceId);
    if (!user) return res.status(404).json({ error: 'DEVICE_NOT_FOUND' });

    stmtDeduct.run(deductAmount, deviceId);
    const updated = stmtGetCredits.get(deviceId);
    const credits = updated ? updated.credits : user.credits - deductAmount;
    console.debug(`[internal/deduct] deducted ${deductAmount} from device, remaining=${credits}`);

    return res.json({ deviceId, credits });
  });
}

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------
app.listen(PORT, () => {
  console.log(`[server] UdiskAI server (${SERVER_ROLE}) running on port ${PORT}`);
  if (SERVER_ROLE === 'llm') {
    if (!DEEPSEEK_API_KEY) console.warn('[server] DEEPSEEK_API_KEY not set');
    if (!USER_SERVER_URL) console.warn('[server] USER_SERVER_URL not set — credit deduction disabled');
    if (!INTERNAL_SECRET) console.warn('[server] INTERNAL_SECRET not set — credit deduction disabled');
  }
  if (SERVER_ROLE === 'users') {
    if (!HUPIJIAO_APP_ID) console.warn('[server] HUPIJIAO_APP_ID not set — payments disabled');
    if (!INTERNAL_SECRET) console.warn('[server] INTERNAL_SECRET not set — /internal/deduct will reject all calls');
  }
});
