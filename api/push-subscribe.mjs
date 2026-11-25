/**
 * api/push-subscribe.mjs — Vercel Serverless Function (ESM)
 *
 * POST   /api/push-subscribe  → salva inscrição + reminders no Redis
 * DELETE /api/push-subscribe  → remove inscrição do Redis
 * OPTIONS                     → preflight CORS
 *
 * Env vars necessárias na Vercel:
 *   UPSTASH_REDIS_REST_URL
 *   UPSTASH_REDIS_REST_TOKEN
 */

import { createHash } from 'node:crypto';

/* ── Helpers Redis (Upstash REST) ──────────────────────────────────── */

const redisUrl   = () => process.env.UPSTASH_REDIS_REST_URL;
const redisToken = () => process.env.UPSTASH_REDIS_REST_TOKEN;

/**
 * Executa um comando Redis via REST API do Upstash.
 * @param  {...(string|number)} args  Partes do comando, ex: 'HSET', 'sf_subs', key, value
 * @returns {Promise<any>} resultado da resposta JSON
 */
async function redis(...args) {
  const url   = redisUrl();
  const token = redisToken();

  if (!url || !token) {
    throw new Error('Upstash env vars não configuradas');
  }

  const res = await fetch(`${url}`, {
    method:  'POST',
    headers: {
      Authorization:  `Bearer ${token}`,
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

/* ── CORS headers ──────────────────────────────────────────────────── */

const CORS_HEADERS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Max-Age':       '86400',
};

function corsResponse(body, status = 200, extra = {}) {
  return new Response(
    typeof body === 'string' ? body : JSON.stringify(body),
    {
      status,
      headers: {
        'Content-Type': 'application/json',
        ...CORS_HEADERS,
        ...extra,
      },
    }
  );
}

/* ── Gera ID estável a partir do endpoint ──────────────────────────── */

function subIdFromEndpoint(endpoint) {
  return createHash('sha256').update(endpoint).digest('hex').slice(0, 24);
}

/* ── Handler principal ─────────────────────────────────────────────── */

export default async function handler(req) {
  const method = req.method.toUpperCase();

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  /* Preflight CORS */
  if (method === 'OPTIONS') {
    return corsResponse('', 204);
  }

  /* Lê body uma única vez */
  let body = {};
  try {
    body = await req.json();
  } catch {
    // Permite body vazio em DELETE sem payload
  }

  /* ── POST: Inscrever / atualizar reminders ── */
  if (method === 'POST') {
    const { subscription, reminders = [] } = body;

    if (!subscription?.endpoint) {
      return corsResponse({ error: 'subscription.endpoint obrigatório' }, 400);
    }

    // Valida que subscription tem as chaves VAPID mínimas
    if (!subscription?.keys?.p256dh || !subscription?.keys?.auth) {
      return corsResponse({ error: 'subscription.keys (p256dh, auth) obrigatórios' }, 400);
    }

    const subId = subIdFromEndpoint(subscription.endpoint);

    const record = JSON.stringify({
      subId,
      subscription,
      reminders,         // [{ id, type, title, releaseDate, poster_path }]
      updatedAt: new Date().toISOString(),
    });

    // HSET sf_subs <subId> <json>
    await redis('HSET', 'sf_subs', subId, record);

    return corsResponse({ ok: true, subId });
  }

  /* ── DELETE: Cancelar inscrição ── */
  if (method === 'DELETE' || body?.action === 'unsubscribe') {
    const { subscription } = body;

    if (!subscription?.endpoint) {
      return corsResponse({ error: 'subscription.endpoint obrigatório para cancelar' }, 400);
    }

    const subId = subIdFromEndpoint(subscription.endpoint);

    // Remove do hash
    await redis('HDEL', 'sf_subs', subId);

    return corsResponse({ ok: true, subId, removed: true });
  }

  /* Método não suportado */
  return corsResponse({ error: `Método ${method} não suportado` }, 405);
}

/* Diz à Vercel que é um Edge-compatible handler (opcional, funciona em Serverless também) */
export const config = {
  runtime: 'nodejs20.x',
};
