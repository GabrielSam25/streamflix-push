/**
 * api/push-subscribe.mjs — Vercel Serverless Function (ESM / Node.js)
 *
 * POST   /api/push-subscribe  → salva inscrição + reminders no Redis
 * DELETE /api/push-subscribe  → remove inscrição do Redis
 * OPTIONS                     → preflight CORS
 */

import { createHash } from 'node:crypto';

/* ── Helpers Redis (Upstash REST) ──────────────────────────────────── */

async function redis(...args) {
  const url   = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;

  if (!url || !token) {
    throw new Error('Upstash env vars não configuradas');
  }

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(args),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Redis REST error ${res.status}: ${text}`);
  }

  const json = await res.json();
  return json.result;
}

/* ── CORS + leitura segura do body ─────────────────────────────────── */

function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Access-Control-Max-Age', '86400');
}

async function readJsonBody(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  if (typeof req.body === 'string') {
    try { return JSON.parse(req.body || '{}'); } catch { return {}; }
  }

  const chunks = [];
  for await (const chunk of req) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
  }
  const raw = Buffer.concat(chunks).toString('utf8').trim();
  if (!raw) return {};
  try { return JSON.parse(raw); } catch { return {}; }
}

/* ── Gera ID estável a partir do endpoint ──────────────────────────── */

function subIdFromEndpoint(endpoint) {
  return createHash('sha256').update(endpoint).digest('hex').slice(0, 24);
}

/* ── Handler principal (Node.js Serverless) ────────────────────────── */

export default async function handler(req, res) {
  setCors(res);

  const method = (req.method || 'GET').toUpperCase();

  /* Preflight CORS */
  if (method === 'OPTIONS') {
    return res.status(200).end();
  }

  try {
    const body = await readJsonBody(req);

    /* ── POST: Inscrever / atualizar reminders ── */
    if (method === 'POST') {
      const { subscription, reminders = [] } = body;

      if (!subscription?.endpoint) {
        return res.status(400).json({ error: 'subscription.endpoint obrigatório' });
      }

      if (!subscription?.keys?.p256dh || !subscription?.keys?.auth) {
        return res.status(400).json({ error: 'subscription.keys (p256dh, auth) obrigatórios' });
      }

      const subId = subIdFromEndpoint(subscription.endpoint);

      const record = JSON.stringify({
        subId,
        subscription,
        reminders,
        updatedAt: new Date().toISOString(),
      });

      await redis('HSET', 'sf_subs', subId, record);

      return res.status(200).json({ ok: true, subId });
    }

    /* ── DELETE: Cancelar inscrição ── */
    if (method === 'DELETE' || body?.action === 'unsubscribe') {
      const { subscription } = body;

      if (!subscription?.endpoint) {
        return res.status(400).json({ error: 'subscription.endpoint obrigatório para cancelar' });
      }

      const subId = subIdFromEndpoint(subscription.endpoint);

      await redis('HDEL', 'sf_subs', subId);

      return res.status(200).json({ ok: true, subId, removed: true });
    }

    return res.status(405).json({ error: `Método ${method} não suportado` });
  } catch (err) {
    return res.status(500).json({ error: err?.message || 'Erro interno' });
  }
}
