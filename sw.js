const V = 'carimbo-v19';
const SHELL = ['./', './index.html', './extract.js', './sync.js', './manifest.webmanifest', './icon.svg', './icon-180.png', './icon-512.png'];
// Leitor de documentos: grande, então é guardado sem travar a instalação
const VENDOR = ['tesseract.min.js', 'worker.min.js', 'tesseract-core-lstm.wasm.js', 'tesseract-core-simd-lstm.wasm.js',
  'lang/eng.traineddata.gz', 'lang/por.traineddata.gz', 'pdf.min.mjs', 'pdf.worker.min.mjs', 'supabase.js'].map(f => './vendor/' + f);

self.addEventListener('install', e => {
  e.waitUntil(caches.open(V).then(async c => {
    // cache: reload ignora a cópia guardada pelo navegador (o GitHub guarda por 10 min)
    await c.addAll(SHELL.map(u => new Request(u, { cache: 'reload' })));
    await Promise.all(VENDOR.map(u => c.add(new Request(u, { cache: 'reload' })).catch(() => {})));
  }).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(ks => Promise.all(ks.filter(k => k !== V).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  const r = e.request;
  if (r.method !== 'GET') return;
  const u = new URL(r.url);

  if (u.origin === location.origin) {
    // Bibliotecas não mudam: cache primeiro, rede só se faltar
    if (u.pathname.includes('/vendor/')) {
      e.respondWith(caches.match(r, { ignoreSearch: true }).then(hit => hit || fetch(r).then(res => {
        if (res.ok) { const cp = res.clone(); caches.open(V).then(c => c.put(r, cp)) }
        return res;
      })));
      return;
    }
    // App: com internet, abre sempre a versão mais nova; sem internet (ou rede lenta, 3 s), usa a guardada
    e.respondWith((async () => {
      const cached = () => caches.match(r, { ignoreSearch: true })
        .then(hit => hit || (r.mode === 'navigate' ? caches.match('./index.html') : undefined));
      const net = fetch(r, { cache: 'no-cache' }).then(res => {
        if (res.ok) { const cp = res.clone(); caches.open(V).then(c => c.put(r, cp)); }
        return res;
      });
      const slow = new Promise(res => setTimeout(res, 3000)).then(cached);
      try {
        const first = await Promise.race([net, slow]);
        return first || await net;
      } catch {
        return (await cached()) || Response.error();
      }
    })());
    return;
  }

  if (u.host === 'fonts.googleapis.com' || u.host === 'fonts.gstatic.com') {
    e.respondWith(caches.match(r).then(hit => hit || fetch(r).then(res => {
      const cp = res.clone(); caches.open(V).then(c => c.put(r, cp)); return res;
    }).catch(() => Response.error())));
  }
});
