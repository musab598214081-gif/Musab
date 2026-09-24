/* Family Notifier - notification helper (service worker)
 *
 * Put this file next to index.html. It is what lets a phone show a call
 * or buzz from the family server while the app is closed, and what
 * opens the app when the notification is tapped.
 *
 * What it does:
 *   - shows calls, group calls, buzzes and missed calls;
 *   - keeps a call ringing: the server re-sends a ringing call every few
 *     seconds with the same tag, and each one replaces the last and
 *     rings again, until it is answered, declined or rings out;
 *   - Answer / Decline on the call itself, Call back on a missed call;
 *   - Approve / Reject on the admin's "wants to join" notification;
 *   - keeps a copy of the app, so opening it from a notification is
 *     instant even on a slow network (the copy refreshes in the
 *     background each time);
 *   - renews this device's notification registration by itself when
 *     the browser replaces it. */

var SW_VERSION = "2026-10-09a";   /* follows the app's build (VERSION in index.html) */
var SHELL = "fmn-shell-v1";
var CFG = "fmn-cfg-v1";
var CALL_KINDS = { call: 1, group: 1 };
var UA = self.navigator.userAgent || "";
var IS_APPLE = /iPhone|iPad|iPod|Macintosh/.test(UA) && !/Chrome|Chromium|Edg|Firefox/.test(UA);

/* Calls the person swiped away. Later rings of the same call still have
   to show something (the browser insists), but they show it quietly. */
var silenced = {};
/* Calls the open app has confirmed it is ringing out loud for. Only
   those skip the repeat notifications while the app is on screen - an
   app that could not start its sound (no tap yet since it opened) used
   to leave the phone silent after the first ring. */
var audible = {};

self.addEventListener("install", function (e) {
  self.skipWaiting();
  /* The app itself, kept for fast opening. */
  e.waitUntil(caches.open(SHELL).then(function (c) {
    return c.add(new Request("./", { cache: "reload" })).catch(function () {});
  }));
});
self.addEventListener("activate", function (e) {
  e.waitUntil(Promise.all([
    self.clients.claim(),
    caches.keys().then(function (keys) {
      return Promise.all(keys.filter(function (k) {
        return /^fmn-shell-/.test(k) && k !== SHELL;
      }).map(function (k) { return caches.delete(k); }));
    })
  ]));
});

/* ------------------------------------------------------ opening fast
 *
 * The page is served from the copy kept here straight away, and the
 * network copy is fetched at the same time to replace it for next
 * time. Opening from a call notification no longer waits on the
 * network for the whole page before it can even start connecting. */
self.addEventListener("fetch", function (e) {
  var req = e.request;
  if (req.method !== "GET" || req.mode !== "navigate") return;
  var url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  if (url.searchParams.has("nocache")) return;
  var key = url.origin + url.pathname;
  e.respondWith(caches.open(SHELL).then(function (c) {
    return c.match(key).then(function (hit) {
      var fresh = fetch(req).then(function (res) {
        if (res && res.ok && res.type === "basic")
          c.put(key, res.clone()).catch(function () {});
        return res;
      });
      if (hit) {
        e.waitUntil(fresh.catch(function () {}));
        return hit;
      }
      return fresh.catch(function () {
        return c.match(self.registration.scope).then(function (any) {
          return any || Response.error();
        });
      });
    });
  }));
});

/* ------------------------------------------------------------ push */

self.addEventListener("push", function (e) {
  var d = {};
  try { d = e.data ? e.data.json() : {}; } catch (x) { d = {}; }
  e.waitUntil(handlePush(d));
});

