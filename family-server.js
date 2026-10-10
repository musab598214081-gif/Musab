/* Family Notifier - family server
 *
 * One Cloudflare Worker with one Durable Object per family. Every open
 * app keeps a single WebSocket to its family's object, which
 *   - passes call setup and family messages between phones instantly,
 *   - keeps each message for 12 hours, so a phone that was closed picks
 *     up what it missed when it connects,
 *   - knows who is connected, so Online / Away / Offline needs no
 *     "I'm still here" messages at all,
 *   - wakes closed phones with the phone's own notifications (Web Push),
 *     so nobody needs the ntfy app - or, for phones running the family's
 *     Android app, through Firebase Cloud Messaging (see fcmSend; needs
 *     the FCM_SERVICE_ACCOUNT secret).
 *
 * The family id (the long random "house" in every invite link) is the
 * key, exactly as the ntfy topic names were: whoever has an invite link
 * can talk to the family, nobody else can find it.
 */

const KEEP_MS = 12 * 3600 * 1000;          /* messages are kept this long  */
const MAX_BODY = 64 * 1024;                /* one message, at most         */

/* Chat. A typed message is kept far longer than call setup - a phone
   that was off for the weekend still gets Friday's messages when it
   connects - and never more than a few thousand characters. */
const KEEP_CHAT_MS = 7 * 24 * 3600 * 1000;
const CHAT_MAX     = 4000;

/* Ringing. A web notification plays its sound once, so a call that is
   only notified once rings for a second and goes quiet. Instead the
   server re-sends the call's notification every few seconds (same tag,
   so each one replaces the last and rings again) until the call is
   answered, declined, cancelled - or rings out. */
const RING_FOR   = 50 * 1000;              /* longest a call keeps ringing */
const RING_EVERY = 4 * 1000;               /* gap between rings            */
const DEAD_MS    = 4 * 60 * 1000;          /* a silent connection is dead  */
const PUSH_LIMIT = 3900;                   /* bytes a push can carry       */

/* Group calls. */
const ROOM_MAX     = 8;                    /* people in one call, phone to phone */
const ROOM_MAX_SFU = 20;                   /* ... through Cloudflare's SFU  */
const SFU_API      = "https://rtc.live.cloudflare.com/v1/apps/";
const INVITE_MS    = 46 * 1000;            /* an invite rings this long    */
const ROOM_LOST_MS = 90 * 1000;            /* phone gone this long = left  */
const ROOM_MAX_AGE = 6 * 3600 * 1000;

/* Joining. Somebody new asks to join; the admin's phone is told at once
   (a notification with Approve / Reject) and decides. */
const JOIN_MAX     = 20;                   /* open requests at one time    */
const JOIN_KEEP_MS = 14 * 24 * 3600 * 1000;/* an unanswered request lasts  */
const DEVREQ_MS    = 10 * 60 * 1000;      /* a new device waits this long */
const REKEY_AFTER  = 24 * 3600 * 1000;     /* see publish()                */

/* Short invite links (…/#i=K7P2QX9M4T). The code is 10 characters from
   an alphabet without look-alikes (no 0/O, 1/I/L) - about 50 bits, far
   beyond guessing. What the link used to carry is kept here instead. */
const INVITE_ABC  = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";
const LINK_MS     = 30 * 24 * 3600 * 1000; /* an invite link lasts        */
const INVITE_REG  = "__invites__";         /* the one registry object      */
/* An expired link is remembered this much longer, as a stub holding
   only who it was for: long enough for the person who opens it late to
   ask for a new one with a tap, instead of hunting down whoever sent it. */
const RENEW_MS    = 60 * 24 * 3600 * 1000;
const RENEW_GAP   = 10 * 60 * 1000;        /* one ask per link this often  */

/* Creating a family. With the CREATE_KEY secret set (wrangler secret put
   CREATE_KEY), only somebody who has that code can bring a new family to
   this server: the code travels with the first publish of a family, and
   every phone that would use an unregistered house is turned away. Set
   it to keep strangers from running families on your worker, your relay
   credentials and your media bucket. Unset, anyone with the page may
   create a family, as before. Invited members never need the code. */
function creationLocked(env) { return !!(env && env.CREATE_KEY); }
function creationKeyOk(env, ck) {
  if (!creationLocked(env)) return true;
  const a = new TextEncoder().encode(String(ck || "")), b = new TextEncoder().encode(String(env.CREATE_KEY));
  if (a.length !== b.length || !a.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a[i] ^ b[i];
  return d === 0;
}
/* One-time creation codes. An admin or co-admin of a family already on
   a locked server can make one (Settings -> Family admin), hand it to
   somebody, and that person creates one family with it. Kept by the
   registry object; good for GRANT_MS, used once. */
const GRANT_MS  = 14 * 24 * 3600 * 1000;
const GRANT_MAX = 20;                       /* open codes per family      */
function grantCode() {
  const b = crypto.getRandomValues(new Uint8Array(8));
  let s = "";
  for (let i = 0; i < 8; i++) s += INVITE_ABC[b[i] % INVITE_ABC.length];
  return s;
}
function grantNorm(ck) { return String(ck || "").replace(/[\s\-–—]/g, "").toUpperCase(); }
function isGrantShape(ck) { return /^[2-9A-Z]{8}$/.test(grantNorm(ck)); }
const ckTries = new Map();                  /* per address, this isolate */
function ckRateOk(ip) {
  const now = Date.now();
  if (ckTries.size > 5000) ckTries.clear();
  let e = ckTries.get(ip);
  if (!e || now - e.t0 > 600000) { e = { t0: now, n: 0 }; ckTries.set(ip, e); }
  return ++e.n <= 10;
}

/* Pictures and files (optional - needs the MEDIA bucket, see
   wrangler.toml). Each is encrypted on the phone before it is sent, and
   only the encrypted bytes are stored here; the key travels inside the
   chat message, never with the file. The limits are set in wrangler.toml
   ([vars]) and every phone is told them, so a file that is too big is
   refused before it uses any data. */
const MEDIA_DEFAULTS = { photoMb: 8, fileMb: 25, dayMb: 300, keepDays: 30,
                         freeGb: 10, totalGb: 9.5 };
function mediaCfg(env) {
  if (!env || !env.MEDIA) return null;
  const n = (v, d, lo, hi) => { const x = Number(v); return isFinite(x) && x >= lo && x <= hi ? x : d; };
  return {
    photo: Math.round(n(env.MEDIA_MAX_PHOTO_MB, MEDIA_DEFAULTS.photoMb, 1, 50) * 1048576),
    file:  Math.round(n(env.MEDIA_MAX_FILE_MB, MEDIA_DEFAULTS.fileMb, 1, 100) * 1048576),
    day:   Math.round(n(env.MEDIA_DAY_MB, MEDIA_DEFAULTS.dayMb, 10, 10000) * 1048576),
    keep:  Math.round(n(env.MEDIA_KEEP_DAYS, MEDIA_DEFAULTS.keepDays, 1, 365)),
    /* The whole bucket, all families on this server together. free: what
       Cloudflare includes at no charge (R2 counts in 1,000,000,000-byte
       GB). total: new files are refused beyond this, so the bill stays at
       nothing - set MEDIA_TOTAL_GB to 0 for no limit. */
    free:  Math.round(n(env.MEDIA_FREE_GB, MEDIA_DEFAULTS.freeGb, 0, 1e6) * 1e9),
    total: Math.round(n(env.MEDIA_TOTAL_GB, MEDIA_DEFAULTS.totalGb, 0, 1e6) * 1e9)
  };
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (req.method === "OPTIONS") return cors(new Response(null, { status: 204 }));
    if (url.pathname === "/" || url.pathname === "")
      return cors(json({ ok: true, app: "family-notifier", v: 12,
                       features: ["ringloop", "rooms", "decline", "members", "join", "audible",
                                  "chat", "rcpt", "reply", "loc", "block", "voice", "renew", "device"]
                         .concat(mediaCfg(env) ? ["media"] : [])
                         .concat(turnReady(env) ? ["turn"] : [])
                         .concat(sfuReady(env) ? ["sfu"] : [])
                         .concat(fcmReady(env) ? ["fcm"] : [])
                         .concat(creationLocked(env) ? ["createkey"] : []) }));
    /* Is this the code? Asked before the setup form opens, so a wrong
       one is caught at once rather than after the family is typed in. */
    if (url.pathname === "/ck" && req.method === "POST") {
      const ip = req.headers.get("cf-connecting-ip") || "";
      if (!ckRateOk(ip)) return cors(json({ ok: false, why: "busy" }, 429));
      let b = null;
      try { b = await req.json(); } catch (e) {}
      let ok = creationKeyOk(env, b && b.ck);
      if (!ok && creationLocked(env) && isGrantShape(b && b.ck)) {
        const reg = env.FAMILY.get(env.FAMILY.idFromName(INVITE_REG));
        const g = await (await reg.fetch(new Request("https://registry/_inv/grantcheck",
          { method: "POST", body: JSON.stringify({ g: grantNorm(b.ck) }) }))).json().catch(() => null);
        ok = !!(g && g.ok);
      }
      return cors(noStore(ok ? json({ ok: true }) : json({ ok: false, why: "createkey" }, 403)));
    }
    /* The Android app's updates. The app is built in a private GitHub
       repository, whose releases a phone cannot download. The worker can
       (GH_TOKEN: a fine-grained token with read access to that
       repository's contents; GH_REPO: "owner/name"), so it hands the
       newest release's latest.json and APK to phones from here. */
    if (url.pathname === "/app/latest.json" || url.pathname === "/app/app-release.apk")
      return cors(await appRelease(env, url.pathname.slice(5)));
    /* Opening a short invite link: the code, looked up in the registry. */
    const inv = url.pathname.match(/^\/i\/([2-9A-Z]{10})$/);
    const ipHdr = { "x-ip": req.headers.get("cf-connecting-ip") || "" };
    if (inv && req.method === "GET") {
      const reg = env.FAMILY.get(env.FAMILY.idFromName(INVITE_REG));
      return cors(noStore(await reg.fetch(new Request("https://registry/_inv/get?c=" + inv[1], { headers: ipHdr }))));
    }
    /* An expired link, asking for a new one: the registry says whose it
       was, and the family is told - the person who sent it, or the
       admins - so they can send a fresh link with one tap. */
    const rnv = url.pathname.match(/^\/i\/([2-9A-Z]{10})\/renew$/);
    if (rnv && req.method === "POST") {
      const reg = env.FAMILY.get(env.FAMILY.idFromName(INVITE_REG));
      const r = await (await reg.fetch(new Request("https://registry/_inv/renew",
        { method: "POST", headers: ipHdr, body: JSON.stringify({ c: rnv[1] }) }))).json().catch(() => null);
      if (!r || !r.ok) return cors(json({ ok: false, why: (r && r.why) || "gone" }, r && r.why === "busy" ? 429 : 404));
      if (r.again) return cors(json({ ok: true, again: true, to: r.to || null }));
      const fam = env.FAMILY.get(env.FAMILY.idFromName(r.house));
      const res = await fam.fetch(new Request("https://" + url.hostname + "/f/" + r.house + "/renew",
        { method: "POST", body: JSON.stringify({ m: r.m, by: r.by }) }));
      const out = await res.json().catch(() => null);
      if (out && out.ok && out.to)
        await reg.fetch(new Request("https://registry/_inv/renewto",
          { method: "POST", body: JSON.stringify({ c: rnv[1], to: out.to }) }));
      return cors(json(out || { ok: false }, res.status));
    }
    /* A picture or file: stored and served here, by the Worker itself,
       so a few megabytes never pass through (and hold up) the family's
       object - it is only asked whether this person may. */
    const blob = url.pathname.match(/^\/f\/([A-Za-z0-9_-]{6,64})\/blob\/([A-Za-z0-9_-]{16,40})$/);
    if (blob && blob[1] !== INVITE_REG) return cors(await blobRoute(req, env, url, blob[1], blob[2]));
    const m = url.pathname.match(/^\/f\/([A-Za-z0-9_-]{6,64})\/(ws|send|vapid|ping|turn)$/);
    if (!m || m[1] === INVITE_REG) return cors(new Response("not found", { status: 404 }));
    const stub = env.FAMILY.get(env.FAMILY.idFromName(m[1]));
    /* The ping also reports which Cloudflare city answered the phone
       (the "front door", nearest to the person). */
    const fwd = m[2] === "ping"
      ? new Request(req.url, { headers: { "x-edge": (req.cf && req.cf.colo) || "" } })
      : req;
    const res = await stub.fetch(fwd);
    return m[2] === "ws" ? res : cors(res);
  }
};

export class Family {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
    this._jwt = {};
    /* Keep-alive pings are answered without waking the object. */
    try { ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong")); }
    catch (e) {}
  }

