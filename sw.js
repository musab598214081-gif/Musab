/* Family Notifier - notification helper (service worker)
 *
 * Put this file next to index.html. It is what lets a phone show a call
 * or buzz from the family server while the app is closed, and what
 * opens the app when the notification is tapped.
 *
 * What it does:
 *   - shows calls, group calls, buzzes, messages and missed calls - each
 *     with its own feel: a call rings on and on, a buzz taps twice, a
 *     message gives one short tick and stacks up per sender;
 *   - keeps the app icon's badge (missed calls + unread messages);
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

var SW_VERSION = "2026-10-20g";   /* follows the app's build (VERSION in index.html) */
var SHELL = "fmn-shell-v1";
var CFG = "fmn-cfg-v1";
var CALL_KINDS = { call: 1, group: 1 };
var UA = self.navigator.userAgent || "";
var IS_APPLE = /iPhone|iPad|iPod|Macintosh/.test(UA) && !/Chrome|Chromium|Edg|Firefox/.test(UA);

/* Calls this phone has dealt with - picked up, declined, swiped away, or
   answered in the app. Later rings of the same call still have to show
   something (the browser insists), but they show it quietly and close it.
   Kept in storage as well as here: a phone stops this helper within
   seconds of idling, and memory alone was forgotten between two rings -
   one reason a call sometimes rang and sometimes didn't. */
var silenced = {};
var STATE = "fmn-state-v1";
function savedSilenced() {
  return caches.open(STATE).then(function (c) { return c.match("silenced"); })
    .then(function (r) { return r ? r.json() : {}; }).catch(function () { return {}; });
}
function markSilenced(tag) {
  if (!tag) return Promise.resolve();
  silenced[tag] = 1;
  return caches.open(STATE).then(function (c) {
    return savedSilenced().then(function (o) {
      var now = Date.now();
      o[tag] = now;
      Object.keys(o).forEach(function (k) { if (now - o[k] > 15 * 60000) delete o[k]; });
      return c.put("silenced", new Response(JSON.stringify(o)));
    });
  }).catch(function () {});
}
function isSilenced(tag) {
  if (!tag) return Promise.resolve(false);
  if (silenced[tag]) return Promise.resolve(true);
  return savedSilenced().then(function (o) { if (o[tag]) silenced[tag] = 1; return !!o[tag]; });
}
/* The number on the app's icon: missed calls plus unread messages. The
   open app sets the true figure (t:"badge"); while it is closed each
   message or missed call adds one. */
function badgeGet() {
  return caches.open(STATE).then(function (c) { return c.match("badge"); })
    .then(function (r) { return r ? r.json() : 0; }).catch(function () { return 0; });
}
function badgeSet(n) {
  n = Math.max(0, Number(n) || 0);
  try {
    if (self.navigator.setAppBadge) {
      if (n) self.navigator.setAppBadge(n).catch(function () {});
      else if (self.navigator.clearAppBadge) self.navigator.clearAppBadge().catch(function () {});
    }
  } catch (x) {}
  return caches.open(STATE).then(function (c) {
    return c.put("badge", new Response(JSON.stringify(n)));
  }).catch(function () {});
}
function badgeAdd() { return badgeGet().then(function (n) { return badgeSet(n + 1); }); }

/* Every notification belonging to one call, whichever of its two labels
   it carries (see showRing). */
function closeCall(tag) {
  if (!tag) return Promise.resolve();
  return self.registration.getNotifications().then(function (ns) {
    ns.forEach(function (n) {
      var d = n.data || {};
      if (d.tag === tag || n.tag === tag || String(n.tag || "").indexOf(tag + "~") === 0) n.close();
    });
  }).catch(function () {});
}
function savedCfg() {
  return caches.open(CFG).then(function (c) { return c.match("cfg"); })
    .then(function (r) { return r ? r.json() : null; }).catch(function () { return null; });
}
/* Tells the family server this call was picked up here: its repeat rings
   stop at once, and this person's other devices go quiet. */
