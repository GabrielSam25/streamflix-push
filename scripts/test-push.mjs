#!/usr/bin/env node
import * as webpushNS from 'web-push';

const webpush = webpushNS.default || webpushNS;
const REDIS_URL = process.env.UPSTASH_REDIS_REST_URL;
const REDIS_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;
const SITE_URL = (process.env.SITE_URL || '').replace(/\/$/, '') || '/';

async function redis(...args) {
  const res = await fetch(REDIS_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${REDIS_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(args),
  });
  if (!res.ok) throw new Error(`Redis REST ${res.status}: ${await res.text()}`);
  return (await res.json()).result;
}

async function main() {
  for (const v of ['UPSTASH_REDIS_REST_URL', 'UPSTASH_REDIS_REST_TOKEN', 'VAPID_PUBLIC_KEY', 'VAPID_PRIVATE_KEY']) {
    if (!process.env[v]) throw new Error(`Env var ausente: ${v}`);
  }

  webpush.setVapidDetails(
    process.env.VAPID_SUBJECT || 'mailto:admin@streamflix.app',
    process.env.VAPID_PUBLIC_KEY,
    process.env.VAPID_PRIVATE_KEY
  );

  const flat = await redis('HGETALL', 'sf_subs');
  if (!flat || flat.length === 0) {
    console.log('Nenhuma inscrição encontrada em sf_subs.');
    return;
  }

  const payload = JSON.stringify({
    title: process.env.TEST_TITLE || 'Teste StreamFlix 🔔',
    body: process.env.TEST_BODY || 'Se você recebeu isso no PC e no celular, o Web Push está 100% funcionando!',
    icon: '/favicon.svg',
    tag: `sf-test-${Date.now()}`,
    url: SITE_URL,
  });

  let sent = 0, expired = 0, failed = 0;

  for (let i = 0; i < flat.length; i += 2) {
    let entry;
    try { entry = JSON.parse(flat[i + 1]); } catch { continue; }

    try {
      await webpush.sendNotification(entry.subscription, payload);
      sent++;
      console.log(`✅ Enviado para ${entry.subId}`);
    } catch (err) {
      const code = err.statusCode || err.status;
      if (code === 404 || code === 410) {
        expired++;
        await redis('HDEL', 'sf_subs', entry.subId);
        console.log(`🗑 Expirada e removida: ${entry.subId}`);
      } else {
        failed++;
        console.error(`❌ Erro em ${entry.subId}:`, code || err.message);
      }
    }
  }

  console.log(`Resumo → Enviadas: ${sent} | Expiradas: ${expired} | Erros: ${failed}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