  async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname.indexOf("/_inv/") === 0) return this.registry(url, req);
    const what = url.pathname.split("/")[3];
    if (url.hostname && url.hostname !== this.host) {
      this.host = url.hostname;
      await this.ctx.storage.put("host", url.hostname);
    }
    /* The family's own id, which the object cannot otherwise know - it
       goes into the Reject button of an approval notification. */
    const house = url.pathname.split("/")[2];
    if (house && house !== this.house) {
      this.house = house;
      await this.ctx.storage.put("house", house);
    }
    if (what === "blobok" && req.method === "POST") return this.blobOk(req);
    if (what === "renew" && req.method === "POST") return this.renewAsk(req);
    if (what === "turn") {
      const me = url.searchParams.get("me") || "";
      const who = await this.auth(me, url.searchParams.get("sec"), null, "turn", url.searchParams.get("dk"));
      if (!who.ok) return json({ iceServers: [], error: "not signed in" }, 401);
      return json(await this.turn(me));
    }
    if (what === "ws") {
      if ((req.headers.get("Upgrade") || "").toLowerCase() !== "websocket")
        return new Response("expected a websocket", { status: 426 });
      const me = url.searchParams.get("me") || "";
      if (!validId(me)) return new Response("bad member id", { status: 400 });
      const since = Number(url.searchParams.get("since")) || 0;
      const who = await this.auth(me, url.searchParams.get("sec"), null, "ws",
                                  url.searchParams.get("dk"), url.searchParams.get("dl"));
      const pair = new WebSocketPair();
      const client = pair[0], server = pair[1];
      if (!who.ok && who.why === "device" && who.dh) {
        /* Another device is this member's: this one waits, connected, for
           the member's device or an admin to allow it. Tagged apart, so
           nothing meant for the member reaches it. */
        this.ctx.acceptWebSocket(server, ["pend:" + me]);
        this.attach(server, { me: me, pending: true, dh: who.dh, dl: who.dl, at: Date.now() });
        safeSend(server, JSON.stringify({ k: "auth", ok: false, why: "device", cur: who.cur || "" }));
        await this.devRequest(me, who.dh, who.dl, url.hostname, false);
        return new Response(null, { status: 101, webSocket: client });
      }
      if (!who.ok) {
        /* Accepted only to say why, then closed: a refused connection
           looks like a network fault to the app, which would keep
           retrying. This way it can tell the person what happened. */
        server.accept();
        safeSend(server, JSON.stringify({ k: "auth", ok: false, why: who.why || "" }));
        try { server.close(4001, "not signed in"); } catch (e) {}
        return new Response(null, { status: 101, webSocket: client });
      }
      this.ctx.acceptWebSocket(server, [me]);
      this.attach(server, { me: me, s: "on", at: Date.now(), kh: who.kh || null });
      await this.opened(server, me, since);
      return new Response(null, { status: 101, webSocket: client });
    }
    if (what === "send" && req.method === "POST") {
      let body;
      try { body = await req.json(); } catch (e) { return json({ ok: false, status: 400 }, 400); }
      if (!body || !validId(body.me)) return json({ ok: false, status: 400 }, 400);
      const who = await this.auth(body.me, body.sec, body.cap, body.k, body.dk);
      if (!who.ok) return json({ ok: false, status: 401, why: who.why || "auth" }, 401);
      return json(await this.handle(body.me, body, url.hostname, who.kh));
    }
    if (what === "vapid") return json({ key: (await this.vapid()).pub });
    if (what === "ping") return json({ ok: true, now: Date.now(),
                                       edge: req.headers.get("x-edge") || null,
                                       home: await this.colo() });
    return new Response("not found", { status: 404 });
  }

  /* ------------------------------------------------------ WebSockets */

  async opened(ws, me, since) {
    await this.reap();
    const prev = this.attachment(ws);
    this.attach(ws, { me: me, s: "on", at: Date.now(), kh: (prev && prev.kh) || null });
    /* Everything kept for this person since they last heard from us. */
    const prefix = "q:" + me + ":";
    const now0 = Date.now();
    const from = prefix + pad(Math.max(since + 1, now0 - KEEP_CHAT_MS));
    const kept = await this.ctx.storage.list({ prefix: prefix, start: from, limit: 800 });
    /* Chat messages (keys ending ":c") are kept for a week; everything
       else - call setup, family updates - only for 12 hours, as before. */
    const shortCut = now0 - KEEP_MS;
    for (const [key, frame] of kept) {
      if (!key.endsWith(":c") && Number(key.split(":")[2]) < shortCut) continue;
      safeSend(ws, frame);
    }

    /* Not (or no longer) in the family: this phone learns only that -
       nobody's status, no calls. A person waiting to be let in stays
       connected so they hear the moment the admin decides. */
    const fam = await this.famState();
    if (fam && !fam.members[me]) {
      const req = await this.ctx.storage.get("jr:" + me);
      safeSend(ws, JSON.stringify({ k: "guest", pending: !!req, name: req ? req.name : null,
                                    rev: fam.rev, now: Date.now() }));
      return;
    }
    /* The family as this person is allowed to see it, signed by the
       admin - so a phone that was closed for days is up to date the
       moment it connects, whether or not the admin's phone is on. */
    if (fam) {
      for (const r of ((await this.ctx.storage.get("rotchain")) || []))
        safeSend(ws, JSON.stringify({ k: "rot", text: r.text, sig: r.sig }));
      const view = await this.ctx.storage.get("view:" + me);
      if (view) safeSend(ws, JSON.stringify({ k: "fam", fam: view.fam, sig: view.sig }));
      safeSend(ws, JSON.stringify({ k: "famrev", rev: fam.rev }));
      if (isAdm(fam, me)) await this.sendJoinRequests(ws);
      await this.sendRenewals(ws, fam, me);
      await this.sendDevReqs(ws, fam, me);
    } else {
      safeSend(ws, JSON.stringify({ k: "famrev", rev: 0 }));
    }
    const mc = mediaCfg(this.env);
    safeSend(ws, JSON.stringify({ k: "caps", sfu: sfuReady(this.env), turn: turnReady(this.env),
                                  createkey: creationLocked(this.env),
                                  media: mc ? { photo: mc.photo, file: mc.file, keep: mc.keep } : null }));
    safeSend(ws, JSON.stringify({ k: "blocks", list: (await this.blockMap()).get(me) || [] }));
    safeSend(ws, JSON.stringify({ k: "presall", list: await this.everyone(me), now: Date.now() }));
    /* Any group call this person is in, or is being asked to join. A
       phone opened from the invite's notification learns of the call
       here, the moment it connects. */
    const rooms = await this.ctx.storage.list({ prefix: "room:" });
    for (const [key, r] of rooms) {
      if (r.live[me] && r.live[me].lost) {
        delete r.live[me].lost;
        await this.ctx.storage.put(key, r);
      }
      if (r.live[me] || r.inv[me])
        safeSend(ws, JSON.stringify({ k: "room", room: roomView(r), why: "sync", now: Date.now() }));
    }
    await this.presenceChanged(me);
  }

  async webSocketMessage(ws, raw) {
    if (typeof raw !== "string") return;
    if (raw === "ping") { safeSend(ws, "pong"); return; }
    if (raw.length > MAX_BODY) return;
    let f;
    try { f = JSON.parse(raw); } catch (e) { return; }
    const a = this.attachment(ws);
    if (!a || !f) return;
    if (a.pending) { await this.pendingMsg(ws, a, f); return; }
    a.seen = Date.now(); this.attach(ws, a);
    if (f.k === "pres") {
      const s = ["on", "away", "off"].indexOf(f.s) !== -1 ? f.s : "on";
      let changed = false;
      /* The phone's time zone, for "9:14 pm in London" on the others'
         screens. Kept while the phone is closed too; an empty one means
         the person stopped sharing it. Goes only where status goes -
         to the people this person is in touch with. */
      if (typeof f.tz === "string") {
        const tz = validTz(f.tz) ? f.tz : "";
        if (tz !== (a.tz || "")) {
          a.tz = tz; changed = true;
          if (tz) await this.ctx.storage.put("tz:" + a.me, tz);
          else await this.ctx.storage.delete("tz:" + a.me);
        }
      }
      if (a.s !== s) { a.s = s; a.at = Date.now(); changed = true; }
      if (changed) { this.attach(ws, a); await this.presenceChanged(a.me); }
      return;
    }
    const res = await this.handle(a.me, f, await this.ownHost(), a.kh || null);
    if (f.q) safeSend(ws, JSON.stringify(Object.assign({ k: "res", q: f.q }, res)));
  }

  async webSocketClose(ws) { await this.gone(ws); }
  async webSocketError(ws) { await this.gone(ws); }

  async gone(ws) {
    const a = this.attachment(ws);
    try { ws.close(1000, "bye"); } catch (e) {}
    if (!a || a.pending) return;
    await this.ctx.storage.put("seen:" + a.me, Date.now());
    await this.presenceChanged(a.me, ws);
    /* The last connection of someone in a group call went. Often it is
       only a phone locking or changing network and it will be back in
       seconds, so they are not taken out at once - only marked, and
       taken out if they stay gone. */
    if (this.socketsOf(a.me, ws) === 0) {
      const rooms = await this.ctx.storage.list({ prefix: "room:" });
      let marked = false;
      for (const [key, r] of rooms) {
        if (r.live[a.me] && !r.live[a.me].lost) {
          r.live[a.me].lost = Date.now();
          await this.ctx.storage.put(key, r);
          marked = true;
        }
      }
      if (marked) await this.rearm();
    }
  }

  /* ------------------------------------------------------- requests */

  async handle(me, f, host, kh) {
    /* Somebody who is not in the family may only ask to join, and set up
       the notification that tells them they are in. */
    const fam = await this.famState();
    if (fam && !fam.members[me] &&
        ["join", "sub", "unsub", "pres", "pub"].indexOf(f.k) === -1)
      return { ok: false, status: 403, why: "notmember" };
    /* No family registered here, and this server only takes families
       brought with the creation code: nothing else can be done with
       this house until that has happened. */
    if (!fam && creationLocked(this.env) && f.k !== "pub")
      return { ok: false, status: 403, why: "createkey" };

    if (f.k === "pub") return this.publish(me, f, host);
    if (f.k === "ckgrant") {
      /* A one-time creation code, by an admin or co-admin of this family. */
      if (!creationLocked(this.env)) return { ok: false, status: 400, why: "open" };
      if (!fam || !isAdm(fam, me)) return { ok: false, status: 403 };
      const house = this.house || (await this.ctx.storage.get("house")) || null;
      const r = await this.regCall("grant", { g: grantCode(), house: house, by: me, exp: Date.now() + GRANT_MS });
      if (!r || !r.ok) return { ok: false, status: r && r.why === "full" ? "full" : 500, why: r && r.why };
      return { ok: true, status: 200, code: r.g, exp: r.exp };
    }
    if (f.k === "invite") return this.invite(me, f);
    if (f.k === "renewdrop") return this.renewDrop(me, f);
    if (f.k === "join") return this.join(me, f, host, kh);
    if (f.k === "jdecide") return this.joinDecide(me, f, host);
    if (f.k === "devdecide") return this.devDecide(me, f);
    if (f.k === "ringstop") {
      /* Picked up - from the notification or in the app - on one of this
         person's devices: the repeat rings stop now, not only once the
         call is connected (which can take a few seconds), and their
         other devices go quiet too. */
      const tag = f.tag ? str(f.tag, 32) : null;
      if (!tag) return { ok: false, status: 400 };
      if (await this.stopRing(tag, me))
        await this.cancelOthers(me, tag, "Call picked up", "Picked up on another device", host);
      return { ok: true, status: 200 };
    }
    if (f.k === "ringing") {
      /* The app says whether it is ringing out loud by itself. Only then
         are the repeat notifications left out while it is on screen. */
      const tag = f.tag ? str(f.tag, 32) : null;
      if (!tag) return { ok: false, status: 400 };
      const key = "rl:" + tag + ":" + me;
      const r = await this.ctx.storage.get(key);
      if (r) { r.audible = !!f.audible; await this.ctx.storage.put(key, r); }
      return { ok: true, status: 200 };
    }

    if (f.k === "send") {
      if (!validId(f.to) || typeof f.body !== "string" || f.body.length > MAX_BODY)
        return { ok: false, status: 400 };
      if (!(await this.mayReach(fam, me, f.to))) return { ok: false, status: 403, why: "notintouch" };
      /* Blocked: a call is never started between the two (see block()).
         Everything else - family updates from the admin, group-call
         set-up inside a call someone else started - still passes. */
      if (BLOCKED_SIG[sigType(f.body)] && (await this.blockedEither(me, f.to)))
        return (await this.blockedBy(me, f.to)) ? { ok: false, status: 403, why: "youblocked" }
                                                : { ok: true, status: 200, live: 0 };
      const frame = { k: "msg", id: rid(), time: Date.now(), from: me, body: f.body };
      const live = await this.deliver(f.to, frame, true);
      await this.noticeSignal(me, f.to, f.body, host);
      return { ok: true, status: 200, live: live };
    }
    if (f.k === "ring") return this.ring(me, f, host);
    if (f.k === "chat") return this.chat(me, f, host);
    if (f.k === "rcpt") return this.receipt(me, f);
    if (f.k === "block") return this.block(me, f);
    if (f.k === "mstat") return this.mediaUsage(me, f);
    if (f.k === "room") return this.room(me, f, host);
    if (f.k === "sfu") return this.sfu(me, f);
    if (f.k === "sub") return this.subscribe(me, f.sub);
    if (f.k === "unsub") {
      if (f.endpoint) await this.ctx.storage.delete("sub:" + me + ":" + await hash(f.endpoint));
      return { ok: true, status: 200 };
    }
    if (f.k === "pres") {
      /* Over plain HTTP (no socket) presence can only be a goodbye: the
         app sends "away" this way as the screen locks, because what it
         wrote to its connection in that moment did not always get out
         before the phone froze the page. Every connection of theirs
         that still says "on screen" is marked away at once - so a
         message sent in the next moments raises a notification instead
         of being handed to a phone that cannot show it. Never upwards:
         only the connection itself can say "on". */
      if (f.s === "away" || f.s === "off") {
        let changed = false;
        for (const ws of this.ctx.getWebSockets(me)) {
          const a = this.attachment(ws);
          if (a && a.s === "on") { a.s = "away"; a.at = Date.now(); this.attach(ws, a); changed = true; }
        }
        if (changed) await this.presenceChanged(me);
      }
      return { ok: true, status: 200 };
    }
    return { ok: false, status: 400 };
  }

  /* A message to one person: to every phone of theirs that is connected,
     and kept for the ones that are not (or only look connected - a phone
     that has just gone to sleep often still has an open socket). */
  async deliver(to, frame, keep) {
    const text = JSON.stringify(frame);
    let live = 0;
    for (const ws of this.ctx.getWebSockets(to)) { if (safeSend(ws, text)) live++; }
    if (keep) {
      /* keep === "long": a chat message, kept for a week (see opened). */
      await this.ctx.storage.put("q:" + to + ":" + pad(frame.time) + ":" + frame.id +
                                 (keep === "long" ? ":c" : ""), text);
      if (!(await this.ctx.storage.get("cleanAt"))) {
        await this.ctx.storage.put("cleanAt", Date.now() + 3600 * 1000);
        await this.rearm();
      }
    }
    return live;
  }

  /* The server carries every call's messages, so it can tell when a
     call has been answered, declined or given up - and stop ringing
     then, even for a phone on an older version of the app that does
     not say so itself. Only the few words needed are read. */
  async noticeSignal(me, to, body, host) {
    if (body.length > 24000 || body.indexOf('"call"') === -1) return;
    let s;
    try { s = JSON.parse(body); } catch (e) { return; }
    if (!s || typeof s.call !== "string" || !s.call) return;
    const tag = str(s.call, 32);
    if (s.t === "answer") {
      /* Answered on one of their phones: the others stop ringing. */
      if (await this.stopRing(tag, me))
        await this.cancelOthers(me, tag, "Call answered", "Answered on another device", host);
    } else if (s.t === "bye") {
      /* Either the caller gave up (their ring stops) or the person
         being called declined (theirs does, on every phone). */
      await this.stopRing(tag, to);
      if (await this.stopRing(tag, me))
        await this.cancelOthers(me, tag, "Call declined", "Declined", host);
    } else if (s.t === "busy" || s.t === "elsewhere") {
      await this.stopRing(tag, me);
    }
  }

  /* ------------------------------------------------------------ chat
   *
   * A typed message to one person. It goes to every phone of theirs that
   * is connected, is kept for a week for the ones that are not, and
   * reaches a closed phone as a quiet notification - one short buzz,
   * grouped per sender, never the long ring of a call. A copy goes to
   * the sender's own other phones, so a conversation reads the same on
   * all of them. The phone's own id for the message (cid) makes a
   * retried send harmless: it is delivered once.
   *
   * A reply carries a small reference to the message it answers (re):
   * that message's id, who wrote it and the first few words - so the
   * quote still reads right on a phone that no longer has the original.
   * Only those three fields, checked and cut to size, are passed on. */
  async chat(me, f, host) {
    if (!validId(f.to) || f.to === me) return { ok: false, status: 400 };
    const text = typeof f.text === "string" ? f.text.slice(0, CHAT_MAX) : "";
    const cid = typeof f.cid === "string" && /^[A-Za-z0-9_-]{6,40}$/.test(f.cid) ? f.cid : null;
    /* A picture, a file or a location - checked field by field. */
    const att = attRef(f.a, !!mediaCfg(this.env));
    if (f.a && !att) return { ok: false, status: 400 };
    if ((!text.trim() && !att) || !cid) return { ok: false, status: 400 };
    const fam = await this.famState();
    if (!(await this.mayReach(fam, me, f.to))) return { ok: false, status: 403, why: "notintouch" };
    if (await this.blockedBy(me, f.to)) return { ok: false, status: 403, why: "youblocked" };
    const seenKey = "cid:" + me + ":" + cid;
    const dup = await this.ctx.storage.get(seenKey);
    if (dup) return { ok: true, status: 200, dup: true, time: dup.t, live: dup.live || 0 };

    const now = Date.now();
    /* Blocked by them: taken as sent - as in other messaging apps, the
       person isn't told they are blocked - but never delivered. */
    if (await this.blockedBy(f.to, me)) {
      await this.ctx.storage.put(seenKey, { t: now, live: 0 });
      /* Their own other phones still show it, as sent. */
      await this.deliver(me, { k: "chat", id: rid(), time: now, from: me, to: f.to, cid: cid, text: text }, "long");
      return { ok: true, status: 200, time: now, live: 0, pushed: 0, subs: 1 };
    }
    const frame = { k: "chat", id: rid(), time: now, from: me, to: f.to, cid: cid, text: text };
    const re = replyRef(f.re, me, f.to);
    if (re) frame.re = re;
    if (att) {
      frame.a = att;
      /* A phone on an older version shows only the text: it gets a line
         saying what it is missing instead of an empty bubble. Newer
         phones know to leave that line out. */
      if (!text.trim()) { frame.text = attLabel(att) + " \u2014 update the app to see it"; frame.lbl = 1; }
    }
    const live = await this.deliver(f.to, frame, "long");
    await this.deliver(me, frame, "long");
    await this.ctx.storage.put(seenKey, { t: now, live: live });

    /* A notification only when no phone of theirs has the app on screen:
       an open app shows the message itself, without a buzz on top. */
    let r = { pushed: 0, subs: 0, failed: [] };
    if (!this.visibleCount(f.to)) {
      const name = str(f.title, 80) || "New message";
      const say = att ? attLabel(att) + (text.trim() ? " · " + text : "") : text;
      r = await this.pushTo(f.to, { kind: "msg", title: name, body: str(say, 300),
                                    tag: "m-" + me, from: me, url: str(f.url, 1500),
                                    cid: cid, ts: now }, host, 86400);
    }
    return { ok: true, status: 200, time: now, live: live, pushed: r.pushed, subs: r.subs };
  }

  /* ------------------------------------------------------------ blocking
   *
   * Anyone can block anyone else in the family, for themselves. From then
   * on, between the two of them: no calls, no buzzes, no messages, no
   * read ticks, and neither sees the other's status. The person who was
   * blocked isn't told - what they send is taken as sent and goes
   * nowhere, as in other messaging apps. Family business still passes
   * (the admin's updates, joining, a group call someone else started).
   * Kept here, so it holds whichever phone or version is used. */
  async blockMap() {
    if (!this._blk) {
      const m = new Map();
      for (const [k, v] of await this.ctx.storage.list({ prefix: "blk:" }))
        if (Array.isArray(v) && v.length) m.set(k.slice(4), v);
      this._blk = m;
    }
    return this._blk;
  }
  /* Only after blockMap() has been awaited. */
  isBlocked(a, b) {
    const m = this._blk;
    if (!m || a === b) return false;
    const x = m.get(a), y = m.get(b);
    return !!((x && x.indexOf(b) !== -1) || (y && y.indexOf(a) !== -1));
  }
  async blockedBy(a, b) { const l = (await this.blockMap()).get(a); return !!(l && l.indexOf(b) !== -1); }
  async blockedEither(a, b) { await this.blockMap(); return this.isBlocked(a, b); }

  async block(me, f) {
    if (!validId(f.who) || f.who === me) return { ok: false, status: 400 };
    const m = await this.blockMap();
    let list = (m.get(me) || []).filter((id) => id !== f.who);
    if (f.on) {
      const fam = await this.famState();
      if (fam && !fam.members[f.who]) return { ok: false, status: 400 };
      list.push(f.who);
      list = list.slice(-100);
    }
    if (list.length) { m.set(me, list); await this.ctx.storage.put("blk:" + me, list); }
    else { m.delete(me); await this.ctx.storage.delete("blk:" + me); }
    /* This person's other phones follow at once; everyone's view of who
       is online is worked out again. */
    const text = JSON.stringify({ k: "blocks", list: list });
    for (const ws of this.ctx.getWebSockets(me)) safeSend(ws, text);
    await this.presenceRefresh();
    return { ok: true, status: 200, list: list };
  }

  /* May this person store (op "put", with its size) or fetch (op "get")
   * a picture or file? Asked by the Worker for every one. Storing also
   * counts against the person's daily allowance, so one phone cannot
   * fill the family's storage or run up its bill. */
  async blobOk(req) {
    let b;
    try { b = await req.json(); } catch (e) { return json({ ok: false }, 400); }
    const cfg = mediaCfg(this.env);
    if (!cfg) return json({ ok: false, why: "nomedia" }, 501);
    if (!b || !validId(b.me)) return json({ ok: false }, 400);
    const who = await this.auth(b.me, b.sec, null, "blob", b.dk);
    if (!who.ok) return json({ ok: false, why: "auth" }, 401);
    const fam = await this.famState();
    if (fam && !fam.members[b.me]) return json({ ok: false, why: "notmember" }, 403);
    if (b.op === "put") {
      const size = Math.max(0, Number(b.size) || 0);
      const day = new Date().toISOString().slice(0, 10);
      const k = "mq:" + b.me;
      const u = (await this.ctx.storage.get(k)) || { d: day, n: 0 };
      if (u.d !== day) { u.d = day; u.n = 0; }
      if (u.n + size > cfg.day) return json({ ok: false, why: "quota" }, 429);
      u.n += size;
      await this.ctx.storage.put(k, u);
      /* Old files are removed once a day, while there are any. */
      if (!(await this.ctx.storage.get("sweepAt"))) {
        await this.ctx.storage.put("sweepAt", Date.now() + 86400000);
        await this.rearm();
      }
    }
    return json({ ok: true });
  }

  /* Delivered / read, for messages from one person. Goes back to that
     person (their ticks) and to the reader's own other phones (so a
     conversation read on one phone is not "unread" on the next). */
  async receipt(me, f) {
    if (!validId(f.to) || f.to === me) return { ok: false, status: 400 };
    const s = f.s === "r" ? "r" : "d";
    const ids = Array.isArray(f.ids)
      ? f.ids.filter((x) => typeof x === "string" && /^[A-Za-z0-9_-]{6,40}$/.test(x)).slice(0, 200) : [];
    if (!ids.length) return { ok: true, status: 200 };
    if (!(await this.mayReach(await this.famState(), me, f.to)))
      return { ok: false, status: 403, why: "notintouch" };
    if (await this.blockedEither(me, f.to)) return { ok: true, status: 200 };
    const frame = { k: "rcpt", id: rid(), time: Date.now(), from: me, to: f.to, s: s, ids: ids };
    await this.deliver(f.to, frame, "long");
    if (s === "r") await this.deliver(me, frame, "long");
    return { ok: true, status: 200 };
  }

  /* A ring: shown in the app if it is open in front, and a notification
     through the phone's own push service otherwise. */
  async ring(me, f, host) {
    if (!validId(f.to)) return { ok: false, status: 400 };
    if (!(await this.mayReach(await this.famState(), me, f.to)))
      return { ok: false, status: 403, why: "notintouch" };
    const KINDS = ["call", "group", "buzz", "missed", "test", "cancel"];
    const kind = KINDS.indexOf(f.kind) !== -1 ? f.kind : "buzz";
    /* Blocked: no ring, no buzz, no notification. The person who was
       blocked is answered as if it went - they aren't told. */
    if (kind !== "cancel" && (await this.blockedEither(me, f.to)))
      return (await this.blockedBy(me, f.to)) ? { ok: false, status: 403, why: "youblocked" }
                                              : { ok: true, status: 200, live: 0, pushed: 1, subs: 1 };
    const calling = kind === "call" || kind === "group";
    const tag = f.tag ? str(f.tag, 32) : null;
    /* A missed call or a cancel ends that call's ringing. */
    if ((kind === "missed" || kind === "cancel") && tag) await this.stopRing(tag, f.to);

    /* "In front" only counts if the phone is still answering. A phone
       that locked or froze with the app open can leave its connection
       looking open - and trusting it meant no notification was sent to
       a phone that could not show the call. The app pings every 30 s,
       so silence for 45 s means it is not really there. */
    const visible = this.visibleCount(f.to);
    let live = 0;
    if (kind !== "missed" && kind !== "cancel") {
      const frame = { k: "ring", id: rid(), time: Date.now(), from: me, kind: kind, tag: tag,
                      title: str(f.title, 200), body: str(f.body, 500) };
      live = await this.deliver(f.to, frame, false);
    }
    const payload = pushPayload(me, kind, f, tag);
    /* The Decline button acts for the person being called: it gets a
       single-use permission for that, not their key. */
    if (payload.dec && payload.dec.b && payload.dec.b.me === f.to)
      payload.dec.b = Object.assign({}, payload.dec.b,
        { cap: await this.makeCap(f.to, ["send", "room"], 5 * 60 * 1000) });
    let r = { pushed: 0, subs: 0, failed: [] };
    /* A call is always sent as a notification too. When an iPhone app
       is swiped away, its connection can look open for a while, and a
       call placed in that window reached nobody. A banner on top of a
       call screen that is already ringing costs nothing; a silent phone
       costs the call. Buzzes still skip it when the app is in front. */
    if (!visible || kind !== "buzz")
      r = await this.pushTo(f.to, payload, host, calling ? 60 : 3600);

    if (calling && tag) {
      const now = Date.now();
      const until = now + Math.min(Math.max(Number(f.ringFor) || RING_FOR, 10000), RING_FOR);
      await this.ctx.storage.put("rl:" + tag + ":" + f.to,
        { tag: tag, to: f.to, from: me, payload: payload, host: host || null,
          until: until, next: now + RING_EVERY, n: 0 });
      await this.rearm();
    }
    const ok = visible > 0 || r.pushed > 0 || live > 0;
    return { ok: ok, status: ok ? 200 : (r.subs ? "pushfail" : "nosub"),
             visible: visible, live: live, pushed: r.pushed, subs: r.subs, failed: r.failed };
  }

  /* Every phone of one person, through their push service. */
  async pushTo(to, payload, host, ttl) {
    const list = await this.ctx.storage.list({ prefix: "sub:" + to + ":" });
    const out = { pushed: 0, subs: list.size, failed: [] };
    if (!list.size) return out;
    const text = fitPayload(payload);
    const keys = await this.vapid();
    const jobs = [];
    for (const [key, sub] of list) {
      jobs.push((sub.fcm ? this.fcmSend(sub.fcm, text, ttl) : this.webPushCached(sub, text, keys, host, ttl))
        .then(async (status) => {
          if (status >= 200 && status < 300) out.pushed++;
          else {
            out.failed.push(status);
            /* Gone for good: the phone unsubscribed or the app was removed. */
            if (status === 404 || status === 410) await this.ctx.storage.delete(key);
          }
        }).catch(() => { out.failed.push(0); }));
    }
    await Promise.all(jobs);
    return out;
  }

  /* Takes a stale "is calling you" off a person's other phones. Only
     worth doing when they have more than one: the phone that answered
     already knows. */
  async cancelOthers(to, tag, title, body, host) {
    const list = await this.ctx.storage.list({ prefix: "sub:" + to + ":", limit: 2 });
    if (list.size < 2) return;
    await this.pushTo(to, { kind: "cancel", tag: tag, title: title, body: body,
                            ts: Date.now() }, host, 60);
  }

  /* The notification that replaces a call nobody picked up. */
  async sendMissed(rang, host, title) {
    const who = String(rang.payload.title || "").replace(/\s+is calling you.*$/i, "") || "Someone";
    await this.pushTo(rang.to, { kind: "missed", tag: rang.tag, from: rang.from,
      title: title || "Missed call", body: who + " tried to call you",
      url: rang.payload.url, cb: rang.from, ts: Date.now() }, host || rang.host, 3600);
  }

  /* Stops one person's ringing for one call. Returns what was ringing. */
  async stopRing(tag, to) {
    if (!tag || !to) return null;
    const key = "rl:" + tag + ":" + to;
    const r = await this.ctx.storage.get(key);
    if (r) await this.ctx.storage.delete(key);
    return r || null;
  }

  async ringTick(now) {
    const loops = await this.ctx.storage.list({ prefix: "rl:" });
    const jobs = [];
    for (const [key, r] of loops) {
      if (now >= r.until) {
        /* Rang out and nobody said so - the caller's phone may have
           died mid-call. Said as a missed call, so "is calling you"
           does not sit on their screen for ever. */
        await this.ctx.storage.delete(key);
        jobs.push(this.sendMissed(r, r.host, r.payload.kind === "group" ? "Missed group call" : "Missed call"));
        continue;
      }
      if (r.next > now + 100) continue;
      r.n++;
      r.next = now + RING_EVERY;
      await this.ctx.storage.put(key, r);
      /* With the app on screen AND ringing out loud, it rings by itself.
         On screen but silent (the browser would not let it play sound
         before a first tap) the notification keeps ringing instead -
         that silence was the incoming call nobody heard. */
      if (r.audible && this.visibleCount(r.to)) continue;
      jobs.push(this.pushTo(r.to, Object.assign({}, r.payload, { n: r.n, ts: now }), r.host, 20));
    }
    await Promise.all(jobs);
  }

  async subscribe(me, sub) {
    let clean, h;
    if (sub && typeof sub.fcm === "string") {
      /* The family's Android app: a Firebase registration token instead
         of a browser subscription. Kept under the same "sub:" names, so
         everything else (one device = one person, unsub, clean-up when
         the app is removed) works the same. Unsubscribed with
         endpoint "fcm:<token>". */
      if (!fcmReady(this.env)) return { ok: false, status: 501, why: "nofcm" };
      if (!/^[A-Za-z0-9_:\-]{20,4096}$/.test(sub.fcm)) return { ok: false, status: 400 };
      clean = { fcm: sub.fcm };
      h = await hash("fcm:" + sub.fcm);
    } else {
      /* Real push services are always https; plain http is accepted only
         for 127.0.0.1, which is what the local test setup uses. */
      if (!sub || typeof sub.endpoint !== "string" || !pushHostOk(sub.endpoint) ||
          !sub.keys || typeof sub.keys.p256dh !== "string" || typeof sub.keys.auth !== "string")
        return { ok: false, status: 400 };
      clean = { endpoint: sub.endpoint, keys: { p256dh: sub.keys.p256dh, auth: sub.keys.auth } };
      h = await hash(sub.endpoint);
    }
    /* One device belongs to one person: the one it is signed in as now.
       A laptop once signed in as "Musab Mobile" and later as "Musab
       laptop" kept receiving Musab Mobile's calls. */
    const all = await this.ctx.storage.list({ prefix: "sub:" });
    const stale = [];
    for (const k of all.keys()) {
      const parts = k.split(":");
      if (parts[2] === h && parts[1] !== me) stale.push(k);
    }
    if (stale.length) await this.ctx.storage.delete(stale);
    await this.ctx.storage.put("sub:" + me + ":" + h, clean);
    return { ok: true, status: 200 };
  }

  /* ------------------------------------------------ who is in it
   *
   * The admin's phone signs the family (see the app) and hands the
   * signed copy to this server as well as to each phone. Checked against
   * the admin's public key, it tells the server who is in the family
   * and who each person may see - so the privacy the admin sets is kept
   * here too, not only on the phones: somebody not in touch with you
   * gets neither your status nor a way to call you, and a phone that is
   * not in the family at all gets nothing but "waiting to be let in".
   *
   * A family whose admin has not sent a signed copy yet works exactly as
   * before - open to whoever has the link. */

  /* ------------------------------------------------ who is calling
   *
   * Every phone proves who it is with a secret key for its person:
   *  - a person the admin adds gets theirs inside their invite link, and
   *    the admin's signed family tells this server its fingerprint, so
   *    only the holder of that link can ever sign in as them;
   *  - a phone already in the family when this arrived makes its own
   *    and registers it the first time it connects;
   *  - a newcomer registers theirs with their request to join.
   * Only a fingerprint (SHA-256) is kept here, never the key. A phone
   * whose key does not match is turned away - however well it knows
   * the family's id and the person's id. The admin can reset a person's
   * key (a new phone, a lost app): the next signed family carries the
   * new fingerprint.
   *
   * A notification's Decline / Reject button cannot hold the key; the
   * server gives it a single-use permission instead (a "cap"), good for
   * that one action, for a short time. */
  async auth(me, sec, cap, kind, dk, dl) {
    if (!validId(me)) return { ok: false };
    if (typeof cap === "string" && cap) {
      const c = await this.ctx.storage.get("cap:" + cap);
      if (!c || c.me !== me || c.exp < Date.now() || (c.kinds && c.kinds.indexOf(kind) === -1))
        return { ok: false };
      await this.ctx.storage.delete("cap:" + cap);
      return { ok: true, cap: true };
    }
    const good = typeof sec === "string" && sec.length >= 16 && sec.length <= 80;
    const kh = good ? await keyHash(sec) : null;
    const rec = await this.ctx.storage.get("key:" + me);
    if (rec) return rec.h === kh ? this.devCheck(me, dk, dl, kh) : { ok: false };
    if (!kh) {
      /* A phone from before keys existed. Allowed until this person has
         a key - then only the key will do. */
      return { ok: true, legacy: true };
    }
    /* First phone with a key for this person: it is theirs. Only for
       people in the family (or any, before the admin has signed one);
       a newcomer's key is kept with their request to join instead. */
    const fam = await this.famState();
    if (!fam || fam.members[me])
      await this.ctx.storage.put("key:" + me, { h: kh, rk: 0, at: Date.now(), how: "claimed" });
    return this.devCheck(me, dk, dl, kh);
  }

  /* ---- One device per member ----
     Each device has its own key (dk); the server keeps the fingerprint of
     the one device each member is signed in on. A different device waits
     until the member's device - or an admin - allows it, and that signs
     the other device out. */
  async devCheck(me, dk, dl, kh) {
    const fam = await this.famState();
    if (fam && !fam.members[me]) return { ok: true, kh: kh };
    const dev = await this.ctx.storage.get("dev:" + me);
    if (typeof dk !== "string" || dk.length < 16 || dk.length > 80)
      return dev ? { ok: false, why: "device", dh: null } : { ok: true, kh: kh };
    const dh = await keyHash("dev:" + dk);
    const label = devLabel(dl);
    if (!dev) {
      await this.ctx.storage.put("dev:" + me, { h: dh, l: label, at: Date.now() });
      return { ok: true, kh: kh, dh: dh };
    }
    if (dev.h === dh) return { ok: true, kh: kh, dh: dh };
    return { ok: false, why: "device", dh: dh, dl: label, cur: dev.l || "" };
  }

  async devRequest(me, dh, label, host, toAdmins) {
    if (!dh) return;
    const key = "dr:" + me, now = Date.now();
    const old = await this.ctx.storage.get(key);
    const same = !!(old && old.h === dh && now - old.at < DEVREQ_MS);
    const r = same ? old : { h: dh, l: label || "another device", at: now };
    const newAdm = toAdmins && !r.adm;
    if (toAdmins) r.adm = 1;
    await this.ctx.storage.put(key, r);
    if (same && !newAdm) return;
    host = host || await this.ownHost();
    const fam = await this.famState();
    const name = fam && fam.members[me] ? fam.members[me].n : "";
    const frame = JSON.stringify({ k: "devreq", req: { who: me, name: name, l: r.l, at: r.at, adm: !!r.adm } });
    if (!same) {
      for (const ws of this.ctx.getWebSockets(me)) safeSend(ws, frame);
      await this.pushTo(me, { kind: "info", tag: "dr-" + me, ts: now, title: "Sign-in request",
        body: "A new device (" + r.l + ") wants to open Family Notifier as you. Open the app to allow or deny." },
        host, DEVREQ_MS / 1000);
    }
    if (newAdm && fam) {
      for (const aid of admIds(fam)) {
        if (aid === me) continue;
        for (const ws of this.ctx.getWebSockets(aid)) safeSend(ws, frame);
        await this.pushTo(aid, { kind: "info", tag: "dr-" + me, ts: now,
          title: (name || "Someone") + " needs a new device approved",
          body: "Their other device is lost or not at hand. Open the app to allow or deny." },
          host, DEVREQ_MS / 1000);
      }
    }
  }

  async sendDevReqs(ws, fam, me) {
    const list = await this.ctx.storage.list({ prefix: "dr:" });
    const now = Date.now();
    for (const [k, r] of list) {
      if (now - r.at > DEVREQ_MS) { await this.ctx.storage.delete(k); continue; }
      const who = k.slice(3);
      if (who === me || (r.adm && isAdm(fam, me)))
        safeSend(ws, JSON.stringify({ k: "devreq", req: { who: who,
          name: fam && fam.members[who] ? fam.members[who].n : "", l: r.l, at: r.at, adm: !!r.adm } }));
    }
  }

  async devDecide(me, f) {
    const who = validId(f.who) ? f.who : me;
    const fam = await this.famState();
    if (who !== me && !isAdm(fam, me)) return { ok: false, status: 403 };
    const r = await this.ctx.storage.get("dr:" + who);
    if (!r || Date.now() - r.at > DEVREQ_MS) {
      await this.ctx.storage.delete("dr:" + who);
      return { ok: false, status: "gone" };
    }
    if (f.ok) await this.devApprove(who, r.h, r.l);
    else await this.devDeny(who, r.h);
    return { ok: true, status: 200 };
  }

  async devApprove(who, dh, label) {
    await this.ctx.storage.put("dev:" + who, { h: dh, l: label || "", at: Date.now() });
    await this.ctx.storage.delete("dr:" + who);
    /* The old device is signed out, and stops ringing: its notification
       registrations go, and the new device makes its own. */
    const subs = await this.ctx.storage.list({ prefix: "sub:" + who + ":" });
    if (subs.size) await this.ctx.storage.delete([...subs.keys()]);
    const out = JSON.stringify({ k: "auth", ok: false, why: "replaced" });
    for (const ws of this.ctx.getWebSockets(who)) { safeSend(ws, out); try { ws.close(4002, "replaced"); } catch (e) {} }
    const ok = JSON.stringify({ k: "devok" });
    for (const ws of this.ctx.getWebSockets("pend:" + who)) {
      const a = this.attachment(ws);
      if (a && a.dh === dh) { safeSend(ws, ok); try { ws.close(4003, "approved"); } catch (e) {} }
    }
    this.adminFrame(await this.famState(), { k: "devdone", who: who });
  }

  async devDeny(who, dh) {
    await this.ctx.storage.delete("dr:" + who);
    const no = JSON.stringify({ k: "devno" });
    for (const ws of this.ctx.getWebSockets("pend:" + who)) {
      const a = this.attachment(ws);
      if (a && a.dh === dh) { safeSend(ws, no); try { ws.close(4004, "denied"); } catch (e) {} }
    }
    const done = JSON.stringify({ k: "devdone", who: who });
    for (const ws of this.ctx.getWebSockets(who)) safeSend(ws, done);
    this.adminFrame(await this.famState(), { k: "devdone", who: who });
  }

  /* What a waiting device may say: "ask the admin", or - an admin's own
     new device - an approval signed with the family key. */
  async pendingMsg(ws, a, f) {
    if (f.k === "devask") { await this.devRequest(a.me, a.dh, a.dl, null, true); return; }
    if (f.k !== "devsign" || typeof f.text !== "string" || typeof f.sig !== "string" || f.text.length > 500) return;
    const fam = await this.famState();
    const house = this.house || (await this.ctx.storage.get("house"));
    let t = null;
    try { t = JSON.parse(f.text); } catch (e) {}
    if (!fam || !Array.isArray(t) || t[0] !== "dev" || t[1] !== house || t[2] !== a.me || t[3] !== a.dh ||
        Math.abs(Date.now() - Number(t[4])) > DEVREQ_MS || !isAdm(fam, a.me)) return;
    if (await verifySig(fam.admin.pub, f.text, f.sig)) await this.devApprove(a.me, a.dh, a.dl);
  }

  async makeCap(me, kinds, ms) {
    const t = b64u(crypto.getRandomValues(new Uint8Array(18)));
    await this.ctx.storage.put("cap:" + t, { me: me, kinds: kinds, exp: Date.now() + ms });
    return t;
  }

  async famState() {
    if (this._fam === undefined) this._fam = (await this.ctx.storage.get("fam")) || null;
    return this._fam;
  }

  /* Whether `a` may see `b`. The admin sees everyone; everyone may reach
     the admin (strict leaves that out, for status); anyone else sees the
     people ticked for them - or everybody, if the admin never narrowed
     it down. */
  /* Two people are in touch only if neither is kept from the other: a
     person set to "only people I choose" is seen only by those people,
     even by someone else who is set to see everyone. */
  sees(fam, a, b, strict) {
    if (!fam) return true;
    const A = fam.members[a], B = fam.members[b];
    if (!A || !B) return false;
    if (a === b || isAdm(fam, a)) return true;
    if (isAdm(fam, b)) return !strict || !A.c || A.c.indexOf(b) !== -1;
    return (!A.c || A.c.indexOf(b) !== -1) && (!B.c || B.c.indexOf(a) !== -1);
  }
  inTouch(fam, a, b) { return this.sees(fam, a, b) || this.sees(fam, b, a); }

  /* Messages may also pass between two people in the same group call -
     somebody invited them both, and the call needs every pair to talk. */
  async mayReach(fam, a, b) {
    if (!fam || this.inTouch(fam, a, b)) return true;
    if (!fam.members[a] || !fam.members[b]) return false;
    const rooms = await this.ctx.storage.list({ prefix: "room:" });
    for (const r of rooms.values()) {
      const inA = r.live[a] || r.inv[a], inB = r.live[b] || r.inv[b];
      if (inA && inB) return true;
    }
    return false;
  }

  async publish(me, f, host) {
    if (typeof f.fam !== "string" || typeof f.sig !== "string" || f.fam.length > 200000)
      return { ok: false, status: 400 };
    let arr;
    try { arr = JSON.parse(f.fam); } catch (e) { return { ok: false, status: 400 }; }
    const p = parseFam(arr);
    if (!p || (this.house && p.house !== this.house)) return { ok: false, status: 400 };
    const cur = await this.famState();
    /* Replacing the family key (a co-admin was removed): the old key
       signs a short statement naming the new one, and the family itself
       comes signed with the new key. Kept, so a phone that was off for
       the change can still follow it later. */
    let rotated = null;
    if (cur && f.rot && typeof f.rot.text === "string" && typeof f.rot.sig === "string" &&
        f.rot.text.length < 1000) {
      let r = null;
      try { r = JSON.parse(f.rot.text); } catch (e) {}
      if (Array.isArray(r) && r[0] === "rot" && r[1] === p.house && r[2] === cur.admin.pub.x &&
          r[3] && r[3].x === p.admin.pub.x && r[3].y === p.admin.pub.y &&
          await verifySig(cur.admin.pub, f.rot.text, f.rot.sig)) rotated = { text: f.rot.text, sig: f.rot.sig };
      else return { ok: false, status: 403, why: "rot" };
    }
    const same = !!cur && (rotated ||
                 (cur.admin.pub.x === p.admin.pub.x && cur.admin.pub.y === p.admin.pub.y));
    /* A different admin key. Only after "Admin key lost for good" does
       that happen legitimately, and then a member of the family may
       bring the new key in - once the old one has been silent a day, so
       nobody can quietly take a working family over. */
    if (cur && !same &&
        (!f.reset || !cur.members[me] || Date.now() - (cur.at || 0) < REKEY_AFTER))
      return { ok: false, status: "rekey",
               wait: Math.max(0, REKEY_AFTER - (Date.now() - (cur.at || 0))) };
    if (!(await verifySig(p.admin.pub, f.fam, f.sig))) return { ok: false, status: 403 };
    /* The first signed family for this house: whoever brings it must be
       in it (and the admin must name themselves). A phone that merely
       holds a link to an unmanaged family cannot make itself its admin
       behind everybody's back. */
    if (!cur && !(p.members || []).some((m) => m && m.id === me)) return { ok: false, status: 403, why: "notmember" };
    if (!cur && !creationKeyOk(this.env, f.ck)) {
      const g = isGrantShape(f.ck) ? await this.regCall("grantuse", { g: grantNorm(f.ck), house: p.house }) : null;
      if (!g || !g.ok) return { ok: false, status: 403, why: "createkey" };
    }
    if (same && p.rev <= cur.rev) return { ok: true, status: 200, stale: true, rev: cur.rev };
    if (rotated) {
      const chain = (await this.ctx.storage.get("rotchain")) || [];
      chain.push(rotated);
      await this.ctx.storage.put("rotchain", chain.slice(-10));
    }

    const members = {};
    for (const m of p.members) {
      if (!m || !validId(m.id)) continue;
      members[m.id] = { n: str(m.name, 40), c: Array.isArray(m.c) ? m.c.filter(validId) : null };
    }
    if (!members[p.admin.id]) return { ok: false, status: 400 };
    /* Keys the admin issued: a new person's, or a reset one's. A reset
       (a newer rk) replaces whatever key that person had. */
    for (const m of p.members) {
      if (!m || !members[m.id] || typeof m.kh !== "string" || !/^[A-Za-z0-9_-]{40,48}$/.test(m.kh)) continue;
      const rk = Number(m.rk) || 0;
      const rec = await this.ctx.storage.get("key:" + m.id);
      if (!rec || rk > (rec.rk || 0)) {
        await this.ctx.storage.put("key:" + m.id, { h: m.kh, rk: rk, at: Date.now(), how: "admin" });
        await this.ctx.storage.delete("dev:" + m.id);
        /* A reset takes effect at once: a phone still connected with the
           old key is signed out now, not at its next reconnect. */
        if (rec) for (const ws of this.ctx.getWebSockets(m.id)) {
          const a = this.attachment(ws);
          if (a && a.kh !== m.kh) {
            safeSend(ws, JSON.stringify({ k: "auth", ok: false }));
            try { ws.close(4001, "signed out"); } catch (e) {}
          }
        }
      }
    }

    const views = {};
    if (f.views && typeof f.views === "object") {
      for (const id of Object.keys(f.views)) {
        const v = f.views[id];
        if (!members[id] || !v || typeof v.fam !== "string" || typeof v.sig !== "string" ||
            v.fam.length > 100000) continue;
        let va;
        try { va = JSON.parse(v.fam); } catch (e) { continue; }
        const pv = parseFam(va);
        if (!pv || pv.house !== p.house || pv.rev !== p.rev) continue;
        if (!(await verifySig(p.admin.pub, v.fam, v.sig))) continue;
        views[id] = { fam: v.fam, sig: v.sig };
      }
    }

    if (cur) for (const id of Object.keys(cur.members)) {
      if (!members[id]) await this.dropInvite(id);
    }
    const admins = (p.admins || []).filter((id) => members[id] && id !== p.admin.id);
    const fam = { rev: p.rev, members: members, at: Date.now(), admins: admins,
                  admin: { id: p.admin.id, pub: { kty: "EC", crv: "P-256",
                                                  x: p.admin.pub.x, y: p.admin.pub.y } } };
    await this.ctx.storage.put("fam", fam);
    this._fam = fam;

    const old = await this.ctx.storage.list({ prefix: "view:" });
    const drop = [];
    for (const k of old.keys()) if (!members[k.slice(5)]) drop.push(k);
    if (drop.length) await this.ctx.storage.delete(drop);
    for (const id of Object.keys(views)) {
      await this.ctx.storage.put("view:" + id, views[id]);
      const text = JSON.stringify({ k: "fam", fam: views[id].fam, sig: views[id].sig });
      for (const ws of this.ctx.getWebSockets(id)) safeSend(ws, text);
    }

    /* Requests answered by this change: the person is in now. */
    const jrs = await this.ctx.storage.list({ prefix: "jr:" });
    for (const [key, r] of jrs) {
      if (!members[r.id]) continue;
      await this.ctx.storage.delete(key);
      await this.joined(fam, r, host);
    }
    await this.presenceRefresh();
    return { ok: true, status: 200, rev: fam.rev };
  }

  /* Somebody asking to join: the person themselves (after opening their
     invite and giving their name), or a member on behalf of somebody
     they are inviting. Kept here until the admin decides, and the admin
     is told at once - on screen if the app is open, and with a
     notification carrying Approve and Reject if it is not. */
  async join(me, f, host, kh) {
    const id = f.id || me;
    const name = str(f.name, 40).trim();
    if (!validId(id) || !name) return { ok: false, status: 400 };
    const fam = await this.famState();
    if (!fam) return { ok: false, status: "noadmin" };
    if (id !== me && !fam.members[me]) return { ok: false, status: 403 };
    if (fam.members[id]) return { ok: true, status: 200, member: true };
    const key = "jr:" + id, now = Date.now();
    let r = await this.ctx.storage.get(key);
    const fresh = !r;
    if (fresh) {
      const open = await this.ctx.storage.list({ prefix: "jr:" });
      let live = 0;
      for (const [k, x] of open) {
        if (now - (x.last || x.at) > JOIN_KEEP_MS) await this.ctx.storage.delete(k);
        else live++;
      }
      if (live >= JOIN_MAX) return { ok: false, status: "full" };
      r = { id: id, at: now };
    }
    const self = id === me;
    /* A newcomer's phone registers its key with its request, so nobody
       else can later sign in as them. */
    if (self && kh && !(await this.ctx.storage.get("key:" + id)))
      await this.ctx.storage.put("key:" + id, { h: kh, rk: 0, at: now, how: "join" });
    if (self || !r.self) r.name = name;
    if (self) r.self = true;
    if (typeof f.colour === "string" && /^#[0-9A-Fa-f]{6}$/.test(f.colour)) r.colour = f.colour;
    const by = !self ? me : (validId(f.by) && fam.members[f.by] ? f.by : null);
    if (by && !isAdm(fam, by)) r.by = by;
    r.last = now;
    const tell = fresh || now - (r.told || 0) > 10 * 60 * 1000 || (self && !r.toldSelf);
    if (tell) { r.told = now; if (self) r.toldSelf = true; }
    await this.ctx.storage.put(key, r);
    if (tell) await this.tellAdmin(fam, r, host);
    else this.adminFrame(fam, { k: "joinreq", req: joinView(r) });
    return { ok: true, status: 200, pending: true, admin: fam.admin.id };
  }

  adminFrame(fam, frame) {
    const text = JSON.stringify(frame);
    let n = 0;
    for (const id of admIds(fam))
      for (const ws of this.ctx.getWebSockets(id)) if (safeSend(ws, text)) n++;
    return n;
  }

  async tellAdmin(fam, r, host) {
    this.adminFrame(fam, { k: "joinreq", req: joinView(r) });
    const byName = r.by && fam.members[r.by] ? fam.members[r.by].n : null;
    const house = this.house || (await this.ctx.storage.get("house"));
    host = host || await this.ownHost();
    for (const aid of admIds(fam)) {
      await this.pushTo(aid, {
        kind: "approve", tag: "jr-" + r.id, jr: r.id, ts: Date.now(), n: 0,
        title: r.name + " wants to join",
        body: (byName ? "Invited by " + byName + ". " : "") + "Approve to let them in.",
        rej: (host && house) ? { u: "https://" + host + "/f/" + house + "/send",
                                 b: { me: aid, k: "jdecide", id: r.id, ok: false,
                                      cap: await this.makeCap(aid, ["jdecide"], 24 * 3600 * 1000) } } : null
      }, host, 24 * 3600);
    }
  }

  async sendJoinRequests(ws) {
    const list = await this.ctx.storage.list({ prefix: "jr:" });
    const now = Date.now();
    for (const [k, r] of list) {
      if (now - (r.last || r.at) > JOIN_KEEP_MS) { await this.ctx.storage.delete(k); continue; }
      safeSend(ws, JSON.stringify({ k: "joinreq", req: joinView(r) }));
    }
  }

  /* The admin said no. Only the admin's phone can say so. (Yes needs the
     admin's signature, so it arrives as a new family - see publish.) */
  async joinDecide(me, f, host) {
    const fam = await this.famState();
    if (!fam || !isAdm(fam, me) || !validId(f.id)) return { ok: false, status: 403 };
    const key = "jr:" + f.id;
    const r = await this.ctx.storage.get(key);
    if (!r) return { ok: true, status: 200, gone: true };
    if (f.ok !== false) return { ok: true, status: 200 };
    await this.ctx.storage.delete(key);
    const adminName = (fam.members[fam.admin.id] || {}).n || "The admin";
    const no = JSON.stringify({ k: "joinno", id: r.id, name: r.name });
    for (const ws of this.ctx.getWebSockets(r.id)) safeSend(ws, no);
    await this.pushTo(r.id, { kind: "info", tag: "jr-" + r.id, ts: Date.now(),
      title: "Not added to the family",
      body: adminName + " didn't approve this request." }, host, 3600);
    if (r.by && fam.members[r.by]) {
      for (const ws of this.ctx.getWebSockets(r.by)) safeSend(ws, no);
      await this.pushTo(r.by, { kind: "info", tag: "jr-" + r.id, ts: Date.now(),
        title: r.name + " wasn't added",
        body: adminName + " didn't approve the request." }, host, 3600);
    }
    this.adminFrame(fam, { k: "joindone", id: r.id });
    for (const aid of admIds(fam))
      await this.cancelOthers(aid, "jr-" + r.id, "Request answered", r.name + " was not added", host);
    return { ok: true, status: 200 };
  }

  async joined(fam, r, host) {
    const adminName = (fam.members[fam.admin.id] || {}).n || "The admin";
    const ok = JSON.stringify({ k: "joinok", id: r.id, name: r.name });
    for (const ws of this.ctx.getWebSockets(r.id)) safeSend(ws, ok);
    await this.pushTo(r.id, { kind: "info", tag: "jr-" + r.id, ts: Date.now(),
      title: "You're in",
      body: adminName + " added you to the family. Tap to open." }, host, 24 * 3600);
    if (r.by && fam.members[r.by]) {
      for (const ws of this.ctx.getWebSockets(r.by)) safeSend(ws, ok);
      await this.pushTo(r.by, { kind: "info", tag: "jr-" + r.id, ts: Date.now(),
        title: r.name + " has joined",
        body: adminName + " approved them." }, host, 3600);
    }
    this.adminFrame(fam, { k: "joindone", id: r.id });
    for (const aid of admIds(fam))
      await this.cancelOthers(aid, "jr-" + r.id, "Request answered", r.name + " was added", host);
  }

  /* ------------------------------------------------- short invites
   *
   * An invite link used to carry the whole family's setup - names,
   * server addresses, relay details - as a few hundred scrambled
   * characters, which looked alarming and put the relay's password in
   * every link. Now the phone making the invite hands that setup here,
   * and the link carries only a code for it.
   *
   * One code per person, and the same one each time while it is valid,
   * so sending someone their link twice sends the same link. It lasts
   * 30 days, and stops working at once when the person is removed or
   * their sign-in is reset (a new key means a new code). The admin's
   * recovery link is never made short: it holds the admin key, which
   * must not be stored anywhere but the admin's phone. */
  async invite(me, f) {
    const fam = await this.famState();
    const id = f.m;
    if (!validId(id) || typeof f.j !== "string" || f.j.length > 12000 || !/^[A-Za-z0-9_-]+$/.test(f.j))
      return { ok: false, status: 400 };
    if (fam) {
      if (!fam.members[me]) return { ok: false, status: 403 };
      /* Someone already in the family: only the admin (or they
         themselves) may make their link. Somebody new: any member may
         invite them - they still need the admin's approval to join. */
      if (fam.members[id] && !isAdm(fam, me) && me !== id) return { ok: false, status: 403 };
    }
    const sec = typeof f.s === "string" && /^[A-Za-z0-9_-]{16,80}$/.test(f.s) ? f.s : null;
    const data = { j: f.j, m: id, s: sec, p: f.p ? 1 : 0,
                   by: validId(f.by) ? f.by : null };
    const kt = sec ? (await keyHash(sec)).slice(0, 12) : "";
    const now = Date.now();
    const cur = await this.ctx.storage.get("invcode:" + id);
    let code, exp;
    if (cur && cur.kt === kt && cur.exp - now > 7 * 24 * 3600 * 1000) {
      code = cur.code; exp = cur.exp;
    } else {
      /* The old code is retired, not deleted: whoever still holds that link
         can ask for a new one from it, and is told a newer one was sent. */
      if (cur) await this.regCall("retire", { c: cur.code });
      code = inviteCode(); exp = now + LINK_MS;
    }
    /* The family's id from storage when this object was woken by a message
       on the live connection rather than a request (then this.house is
       unset). Without it an expired link could not be traced back here. */
    const house = this.house || (await this.ctx.storage.get("house")) || null;
    const r = await this.regCall("put", { c: code, house: house, exp: exp, data: data });
    if (!r || !r.ok) return { ok: false, status: 500 };
    await this.ctx.storage.put("invcode:" + id, { code: code, kt: kt, exp: exp });
    /* Somebody asked for this person's link to be renewed: this is it. */
    if (await this.ctx.storage.get("rn:" + id)) {
      await this.ctx.storage.delete("rn:" + id);
      this.broadcastFrame({ k: "renewdone", m: id });
    }
    return { ok: true, status: 200, code: code, exp: exp };
  }

  /* ------------------------------------------------- renewing a link
   *
   * Somebody opened their invite link after it expired. Rather than a
   * dead end ("ask whoever invited you"), the link asks for them: the
   * person who sent it - or the admins, for someone already in the
   * family - gets a card in the app and a notification, and sends a
   * fresh link with one tap. The ask lives until a link is made or it
   * is dismissed, for two weeks at most. */
  async renewAsk(req) {
    let b = null;
    try { b = await req.json(); } catch (e) {}
    const fam = await this.famState();
    if (!b || !validId(b.m)) return json({ ok: false }, 400);
    if (!fam) return json({ ok: false, why: "nofam" }, 404);
    const m = b.m;
    const who = fam.members[m] || null;
    const by = validId(b.by) && fam.members[b.by] ? b.by : null;
    /* The family admin is always asked. For a newcomer, the person who
       invited them is asked as well: their phone holds the newcomer's
       details, and any member may make that link (see invite). */
    const targets = admIds(fam).slice();
    if (by && targets.indexOf(by) === -1) targets.push(by);
    if (!targets.length) return json({ ok: false, why: "noadmin" }, 404);
    const now = Date.now();
    const old = await this.ctx.storage.get("rn:" + m);
    const r = { m: m, by: by, name: who ? who.n : null, to: targets, at: (old && old.at) || now, last: now,
                n: ((old && old.n) || 0) + 1 };
    await this.ctx.storage.put("rn:" + m, r);
    const frame = JSON.stringify({ k: "renew", req: renewView(r) });
    const host = await this.ownHost();
    const label = who ? who.n : (by ? "Someone you invited" : "Someone");
    for (const id of targets) {
      for (const ws of this.ctx.getWebSockets(id)) safeSend(ws, frame);
      await this.pushTo(id, {
        kind: "renew", tag: "rn-" + m, rn: m, ts: now, n: 0,
        title: label + " needs a new link",
        body: "Their invitation expired. Tap to send a fresh one."
      }, host, 24 * 3600);
    }
    /* Who was told, in words, for the person waiting. */
    const first = fam.members[targets[0]];
    const to = targets.length === 1 && first ? String(first.n || "").split(/\s+/)[0] : null;
    return json({ ok: true, to: to || null });
  }

  async sendRenewals(ws, fam, me) {
    const list = await this.ctx.storage.list({ prefix: "rn:" });
    const now = Date.now();
    for (const [k, r] of list) {
      if (now - (r.last || r.at) > JOIN_KEEP_MS) { await this.ctx.storage.delete(k); continue; }
      if ((r.to || []).indexOf(me) !== -1 || isAdm(fam, me))
        safeSend(ws, JSON.stringify({ k: "renew", req: renewView(r) }));
    }
  }

  /* Dismissed without sending - by anyone it was addressed to. */
  async renewDrop(me, f) {
    const fam = await this.famState();
    if (!fam || !validId(f.m)) return { ok: false, status: 400 };
    const r = await this.ctx.storage.get("rn:" + f.m);
    if (!r) return { ok: true, status: 200 };
    if ((r.to || []).indexOf(me) === -1 && !isAdm(fam, me)) return { ok: false, status: 403 };
    await this.ctx.storage.delete("rn:" + f.m);
    this.broadcastFrame({ k: "renewdone", m: f.m });
    return { ok: true, status: 200 };
  }

  broadcastFrame(frame) {
    const text = JSON.stringify(frame);
    for (const ws of this.ctx.getWebSockets()) { const a = this.attachment(ws); if (!a || !a.pending) safeSend(ws, text); }
  }

  async dropInvite(id) {
    const cur = await this.ctx.storage.get("invcode:" + id);
    if (!cur) return;
    await this.regCall("del", { c: cur.code });
    await this.ctx.storage.delete("invcode:" + id);
  }

  async regCall(op, body) {
    try {
      const reg = this.env.FAMILY.get(this.env.FAMILY.idFromName(INVITE_REG));
      const res = await reg.fetch(new Request("https://registry/_inv/" + op,
        { method: "POST", body: JSON.stringify(body) }));
      return await res.json();
    } catch (e) { return null; }
  }

  /* ------------------------------------------------ storage, in total
   *
   * Kept by the one registry object, for the whole bucket - every family
   * on this server shares it, and so shares Cloudflare's free allowance.
   * Counted properly (by listing the bucket) at most once an hour, or
   * every few minutes while an admin is looking; in between, each new
   * file is added and each deleted one taken off, so it stays close.
   *   op "get"      the numbers (fresh: counted again if a few minutes old)
   *   op "reserve"  room for a new file of `size` - refused when full
   *   op "sub"      files of `size` bytes in total (`n` of them) deleted */
  async bucketStat(b) {
    const cfg = mediaCfg(this.env);
    if (!cfg) return { ok: false, why: "nomedia" };
    const now = Date.now();
    let st = await this.ctx.storage.get("mstat");
    if (!st || now - st.at > (b.fresh ? 5 * 60000 : 3600000)) {
      try { st = await this.bucketCount(); } catch (e) { if (!st) st = { bytes: 0, count: 0, fam: 0, at: 0 }; }
    }
    if (b.op === "reserve") {
      const size = Math.max(0, Number(b.size) || 0);
      if (cfg.total && st.bytes + size > cfg.total)
        return { ok: false, full: true, bytes: st.bytes, total: cfg.total };
      st.bytes += size; st.count += 1;
      /* Which families use it, so the count of them is right between recounts. */
      st.hs = st.hs || [];
      if (typeof b.house === "string" && st.hs.indexOf(b.house) === -1 && st.hs.length < 1000) st.hs.push(b.house);
      st.fam = Math.max(st.fam || 0, st.hs.length);
    } else if (b.op === "sub") {
      st.bytes = Math.max(0, st.bytes - (Number(b.size) || 0));
      st.count = Math.max(0, st.count - (Number(b.n) || 0));
    }
    await this.ctx.storage.put("mstat", st);
    return { ok: true, bytes: st.bytes, count: st.count, fam: st.fam, at: st.at, part: !!st.part,
             free: cfg.free, total: cfg.total };
  }
  async bucketCount() {
    let cursor, bytes = 0, count = 0, part = false;
    const houses = {};
    for (let page = 0; ; page++) {
      if (page >= 100) { part = true; break; }          /* 100,000 files: plenty */
      const l = await this.env.MEDIA.list({ prefix: "h/", limit: 1000, cursor: cursor });
      for (const o of l.objects) { bytes += o.size; count++; houses[o.key.split("/")[1]] = 1; }
      if (!l.truncated) break;
      cursor = l.cursor;
    }
    return { bytes: bytes, count: count, fam: Object.keys(houses).length, hs: Object.keys(houses).slice(0, 1000),
             at: Date.now(), part: part };
  }

  /* This family's share, for its admin. */
  async mediaUsage(me, f) {
    const fam = await this.famState();
    if (fam && !isAdm(fam, me)) return { ok: false, status: 403 };
    const cfg = mediaCfg(this.env);
    if (!cfg) return { ok: true, status: 200, media: false };
    const house = this.house || (await this.ctx.storage.get("house"));
    const now = Date.now();
    let mine = this._mine;
    if (!mine || now - mine.at > (f.fresh ? 60000 : 600000)) {
      let cursor, bytes = 0, count = 0, oldest = 0;
      for (let page = 0; page < 50; page++) {
        const l = await this.env.MEDIA.list({ prefix: "h/" + house + "/", limit: 1000, cursor: cursor,
                                              include: ["customMetadata"] });
        for (const o of l.objects) {
          bytes += o.size; count++;
          const t = Number(o.customMetadata && o.customMetadata.at) || o.uploaded.getTime();
          if (!oldest || t < oldest) oldest = t;
        }
        if (!l.truncated) break;
        cursor = l.cursor;
      }
      mine = this._mine = { bytes: bytes, count: count, oldest: oldest, at: now };
    }
    const all = (await this.regCall("mstat", { op: "get", fresh: !!f.fresh })) || {};
    /* What each person has sent today, against their daily allowance. */
    const today = new Date().toISOString().slice(0, 10), sent = {};
    for (const [k, v] of await this.ctx.storage.list({ prefix: "mq:" }))
      if (v && v.d === today && v.n) sent[k.slice(3)] = v.n;
    return { ok: true, status: 200, media: true, family: mine,
             all: all.ok ? { bytes: all.bytes, count: all.count, fam: all.fam, at: all.at, part: all.part } : null,
             free: cfg.free, total: cfg.total, keep: cfg.keep, photo: cfg.photo, file: cfg.file, day: cfg.day,
             sent: sent };
  }

  /* An expired record, as the stub that outlives it: who the link was for
     and who sent it, and nothing else. null once that too has run out. */
  renewStub(r, now) {
    if (!r) return null;
    if (r.gone) return r.until > now ? r : null;
    if (!r.data || !r.house || !r.data.m) return null;
    return { house: r.house, exp: r.exp, until: Math.max(r.exp, now) + RENEW_MS,
             gone: { m: r.data.m, by: r.data.by || null } };
  }

  /* The registry itself: code -> what the link used to carry. */
  /* The two operations anyone on the internet can call (opening a code,
     asking for a renewal) are limited per address: a code cannot be
     guessed in any case (about 50 bits), but a flood should cost the
     flooder, not the families. Kept in memory: enough, since every such
     request passes through this one object. */
  rateOk(req) {
    const ip = (req.headers.get("x-ip") || "").slice(0, 64);
    if (!ip) return true;
    const now = Date.now();
    this._rl = this._rl || new Map();
    if (this._rl.size > 5000) this._rl.clear();
    let e = this._rl.get(ip);
    if (!e || now - e.t0 > 60000) { e = { t0: now, n: 0 }; this._rl.set(ip, e); }
    e.n++;
    return e.n <= 40;
  }

  async registry(url, req) {
    const op = url.pathname.slice(6);
    if ((op === "get" || op === "renew") && !this.rateOk(req))
      return json({ ok: false, status: 429, why: "busy" }, 429);
    if (op === "get") {
      const c = url.searchParams.get("c") || "";
      const r = /^[2-9A-Z]{10}$/.test(c) ? await this.ctx.storage.get("inv:" + c) : null;
      const now = Date.now();
      if (r && r.data && r.exp >= now) return json(Object.assign({ ok: true, exp: r.exp }, r.data));
      /* Expired. What it was for is kept a while longer (never the setup
         it carried), so the person can ask for a new one from here. */
      const stub = this.renewStub(r, now);
      if (stub) {
        if (stub !== r) await this.ctx.storage.put("inv:" + c, stub);
        return json({ ok: false, status: 404, why: "expired", renew: true, to: stub.to || null,
                      newer: !!stub.newer }, 404);
      }
      if (r) await this.ctx.storage.delete("inv:" + c);
      return json({ ok: false, status: 404, why: "expired", renew: false }, 404);
    }
    let b = null;
    try { b = await req.json(); } catch (e) {}
    if (op === "mstat") return json(await this.bucketStat(b || {}));
    if (op === "grant" || op === "grantcheck" || op === "grantuse") {
      const g = b && /^[2-9A-Z]{8}$/.test(String(b.g || "")) ? b.g : null;
      if (!g) return json({ ok: false }, 400);
      const now = Date.now();
      if (op === "grant") {
        /* Only so many open codes per family at once. */
        const all = await this.ctx.storage.list({ prefix: "ck:" });
        let live = 0;
        for (const [k, v] of all) {
          if (v.exp < now) { await this.ctx.storage.delete(k); continue; }
          if (v.house === b.house) live++;
        }
        if (live >= GRANT_MAX) return json({ ok: false, why: "full" });
        await this.ctx.storage.put("ck:" + g, { house: b.house || null, by: b.by || null, exp: Number(b.exp) || now + GRANT_MS });
        return json({ ok: true, g: g, exp: Number(b.exp) || now + GRANT_MS });
      }
      const r = await this.ctx.storage.get("ck:" + g);
      if (!r || r.exp < now) { if (r) await this.ctx.storage.delete("ck:" + g); return json({ ok: false, why: "gone" }); }
      if (op === "grantuse") await this.ctx.storage.delete("ck:" + g);
      return json({ ok: true });
    }
    if (!b || !/^[2-9A-Z]{10}$/.test(String(b.c || ""))) return json({ ok: false }, 400);
    if (op === "put") {
      await this.ctx.storage.put("inv:" + b.c, { data: b.data, exp: b.exp, house: b.house });
      return json({ ok: true });
    }
    if (op === "renew") {
      const r = await this.ctx.storage.get("inv:" + b.c);
      const now = Date.now();
      if (r && r.data && r.exp >= now) return json({ ok: false, why: "valid" });
      const stub = this.renewStub(r, now);
      if (!stub) { if (r) await this.ctx.storage.delete("inv:" + b.c); return json({ ok: false, why: "gone" }); }
      /* Asked again within minutes: the family was told already. */
      if (stub.rn && now - stub.rn < RENEW_GAP) return json({ ok: true, again: true, house: stub.house,
                                                              m: stub.gone.m, by: stub.gone.by, to: stub.to || null });
      stub.rn = now;
      await this.ctx.storage.put("inv:" + b.c, stub);
      return json({ ok: true, house: stub.house, m: stub.gone.m, by: stub.gone.by });
    }
    if (op === "renewto") {
      const r = await this.ctx.storage.get("inv:" + b.c);
      if (r && r.gone && typeof b.to === "string") { r.to = b.to.slice(0, 40); await this.ctx.storage.put("inv:" + b.c, r); }
      return json({ ok: true });
    }
    if (op === "del") { await this.ctx.storage.delete("inv:" + b.c); return json({ ok: true }); }
    if (op === "retire") {
      const r = await this.ctx.storage.get("inv:" + b.c);
      const stub = this.renewStub(r, Date.now());
      if (stub) { stub.newer = true; await this.ctx.storage.put("inv:" + b.c, stub); }
      else if (r) await this.ctx.storage.delete("inv:" + b.c);
      return json({ ok: true });
    }
    return json({ ok: false }, 404);
  }

  /* ------------------------------------------------------- relay
   *
   * Call audio needs a relay on many mobile networks. When this server
   * has Cloudflare TURN keys (two secrets, set once - see wrangler.toml)
   * it hands every phone in the family fresh relay details itself, so
   * nobody has to paste a relay link into Settings. Without them it says
   * so, and the phones use whatever relay the admin set up, as before. */
  async turn(me) {
    if (!turnReady(this.env)) return { iceServers: [], off: true };
    const fam = await this.famState();
    if (!validId(me) || (fam && !fam.members[me]))
      return { iceServers: [], error: "not in this family" };
    const now = Date.now();
    if (this._turn && this._turn.until > now) return { iceServers: this._turn.list };
    try {
      const res = await fetch("https://rtc.live.cloudflare.com/v1/turn/keys/" +
        encodeURIComponent(this.env.TURN_KEY_ID) + "/credentials/generate-ice-servers", {
        method: "POST",
        headers: { "Authorization": "Bearer " + this.env.TURN_KEY_API_TOKEN,
                   "Content-Type": "application/json" },
        body: JSON.stringify({ ttl: 86400 })
      });
      if (!res.ok) return { iceServers: [], error: "Cloudflare TURN answered " + res.status };
      const j = await res.json();
      const list = Array.isArray(j.iceServers) ? j.iceServers
                 : j.iceServers ? [j.iceServers] : [];
      /* Credentials last a day; handed out for two hours, so a phone's
         own copy (kept up to 20 hours) never outlives them. */
      this._turn = { list: list, until: now + 2 * 3600 * 1000 };
      return { iceServers: list };
    } catch (e) {
      return { iceServers: [], error: "couldn't reach Cloudflare TURN" };
    }
  }

  /* ---------------------------------------------------- group calls
   *
   * A group call is a "room" kept here: who is in it (live), who has
   * been asked (inv) and who has gone (out). The audio itself goes
   * phone to phone, every phone connected to every other; the room only
   * tells each phone who to connect to, and rings the people asked. */

  /* ------------------------------------------ group calls via the SFU
   *
   * Each phone in an SFU call has one connection to Cloudflare. It
   * publishes its microphone there once, and receives everyone else's
   * voice over the same connection - so a call of 20 costs each phone
   * one upload, not nineteen. This server holds the SFU secret and
   * makes every request; a phone may only publish its own voice, and
   * receive the voices of people in the same call. */
  async sfuApi(method, path, body) {
    try {
      const res = await fetch(SFU_API + encodeURIComponent(this.env.SFU_APP_ID) + path, {
        method: method,
        headers: { "Authorization": "Bearer " + this.env.SFU_APP_SECRET,
                   "Content-Type": "application/json" },
        body: body ? JSON.stringify(body) : undefined
      });
      let j = null;
      try { j = await res.json(); } catch (e) {}
      return { ok: res.ok, status: res.status, j: j || {} };
    } catch (e) { return { ok: false, status: 0, j: {} }; }
  }

  async sfu(me, f) {
    if (!sfuReady(this.env)) return { ok: false, status: "nosfu" };
    const id = String(f.room || "");
    if (!/^[A-Za-z0-9_-]{4,32}$/.test(id)) return { ok: false, status: 400 };
    const key = "room:" + id;
    let r = await this.ctx.storage.get(key);
    if (!r || r.mode !== "sfu" || !r.live[me]) return { ok: false, status: "gone" };
    const fail = (x) => ({ ok: false, status: "sfu", code: x.status,
                           why: str((x.j && (x.j.errorDescription || x.j.errorCode)) || "", 200) });

    if (f.op === "push") {
      /* A new connection publishing this phone's microphone. Also used
         to start over after the phone lost its connection. */
      if (typeof f.sdp !== "string" || f.sdp.length > 60000 || typeof f.mid !== "string")
        return { ok: false, status: 400 };
      const sess = await this.sfuApi("POST", "/sessions/new");
      if (!sess.ok || !sess.j.sessionId) return fail(sess);
      const sid = sess.j.sessionId;
      const tr = await this.sfuApi("POST", "/sessions/" + encodeURIComponent(sid) + "/tracks/new", {
        sessionDescription: { type: "offer", sdp: f.sdp },
        tracks: [{ location: "local", mid: f.mid, trackName: "mic" }] });
      const t0 = tr.j.tracks && tr.j.tracks[0];
      if (!tr.ok || !tr.j.sessionDescription || (t0 && t0.errorCode)) return fail(tr);
      /* The room may have changed while Cloudflare answered. */
      r = await this.ctx.storage.get(key);
      if (!r || !r.live[me]) return { ok: false, status: "gone" };
      r.live[me].sfu = { s: sid, t: "mic" };
      await this.ctx.storage.put(key, r);
      await this.roomSend(r, "sync", me);
      return { ok: true, status: 200, sid: sid, sdp: tr.j.sessionDescription.sdp,
               type: tr.j.sessionDescription.type, room: roomView(r) };
    }

    const mine = r.live[me].sfu;
    if (!mine) return { ok: false, status: "nosession" };
    const base = "/sessions/" + encodeURIComponent(mine.s);

    if (f.op === "pull") {
      /* Receive the voices of these people in the call. */
      const ids = Array.isArray(f.ids) ? f.ids.filter((x) => validId(x) && x !== me) : [];
      const want = [];
      for (const who of ids) {
        const e = r.live[who] && r.live[who].sfu;
        if (e) want.push({ id: who, s: e.s, t: e.t });
      }
      if (!want.length) return { ok: true, status: 200, tracks: [], sdp: null };
      const tr = await this.sfuApi("POST", base + "/tracks/new", {
        tracks: want.map((w) => ({ location: "remote", sessionId: w.s, trackName: w.t })) });
      if (!tr.ok) return fail(tr);
      const got = (tr.j.tracks || []).map((t, i) => {
        const w = want.filter((x) => x.s === t.sessionId && x.t === t.trackName)[0] || want[i] || {};
        return { id: w.id || null, s: w.s || null, mid: t.mid || null,
                 err: t.errorCode ? str(t.errorDescription || t.errorCode, 120) : null };
      });
      const d = tr.j.sessionDescription;
      return { ok: true, status: 200, tracks: got, sdp: d ? d.sdp : null, type: d ? d.type : null,
               renegotiate: !!tr.j.requiresImmediateRenegotiation };
    }
    if (f.op === "answer") {
      if (typeof f.sdp !== "string" || f.sdp.length > 60000) return { ok: false, status: 400 };
      const tr = await this.sfuApi("PUT", base + "/renegotiate",
                                   { sessionDescription: { type: "answer", sdp: f.sdp } });
      return tr.ok ? { ok: true, status: 200 } : fail(tr);
    }
    if (f.op === "close") {
      const mids = Array.isArray(f.mids) ? f.mids.filter((m) => typeof m === "string").slice(0, 40) : [];
      if (!mids.length) return { ok: true, status: 200 };
      const tr = await this.sfuApi("PUT", base + "/tracks/close",
                                   { tracks: mids.map((m) => ({ mid: m })), force: true });
      return tr.ok ? { ok: true, status: 200 } : fail(tr);
    }
    return { ok: false, status: 400 };
  }

  async room(me, f, host) {
    const id = String(f.room || "");
    if (!/^[A-Za-z0-9_-]{4,32}$/.test(id)) return { ok: false, status: 400 };
    const key = "room:" + id;
    const now = Date.now();
    let r = await this.ctx.storage.get(key);
    const op = f.op;

    if (op === "get") return { ok: true, status: 200, room: r ? roomView(r) : null };

    if (op === "open" || op === "join") {
      if (!r) {
        if (op === "join") return { ok: false, status: "gone", room: null };
        /* Through Cloudflare's SFU when this server has its keys and the
           phone opening the call knows how; phone to phone otherwise.
           Everyone in one call uses the same way. */
        r = { id: id, host: me, t: now, last: 0, live: {}, inv: {}, out: {},
              mode: (sfuReady(this.env) && f.sfu) ? "sfu" : "mesh" };
      }
      if (r.mode === "sfu" && !f.sfu) return { ok: false, status: "update", room: null };
      if (!r.live[me] && Object.keys(r.live).length >= roomMax(r))
        return { ok: false, status: "full", room: roomView(r) };
      const had = r.live[me];
      /* The order people joined decides who connects to whom: the later
         one always makes the connection, so two phones never both try. */
      const at = had ? had.at : Math.max(now, (r.last || 0) + 1);
      r.last = Math.max(r.last || 0, at);
      r.live[me] = { at: at, n: str(f.name, 60), c: str(f.colour, 9) };
      if (had && had.sfu) r.live[me].sfu = had.sfu;
      delete r.inv[me]; delete r.out[me];
      await this.ctx.storage.put(key, r);
      if (await this.stopRing(id, me))
        await this.cancelOthers(me, id, "Group call", "Joined on another device", host);
      await this.roomSend(r, had ? "sync" : "join", me);
      await this.rearm();
      return { ok: true, status: 200, room: roomView(r) };
    }

    if (op === "invite") {
      if (!r || !r.live[me]) return { ok: false, status: "gone", room: null };
      const names = (f.names && typeof f.names === "object") ? f.names : {};
      const fam = await this.famState();
      await this.blockMap();
      const ids = Array.isArray(f.ids)
        ? f.ids.filter((id) => validId(id) && this.inTouch(fam, me, id) && !this.isBlocked(me, id)) : [];
      let room = Object.keys(r.live).length + Object.keys(r.inv).length;
      const added = [];
      for (const who of ids) {
        if (r.live[who] || r.inv[who] || room >= roomMax(r)) continue;
        const nm = names[who] || {};
        r.inv[who] = { at: now, by: me, n: str(nm.n, 60), c: str(nm.c, 9) };
        delete r.out[who];
        room++; added.push(who);
      }
      await this.ctx.storage.put(key, r);
      await this.roomSend(r, "invite", me);
      await this.rearm();
      return { ok: true, status: 200, room: roomView(r), added: added };
    }

    if (op === "leave" || op === "decline" || op === "uninvite") {
      if (!r) return { ok: true, status: 200, room: null };
      const who = op === "uninvite" && validId(f.who) ? f.who : me;
      if (op === "uninvite" && !r.live[me]) return { ok: false, status: 403 };
      const wasLive = !!r.live[who], wasInv = !!r.inv[who];
      delete r.live[who]; delete r.inv[who];
      if (wasLive || wasInv)
        r.out[who] = { why: op === "leave" ? "left" : op === "decline" ? "declined" : "cancelled", at: now };
      const rang = await this.stopRing(id, who);
      if (op === "decline" && rang)
        await this.cancelOthers(who, id, "Group call", "Declined", host);
      if (op === "uninvite" && rang) await this.sendMissed(rang, host, "Missed group call");
      if (!Object.keys(r.live).length) {
        await this.endRoom(r, host);
        return { ok: true, status: 200, room: null };
      }
      await this.ctx.storage.put(key, r);
      await this.roomSend(r, op === "leave" ? "left" : "declined", who);
      return { ok: true, status: 200, room: roomView(r) };
    }
    return { ok: false, status: 400 };
  }

  /* The last person has left. Anyone still being rung hears it was a
     missed call; everyone involved hears the call is over. */
  async endRoom(r, host) {
    await this.ctx.storage.delete("room:" + r.id);
    const now = Date.now();
    for (const who of Object.keys(r.inv)) {
      const rang = await this.stopRing(r.id, who);
      if (rang) await this.sendMissed(rang, host, "Missed group call");
      r.out[who] = { why: "ended", at: now };
    }
    r.inv = {};
    r.ended = true;
    await this.roomSend(r, "ended", null, true);
  }

  /* Tells everyone in (or asked into) a call how it stands now. */
  async roomSend(r, why, who, all) {
    const text = JSON.stringify({ k: "room", room: roomView(r), why: why, who: who || null,
                                  now: Date.now() });
    const ids = Object.keys(r.live).concat(Object.keys(r.inv));
    if (who && ids.indexOf(who) === -1) ids.push(who);
    if (all) for (const k of Object.keys(r.out)) if (ids.indexOf(k) === -1) ids.push(k);
    for (const id of ids)
      for (const ws of this.ctx.getWebSockets(id)) safeSend(ws, text);
  }

  async roomTick(now, host) {
    const rooms = await this.ctx.storage.list({ prefix: "room:" });
    for (const [key, r] of rooms) {
      let changed = false;
      if (now - r.t > ROOM_MAX_AGE) { await this.endRoom(r, host); continue; }
      for (const who of Object.keys(r.inv)) {
        if (now - r.inv[who].at > INVITE_MS) {
          delete r.inv[who];
          r.out[who] = { why: "noanswer", at: now };
          changed = true;
          const rang = await this.stopRing(r.id, who);
          if (rang) await this.sendMissed(rang, host, "Missed group call");
        }
      }
      for (const who of Object.keys(r.live)) {
        const m = r.live[who];
        if (this.socketsOf(who)) { if (m.lost) { delete m.lost; changed = true; } continue; }
        if (!m.lost) { m.lost = now; changed = true; continue; }
        if (now - m.lost > ROOM_LOST_MS) {
          delete r.live[who];
          r.out[who] = { why: "dropped", at: now };
          changed = true;
        }
      }
      if (!Object.keys(r.live).length) { await this.endRoom(r, host); continue; }
      if (changed) {
        await this.ctx.storage.put(key, r);
        await this.roomSend(r, "tick", null);
      }
    }
  }

  /* ------------------------------------------------------- presence */

  /* One person's status: the most present of their phones. */
  stateOf(id, skip) {
    let best = null;
    for (const ws of this.ctx.getWebSockets(id)) {
      if (ws === skip) continue;
      const a = this.attachment(ws);
      if (!a) continue;
      /* A phone that locked can leave its connection open-looking for a
         long while (a mobile network keeps it on its books), with the
         page behind it frozen. What it last said is only believed for
         as long as it keeps pinging: silent past its ping it counts as
         away, silent for minutes it does not count at all. */
      const quiet = this.quietFor(ws, a);
      if (quiet > DEAD_MS) continue;
      const s = (a.s === "on" && quiet > 45000) ? "away" : a.s;
      if (!best || rank(s) > rank(best.s)) best = { me: a.me, s: s, at: a.at, tz: a.tz };
    }
    return best;
  }

  /* Milliseconds since this connection last showed a sign of life. */
  quietFor(ws, a) {
    let last = a.at || 0;
    try {
      const t = this.ctx.getWebSocketAutoResponseTimestamp(ws);
      if (t && t.getTime() > last) last = t.getTime();
    } catch (e) {}
    if (a.seen && a.seen > last) last = a.seen;
    return Date.now() - last;
  }

  /* Connections nothing has come over for minutes belong to phones that
     are gone: closed, so their owner is not shown as present for hours
     and their group calls are tidied. Run whenever someone connects and
     with the periodic alarm. */
  async reap() {
    const dead = [];
    for (const ws of this.ctx.getWebSockets()) {
      const a = this.attachment(ws);
      if (a && this.quietFor(ws, a) > DEAD_MS) dead.push(ws);
    }
    for (const ws of dead) { try { await this.gone(ws); } catch (e) {} }
  }

  socketsOf(id, skip) {
    let n = 0;
    for (const ws of this.ctx.getWebSockets(id)) if (ws !== skip) n++;
    return n;
  }

  /* Phones of this person with the app on screen and still answering. */
  visibleCount(id) {
    let n = 0;
    for (const ws of this.ctx.getWebSockets(id)) {
      const a = this.attachment(ws);
      if (a && a.s === "on" && this.alive(ws, a)) n++;
    }
    return n;
  }

  /* Everybody's status - as far as `viewer` may see them. Somebody not
     in touch with you is not listed at all, not even as an id. */
  async everyone(viewer) {
    const out = {}, now = Date.now();
    const fam = await this.famState();
    await this.blockMap();
    const may = (id) => !viewer || id === viewer ||
                        (this.sees(fam, viewer, id, true) && !this.isBlocked(viewer, id));
    const tzs = await this.ctx.storage.list({ prefix: "tz:" });
    const tzOf = (id) => tzs.get("tz:" + id) || null;
    const seen = await this.ctx.storage.list({ prefix: "seen:" });
    for (const [k, at] of seen) {
      const id = k.slice(5);
      if (may(id)) out[id] = { id: id, s: "off", at: at, tz: tzOf(id) };
    }
    for (const ws of this.ctx.getWebSockets()) {
      const a = this.attachment(ws);
      if (!a || !may(a.me)) continue;
      const cur = this.stateOf(a.me);
      if (cur) out[a.me] = { id: a.me, s: cur.s, at: cur.at || now, tz: tzOf(a.me) };
    }
    return Object.values(out);
  }

  async presenceChanged(id, closing) {
    const cur = this.stateOf(id, closing);
    let p;
    if (cur) p = { k: "pres", id: id, s: cur.s, at: cur.at };
    else p = { k: "pres", id: id, s: "off", at: (await this.ctx.storage.get("seen:" + id)) || Date.now() };
    p.tz = (await this.ctx.storage.get("tz:" + id)) || null;
    const text = JSON.stringify(p);
    const fam = await this.famState();
    await this.blockMap();
    for (const ws of this.ctx.getWebSockets()) {
      if (ws === closing) continue;
      const a = this.attachment(ws);
      if (a && a.pending) continue;
      if (a && a.me !== id && (!this.sees(fam, a.me, id, true) || this.isBlocked(a.me, id))) continue;
      safeSend(ws, text);
    }
  }

  /* After the family changed: everyone's list of who is online, again,
     since who may see whom may have changed with it. */
  async presenceRefresh() {
    const fam = await this.famState();
    const now = Date.now();
    for (const ws of this.ctx.getWebSockets()) {
      const a = this.attachment(ws);
      if (!a || a.pending) continue;
      if (fam && !fam.members[a.me]) {
        const req = await this.ctx.storage.get("jr:" + a.me);
        safeSend(ws, JSON.stringify({ k: "guest", pending: !!req, name: req ? req.name : null,
                                      rev: fam.rev, now: now }));
        continue;
      }
      safeSend(ws, JSON.stringify({ k: "presall", list: await this.everyone(a.me), now: now }));
    }
  }

  /* --------------------------------------------------------- upkeep */

  /* One alarm does three jobs: the rings that are due, group calls that
     need tidying, and the hourly clear-out of old messages. It is set
     for whichever of those comes first. */
  async rearm() {
    const now = Date.now();
    let next = Infinity;
    const loops = await this.ctx.storage.list({ prefix: "rl:" });
    for (const r of loops.values()) next = Math.min(next, r.next, r.until);
    const rooms = await this.ctx.storage.list({ prefix: "room:", limit: 1 });
    if (rooms.size) next = Math.min(next, now + 10000);
    const clean = await this.ctx.storage.get("cleanAt");
    if (clean) next = Math.min(next, clean);
    const sweep = await this.ctx.storage.get("sweepAt");
    if (sweep) next = Math.min(next, sweep);
    if (next === Infinity) return;
    const cur = await this.ctx.storage.getAlarm();
    if (cur === null || cur === undefined || cur > next)
      await this.ctx.storage.setAlarm(Math.max(next, now + 20));
  }

  async alarm() {
    const now = Date.now();
    const host = await this.ownHost();
    try { await this.reap(); } catch (e) {}
    try { await this.ringTick(now); } catch (e) {}
    try { await this.roomTick(now, host); } catch (e) {}
    try { await this.mediaSweep(now); } catch (e) {}
    const clean = await this.ctx.storage.get("cleanAt");
    if (!clean || now >= clean) {
      const cutoff = now - KEEP_MS, chatCut = now - KEEP_CHAT_MS;
      const all = await this.ctx.storage.list({ prefix: "q:" });
      const old = [];
      let left = 0;
      for (const k of all.keys()) {
        const t = Number(k.split(":")[2]);
        if (t < (k.endsWith(":c") ? chatCut : cutoff)) old.push(k); else left++;
      }
      /* The "already delivered" marks of chat messages: a day is plenty
         for any retry. */
      const cids = await this.ctx.storage.list({ prefix: "cid:" });
      for (const [k, v] of cids) {
        if (!v || !v.t || v.t < now - 86400000) old.push(k); else left++;
      }
      for (let i = 0; i < old.length; i += 128) await this.ctx.storage.delete(old.slice(i, i + 128));
      if (left) await this.ctx.storage.put("cleanAt", now + 3600 * 1000);
      else await this.ctx.storage.delete("cleanAt");
    }
    await this.rearm();
  }

  /* Pictures and files older than the family keeps them (MEDIA_KEEP_DAYS)
     are deleted, once a day - storage stays at what is actually wanted. */
  async mediaSweep(now) {
    const at = await this.ctx.storage.get("sweepAt");
    if (!at || now < at) return;
    const cfg = mediaCfg(this.env);
    const house = this.house || (await this.ctx.storage.get("house"));
    if (!cfg || !house) { await this.ctx.storage.delete("sweepAt"); return; }
    const cut = now - cfg.keep * 86400000;
    let cursor, left = 0;
    for (let page = 0; page < 10; page++) {
      const l = await this.env.MEDIA.list({ prefix: "h/" + house + "/", limit: 1000, cursor: cursor,
                                            include: ["customMetadata"] });
      const old = [];
      let gone = 0;
      for (const o of l.objects) {
        const t = Number(o.customMetadata && o.customMetadata.at) || o.uploaded.getTime();
        if (t < cut) { old.push(o.key); gone += o.size; } else left++;
      }
      if (old.length) {
        await this.env.MEDIA.delete(old);
        await this.regCall("mstat", { op: "sub", size: gone, n: old.length });
      }
      if (!l.truncated) break;
      cursor = l.cursor; left++;
    }
    if (left) await this.ctx.storage.put("sweepAt", now + 86400000);
    else await this.ctx.storage.delete("sweepAt");
    this._mine = null;
  }

  /* The family's own push keys, made once and kept. */
  async vapid() {
    if (this._vapid) return this._vapid;
    let v = await this.ctx.storage.get("vapid");
    if (!v) {
      const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
      const jwk = await crypto.subtle.exportKey("jwk", pair.privateKey);
      const raw = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey));
      v = { jwk: jwk, pub: b64u(raw) };
      await this.ctx.storage.put("vapid", v);
    }
    this._vapid = v;
    return v;
  }

  /* A push to the family's Android app, through Firebase Cloud Messaging
     (HTTP v1). A data message, so the app decides how to show it - a
     full-screen ringing call, a message, a missed call - exactly as
     sw.js does for the browser. Answers with an HTTP-like status, so
     pushTo treats it like any other push: 404 means the app was removed
     (or its token replaced) and the registration is forgotten. */
  async fcmSend(token, text, ttl) {
    const acc = fcmAccount(this.env);
    if (!acc) return 503;
    const access = await this.fcmAccess(acc);
    const res = await fetch("https://fcm.googleapis.com/v1/projects/" + acc.project_id + "/messages:send", {
      method: "POST",
      headers: { "Authorization": "Bearer " + access, "Content-Type": "application/json" },
      body: JSON.stringify({ message: { token: token, data: { p: text },
        android: { priority: "HIGH", ttl: Math.max(1, Math.round(ttl || 60)) + "s" } } })
    });
    if (res.ok) return 200;
    if (res.status === 401) this._fcmTok = null;        /* try a fresh sign-in next time */
    let why = "";
    try { const j = await res.json(); why = JSON.stringify(j && j.error || ""); } catch (e) {}
    if (/UNREGISTERED/.test(why) || (res.status === 400 && /registration token/i.test(why))) return 404;
    return res.status;
  }
  /* Google's sign-in for the push, made once an hour, not per ring. */
  async fcmAccess(acc) {
    const now = Date.now();
    if (this._fcmTok && this._fcmTok.until > now) return this._fcmTok.t;
    const t = await googleAccessToken(acc);
    this._fcmTok = { t: t, until: now + 50 * 60 * 1000 };
    return t;
  }

  /* The signed "this is us" every push carries, made once an hour per
     push service instead of once per notification - a ringing call
     sends many. */
  async webPushCached(sub, text, keys, host, ttl) {
    const aud = new URL(sub.endpoint).origin;
    const now = Date.now();
    let j = this._jwt[aud];
    if (!j || j.host !== host || j.until < now) {
      j = { jwt: await vapidJwt(aud, keys, host), host: host, until: now + 3600 * 1000 };
      this._jwt[aud] = j;
    }
    return webPush(sub, text, keys, host, ttl, null, j.jwt);
  }

  /* This server's own web address - the contact Apple insists on in
     every notification. It was missing for rings sent over the live
     connection, and Apple refused them (403). */
  async ownHost() {
    if (!this.host) this.host = await this.ctx.storage.get("host");
    return this.host || null;
  }

  alive(ws, a) { return this.quietFor(ws, a) < 45000; }

  /* Which Cloudflare city this family's server lives in. Asked once,
     from Cloudflare's own trace page, and remembered. */
  async colo() {
    if (this._colo !== undefined) return this._colo;
    try {
      const t = await (await fetch("https://cloudflare.com/cdn-cgi/trace")).text();
      const m = t.match(/^colo=([A-Z]{3})/m);
      this._colo = m ? m[1] : null;
    } catch (e) { this._colo = null; }
    return this._colo;
  }

  attach(ws, a) { try { ws.serializeAttachment(a); } catch (e) {} }
  attachment(ws) { try { return ws.deserializeAttachment(); } catch (e) { return null; } }
}