function ringStop(tag) {
  return savedCfg().then(function (cfg) {
    if (!cfg || !cfg.send || !tag) return;
    return fetch(cfg.send, { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ me: cfg.me, sec: cfg.sec || undefined, k: "ringstop", tag: tag }),
      keepalive: true }).catch(function () {});
  });
}
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

/* The person's sound settings (from the app - see sndToHelper there):
   note  false = the notification sound is set to Silent
   nvib  vibrate for notifications      rvib  vibrate for calls
   Kept in memory too, so a burst of rings doesn't read it every time. */
var SND = null;
function savedSound() {
  if (SND) return Promise.resolve(SND);
  return caches.open(CFG).then(function (c) { return c.match("sound"); })
    .then(function (r) { return r ? r.json() : null; })
    .then(function (o) { SND = o || { note: true, nvib: true, rvib: true }; return SND; })
    .catch(function () { return { note: true, nvib: true, rvib: true }; });
}

function handlePush(d) {
  var kind = d.kind || "buzz";
  var tag = d.tag || null;
  var ringing = !!CALL_KINDS[kind];
  var cfg = null, quietCall = false;

  return Promise.all([savedCfg(), ringing ? isSilenced(tag) : false, savedSound()]).then(function (got) {
    cfg = got[0]; quietCall = got[1];
    return self.clients.matchAll({ type: "window", includeUncontrolled: true });
  }).then(function (list) {
    /* Any open copy of the app is told at once. A laptop tab that was
       asleep has usually lost its connection without noticing; this
       makes it reconnect now and pick the call up, instead of at its
       next check. */
    list.forEach(function (c) {
      try { c.postMessage({ t: "push", kind: kind, tag: tag, n: d.n || 0 }); } catch (x) {}
    });
    var front = list.some(function (c) { return c.visibilityState === "visible" && c.focused; });

    if (kind === "cancel") return cancel(tag, d, front);
    if (kind === "msg") return showMessage(d, front);

    /* A call that arrives long after it was sent (the phone was offline)
       is not ringing any more. "Long after" by the SERVER's clock: the
       app measures how far this phone's clock is off, so a phone whose
       clock runs a minute fast no longer turns every call into a silent
       "missed call". */
    var skew = (cfg && typeof cfg.skew === "number" && Math.abs(cfg.skew) < 86400000) ? cfg.skew : 0;
    if (ringing && d.ts && Date.now() + skew - d.ts > 70000) {
      d = Object.assign({}, d, { title: "Missed call",
        body: String(d.title || "").replace(/\s+is calling you.*$/i, "") + " tried to call you",
        cb: d.from, dec: null, answer: null, ans: null });
      kind = "missed";
      ringing = false;
    }

    /* A repeat ring while the app is on screen and ringing out loud by
       itself. (Apple needs every push to show something, so not there.) */
    if (ringing && d.n > 0 && front && !IS_APPLE && tag && audible[tag]) return;

    if (ringing && tag) {
      /* Already picked up (or declined) here: nothing to ring. The
         browser insists something is shown, so a quiet one - closed at
         once - unless the app is on screen. */
      if (quietCall) {
        if (front && !IS_APPLE) return closeCall(tag);
        return self.registration.showNotification(d.title || "Family Notifier", options(d, kind, true))
          .then(function () { return new Promise(function (r) { setTimeout(r, 300); }); })
          .then(function () { return closeCall(tag); });
      }
      return showRing(d, kind, tag);
    }
    if (kind === "missed") {
      badgeAdd();
      /* The rings of this call are shown under their own labels (see
         showRing), so "Missed call" did not replace them: "Alice is
         calling you", with a live Answer button, stayed on the phone
         for good next to it. Every notification of the call goes first. */
      if (tag) return markSilenced(tag).then(function () { return closeCall(tag); }).then(function () {
        return self.registration.showNotification(d.title || "Missed call", options(d, kind, false));
      });
    }
    return self.registration.showNotification(d.title || "Family Notifier", options(d, kind, false));
  });
}

