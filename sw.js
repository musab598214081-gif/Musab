/* Family Notifier - notification helper (service worker)
 *
 * Put this file next to index.html. It is what lets a phone show a call
 * or buzz from the family server while the app is closed, and what
 * opens the app when the notification is tapped. */

self.addEventListener("install", function () { self.skipWaiting(); });
self.addEventListener("activate", function (e) { e.waitUntil(self.clients.claim()); });

self.addEventListener("push", function (e) {
  var d = {};
  try { d = e.data ? e.data.json() : {}; } catch (x) { d = {}; }
  var title = d.title || "Family Notifier";
  var opts = {
    body: d.body || "",
    data: { url: d.url || "./", answer: d.answer || null },
    vibrate: [400, 200, 400, 200, 400]
  };
  /* The same tag for a call's ring and its "missed" note, so the second
     replaces the first instead of leaving a stale "calling" behind. */
  if (d.tag) { opts.tag = d.tag; opts.renotify = true; }
  if (d.kind === "call") {
    opts.requireInteraction = true;
    if (d.answer) opts.actions = [{ action: "answer", title: "Answer" }];
  }
  e.waitUntil(self.registration.showNotification(title, opts));
});

self.addEventListener("notificationclick", function (e) {
  e.notification.close();
  var d = e.notification.data || {};
  var url = (e.action === "answer" && d.answer) ? d.answer : (d.url || "./");
  e.waitUntil(self.clients.matchAll({ type: "window", includeUncontrolled: true })
    .then(function (list) {
      for (var i = 0; i < list.length; i++) {
        var c = list[i];
        if ("focus" in c) {
          c.postMessage({ t: "open", url: url });
          return c.focus();
        }
      }
      return self.clients.openWindow(url);
    }));
});