/* Firebase, for the Android app: the service account JSON, pasted whole
   as the FCM_SERVICE_ACCOUNT secret (wrangler secret put FCM_SERVICE_ACCOUNT). */
function fcmAccount(env) {
  if (!env || !env.FCM_SERVICE_ACCOUNT) return null;
  if (env.__fcm !== undefined) return env.__fcm;
  let a = null;
  try {
    const j = JSON.parse(env.FCM_SERVICE_ACCOUNT);
    if (j && j.project_id && j.client_email && j.private_key) a = j;
  } catch (e) {}
  try { env.__fcm = a; } catch (e) {}
  return a;
}
function fcmReady(env) { return !!fcmAccount(env); }

/* An OAuth access token for Firebase Cloud Messaging, from the service
   account: a JWT signed with its RSA key, traded at Google's token
   endpoint (RFC 7523). */
async function googleAccessToken(acc) {
  const enc = (o) => b64u(new TextEncoder().encode(JSON.stringify(o)));
  const now = Math.floor(Date.now() / 1000);
  const head = enc({ alg: "RS256", typ: "JWT" });
  const body = enc({ iss: acc.client_email, scope: "https://www.googleapis.com/auth/firebase.messaging",
                     aud: "https://oauth2.googleapis.com/token", iat: now, exp: now + 3600 });
  const pem = String(acc.private_key).replace(/-----[^-]+-----/g, "").replace(/\s+/g, "");
  const der = Uint8Array.from(atob(pem), (c) => c.charCodeAt(0));
  const key = await crypto.subtle.importKey("pkcs8", der, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
                                            false, ["sign"]);
  const sig = new Uint8Array(await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key,
                                                      new TextEncoder().encode(head + "." + body)));
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: "grant_type=" + encodeURIComponent("urn:ietf:params:oauth:grant-type:jwt-bearer") +
          "&assertion=" + head + "." + body + "." + b64u(sig)
  });
  const j = await res.json().catch(() => null);
  if (!res.ok || !j || !j.access_token) throw new Error("fcm auth " + res.status);
  return j.access_token;
}