function handlePush(d) {
  var kind = d.kind || "buzz";
  var tag = d.tag || null;
  var ringing = !!CALL_KINDS[kind];

  return self.clients.matchAll({ type: "window", includeUncontrolled: true }).then(function (list) {
    /* Any open copy of the app is told at once. A laptop tab that was
       asleep has usually lost its connection without noticing; this
       makes it reconnect now and pick the call up, instead of at its
       next check. */
    list.forEach(function (c) {
      try { c.postMessage({ t: "push", kind: kind, tag: tag, n: d.n || 0 }); } catch (x) {}
    });
    var front = list.some(function (c) { return c.visibilityState === "visible" && c.focused; });

    if (kind === "cancel") return cancel(tag, d, front);

    /* A call that arrives long after it was sent (the phone was offline)
       is not ringing any more. */
    if (ringing && d.ts && Date.now() - d.ts > 70000) {
      d = Object.assign({}, d, { title: "Missed call",
        body: String(d.title || "").replace(/\s+is calling you.*$/i, "") + " tried to call you",
        cb: d.from, dec: null, answer: null, ans: null });
      kind = "missed";
      ringing = false;
    }

    /* A repeat ring while the app is on screen and ringing out loud by
       itself. (Apple needs every push to show something, so not there.) */
    if (ringing && d.n > 0 && front && !IS_APPLE && tag && audible[tag]) return;

    var quiet = !!(ringing && tag && silenced[tag]);
    return self.registration.showNotification(d.title || "Family Notifier", options(d, kind, quiet));
  });
}

function options(d, kind, quiet) {
  var url = d.url || "./";
  var answer = d.answer || (d.ans != null && d.url ? d.url + d.ans : null);
  var o = {
    body: d.body || "",
    data: { url: url, answer: answer, dec: d.dec || null, kind: kind, tag: d.tag || null,
            cb: d.cb || null, jr: d.jr || null, rej: d.rej || null },
    timestamp: d.ts || Date.now()
  };
  if (d.tag) { o.tag = d.tag; o.renotify = !quiet; }
  if (quiet) o.silent = true;
  if (CALL_KINDS[kind]) {
    o.requireInteraction = true;
    if (!quiet) o.vibrate = [700, 300, 700, 300, 700, 300, 700];
    o.actions = [];
    if (answer) o.actions.push({ action: "answer", title: kind === "group" ? "Join" : "Answer" });
    if (d.dec) o.actions.push({ action: "decline", title: "Decline" });
  } else if (kind === "approve") {
    /* Somebody wants to join: stays until the admin decides. */
    o.requireInteraction = true;
    o.vibrate = [300, 150, 300];
    o.actions = [{ action: "approve", title: "Approve" }];
    if (d.rej) o.actions.push({ action: "reject", title: "Reject" });
  } else if (kind === "info") {
    o.vibrate = [200];
  } else if (kind === "missed") {
    o.vibrate = [200, 120, 200];
    if (d.cb) o.actions = [{ action: "callback", title: "Call back" }];
  } else {
    o.vibrate = [400, 200, 400, 200, 400];
  }
  return o;
}

/* The call was answered or declined somewhere else: the ringing
   notification goes. Where the browser needs something shown for every
   push, a quiet note takes its place instead. */
function cancel(tag, d, front) {
  return self.registration.getNotifications(tag ? { tag: tag } : undefined).then(function (ns) {
    ns.forEach(function (n) { n.close(); });
    if (tag) silenced[tag] = 1;
    if (front && !IS_APPLE) return;
    return self.registration.showNotification(d.title || "Call ended", {
      body: d.body || "", tag: tag || undefined, silent: true, renotify: false,
      data: { url: "./", kind: "cancel" }
    });
  });
}

self.addEventListener("notificationclose", function (e) {
  var d = e.notification.data || {};
  if (d.tag && CALL_KINDS[d.kind]) silenced[d.tag] = 1;
});

