'use strict';

const express = require('express');
const Database = require('better-sqlite3');
const crypto = require('crypto');
const https = require('https');
const http = require('http');
const path = require('path');
const fs = require('fs');

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
require('dotenv').config({ path: path.join(__dirname, '.env') });

const PORT              = parseInt(process.env.PORT || '3000', 10);
const DEEPSEEK_API_KEY  = process.env.DEEPSEEK_API_KEY || '';
const DEEPSEEK_BASE_URL = process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com';
const HUPIJIAO_APP_ID     = process.env.HUPIJIAO_APP_ID || '';
const HUPIJIAO_APP_SECRET = process.env.HUPIJIAO_APP_SECRET || '';
const HUPIJIAO_NOTIFY_URL = process.env.HUPIJIAO_NOTIFY_URL || '';
const FREE_CREDITS      = parseInt(process.env.FREE_CREDITS || '10000', 10);

// Packages: amount in CNY → credits (积分)
const PACKAGES = {
  pkg_10:  { amount: 10,  credits: 10_000,  label: 'UdiskAI 积分 · 10000' },
  pkg_30:  { amount: 30,  credits: 32_000,  label: 'UdiskAI 积分 · 32000' },
  pkg_100: { amount: 100, credits: 120_000, label: 'UdiskAI 积分 · 120000' },
};

// Credits deducted per chat completion (fixed, independent of token count)
const CREDITS_PER_CHAT = parseInt(process.env.CREDITS_PER_CHAT || '20', 10);

// Rate limit: per device, max requests per window
const RATE_WINDOW_MS = 1000;
const RATE_MAX       = 5;

// ---------------------------------------------------------------------------
// Database
// ---------------------------------------------------------------------------
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

// Prepared statements
const stmtGetUser    = db.prepare('SELECT * FROM users WHERE device_id = ?');
const stmtInsertUser = db.prepare('INSERT INTO users (device_id, credits) VALUES (?, ?)');
const stmtGetCredits = db.prepare('SELECT credits FROM users WHERE device_id = ?');
const stmtDeduct     = db.prepare('UPDATE users SET credits = credits - ? WHERE device_id = ? AND credits >= ?');
const stmtAddCredits = db.prepare('UPDATE users SET credits = credits + ? WHERE device_id = ?');
const stmtInsertOrder = db.prepare(
  'INSERT INTO orders (order_id, device_id, amount, credits) VALUES (?, ?, ?, ?)'
);
const stmtGetOrder   = db.prepare('SELECT * FROM orders WHERE order_id = ?');
const stmtPayOrder   = db.prepare("UPDATE orders SET status = 'paid' WHERE order_id = ?");

// ---------------------------------------------------------------------------
// Helpers
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
  return md5(str); // lowercase per xunhupay spec
}

// Simple in-memory rate limiter
const rateBuckets = new Map(); // deviceId → [timestamp, ...]
function checkRateLimit(deviceId) {
  const now = Date.now();
  const bucket = (rateBuckets.get(deviceId) || []).filter(t => now - t < RATE_WINDOW_MS);
  if (bucket.length >= RATE_MAX) return false;
  bucket.push(now);
  rateBuckets.set(deviceId, bucket);
  return true;
}
// Clean up rate buckets every minute
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
// App
// ---------------------------------------------------------------------------
const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// CORS — clients are Electron (file://) or localhost
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Device-Id');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// ---------------------------------------------------------------------------
// POST /auth/register
// ---------------------------------------------------------------------------
app.post('/auth/register', (req, res) => {
  const { deviceId } = req.body;
  if (!validateDeviceId(deviceId)) {
    return res.status(400).json({ error: 'INVALID_DEVICE_ID' });
  }

  const existing = stmtGetUser.get(deviceId);
  if (existing) {
    return res.json({ deviceId, credits: existing.credits, isNew: false });
  }

  stmtInsertUser.run(deviceId, FREE_CREDITS);
  console.log(`[register] new device registered, credits=${FREE_CREDITS}`);
  return res.json({ deviceId, credits: FREE_CREDITS, isNew: true });
});