/* Only the browsers' own push services - the server never posts to an
   address of somebody's choosing. */
function pushHostOk(u) {
  let h;
  try { const x = new URL(u); if (x.protocol !== "https:") return /^http:\/\/127\.0\.0\.1[:/]/.test(u); h = x.hostname; }
  catch (e) { return false; }
  return /(^|\.)(fcm\.googleapis\.com|android\.googleapis\.com|push\.apple\.com|push\.services\.mozilla\.com|notify\.windows\.com)$/.test(h);
}

/* A device's name as the app describes it ("iPhone app", "Windows computer"). */
function devLabel(dl) {
  return String(dl || "").replace(/[^A-Za-z0-9 ().-]/g, "").slice(0, 40).trim() || "another device";
}

/* A key's fingerprint: all of SHA-256. */
async function keyHash(s) {
  return b64u(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(String(s)))));
}

function renewView(r) {
  return { m: r.m, by: r.by || null, name: r.name || null, at: r.at, n: r.n || 1 };
}

function inviteCode() {
  const r = crypto.getRandomValues(new Uint8Array(10));
  let s = "";
  for (let i = 0; i < 10; i++) s += INVITE_ABC[r[i] % INVITE_ABC.length];
  return s;
}

/* An IANA time zone name, like Europe/London - nothing else is stored. */
function validTz(t) {
  return typeof t === "string" && t.length <= 48 &&
         /^[A-Za-z][A-Za-z_]*(\/[A-Za-z0-9_+\-]+){0,2}$/.test(t);
}

