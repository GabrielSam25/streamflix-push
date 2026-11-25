#!/usr/bin/env node
/**
 * scripts/check-and-push.mjs — Executado pelo GitHub Actions a cada 2h
 *
 * Fluxo:
 *  1. Lê todas as inscrições de sf_subs no Redis
 *  2. Coleta títulos relevantes (reminders + lançamentos recentes TMDB)
 *  3. Verifica disponibilidade nas fontes (com cache sf_available)
 *  4. Envia Web Push para inscritos interessados (sem duplicar — sf_sent)
 *  5. Remove inscrições expiradas (endpoint retornou 404/410)
 *
 * Env vars necessárias (GitHub Actions Secrets):
 *   UPSTASH_REDIS_REST_URL   UPSTASH_REDIS_REST_TOKEN
 *   VAPID_PUBLIC_KEY         VAPID_PRIVATE_KEY
 *   TMDB_BEARER              (ou TMDB_API_KEY como fallback)
 *   SITE_URL                 (ex: https://streamflix.vercel.app)
 *   VAPID_SUBJECT            (opcional, ex: mailto:admin@streamflix.app)
 */

import * as webpush from 'web-push';

/* ════════════════════════════════════════════════════════════════════
 *  REDIS (Upstash REST)
 * ════════════════════════════════════════════════════════════════════ */

const REDIS_URL   = process.env.UPSTASH_REDIS_REST_URL;
const REDIS_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;

async function redis(...args) {
  const res = await fetch(REDIS_URL, {
    method:  'POST',
    headers: {
      Authorization:  `Bearer ${REDIS_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(args),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Redis REST ${res.status}: ${text}`);
  }

  return (await res.json()).result;
}

/** Lê todas as inscrições do hash sf_subs → [{ subId, subscription, reminders }] */
async function getAllSubscriptions() {
  const flat = await redis('HGETALL', 'sf_subs');
  if (!flat || flat.length === 0) return [];

  const subs = [];
  for (let i = 0; i < flat.length; i += 2) {
    try {
      subs.push(JSON.parse(flat[i + 1]));
    } catch {
      // Registro corrompido — ignora
    }
  }
  return subs;
}

/** Lê chave string do Redis (retorna null se inexistente) */
async function redisGet(key) {
  try {
    return await redis('GET', key);
  } catch {
    return null;
  }
}

/** Grava chave string no Redis com TTL em segundos */
async function redisSetEx(key, ttlSeconds, value) {
  await redis('SET', key, value, 'EX', ttlSeconds);
}

/** Verifica se chave existe */
async function redisExists(key) {
  const r = await redis('EXISTS', key);
  return r === 1;
}

/* ════════════════════════════════════════════════════════════════════
 *  TMDB
 * ════════════════════════════════════════════════════════════════════ */

const TMDB_BASE = 'https://api.themoviedb.org/3';

function tmdbHeaders() {
  if (process.env.TMDB_BEARER) {
    return { Authorization: `Bearer ${process.env.TMDB_BEARER}` };
  }
  return {}; // usará api_key na query
}

function tmdbApiKeyParam() {
  return process.env.TMDB_API_KEY ? `api_key=${process.env.TMDB_API_KEY}` : '';
}

function buildTmdbUrl(path, params = {}) {
  const url = new URL(`${TMDB_BASE}${path}`);
  if (tmdbApiKeyParam()) url.searchParams.set('api_key', process.env.TMDB_API_KEY);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  return url.toString();
}

async function tmdbFetch(path, params = {}) {
  const url = buildTmdbUrl(path, params);
  const res = await fetch(url, { headers: tmdbHeaders() });
  if (!res.ok) throw new Error(`TMDB ${res.status} → ${path}`);
  return res.json();
}

/** Busca lançamentos recentes do TMDB (últimos N dias, popularidade >= minPop) */
async function fetchRecentReleases(type, daysBack = 3, minPop = 4) {
  const dateEnd   = new Date();
  const dateStart = new Date(Date.now() - daysBack * 86_400_000);

  const fmt = (d) => d.toISOString().slice(0, 10);

  const dateField = type === 'movie'
    ? 'primary_release_date'
    : 'first_air_date';

  const data = await tmdbFetch(`/discover/${type}`, {
    [`${dateField}.gte`]: fmt(dateStart),
    [`${dateField}.lte`]: fmt(dateEnd),
    'vote_count.gte':     1,
    'popularity.gte':     minPop,
    sort_by:              'popularity.desc',
    page:                 1,
    language:             'pt-BR',
  });

  return (data.results || []).map((r) => ({
    id:          r.id,
    type,
    title:       r.title || r.name,
    releaseDate: r.release_date || r.first_air_date || null,
    poster_path: r.poster_path || null,
  }));
}

/** Busca external_ids (para obter imdb_id) */
async function fetchExternalIds(tmdbId, type) {
  try {
    const path = type === 'movie' ? `/movie/${tmdbId}/external_ids` : `/tv/${tmdbId}/external_ids`;
    const data = await tmdbFetch(path);
    return data.imdb_id || null;
  } catch {
    return null;
  }
}

/* ════════════════════════════════════════════════════════════════════
 *  FONTES DE STREAM
 * ════════════════════════════════════════════════════════════════════ */

const TIMEOUT_MS = 10_000;

function withTimeout(promise, ms = TIMEOUT_MS) {
  return Promise.race([
    promise,
    new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), ms)),
  ]);
}

