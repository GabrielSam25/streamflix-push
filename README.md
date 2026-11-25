# 🔔 StreamFlix — Web Push 24h (Vercel + Upstash + GitHub Actions)

> Notificações push gratuitas sem servidor ligado 24h, sem banco pago.

---

## 📂 Estrutura do projeto

```
streamflix-webpush/
├── sw.js                                ← Service Worker (copiar para public/)
├── manifest.json                        ← PWA Manifest  (copiar para public/)
├── vercel.json                          ← Config da Vercel
├── .env                                 ← Variáveis locais (NÃO commitar)
├── .env.example                         ← Modelo sem segredos (pode commitar)
├── .gitignore
├── api/
│   └── push-subscribe.mjs               ← Endpoint Vercel (POST/DELETE)
├── scripts/
│   └── check-and-push.mjs               ← Script do cron
└── .github/
    └── workflows/
        └── agenda-push.yml              ← GitHub Actions (a cada 2h)
```

---

## ✅ Passo a passo completo

### PASSO 1 — Obter token do TMDB

1. Acesse **themoviedb.org** → crie conta gratuita
2. Vá em **Settings → API → Request an API Key**
3. Copie o **API Read Access Token** (começa com `eyJ...`)
4. Cole no `.env` no campo `TMDB_BEARER`

---

### PASSO 2 — Preencher o .env

Abra o arquivo `.env` e preencha os dois campos que estão vazios:

```env
TMDB_BEARER="eyJhbGciOiJSUzI1NiJ9..."   ← token do passo 1
SITE_URL="https://seusite.vercel.app"    ← URL real do seu site na Vercel
```

> Os demais campos (Upstash + VAPID) já estão preenchidos.

---

### PASSO 3 — Copiar arquivos para o seu projeto existente

> Se você já tem um projeto Next.js / Nuxt / Vite na Vercel, copie assim:

| Arquivo deste ZIP | Destino no SEU projeto |
|---|---|
| `sw.js` | `public/sw.js` |
| `manifest.json` | `public/manifest.json` |
| `vercel.json` | raiz do projeto (se já existir, mescle o conteúdo) |
| `.env` | raiz do projeto |
| `.env.example` | raiz do projeto |
| `.gitignore` | mescle com o seu |
| `api/push-subscribe.mjs` | `api/push-subscribe.mjs` |
| `scripts/check-and-push.mjs` | `scripts/check-and-push.mjs` |
| `.github/workflows/agenda-push.yml` | `.github/workflows/agenda-push.yml` |

---

### PASSO 4 — Adicionar o manifest no HTML

No `<head>` de todas as páginas (ou no `_document.jsx` / `app.html`):

```html
<link rel="manifest" href="/manifest.json">
<meta name="theme-color" content="#e50914">
```

---

### PASSO 5 — Adicionar variáveis na Vercel

1. Abra **vercel.com** → seu projeto → **Settings → Environment Variables**
2. Adicione uma por uma:

| Nome | Valor |
|---|---|
| `UPSTASH_REDIS_REST_URL` | `https://driven-lizard-184733.upstash.io` |
| `UPSTASH_REDIS_REST_TOKEN` | *(seu token Upstash)* |

---

### PASSO 6 — Adicionar secrets no GitHub

1. Abra seu repositório no GitHub
2. Vá em **Settings → Secrets and variables → Actions**
3. Clique em **New repository secret** e adicione cada um:

| Secret | Valor |
|---|---|
| `UPSTASH_REDIS_REST_URL` | `https://driven-lizard-184733.upstash.io` |
| `UPSTASH_REDIS_REST_TOKEN` | *(seu token Upstash)* |
| `VAPID_PUBLIC_KEY` | `BBmadIag_26Ddps18qpsL872t8fcQ9...` |
| `VAPID_PRIVATE_KEY` | `_0mjmKEWR0h5I2KByEHrwflVF62Ucd...` |
| `VAPID_SUBJECT` | `mailto:admin@streamflix.app` |
| `TMDB_BEARER` | *(token do TMDB — passo 1)* |
| `SITE_URL` | `https://seusite.vercel.app` |

---

### PASSO 7 — Integrar no frontend (pedir permissão ao usuário)

Adicione este código no botão "Ativar notificações" do seu site.
Substitua `SUA_VAPID_PUBLIC_KEY` pela chave pública real:

```js
// helpers/webpush.js  (ou inline no componente)

const VAPID_PUBLIC_KEY = 'BBmadIag_26Ddps18qpsL872t8fcQ9esX8Xdx4C_W_VE41iOXcCVpHGcJvlewKri5QbpmNjQELCgCnFRTLu9KKY';

export async function ativarNotificacoes(reminders = []) {
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
    alert('Seu navegador não suporta notificações push.');
    return;
  }

  // 1. Registra o Service Worker
  const reg = await navigator.serviceWorker.register('/sw.js');

  // 2. Pede permissão
  const permission = await Notification.requestPermission();
  if (permission !== 'granted') {
    console.warn('Permissão negada pelo usuário.');
    return;
  }

  // 3. Cria inscrição push
  const sub = await reg.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: VAPID_PUBLIC_KEY,
  });

  // 4. Envia para o backend (salva no Redis)
  const res = await fetch('/api/push-subscribe', {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      subscription: sub.toJSON(),
      reminders,   // ex: [{ id: 550, type: 'movie', title: 'Fight Club', releaseDate: '1999-10-15' }]
    }),
  });

  const data = await res.json();
  console.log('Inscrito!', data.subId);
}

export async function desativarNotificacoes() {
  const reg = await navigator.serviceWorker.ready;
  const sub = await reg.pushManager.getSubscription();
  if (!sub) return;

  await fetch('/api/push-subscribe', {
    method:  'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ subscription: sub.toJSON() }),
  });

  await sub.unsubscribe();
  console.log('Inscrição cancelada.');
}
```

---

### PASSO 8 — Fazer o deploy

```bash
git add .
git commit -m "feat: web push notifications"
git push
```

A Vercel fará o deploy automaticamente.

---

### PASSO 9 — Testar o cron manualmente

1. Abra seu repositório no GitHub
2. Vá em **Actions → 🔔 StreamFlix — Web Push (a cada 2h)**
3. Clique em **Run workflow → Run workflow**
4. Aguarde ~1 min e veja o log

Se aparecer `✅ Concluído` no log, está funcionando.
A partir daí o cron roda sozinho a cada 2 horas.

---

## 🗄️ O que fica salvo no Redis

| Chave | O que é |
|---|---|
| `sf_subs` | Hash com todas as inscrições ativas |
| `sf_available:{type}:{id}` | Cache de disponibilidade (2h se não disponível, 48h se disponível) |
| `sf_sent:{subId}:{type}:{id}` | Controle anti-duplicata (expira em 30 dias) |

---

## ⚠️ Aviso de segurança

As chaves VAPID e tokens Upstash **nunca** devem ir para o repositório Git.
O arquivo `.env` já está no `.gitignore` — confirme antes de commitar.

Para gerar novas chaves VAPID quando necessário:
```bash
npx web-push generate-vapid-keys
```