/* The family's admins: the one who made it, and any co-admins. */
function admIds(fam) { return fam ? [fam.admin.id].concat(fam.admins || []) : []; }
function isAdm(fam, id) { return !!fam && admIds(fam).indexOf(id) !== -1; }

function turnReady(env) { return !!(env && env.TURN_KEY_ID && env.TURN_KEY_API_TOKEN); }
function sfuReady(env) { return !!(env && env.SFU_APP_ID && env.SFU_APP_SECRET); }
function roomMax(r) { return r && r.mode === "sfu" ? ROOM_MAX_SFU : ROOM_MAX; }

/* The signed family, as the app writes it: [house, members, turn, turn2,
   route, server, token, rev, admin, fs]. */
function parseFam(a) {
  if (!Array.isArray(a) || a.length < 9) return null;
  const admin = a[8];
  if (typeof a[0] !== "string" || !Array.isArray(a[1]) || !admin || !validId(admin.id) ||
      !admin.pub || typeof admin.pub.x !== "string" || typeof admin.pub.y !== "string")
    return null;
  return { house: a[0], members: a[1], rev: Number(a[7]) || 0, admin: admin,
           admins: Array.isArray(a[10]) ? a[10].filter(validId).slice(0, 10) : [] };
}

async function verifySig(pub, text, sig) {
  try {
    const key = await crypto.subtle.importKey("jwk",
      { kty: "EC", crv: "P-256", x: pub.x, y: pub.y, ext: true },
      { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
    return await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, key,
                                      unb64u(sig), new TextEncoder().encode(text));
  } catch (e) { return false; }
}

/* A join request, as the admin's phone sees it. */
function joinView(r) {
  return { id: r.id, name: r.name, colour: r.colour || null, by: r.by || null,
           at: r.at, last: r.last || r.at };
}

/* What a room looks like to the phones in it. */
function roomView(r) {
  const live = {}, inv = {};
  for (const k of Object.keys(r.live)) live[k] = { at: r.live[k].at, n: r.live[k].n, c: r.live[k].c,
                                                   lost: r.live[k].lost ? 1 : 0,
                                                   s: r.live[k].sfu || null };
  for (const k of Object.keys(r.inv)) inv[k] = { at: r.inv[k].at, by: r.inv[k].by,
                                                 n: r.inv[k].n, c: r.inv[k].c };
  return { id: r.id, host: r.host, t: r.t, live: live, inv: inv, out: r.out || {},
           ended: !!r.ended, mode: r.mode || "mesh", max: roomMax(r) };
}

/* The notification itself. The answer link is the tap link with a few
   characters added, so only the difference travels - a push carries
   about 4 KB, and two full personal links in one could go over it,
   which the push service then refused outright. */
function pushPayload(me, kind, f, tag) {
  const url = str(f.url, 3800);
  let ans = null, answer = null;
  if (f.answer) {
    const a = str(f.answer, 3800);
    if (url && a.indexOf(url) === 0 && a.length - url.length < 200) ans = a.slice(url.length);
    else answer = a;
  }
  let dec = null;
  if (f.dec && typeof f.dec === "object" && typeof f.dec.u === "string" &&
      /^https?:\/\//.test(f.dec.u) && f.dec.b && typeof f.dec.b === "object") {
    const b = JSON.stringify(f.dec.b);
    if (b.length < 900 && f.dec.u.length < 300) dec = { u: f.dec.u, b: f.dec.b };
  }
  return { kind: kind, title: str(f.title, 200), body: str(f.body, 500), url: url,
           answer: answer, ans: ans, tag: tag, from: me, dec: dec,
           cb: kind === "missed" ? me : null, ts: Date.now(), n: 0 };
}

/* Made to fit: if the links make it too long, the tap link falls back
   to the plain page address, which still opens the app. */
function fitPayload(p) {
  let text = JSON.stringify(p);
  if (byteLen(text) <= PUSH_LIMIT) return text;
  const q = Object.assign({}, p);
  const base = String(q.url || "").split("#")[0];
  q.url = base ? base + "#n=1" : "";
  if (q.answer) { q.answer = null; q.ans = "&ans=1"; }
  text = JSON.stringify(q);
  if (byteLen(text) <= PUSH_LIMIT) return text;
  q.dec = null; q.body = str(q.body, 120);
  return JSON.stringify(q);
}
function byteLen(s) { return new TextEncoder().encode(s).length; }

/* ------------------------------------------------------------ Web Push
 *
 * RFC 8291 (message encryption, aes128gcm) and RFC 8292 (VAPID), with
 * nothing but the WebCrypto built into Workers. */

export async function webPush(sub, payload, keys, host, ttl, topic, jwtReady) {
  const body = await encryptPayload(sub, new TextEncoder().encode(payload));
  const endpoint = new URL(sub.endpoint);
  const jwt = jwtReady || await vapidJwt(endpoint.origin, keys, host);
  const headers = {
    "Content-Encoding": "aes128gcm",
    "Content-Type": "application/octet-stream",
    "TTL": String(ttl || 60),
    "Urgency": "high",
    "Authorization": "vapid t=" + jwt + ", k=" + keys.pub
  };
  /* No "Topic" header: Apple's push service refused calls that carried
     one, while the same notification without it went through. The
     replacing of a ring by "Missed call" is done on the phone by the
     notification's tag instead. */
  const res = await fetch(sub.endpoint, { method: "POST", headers: headers, body: body });
  return res.status;
}

export async function vapidJwt(aud, keys, host) {
  const header = b64u(new TextEncoder().encode(JSON.stringify({ typ: "JWT", alg: "ES256" })));
  const claims = b64u(new TextEncoder().encode(JSON.stringify({
    aud: aud, exp: Math.floor(Date.now() / 1000) + 12 * 3600,
    sub: host ? "https://" + host : "mailto:family-notifier@users.noreply.github.com" })));
  const key = await crypto.subtle.importKey("jwk", keys.jwk, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
  const sig = new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key,
                                                      new TextEncoder().encode(header + "." + claims)));
  return header + "." + claims + "." + b64u(sig);
}