/**
 * Valida se a resposta da fonte corresponde ao título pedido.
 * Aceita a resposta apenas se tmdbId e mediaType (quando presentes) baterem.
 */
function validateSource(data, expectedId, expectedType) {
  if (!data || typeof data !== 'object') return false;

  // Verifica tmdbId — aceita string ou número
  if (data.tmdbId !== undefined) {
    const returnedId = Number(data.tmdbId);
    if (returnedId !== Number(expectedId)) return false;
  }

  // Verifica mediaType — normaliza movie/series/tv
  if (data.mediaType !== undefined) {
    const normalize = (t) => (t === 'series' ? 'tv' : t);
    if (normalize(data.mediaType) !== normalize(expectedType)) return false;
  }

  return true;
}

/** Fonte 1 — testar-fontes.vercel.app */
async function checkTestarFontes({ tmdbId, type }) {
  try {
    const params = new URLSearchParams({
      tmdb:    tmdbId,
      type:    type === 'tv' ? 'tv' : 'movie',
      season:  '1',
      episode: '1',
    });

    const res = await withTimeout(
      fetch(`https://testar-fontes.vercel.app/api/extract?${params}`)
    );
    if (!res.ok) return false;

    const data = await res.json();
    return validateSource(data, tmdbId, type) && !!(data.url || data.sources?.length);
  } catch {
    return false;
  }
}

/** Fonte 2 — rynex-api.vercel.app */
async function checkRynexApi({ tmdbId, type }) {
  try {
    const params = new URLSearchParams({
      tmdb:    tmdbId,
      type:    type === 'tv' ? 'series' : 'movie',
      season:  '1',
      episode: '1',
    });

    const res = await withTimeout(
      fetch(`https://rynex-api.vercel.app/api/extract?${params}`)
    );
    if (!res.ok) return false;

    const data = await res.json();
    return validateSource(data, tmdbId, type) && !!(data.url || data.sources?.length);
  } catch {
    return false;
  }
}

/** Fonte 3 — redecanais.forum */
async function checkRedeCanais({ tmdbId, type }) {
  try {
    const body = new URLSearchParams({
      type:    type === 'tv' ? 'episode' : 'movie',
      tmdb:    tmdbId,
      season:  '1',
      episode: '1',
    });

    const res = await withTimeout(
      fetch('https://redecanais.forum/wp-json/api/v1/player', {
        method:  'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body:    body.toString(),
      })
    );
    if (!res.ok) return false;

    const data = await res.json();
    return validateSource(data, tmdbId, type) && !!(data.url || data.embedUrl || data.player);
  } catch {
    return false;
  }
}

/** Fonte 4 — fenixflix.fenixhub.online (precisa de imdb_id) */
async function checkFenixFlix({ tmdbId, type, imdbId }) {
  try {
    if (!imdbId) return false;

    const params = new URLSearchParams({ imdb_id: imdbId });
    const res = await withTimeout(
      fetch(`https://fenixflix.fenixhub.online/stream?${params}`)
    );
    if (!res.ok) return false;

    const data = await res.json();
    return !!(data.url || data.sources?.length || data.stream);
  } catch {
    return false;
  }
}

