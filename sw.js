/* =====================================================================
 *  StreamFlix — Service Worker
 *  Responsável por:
 *   • Receber eventos push (mesmo com o site fechado)
 *   • Exibir notificações nativas via showNotification()
 *   • Redirecionar o usuário ao clicar na notificação
 * ===================================================================== */

const CACHE_NAME = 'sf-sw-v1';

/* ---------- Install ---------- */
self.addEventListener('install', (event) => {
  // Pula a fase de espera e ativa imediatamente
  self.skipWaiting();
});

/* ---------- Activate ---------- */
self.addEventListener('activate', (event) => {
  event.waitUntil(
    // Assume controle de todas as abas abertas imediatamente
    self.clients.claim()
  );
});

/* ---------- Push ---------- */
self.addEventListener('push', (event) => {
  let data = {};

  if (event.data) {
    try {
      data = event.data.json();
    } catch {
      // Fallback: texto simples
      data = { title: 'StreamFlix', body: event.data.text() };
    }
  }

  const {
    title   = 'StreamFlix',
    body    = 'Novo conteúdo disponível!',
    icon    = '/icons/icon-192x192.png',
    badge   = '/icons/badge-72x72.png',
    tag     = 'sf-notification',
    url     = '/',
  } = data;

  const options = {
    body,
    icon,
    badge,
    tag,
    data: { url },
    // Vibração: curta-pausa-longa
    vibrate: [200, 100, 400],
    // Mantém a notificação visível até o usuário interagir
    requireInteraction: false,
    // Recolhe notificações com mesmo tag (evita spam na Central)
    renotify: false,
    actions: [
      { action: 'open',    title: '▶ Assistir agora' },
      { action: 'dismiss', title: 'Fechar'            },
    ],
  };

  event.waitUntil(
    self.registration.showNotification(title, options)
  );
});

/* ---------- Notification Click ---------- */
self.addEventListener('notificationclick', (event) => {
  event.notification.close();

  // Ignora clique em "Fechar"
  if (event.action === 'dismiss') return;

  const targetUrl = (event.notification.data && event.notification.data.url)
    ? event.notification.data.url
    : '/';

  // Resolve URL absoluta para comparar com clientes abertos
  const absoluteUrl = new URL(targetUrl, self.location.origin).href;

  event.waitUntil(
    self.clients
      .matchAll({ type: 'window', includeUncontrolled: true })
      .then((windowClients) => {
        // Tenta focar aba já aberta na mesma origem
        for (const client of windowClients) {
          const clientUrl = new URL(client.url, self.location.origin).href;

          if (clientUrl === absoluteUrl && 'focus' in client) {
            return client.focus();
          }

          // Se a aba está na origem mas em outra rota, navega para a URL alvo
          if (
            new URL(client.url).origin === self.location.origin &&
            'navigate' in client
          ) {
            return client.focus().then((c) => c.navigate(absoluteUrl));
          }
        }

        // Nenhuma aba compatível: abre nova janela
        if (self.clients.openWindow) {
          return self.clients.openWindow(absoluteUrl);
        }
      })
  );
});