/* A chat message. One notification per sender: a second message from
   the same person replaces the first and says how many are waiting,
   instead of a pile of separate buzzes. One short tick - never the
   long pattern a call uses. With the app on screen nothing is shown:
   the app shows the message itself. */
function showMessage(d, front) {
  if (front && !IS_APPLE) return Promise.resolve();
  var tag = d.tag || ("m-" + (d.from || ""));
  return self.registration.getNotifications({ tag: tag }).then(function (ns) {
    var prev = ns && ns[0] && ns[0].data ? ns[0].data : null;
    var n = (prev && prev.n ? prev.n : 0) + 1;
    var lines = (prev && prev.lines ? prev.lines : []).concat([String(d.body || "")]).slice(-4);
    var o = options(Object.assign({}, d, { tag: tag }), "msg", false);
    o.data.n = n; o.data.lines = lines;
    o.body = n > 1 ? lines.join("\n") + "\n(" + n + " new messages)" : String(d.body || "");
    return badgeAdd().then(function () {
      return self.registration.showNotification(d.title || "New message", o);
    });
  });
}

/* Each ring must make a sound. Re-showing a notification under the SAME
   label re-alerts on Android, but Windows, macOS and iPhones often just
   update it silently - so a call rang once and then went quiet. Each
   ring alternates between two labels (…~0, …~1): to the phone every ring
   is a new notification and sounds; the previous one is closed, so only
   one is ever on screen. */
function showRing(d, kind, tag) {
  var n = d.n || 0;
  var now = tag + "~" + (n % 2), before = tag + "~" + ((n + 1) % 2);
  var o = options(Object.assign({}, d, { tag: now }), kind, false);
  o.data.tag = tag;                                   /* the call, whichever label */
  return self.registration.showNotification(d.title || "Family Notifier", o).then(function () {
    return self.registration.getNotifications().then(function (ns) {
      ns.forEach(function (x) { if (x.tag === before || x.tag === tag) x.close(); });
    });
  });
}

/* Two kinds of alert, never mixed up. A call: stays up, alerts again
   with every ring (the server re-sends it every few seconds until it is
   answered, declined or gives up), and a long vibration. Everything
   else - message, missed call, buzz, join request: alerts once, one
   short vibration, the same for all of them. The sound itself is the
   phone's own; phones don't let a web app choose it. */
var CALL_VIB = [700, 300, 700, 300, 700, 300, 700];
var NOTE_VIB = [100, 70, 100];
function options(d, kind, quiet) {
  var snd = SND || { note: true, nvib: true, rvib: true };
  var url = d.url || "./";
  var answer = d.answer || (d.ans != null && d.url ? d.url + d.ans : null);
  var o = {
    body: d.body || "",
    data: { url: url, answer: answer, dec: d.dec || null, kind: kind, tag: d.tag || null,
            cb: d.cb || null, jr: d.jr || null, rej: d.rej || null },
    timestamp: d.ts || Date.now()
  };
  var call = !!CALL_KINDS[kind];
  /* Silent chosen for notifications: arrives without a sound. Never for
     a call - a call must be heard. */
  if (!call && !snd.note) quiet = true;
  if (d.tag) { o.tag = d.tag; o.renotify = !quiet; }
  if (quiet) o.silent = true;
  if (!quiet && (call ? snd.rvib : snd.nvib)) o.vibrate = call ? CALL_VIB : NOTE_VIB;
  if (call) {
    o.requireInteraction = true;
    o.actions = [];
    if (answer) o.actions.push({ action: "answer", title: kind === "group" ? "Join" : "Answer" });
    if (d.dec) o.actions.push({ action: "decline", title: "Decline" });
  } else if (kind === "approve") {
    /* Somebody wants to join: stays until the admin decides. */
    o.requireInteraction = true;
    o.actions = [{ action: "approve", title: "Approve" }];
    if (d.rej) o.actions.push({ action: "reject", title: "Reject" });
  } else if (kind === "missed") {
    if (d.cb) o.actions = [{ action: "callback", title: "Call back" }];
  } else if (kind === "msg") {
    o.data.from = d.from || null;
  }
  return o;
}