// ---------------------------------------------------------------------------
// GET /credits?deviceId=xxx
// ---------------------------------------------------------------------------
app.get('/credits', (req, res) => {
  const { deviceId } = req.query;
  if (!validateDeviceId(deviceId)) {
    return res.status(400).json({ error: 'INVALID_DEVICE_ID' });
  }

  const row = stmtGetCredits.get(deviceId);
  if (!row) return res.status(404).json({ error: 'DEVICE_NOT_FOUND' });
  return res.json({ deviceId, credits: row.credits });
});

// ---------------------------------------------------------------------------
// POST /chat  — proxy to DeepSeek, deduct credits
// ---------------------------------------------------------------------------
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

  const user = stmtGetUser.get(deviceId);
  if (!user) return res.status(404).json({ error: 'DEVICE_NOT_FOUND' });
  if (user.credits < CREDITS_PER_CHAT) {
    return res.status(402).json({ error: 'INSUFFICIENT_CREDITS', credits: user.credits });
  }

  const isStream = stream === true || stream === 'true';
  const targetModel = model || 'deepseek-chat';
  const payload = JSON.stringify({ model: targetModel, messages, stream: isStream });

  const dsUrl = new URL('/v1/chat/completions', DEEPSEEK_BASE_URL);
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

  const proto = dsUrl.protocol === 'https:' ? https : http;

  if (isStream) {
    // --- Streaming ---
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

      dsRes.on('data', chunk => {
        res.write(chunk); // forward raw SSE chunk immediately
      });

      dsRes.on('end', () => {
        res.end();
        stmtDeduct.run(CREDITS_PER_CHAT, deviceId, CREDITS_PER_CHAT);
        console.debug(`[chat/stream] deducted ${CREDITS_PER_CHAT} credits for device`);
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
    // --- Non-streaming ---
    const dsReq = proto.request(options, dsRes => {
      let body = '';
      dsRes.on('data', c => { body += c; });
      dsRes.on('end', () => {
        if (dsRes.statusCode !== 200) {
          return res.status(502).json({ error: 'UPSTREAM_ERROR', detail: body });
        }
        let parsed;
        try { parsed = JSON.parse(body); }
        catch (e) {
          return res.status(502).json({ error: 'UPSTREAM_PARSE_ERROR' });
        }

        stmtDeduct.run(CREDITS_PER_CHAT, deviceId, CREDITS_PER_CHAT);
        const remaining = Math.max(0, user.credits - CREDITS_PER_CHAT);

        res.setHeader('X-Credits-Used', CREDITS_PER_CHAT);
        res.setHeader('X-Credits-Remaining', remaining);
        res.json(parsed);
        console.debug(`[chat] deducted ${CREDITS_PER_CHAT} credits, remaining ~${remaining}`);
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

// ---------------------------------------------------------------------------
// POST /pay/create
// ---------------------------------------------------------------------------
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

// ---------------------------------------------------------------------------
// POST /pay/notify  — called by Hupijiao server
// ---------------------------------------------------------------------------
app.post('/pay/notify', (req, res) => {
  const params = req.body;

  // Verify signature
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

  // Idempotent
  if (order.status === 'paid') return res.send('success');

  // Credit the user
  stmtAddCredits.run(order.credits, order.device_id);
  stmtPayOrder.run(orderId);
  console.log(`[pay/notify] order paid, added ${order.credits} credits to device`);

  return res.send('success');
});

// ---------------------------------------------------------------------------
// GET /pay/status?orderId=xxx
// ---------------------------------------------------------------------------
app.get('/pay/status', (req, res) => {
  const { orderId } = req.query;
  if (!orderId) return res.status(400).json({ error: 'MISSING_ORDER_ID' });

  const order = stmtGetOrder.get(orderId);
  if (!order) return res.status(404).json({ error: 'ORDER_NOT_FOUND' });

  const payload = { orderId: order.order_id, status: order.status };
  if (order.status === 'paid') payload.credits = order.credits;
  return res.json(payload);
});

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------
app.listen(PORT, () => {
  console.log(`[server] UdiskAI server running on port ${PORT}`);
  if (!DEEPSEEK_API_KEY) console.warn('[server] DEEPSEEK_API_KEY not set');
  if (!HUPIJIAO_APP_ID) console.warn('[server] HUPIJIAO_APP_ID not set — payments disabled');
});