self.addEventListener("notificationclick", function (e) {
  e.notification.close();
  var d = e.notification.data || {};
  if (d.tag) silenced[d.tag] = 1;

  if (e.action === "reject" && d.rej) {
    e.waitUntil(fetch(d.rej.u, { method: "POST", headers: { "Content-Type": "application/json" },
                                 body: JSON.stringify(d.rej.b), keepalive: true })
      .catch(function () {}));
    return;
  }

  if (e.action === "decline" && d.dec) {
    /* Straight to the family server - no need to open the app to say no. */
    e.waitUntil(fetch(d.dec.u, { method: "POST", headers: { "Content-Type": "application/json" },
                                 body: JSON.stringify(d.dec.b), keepalive: true })
      .catch(function () {}));
    return;
  }

  var url = d.url || "./";
  /* Approve adds them as the app opens; a tap on the notification
     itself opens the request so it can be looked at first. */
  if (d.kind === "approve" && d.jr)
    url = "./#" + (e.action === "approve" ? "approve=" : "jr=") + encodeURIComponent(d.jr);
  else if (e.action === "answer" && d.answer) url = d.answer;
  else if ((e.action === "callback" || d.kind === "missed") && d.cb)
    url = url + (url.indexOf("#") === -1 ? "#" : "&") + "cb=" + encodeURIComponent(d.cb);

  e.waitUntil(self.clients.matchAll({ type: "window", includeUncontrolled: true })
    .then(function (list) {
      /* The copy on screen first, then any copy at all. */
      list.sort(function (a, b) {
        return (b.visibilityState === "visible") - (a.visibilityState === "visible");
      });
      for (var i = 0; i < list.length; i++) {
        var c = list[i];
        if ("focus" in c) {
          c.postMessage({ t: "open", url: url });
          return c.focus().catch(function () { return self.clients.openWindow(url); });
        }
      }
      return self.clients.openWindow(url);
    }));
});

/* ------------------------------------------- keeping the registration
 *
 * Browsers replace a device's push registration now and then. When
 * they do, the new one is sent to the family server from here, so the
 * phone keeps ringing without anyone opening the app first. The app
 * tells this helper where to send it each time it starts. */
self.addEventListener("message", function (e) {
  var m = e.data || {};
  if (m.t === "cfg" && m.send && m.me && m.key) {
    /* sec: this person's key, so a renewed registration is accepted
       (the family server only believes a phone that holds it). */
    e.waitUntil(caches.open(CFG).then(function (c) {
      return c.put("cfg", new Response(JSON.stringify({ send: m.send, me: m.me, key: m.key,
                                                        sec: m.sec || null })));
    }));
  } else if (m.t === "silence" && m.tag) {
    /* The app answered, declined or ended this call itself. */
    silenced[m.tag] = 1;
    e.waitUntil(self.registration.getNotifications({ tag: m.tag }).then(function (ns) {
      ns.forEach(function (n) { n.close(); });
    }));
  } else if (m.t === "forget") {
    /* This phone was removed from the family: stop acting for anyone. */
    e.waitUntil(caches.delete(CFG));
  } else if (m.t === "audible" && m.tag) {
    if (m.on) audible[m.tag] = 1; else delete audible[m.tag];
  } else if (m.t === "version" && e.source) {
    e.source.postMessage({ t: "version", v: SW_VERSION });
  }
});

self.addEventListener("pushsubscriptionchange", function (e) {
  e.waitUntil(caches.open(CFG).then(function (c) { return c.match("cfg"); })
    .then(function (r) { return r ? r.json() : null; })
    .then(function (cfg) {
      if (!cfg) return;
      return self.registration.pushManager.subscribe({
        userVisibleOnly: true, applicationServerKey: fromB64u(cfg.key)
      }).then(function (sub) {
        return fetch(cfg.send, { method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ me: cfg.me, sec: cfg.sec || undefined, k: "sub", sub: sub.toJSON() }) });
      });
    }).catch(function () {}));
});

function fromB64u(s) {
  var b = String(s).replace(/-/g, "+").replace(/_/g, "/");
  while (b.length % 4) b += "=";
  var bin = atob(b), out = new Uint8Array(bin.length);
  for (var i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
