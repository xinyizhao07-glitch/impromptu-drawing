/* Shared helpers — Impromptu Drawing (serverless edition)
   ------------------------------------------------------------------
   No backend required: every browser (presenter + participants) talks
   over a public MQTT-over-WebSocket relay, so the QR code works from
   any network — no shared Wi-Fi needed.
*/
(function () {
  'use strict';

  /* ---------------------------------------------------------- relay */

  const BROKERS = [
    'wss://broker-cn.emqx.io:8084/mqtt',
    'wss://broker.emqx.io:8084/mqtt',
    'wss://broker.hivemq.com:8884/mqtt',
    'wss://test.mosquitto.org:8081/mqtt',
  ];
  const NS = 'impromptu-draw/v1';

  /* Public relays cap a single message at ~32-64KB, so anything bigger
     (artwork, previews) is split into chunks and reassembled on arrival. */
  const CHUNK = 16000;

  function randomId(n) {
    const abc = 'abcdefghijklmnopqrstuvwxyz0123456789';
    let out = '';
    for (let i = 0; i < (n || 8); i += 1) out += abc[Math.floor(Math.random() * abc.length)];
    return out;
  }

  /**
   * Open a room channel on the relay.
   * opts: { code, onMessage(msg), onStatus(state, url) }
   */
  function open(opts) {
    const topic = `${NS}/${opts.code}`;
    const sid = randomId(10); // ignore our own echoes
    let idx = 0;
    let client = null;
    let connected = false;
    let closed = false;
    const incoming = new Map(); // cid -> chunk buffer

    function status(state, url) {
      if (opts.onStatus) opts.onStatus(state, url || '');
    }

    /** Reassemble chunked messages, then hand them to the app. */
    function deliver(msg) {
      if (!msg.chunk) {
        if (opts.onMessage) opts.onMessage(msg);
        return;
      }
      const { cid, i, n } = msg.chunk;
      let e = incoming.get(cid);
      if (!e) {
        e = { parts: new Array(n), got: 0, meta: null };
        incoming.set(cid, e);
        setTimeout(() => incoming.delete(cid), 25000);
      }
      if (!e.parts[i]) {
        e.parts[i] = msg.part;
        e.got += 1;
      }
      e.meta = e.meta || msg;
      if (e.got === n) {
        incoming.delete(cid);
        const meta = Object.assign({}, e.meta);
        delete meta.chunk;
        delete meta.part;
        meta.data = e.parts.join('');
        if (opts.onMessage) opts.onMessage(meta);
      }
    }

    function tryOne() {
      if (closed) return;
      const url = BROKERS[idx % BROKERS.length];
      status('connecting', url);
      let c;
      try {
        c = mqtt.connect(url, {
          clientId: 'id-' + randomId(12),
          clean: true,
          keepalive: 25,
          connectTimeout: 7000,
          reconnectPeriod: 0,
        });
      } catch (err) {
        idx += 1;
        setTimeout(tryOne, 400);
        return;
      }
      client = c;

      const watchdog = setTimeout(() => {
        if (!connected) {
          try { c.end(true); } catch (e) {}
          idx += 1;
          setTimeout(tryOne, 400);
        }
      }, 8000);

      c.on('connect', () => {
        clearTimeout(watchdog);
        connected = true;
        c.subscribe(topic, { qos: 0 }, () => {});
        status('online', url);
      });

      c.on('message', (t, payload) => {
        if (t !== topic) return;
        let msg;
        try {
          msg = JSON.parse(payload.toString());
        } catch (err) {
          return;
        }
        if (!msg || msg.sid === sid) return;
        deliver(msg);
      });

      c.on('error', () => {});
      c.on('close', () => {
        clearTimeout(watchdog);
        if (closed) return;
        const wasUp = connected;
        connected = false;
        status('offline');
        setTimeout(tryOne, wasUp ? 900 : 400);
      });
    }

    tryOne();

    return {
      publish(obj) {
        if (!client || !connected) return false;
        const base = { sid, ts: Date.now() };
        const whole = JSON.stringify(Object.assign({}, base, obj));
        if (whole.length <= CHUNK * 1.4) {
          client.publish(topic, whole, { qos: 0 });
          return true;
        }
        const data = String(obj.data || '');
        const meta = Object.assign({}, obj);
        delete meta.data;
        const cid = randomId(8);
        const n = Math.ceil(data.length / CHUNK) || 1;
        for (let i = 0; i < n; i += 1) {
          const body = JSON.stringify(Object.assign({}, base, meta, {
            chunk: { cid, i, n },
            part: data.slice(i * CHUNK, (i + 1) * CHUNK),
          }));
          // pace the burst: public relays throttle very fast publishers
          if (i === 0) client.publish(topic, body, { qos: 0 });
          else setTimeout(() => { if (!closed && client && connected) client.publish(topic, body, { qos: 0 }); }, i * 45);
        }
        return true;
      },
      close() {
        closed = true;
        try { client && client.end(true); } catch (e) {}
      },
      get ready() {
        return connected;
      },
      get relay() {
        return BROKERS[idx % BROKERS.length];
      },
    };
  }

  /* ---------------------------------------------------------- local store (IndexedDB) */

  const DB_NAME = 'impromptu-draw';
  const STORE = 'artworks';

  function db() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => {
        const d = req.result;
        if (!d.objectStoreNames.contains(STORE)) {
          d.createObjectStore(STORE, { keyPath: 'key' });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  function withStore(mode, fn) {
    return db().then((d) => new Promise((resolve, reject) => {
      const tx = d.transaction(STORE, mode);
      const store = tx.objectStore(STORE);
      let result;
      try {
        result = fn(store);
      } catch (err) {
        return reject(err);
      }
      tx.oncomplete = () => resolve(result && result.result !== undefined ? result.result : result);
      tx.onerror = () => reject(tx.error);
    }));
  }

  const store = {
    async save(code, item) {
      await withStore('readwrite', (s) => s.put(Object.assign({ key: code + '|' + item.id }, item, { code })));
      return true;
    },
    async all(code) {
      const d = await db();
      return new Promise((resolve) => {
        const out = [];
        const tx = d.transaction(STORE, 'readonly');
        const cur = tx.objectStore(STORE).openCursor();
        cur.onsuccess = (e) => {
          const c = e.target.result;
          if (!c) return resolve(out);
          if (c.value.code === code) out.push(c.value);
          c.continue();
        };
        cur.onerror = () => resolve(out);
      });
    },
    async clear(code) {
      const d = await db();
      return new Promise((resolve) => {
        const tx = d.transaction(STORE, 'readwrite');
        const cur = tx.objectStore(STORE).openCursor();
        cur.onsuccess = (e) => {
          const c = e.target.result;
          if (!c) return resolve();
          if (c.value.code === code) c.delete();
          c.continue();
        };
        cur.onerror = () => resolve();
      });
    },
  };

  /* ---------------------------------------------------------- misc */

  function toast(message, ms) {
    let box = document.querySelector('.toasts');
    if (!box) {
      box = document.createElement('div');
      box.className = 'toasts';
      document.body.appendChild(box);
    }
    const el = document.createElement('div');
    el.className = 'toast';
    el.textContent = message;
    box.appendChild(el);
    setTimeout(() => {
      el.style.transition = 'opacity .25s ease, transform .25s ease';
      el.style.opacity = '0';
      el.style.transform = 'translateY(6px)';
      setTimeout(() => el.remove(), 260);
    }, ms || 2000);
  }

  async function copy(text) {
    try {
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(text);
      } else {
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        ta.remove();
      }
      toast('Copied');
      return true;
    } catch (err) {
      toast('Copy failed — select and copy manually');
      return false;
    }
  }

  function fmtClock(ms) {
    const total = Math.max(0, Math.round(ms / 1000));
    return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
  }

  function fmtTime(ts) {
    return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }

  /** Space codes: 8 characters, no look-alikes. */
  const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  function makeCode(len) {
    let out = '';
    for (let i = 0; i < (len || 8); i += 1) out += ALPHABET[Math.floor(Math.random() * ALPHABET.length)];
    return out;
  }

  function qrDataURL(text) {
    const q = qrcode(0, 'M');
    q.addData(text);
    q.make();
    const svg = q.createSvgTag(6, 2);
    return 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
  }

  /** Artwork downscale helper — keeps relay messages small. */
  function resize(dataURL, maxW, quality) {
    return new Promise((resolve) => {
      const img = new Image();
      img.onload = () => {
        const scale = Math.min(1, (maxW || 1000) / img.width);
        const c = document.createElement('canvas');
        c.width = Math.round(img.width * scale);
        c.height = Math.round(img.height * scale);
        const ctx = c.getContext('2d');
        ctx.fillStyle = '#fff';
        ctx.fillRect(0, 0, c.width, c.height);
        ctx.drawImage(img, 0, 0, c.width, c.height);
        resolve(c.toDataURL('image/jpeg', quality || 0.85));
      };
      img.onerror = () => resolve(dataURL);
      img.src = dataURL;
    });
  }

  const KEY = 'impromptu.spaces.v1';
  const spaces = {
    list() {
      try {
        return JSON.parse(localStorage.getItem(KEY) || '[]');
      } catch (err) {
        return [];
      }
    },
    add(entry) {
      const all = spaces.list().filter((s) => s.code !== entry.code);
      all.unshift(entry);
      try {
        localStorage.setItem(KEY, JSON.stringify(all.slice(0, 12)));
      } catch (err) {}
    },
    get(code) {
      return spaces.list().find((s) => s.code === code) || null;
    },
    remove(code) {
      const all = spaces.list().filter((s) => s.code !== code);
      try {
        localStorage.setItem(KEY, JSON.stringify(all));
      } catch (err) {}
      return all;
    },
  };

  function clientId() {
    const k = 'impromptu.uid';
    let id = localStorage.getItem(k);
    if (!id) {
      id = (crypto.randomUUID ? crypto.randomUUID() : randomId(16));
      localStorage.setItem(k, id);
    }
    return id;
  }

  const $ = (sel, root) => (root || document).querySelector(sel);

  window.ID = {
    bus: { open, BROKERS },
    store, toast, copy, fmtClock, fmtTime, makeCode, qrDataURL, resize,
    spaces, clientId, randomId, $,
  };
})();
