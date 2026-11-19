/* ============================================================
   泸州食味手册 · 智能媒体线路调度器
   ------------------------------------------------------------
   策略：
   1. 每次访问只做一次「线路竞速」，选出一条镜像线路给全站复用，
      避免每张图都重复测速、浪费流量；
   2. 判定同时看首字节延迟与下载速度：超过 1.6s 未响应，
      或速度低于 140KB/s，立即换下一条线路；
   3. 镜像全部不可用时，最后回退 GitHub Pages 原站；
   4. 线路缓存 6 小时；任一资源加载失败会立刻作废线路并回退原站。
   ============================================================ */
(function () {
  'use strict';

  var ORIGIN = 'https://newcyr.github.io/sc/';
  var PROBE_PATH = 'assets/laojiao.jpg'; // 373KB，足够测出真实速度

  var MIRRORS = [
    { id: 'jsdelivr', label: 'jsDelivr', base: 'https://cdn.jsdelivr.net/gh/newcyr/sc@main/' },
    { id: 'fastly', label: 'jsDelivr Fastly', base: 'https://fastly.jsdelivr.net/gh/newcyr/sc@main/' },
    { id: 'statically', label: 'Statically', base: 'https://cdn.statically.io/gh/newcyr/sc/main/' },
    { id: 'githack', label: 'GitHack', base: 'https://raw.githack.com/newcyr/sc/main/' },
    { id: 'origin', label: 'GitHub Pages 原站', base: ORIGIN, origin: true }
  ];

  var RULES = {
    probeBytes: 96 * 1024,
    timeout: 2800,
    maxTTFB: 1600,
    minSpeed: 140 * 1024,
    totalBudget: 6200,
    cacheKey: 'lz-media-route-v3',
    cacheTTL: 6 * 60 * 60 * 1000
  };

  var route = null;
  var routePromise = null;
  var listeners = [];

  /* ---------- 线路缓存 ---------- */
  function readCache() {
    try {
      var raw = localStorage.getItem(RULES.cacheKey);
      if (!raw) return null;
      var obj = JSON.parse(raw);
      if (!obj || Date.now() - (obj.at || 0) > RULES.cacheTTL) return null;
      var found = null;
      for (var i = 0; i < MIRRORS.length; i++) {
        if (MIRRORS[i].id === obj.id && !MIRRORS[i].origin) found = MIRRORS[i];
      }
      return found;
    } catch (e) { return null; }
  }

  function writeCache(mirror) {
    try {
      localStorage.setItem(RULES.cacheKey, JSON.stringify({ at: Date.now(), id: mirror.id }));
    } catch (e) { /* 隐私模式忽略 */ }
  }

  function invalidate() {
    route = null;
    routePromise = null;
    try { localStorage.removeItem(RULES.cacheKey); } catch (e) {}
  }

  function announce(info) {
    for (var i = 0; i < listeners.length; i++) {
      try { listeners[i](info); } catch (e) {}
    }
  }

  /* ---------- 单线路测速：读到 96KB 主动断开，不整包下载 ---------- */
  function probe(mirror) {
    var url = mirror.base + PROBE_PATH;
    var ctrl = 'AbortController' in window ? new AbortController() : null;
    var timer = setTimeout(function () { if (ctrl) ctrl.abort(); }, RULES.timeout);
    var started = performance.now();
    var firstByte = 0;
    var received = 0;

    return fetch(url, {
      mode: 'cors',
      cache: 'default',
      credentials: 'omit',
      headers: { Range: 'bytes=0-' + (RULES.probeBytes - 1) },
      signal: ctrl ? ctrl.signal : undefined
    }).then(function (res) {
      if (!res.ok) throw new Error('HTTP ' + res.status);
      if (!res.body || !res.body.getReader) {
        return res.arrayBuffer().then(function (b) { received = b.byteLength; firstByte = performance.now(); return finish(); });
      }
      return pump(res.body.getReader());
    }).catch(function () { clearTimeout(timer); return null; });

    function pump(reader) {
      return reader.read().then(function (chunk) {
        if (chunk.done) return finish();
        if (!firstByte) firstByte = performance.now();
        received += chunk.value ? chunk.value.length : 0;
        if (received >= RULES.probeBytes) {
          try { reader.cancel(); } catch (e) {}
          return finish();
        }
        return pump(reader);
      });
    }

    function finish() {
      clearTimeout(timer);
      var now = performance.now();
      var ttfb = (firstByte || now) - started;
      var speed = received / Math.max(1, now - (firstByte || started)) * 1000;
      var info = {
        id: mirror.id,
        label: mirror.label,
        base: mirror.base,
        ttfb: Math.round(ttfb),
        speed: Math.round(speed),
        bytes: received,
        ok: ttfb <= RULES.maxTTFB && speed >= RULES.minSpeed,
        at: Date.now()
      };
      info.ok = info.ok || !!mirror.origin;
      return info;
    }
  }

  /* ---------- 选线路：缓存 → 各镜像 → 原站 ---------- */
  function chooseRoute() {
    if (routePromise) return routePromise;
    var cached = readCache();
    if (cached) {
      route = cached;
      routePromise = Promise.resolve(cached);
      announce({ id: cached.id, label: cached.label, ttfb: 0, speed: 0, cached: true, ok: true });
      return routePromise;
    }

    var deadline = Date.now() + RULES.totalBudget;
    var queue = MIRRORS.slice();

    routePromise = queue.reduce(function (chain, mirror) {
      return chain.then(function (found) {
        if (found) return found;
        if (Date.now() > deadline && !mirror.origin) return null;
        return probe(mirror).then(function (info) {
          if (!info) return null;
          if (info.ok) {
            route = mirror;
            if (!mirror.origin) writeCache(mirror);
            announce(info);
            return mirror;
          }
          return null;
        });
      });
    }, Promise.resolve(null)).then(function (found) {
      if (!found) {
        var fallback = MIRRORS[MIRRORS.length - 1];
        route = fallback;
        announce({ id: fallback.id, label: fallback.label, ttfb: 0, speed: 0, fallback: true, ok: true });
        return fallback;
      }
      return found;
    });

    return routePromise;
  }

  function resolve(path) {
    return chooseRoute().then(function (mirror) {
      return mirror.base + path;
    });
  }

  /* ---------- 图片 ---------- */
  function loadImage(img) {
    if (img.dataset.mediaState) return;
    img.dataset.mediaState = 'loading';
    var path = img.dataset.media;
    resolve(path).then(function (url) {
      img.dataset.mediaState = 'ready';
      img.dataset.route = route ? route.id : '';
      img.addEventListener('error', function onErr() {
        img.removeEventListener('error', onErr);
        invalidate();
        img.dataset.route = 'origin';
        img.src = ORIGIN + path;
      });
      img.src = url;
    });
  }

  /* ---------- 视频 ---------- */
  function attachVideo(video, path, autoplay) {
    if (video.dataset.mediaState === 'ready') {
      video.classList.add('is-live');
      if (autoplay) safePlay(video);
      return;
    }
    if (video.dataset.mediaState === 'loading') {
      if (autoplay) {
        video.addEventListener('canplay', function once() {
          video.removeEventListener('canplay', once);
          video.classList.add('is-live');
          safePlay(video);
        });
      }
      return;
    }
    video.dataset.mediaState = 'loading';
    resolve(path).then(function (url) {
      video.dataset.mediaState = 'ready';
      video.dataset.route = route ? route.id : '';
      video.src = url;
      video.load();
      if (autoplay) {
        video.addEventListener('canplay', function once() {
          video.removeEventListener('canplay', once);
          video.classList.add('is-live');
          safePlay(video);
        });
      }
      video.addEventListener('error', function onErr() {
        video.removeEventListener('error', onErr);
        invalidate();
        video.dataset.mediaState = 'error';
        video.classList.remove('is-live');
        video.src = ORIGIN + path;
        video.load();
        if (autoplay) safePlay(video);
      }, { once: true });
    });
  }

  function safePlay(video) {
    var p = video.play();
    if (p && p.catch) p.catch(function () {});
  }

  function stop(video) {
    if (!video) return;
    try { video.pause(); } catch (e) {}
  }

  function subscribe(fn) {
    listeners.push(fn);
    if (route) {
      fn({ id: route.id, label: route.label, ttfb: 0, speed: 0, ok: true, cached: true });
    }
  }

  window.LZMedia = {
    ORIGIN: ORIGIN,
    mirrors: MIRRORS,
    resolve: resolve,
    loadImage: loadImage,
    attachVideo: attachVideo,
    stop: stop,
    subscribe: subscribe,
    get route() { return route; }
  };
})();