export async function encryptPayload(sub, plain) {
  const uaPublic = unb64u(sub.keys.p256dh);          /* 65 bytes */
  const authSecret = unb64u(sub.keys.auth);          /* 16 bytes */
  const local = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
  const asPublic = new Uint8Array(await crypto.subtle.exportKey("raw", local.publicKey));
  const uaKey = await crypto.subtle.importKey("raw", uaPublic, { name: "ECDH", namedCurve: "P-256" }, false, []);
  const ecdh = new Uint8Array(await crypto.subtle.deriveBits({ name: "ECDH", public: uaKey }, local.privateKey, 256));
  const keyInfo = concat(new TextEncoder().encode("WebPush: info\0"), uaPublic, asPublic);
  const ikm = await hkdf(authSecret, ecdh, keyInfo, 32);
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const cek = await hkdf(salt, ikm, new TextEncoder().encode("Content-Encoding: aes128gcm\0"), 16);
  const nonce = await hkdf(salt, ikm, new TextEncoder().encode("Content-Encoding: nonce\0"), 12);
  const aes = await crypto.subtle.importKey("raw", cek, { name: "AES-GCM" }, false, ["encrypt"]);
  const record = concat(plain, new Uint8Array([2]));   /* last record, no padding */
  const cipher = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, aes, record));
  const header = new Uint8Array(16 + 4 + 1 + asPublic.length);
  header.set(salt, 0);
  new DataView(header.buffer).setUint32(16, 4096);
  header[20] = asPublic.length;
  header.set(asPublic, 21);
  return concat(header, cipher);
}

