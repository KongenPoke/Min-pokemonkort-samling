// Kortpermen service worker: gør siden installerbar og hurtig på telefonen.
// - Appens egne filer: netværk først (så opdateringer altid kommer med), cache som reserve offline.
// - Kortbilleder, skrifttyper og Supabase-biblioteket: cache først (de ændrer sig ikke).
// - Data fra Supabase og TCGdex' API caches ikke her.
const VERSION = "kp-v1";
const SHELL = ["./", "./index.html", "./app.js", "./parse.js", "./style.css", "./manifest.webmanifest", "./icons/icon-192.png"];
const IMG_CACHE = "kp-img";
const IMG_MAX = 800;

self.addEventListener("install", e => {
  e.waitUntil(caches.open(VERSION).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== VERSION && k !== IMG_CACHE).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});

async function networkFirst(req) {
  const cache = await caches.open(VERSION);
  try {
    const res = await fetch(req);
    if (res.ok) cache.put(req, res.clone());
    return res;
  } catch {
    return (await cache.match(req)) || (await cache.match("./index.html")) || Response.error();
  }
}

async function cacheFirst(req, name, max) {
  const cache = await caches.open(name);
  const hit = await cache.match(req);
  if (hit) return hit;
  const res = await fetch(req);
  if (res.ok || res.type === "opaque") {
    cache.put(req, res.clone());
    if (max) cache.keys().then(keys => { if (keys.length > max) keys.slice(0, keys.length - max).forEach(k => cache.delete(k)); });
  }
  return res;
}

self.addEventListener("fetch", e => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin === location.origin) return e.respondWith(networkFirst(req));
  if (url.hostname === "assets.tcgdex.net") return e.respondWith(cacheFirst(req, IMG_CACHE, IMG_MAX));
  if (url.hostname === "fonts.googleapis.com" || url.hostname === "fonts.gstatic.com" || url.hostname === "cdn.jsdelivr.net")
    return e.respondWith(cacheFirst(req, VERSION));
  // alt andet (Supabase, TCGdex-API) går direkte til netværket
});