/* The call was answered or declined somewhere else: the ringing
   notification goes. Where the browser needs something shown for every
   push, a quiet note takes its place instead. */
function cancel(tag, d, front) {
  var here = false;
  return (tag ? isSilenced(tag) : Promise.resolve(false)).then(function (s) {
    here = s;                         /* answered or declined on THIS phone */
    return Promise.all([tag ? closeCall(tag) : self.registration.getNotifications().then(function (ns) {
      ns.forEach(function (n) { n.close(); }); }), markSilenced(tag)]);
  }).then(function () {
    if (front && !IS_APPLE) return;
    return self.registration.showNotification(d.title || "Call ended", {
      body: d.body || "", tag: tag || undefined, silent: true, renotify: false,
      data: { url: "./", kind: "cancel" }
    }).then(function () {
      /* "Picked up on another device" is wrong on the phone that picked
         it up: shown (the browser insists) and taken away at once. */
      if (!here) return;
      return new Promise(function (r) { setTimeout(r, 300); }).then(function () { return closeCall(tag); });
    });
  });
}

self.addEventListener("notificationclose", function (e) {
  var d = e.notification.data || {};
  /* Swiped away: later rings of this call stay quiet. (Closing one label
     in favour of the other, above, is the helper's own doing and does
     not come here - only a person's swipe does.) */
  if (d.tag && CALL_KINDS[d.kind]) e.waitUntil(markSilenced(d.tag));
});

self.addEventListener("notificationclick", function (e) {
  e.notification.close();
  var d = e.notification.data || {};
  /* Picked up (or declined): the ringing stops now - here, on the
     server, and on this person's other devices. */
  if (d.tag && CALL_KINDS[d.kind]) {
    e.waitUntil(Promise.all([markSilenced(d.tag), closeCall(d.tag),
                             e.action === "decline" ? null : ringStop(d.tag)]));
  } else if (d.tag) markSilenced(d.tag);

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
  else if (d.kind === "msg" && d.from)
    url = url + (url.indexOf("#") === -1 ? "#" : "&") + "chat=" + encodeURIComponent(d.from);

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
    /* skew: how far this phone's clock is from the family server's. */
    /* sec: this person's key, so a renewed registration is accepted
       (the family server only believes a phone that holds it). */
    e.waitUntil(caches.open(CFG).then(function (c) {
      return c.put("cfg", new Response(JSON.stringify({ send: m.send, me: m.me, key: m.key,
                                                        sec: m.sec || null,
                                                        skew: typeof m.skew === "number" ? m.skew : 0 })));
    }));
  } else if (m.t === "sound" && m.p) {
    SND = { note: m.p.note !== false, nvib: m.p.nvib !== false, rvib: m.p.rvib !== false };
    e.waitUntil(caches.open(CFG).then(function (c) {
      return c.put("sound", new Response(JSON.stringify(SND)));
    }).catch(function () {}));
  } else if (m.t === "silence" && m.tag) {
    /* The app answered, declined or ended this call itself. */
    e.waitUntil(Promise.all([markSilenced(m.tag), closeCall(m.tag)]));
  } else if (m.t === "forget") {
    /* This phone was removed from the family: stop acting for anyone. */
    SND = null;
    e.waitUntil(caches.delete(CFG));
  } else if (m.t === "audible" && m.tag) {
    if (m.on) audible[m.tag] = 1; else delete audible[m.tag];
  } else if (m.t === "badge") {
    e.waitUntil(badgeSet(m.n));
  } else if (m.t === "readchat" && m.from) {
    /* The conversation was opened: its notification has done its job. */
    e.waitUntil(self.registration.getNotifications({ tag: "m-" + m.from }).then(function (ns) {
      ns.forEach(function (n) { n.close(); });
    }).catch(function () {}));
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