/** Verifica todas as fontes em paralelo; retorna true se qualquer uma responder */
async function isAvailableOnAnySource({ tmdbId, type, imdbId }) {
  const checks = await Promise.allSettled([
    checkTestarFontes({ tmdbId, type }),
    checkRynexApi({ tmdbId, type }),
    checkRedeCanais({ tmdbId, type }),
    checkFenixFlix({ tmdbId, type, imdbId }),
  ]);

  return checks.some((r) => r.status === 'fulfilled' && r.value === true);
}

/* ════════════════════════════════════════════════════════════════════
 *  URLS DO SITE
 * ════════════════════════════════════════════════════════════════════ */

const SITE_URL = (process.env.SITE_URL || '').replace(/\/$/, '');

function slugify(str = '') {
  return str
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

function buildWatchUrl(type, id, title) {
  const slug = slugify(title);
  if (type === 'movie') return `${SITE_URL}/assistir/filmes/${slug}-${id}`;
  return `${SITE_URL}/assistir/series/${slug}-${id}/temporada/1/episodio/1`;
}

/* ════════════════════════════════════════════════════════════════════
 *  WEB PUSH
 * ════════════════════════════════════════════════════════════════════ */

function setupWebPush() {
  const subject = process.env.VAPID_SUBJECT || `mailto:admin@streamflix.app`;
  webpush.setVapidDetails(
    subject,
    process.env.VAPID_PUBLIC_KEY,
    process.env.VAPID_PRIVATE_KEY
  );
}

/**
 * Envia notificação push para uma inscrição.
 * Retorna: 'sent' | 'expired' | 'error'
 */
async function sendPush(subscription, payload) {
  try {
    await webpush.sendNotification(subscription, JSON.stringify(payload));
    return 'sent';
  } catch (err) {
    const statusCode = err.statusCode || err.status;
    if (statusCode === 404 || statusCode === 410) return 'expired';
    console.error('  ⚠ sendNotification error:', err.message);
    return 'error';
  }
}

/* ════════════════════════════════════════════════════════════════════
 *  MAIN
 * ════════════════════════════════════════════════════════════════════ */

async function main() {
  console.log(`\n🚀 check-and-push iniciado — ${new Date().toISOString()}`);

  /* 1. Valida env vars */
  const required = [
    'UPSTASH_REDIS_REST_URL', 'UPSTASH_REDIS_REST_TOKEN',
    'VAPID_PUBLIC_KEY', 'VAPID_PRIVATE_KEY',
  ];
  for (const v of required) {
    if (!process.env[v]) throw new Error(`Env var obrigatória não definida: ${v}`);
  }
  if (!process.env.TMDB_BEARER && !process.env.TMDB_API_KEY) {
    throw new Error('Nenhuma credencial TMDB definida (TMDB_BEARER ou TMDB_API_KEY)');
  }

  setupWebPush();

  /* 2. Lê inscrições */
  console.log('📡 Lendo inscrições do Redis...');
  const subscriptions = await getAllSubscriptions();

  if (subscriptions.length === 0) {
    console.log('✅ Nenhuma inscrição ativa — encerrando sem gastar recursos.');
    return;
  }
  console.log(`   ${subscriptions.length} inscrição(ões) encontrada(s).`);

  /* 3. Coleta títulos de interesse: reminders + lançamentos recentes */
  const titlesMap = new Map(); // key: `${type}:${id}` → { id, type, title, poster_path }

  // 3a. Reminders de cada inscrito
  for (const sub of subscriptions) {
    for (const r of sub.reminders || []) {
      if (r?.id && r?.type) {
        const key = `${r.type}:${r.id}`;
        if (!titlesMap.has(key)) titlesMap.set(key, r);
      }
    }
  }

  // 3b. Lançamentos recentes do TMDB
  console.log('🎬 Buscando lançamentos recentes no TMDB...');
  try {
    const [recentMovies, recentTv] = await Promise.all([
      fetchRecentReleases('movie'),
      fetchRecentReleases('tv'),
    ]);
    for (const item of [...recentMovies, ...recentTv]) {
      const key = `${item.type}:${item.id}`;
      if (!titlesMap.has(key)) titlesMap.set(key, item);
    }
    console.log(`   ${recentMovies.length} filmes + ${recentTv.length} séries recentes.`);
  } catch (err) {
    console.warn('  ⚠ Falha ao buscar lançamentos TMDB:', err.message);
  }

  const titles = [...titlesMap.values()];
  console.log(`📋 Total de títulos a verificar: ${titles.length}`);

  /* 4. Para cada título, verifica disponibilidade (com cache Redis) */
  const availableNow = []; // títulos confirmados disponíveis neste ciclo

  for (const item of titles) {
    const cacheKey = `sf_available:${item.type}:${item.id}`;
    const cached   = await redisGet(cacheKey);

    if (cached === '1') {
      // Já confirmado em ciclo anterior — não reenvia (controlado por sf_sent)
      availableNow.push(item);
      continue;
    }

    if (cached === '0') {
      // Verificado recentemente e não disponível — pula
      continue;
    }

    // Sem cache: consulta as fontes
    console.log(`🔍 Verificando "${item.title}" (${item.type} ${item.id})...`);

    let imdbId = null;
    try {
      imdbId = await fetchExternalIds(item.id, item.type);
    } catch {
      // imdbId opcional — fenixflix não será usado
    }

    const available = await isAvailableOnAnySource({
      tmdbId: item.id,
      type:   item.type,
      imdbId,
    });

    if (available) {
      console.log(`  ✅ Disponível: "${item.title}"`);
      // Cache positivo por 48h (evita re-verificar o que já está disponível)
      await redisSetEx(cacheKey, 172_800, '1');
      availableNow.push(item);
    } else {
      console.log(`  ⏳ Indisponível: "${item.title}"`);
      // Cache negativo por 2h (próximo ciclo verificará novamente)
      await redisSetEx(cacheKey, 7_200, '0');
    }
  }

  console.log(`\n📬 ${availableNow.length} título(s) disponível(is) para notificar.`);

  if (availableNow.length === 0) {
    console.log('✅ Nada a notificar neste ciclo.');
    return;
  }

  /* 5. Envia notificações */
  const expiredSubIds = [];
  let totalSent = 0;

  for (const sub of subscriptions) {
    const { subId, subscription, reminders = [] } = sub;

    // Interesses desta inscrição (reminders + "todos" os lançamentos recentes se sem reminders)
    const interestedIds = new Set(reminders.map((r) => `${r.type}:${r.id}`));

    for (const item of availableNow) {
      const itemKey  = `${item.type}:${item.id}`;
      const sentKey  = `sf_sent:${subId}:${item.type}:${item.id}`;

      // Pula se não está nos interesses deste usuário (e ele tem reminders definidos)
      if (interestedIds.size > 0 && !interestedIds.has(itemKey)) continue;

      // Pula se já foi notificado antes
      const alreadySent = await redisExists(sentKey);
      if (alreadySent) continue;

      const url     = buildWatchUrl(item.type, item.id, item.title);
      const typeStr = item.type === 'movie' ? 'Filme' : 'Série';
      const icon    = item.poster_path
        ? `https://image.tmdb.org/t/p/w92${item.poster_path}`
        : '/icons/icon-192x192.png';

      const payload = {
        title: `${typeStr} disponível! 🎬`,
        body:  `"${item.title}" já está disponível para assistir.`,
        icon,
        badge: '/icons/badge-72x72.png',
        tag:   `sf-${item.type}-${item.id}`,
        url,
      };

      console.log(`  📤 Enviando para ${subId.slice(0, 8)}… → "${item.title}"`);
      const result = await sendPush(subscription, payload);

      if (result === 'sent') {
        totalSent++;
        // Marca como enviado — expira em 30 dias para limpar Redis
        await redisSetEx(sentKey, 2_592_000, '1');

      } else if (result === 'expired') {
        console.log(`  🗑 Inscrição expirada: ${subId}`);
        if (!expiredSubIds.includes(subId)) expiredSubIds.push(subId);
        break; // Não adianta continuar para esta inscrição

      }
      // 'error': já logado dentro de sendPush — continua para próximo item
    }
  }

  /* 6. Remove inscrições expiradas */
  if (expiredSubIds.length > 0) {
    console.log(`\n🧹 Removendo ${expiredSubIds.length} inscrição(ões) expirada(s)...`);
    for (const subId of expiredSubIds) {
      await redis('HDEL', 'sf_subs', subId);
    }
  }

  console.log(`\n✅ Concluído — ${totalSent} notificação(ões) enviada(s).`);
  console.log(`   Encerrado: ${new Date().toISOString()}\n`);
}

main().catch((err) => {
  console.error('❌ Erro fatal:', err);
  process.exit(1);
});
