/* MailSorta PWA Service Worker
 * 缓存策略：
 *  - 导航请求（HTML）：网络优先，失败回退缓存（保证离线可打开应用壳）
 *  - 静态资源（带哈希的构建产物 / 图标 / manifest）：缓存优先，加速二次加载
 *  - 仅处理同源 GET；API 请求（/api/*）一律网络直连，不缓存（避免数据过期）
 */
const CACHE = 'mailsorta-v2';
const PRECACHE = ['/', '/index.html', '/manifest.webmanifest', '/icons/icon.svg'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) => cache.addAll(PRECACHE))
      .catch(() => undefined)
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  // API 请求不缓存
  if (url.pathname.startsWith('/api/')) return;

  // 导航请求：网络优先
  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req)
        .then((res) => {
          const copy = res.clone();
          caches.open(CACHE).then((cache) => cache.put('/', copy)).catch(() => undefined);
          return res;
        })
        .catch(() => caches.match('/').then((hit) => hit || caches.match('/index.html')))
    );
    return;
  }

  // 静态资源：缓存优先
  event.respondWith(
    caches.match(req).then(
      (hit) =>
        hit ||
        fetch(req)
          .then((res) => {
            if (res && res.status === 200 && res.type === 'basic') {
              const copy = res.clone();
              caches.open(CACHE).then((cache) => cache.put(req, copy)).catch(() => undefined);
            }
            return res;
          })
          .catch(() => hit)
    )
  );
});
