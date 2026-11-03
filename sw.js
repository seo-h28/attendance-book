// 와이파이가 끊겨도 출석 체크 화면이 열리도록 앱 파일을 기기에 보관한다.
// 앱 파일을 수정해 다시 올릴 때는 VERSION 을 js/app.js 의 APP_VERSION 과 같이 올려 주세요.
const VERSION = '1.0.0';
const FILES = [
  './',
  'index.html',
  'css/style.css',
  'js/app.js',
  'js/store.js',
  'js/hangul.js',
  'js/xlsx.js',
  'js/roster.js',
  'js/book.js',
  'js/demo.js',
  'manifest.webmanifest',
  'icon.svg',
];

self.addEventListener('install', (e) => {
  // cache: 'reload' = 브라우저 캐시가 아닌 서버에서 새로 받아 보관
  const requests = FILES.map((f) => new Request(f, { cache: 'reload' }));
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(requests)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

// 인터넷이 되면 최신 파일, 안 되면(또는 3초 넘게 느리면) 보관해 둔 파일
self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET' || new URL(e.request.url).origin !== location.origin) return;
  e.respondWith(
    (async () => {
      const cache = await caches.open(VERSION);
      // no-cache: 브라우저 캐시에 남은 옛 파일 대신 서버에 새 버전이 있는지 확인한다
      const network = fetch(e.request, { cache: 'no-cache' }).then((res) => {
        if (res.ok) cache.put(e.request, res.clone());
        return res;
      });
      const timeout = new Promise((resolve) => setTimeout(resolve, 3000));
      try {
        const res = await Promise.race([network, timeout]);
        if (res) return res;
      } catch {}
      const cached = await cache.match(e.request, { ignoreSearch: true });
      return cached || network;
    })(),
  );
});