async function hkdf(salt, ikm, info, len) {
  const key = await crypto.subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt: salt, info: info }, key, len * 8));
}

/* ------------------------------------------------------------- helpers */

function rank(s) { return s === "on" ? 3 : s === "away" ? 2 : 1; }
function validId(id) { return typeof id === "string" && /^[A-Za-z0-9]{3,16}$/.test(id); }
function str(v, max) { return String(v == null ? "" : v).slice(0, max); }
/* What a reply may say about the message it answers: its id, its writer
   (one of the two people in the conversation) and a short snippet. */
function replyRef(re, me, to) {
  if (!re || typeof re !== "object") return null;
  if (typeof re.c !== "string" || !/^[A-Za-z0-9_-]{6,40}$/.test(re.c)) return null;
  const by = re.f === me || re.f === to ? re.f : null;
  if (!by) return null;
  return { c: re.c, f: by, t: str(typeof re.t === "string" ? re.t : "", 200) };
}

/* What a message may say about its picture, file or location. Nothing
   else is passed on, and nothing here is trusted to be what it claims:
   the phones treat a received file as plain bytes to save, never as a
   page to open. */
function attRef(a, media) {
  if (!a || typeof a !== "object") return null;
  const int = (v, max) => { const x = Math.round(Number(v)); return isFinite(x) && x >= 0 ? Math.min(x, max) : 0; };
  if (a.k === "loc") {
    const lat = Number(a.lat), lon = Number(a.lon);
    if (!isFinite(lat) || !isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
    return { k: "loc", lat: Math.round(lat * 1e5) / 1e5, lon: Math.round(lon * 1e5) / 1e5,
             acc: int(a.acc, 100000) };
  }
  if (!media || (a.k !== "img" && a.k !== "file")) return null;
  if (typeof a.id !== "string" || !/^[A-Za-z0-9_-]{16,40}$/.test(a.id)) return null;
  if (typeof a.key !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(a.key)) return null;
  if (typeof a.iv !== "string" || !/^[A-Za-z0-9_-]{16}$/.test(a.iv)) return null;
  const o = { k: a.k, id: a.id, key: a.key, iv: a.iv, s: int(a.s, 200 * 1048576),
              n: str(typeof a.n === "string" ? a.n.replace(/[\u0000-\u001f\\/]/g, "") : "", 120),
              m: typeof a.m === "string" && /^[\w.+-]{1,40}\/[\w.+-]{1,60}$/.test(a.m) ? a.m : "" };
  if (a.k === "img") {
    o.w = int(a.w, 20000); o.h = int(a.h, 20000);
    if (typeof a.th === "string" && a.th.length <= 4000 &&
        /^data:image\/(jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(a.th)) o.th = a.th;
  }
  /* A voice message: its length (ms) and the outline of its loudness -
     the bars the app draws. */
  if (a.k === "file" && /^audio\//.test(o.m)) {
    const vd = int(a.vd, 3600000);
    if (vd) o.vd = vd;
    if (typeof a.vw === "string" && /^[a-z]{1,64}$/.test(a.vw)) o.vw = a.vw;
  }
  return o;
}
function attLabel(a) {
  if (a.k === "file" && /^audio\//.test(a.m || "") && (a.vd || /^Voice message/.test(a.n || ""))) {
    const s = Math.round((a.vd || 0) / 1000);
    return "\u{1F3A4} Voice message" + (s ? " · " + Math.floor(s / 60) + ":" + String(s % 60).padStart(2, "0") : "");
  }
  return a.k === "img" ? "\u{1F4F7} Photo" : a.k === "loc" ? "\u{1F4CD} Location"
       : "\u{1F4CE} " + (a.n || "File");
}

/* Storing and fetching one encrypted picture or file. */
async function blobRoute(req, env, url, house, id) {
  const cfg = mediaCfg(env);
  if (!cfg) return json({ ok: false, why: "nomedia" }, 501);
  if (req.method !== "PUT" && req.method !== "GET" && req.method !== "POST") return json({ ok: false }, 405);
  const put = req.method === "PUT";
  /* A download can come as a plain POST with who is asking in its body:
     a browser sends that without first asking the server's permission
     (the extra round trip custom headers cost on every single photo). */
  let me = req.headers.get("x-me") || "", sec = req.headers.get("x-sec") || "", dk = req.headers.get("x-dk") || "";
  if (req.method === "POST") {
    let b = null;
    try { const t = await req.text(); if (t.length < 500) b = JSON.parse(t); } catch (e) {}
    if (!b) return json({ ok: false }, 400);
    me = typeof b.me === "string" ? b.me : ""; sec = typeof b.sec === "string" ? b.sec : ""; dk = typeof b.dk === "string" ? b.dk : "";
  }
  const kind = req.headers.get("x-kind") === "img" ? "img" : "file";
  const limit = kind === "img" ? cfg.photo : cfg.file;
  const size = Number(req.headers.get("content-length")) || 0;
  if (put && (!size || size > limit + 64)) return json({ ok: false, why: "size", max: limit }, 413);
  const stub = env.FAMILY.get(env.FAMILY.idFromName(house));
  const ok = await stub.fetch(new Request(url.origin + "/f/" + house + "/blobok", {
    method: "POST",
    body: JSON.stringify({ me: me, sec: sec, dk: dk, op: put ? "put" : "get", size: size })
  }));
  if (!ok.ok) return new Response(ok.body, { status: ok.status, headers: { "Content-Type": "application/json" } });
  const key = "h/" + house + "/" + id;
  if (put) {
    /* The phone's own id for the file: sending it again is harmless. */
    if (await env.MEDIA.head(key)) return json({ ok: true, dup: true });
    /* Room left in the storage as a whole? Past the limit set for the
       bucket, new files wait - old ones are deleted after MEDIA_KEEP_DAYS,
       which makes room again. If the count can't be had, the file goes. */
    if (cfg.total) {
      try {
        const reg = env.FAMILY.get(env.FAMILY.idFromName(INVITE_REG));
        const rs = await (await reg.fetch(new Request("https://registry/_inv/mstat",
          { method: "POST", body: JSON.stringify({ op: "reserve", size: size, house: house }) }))).json();
        if (rs && rs.full) return json({ ok: false, why: "full" }, 507);
      } catch (e) {}
    }
    /* Passed straight through to storage, never held here: copying a 25 MB
       file in memory could use up the free plan's few milliseconds of
       processing per request. The length was checked above, and a body
       can't be longer than the length it declares. */
    const meta = { httpMetadata: { contentType: "application/octet-stream" },
                   customMetadata: { by: me, kind: kind, at: String(Date.now()) } };
    try {
      await env.MEDIA.put(key, req.body, meta);
    } catch (e) {
      return json({ ok: false, why: "upload" }, 500);
    }
    return json({ ok: true });
  }
  const obj = await env.MEDIA.get(key);
  if (!obj) return json({ ok: false, why: "gone" }, 404);
  const at = Number(obj.customMetadata && obj.customMetadata.at) || 0;
  if (at && Date.now() - at > cfg.keep * 86400000) {
    try { await env.MEDIA.delete(key); } catch (e) {}
    return json({ ok: false, why: "gone" }, 410);
  }
  return new Response(obj.body, { headers: {
    "Content-Type": "application/octet-stream",
    "Content-Length": String(obj.size),
    "Cache-Control": "private, no-store"
  } });
}
function pad(t) { return String(Math.floor(t)).padStart(15, "0"); }
function rid() {
  const b = crypto.getRandomValues(new Uint8Array(9));
  return b64u(b);
}
/* The kind of a call message, read without trusting the rest of it. */
function sigType(body) {
  const m = /"t"\s*:\s*"([a-z-]{1,16})"/.exec(String(body).slice(0, 400));
  return m ? m[1] : "";
}
/* Messages that start a one-to-one call - never passed between two
   people when one has blocked the other. */
const BLOCKED_SIG = { offer: 1, still: 1, yes: 1 };
function safeSend(ws, text) { try { ws.send(text); return true; } catch (e) { return false; } }
async function hash(s) {
  const d = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)));
  return b64u(d.slice(0, 12));
}
function concat() {
  let n = 0;
  for (const a of arguments) n += a.length;
  const out = new Uint8Array(n);
  let o = 0;
  for (const a of arguments) { out.set(a, o); o += a.length; }
  return out;
}
export function b64u(bytes) {
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
export function unb64u(str) {
  const b = str.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((str.length + 3) % 4);
  const bin = atob(b);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
function json(o, status) {
  return new Response(JSON.stringify(o), { status: status || 200,
    headers: { "Content-Type": "application/json" } });
}
/* The newest release of the Android app, read from GitHub on behalf of
   the phones. The release listing is kept a minute, so a family's phones
   checking at once cost one call. The APK itself is streamed through:
   GitHub answers an asset request with a redirect to its file store,
   which must be followed WITHOUT the token. */
let ghLatest = null;
async function appRelease(env, name) {
  if (!env.GH_TOKEN || !env.GH_REPO) return json({ ok: false, why: "noupdates" }, 404);
  const now = Date.now();
  if (!ghLatest || now - ghLatest.at > 60000) {
    const r = await fetch("https://api.github.com/repos/" + env.GH_REPO + "/releases/latest", {
      headers: { "Authorization": "Bearer " + env.GH_TOKEN, "Accept": "application/vnd.github+json",
                 "User-Agent": "family-notifier-server", "X-GitHub-Api-Version": "2022-11-28" } });
    if (!r.ok) return json({ ok: false, why: "github " + r.status }, 502);
    ghLatest = { at: now, rel: await r.json() };
  }
  const asset = ((ghLatest.rel && ghLatest.rel.assets) || []).find((a) => a.name === name);
  if (!asset) return json({ ok: false, why: "noasset" }, 404);
  const first = await fetch(asset.url, { redirect: "manual",
    headers: { "Authorization": "Bearer " + env.GH_TOKEN, "Accept": "application/octet-stream",
               "User-Agent": "family-notifier-server" } });
  let res = first;
  if (first.status >= 300 && first.status < 400 && first.headers.get("location"))
    res = await fetch(first.headers.get("location"));
  if (!res.ok) return json({ ok: false, why: "asset " + res.status }, 502);
  const headers = { "Cache-Control": name.endsWith(".apk") ? "public, max-age=300" : "no-store" };
  if (name.endsWith(".json")) headers["Content-Type"] = "application/json";
  else { headers["Content-Type"] = "application/vnd.android.package-archive";
         headers["Content-Disposition"] = "attachment; filename=\"app-release.apk\"";
         if (asset.size) headers["Content-Length"] = String(asset.size); }
  return new Response(res.body, { status: 200, headers: headers });
}
function noStore(res) {
  const r = new Response(res.body, res);
  r.headers.set("Cache-Control", "no-store");
  return r;
}
function cors(res) {
  const r = new Response(res.body, res);
  r.headers.set("Access-Control-Allow-Origin", "*");
  r.headers.set("Access-Control-Allow-Methods", "GET, POST, PUT, OPTIONS");
  r.headers.set("Access-Control-Allow-Headers", "Content-Type, X-Me, X-Sec, X-Kind, X-Dk");
  r.headers.set("Access-Control-Max-Age", "86400");
  return r;
}
