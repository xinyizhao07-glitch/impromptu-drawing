/* Participant side — Impromptu Drawing (serverless edition) */
(function () {
  'use strict';

  const $ = ID.$;
  const COLORS = [
    '#1f2430', '#e05260', '#ff8a3d', '#ffc53d', '#16a97a',
    '#2bb0ff', '#6c5ce7', '#ff6bd6', '#8d6e63', '#c0c6d2',
  ];

  const state = {
    code: null,
    name: '',
    id: ID.clientId(),
    locked: false,
    ended: false,
    submitted: false,
    lastArt: null,
    pending: null,
    pad: null,
    bus: null,
    gallery: [],
  };

  let previewTimer = null;
  let lastPreviewAt = 0;

  /* Phones get shorter labels so the header fits on one line. */
  const NARROW = window.matchMedia('(max-width: 560px)');
  let hostKind = 'connecting';

  function hostLabel(kind) {
    const p = NARROW.matches;
    switch (kind) {
      case 'online': return p ? 'Live' : 'Presenter online';
      case 'offline': return p ? 'Offline' : 'Presenter offline';
      case 'deleted': return 'Deleted';
      case 'reconnecting': return p ? 'Retry…' : 'Reconnecting…';
      default: return p ? 'Connecting' : 'Connecting…';
    }
  }

  function setHost(kind) {
    hostKind = kind;
    $('#hostPill').classList.toggle('live', kind === 'online');
    $('#hostText').textContent = hostLabel(kind);
  }

  function paintCodePill() {
    if (!state.code) return;
    $('#codePill').textContent = NARROW.matches
      ? state.code
      : 'SPACE ' + state.code.split('').join(' ');
  }

  /* ------------------------------------------------------------ setup */

  function buildColors() {
    const box = $('#colors');
    COLORS.forEach((c, i) => {
      const b = document.createElement('button');
      b.className = 'swatch' + (i === 0 ? ' active' : '');
      b.style.background = c;
      b.onclick = () => {
        document.querySelectorAll('.swatch').forEach((s) => s.classList.remove('active'));
        b.classList.add('active');
        state.pad.setColor(c);
      };
      box.appendChild(b);
    });

    const custom = document.createElement('button');
    custom.className = 'swatch custom';
    custom.title = 'Custom colour';
    custom.innerHTML = '<input type="color" value="#6c5ce7" />';
    custom.querySelector('input').addEventListener('input', (e) => {
      document.querySelectorAll('.swatch').forEach((s) => s.classList.remove('active'));
      custom.classList.add('active');
      state.pad.setColor(e.target.value);
    });
    box.appendChild(custom);
  }

  function initPad() {
    const pad = new SketchPad($('#pad'));
    state.pad = pad;
    pad.onChange = () => schedulePreview();
    pad.onStrokeEnd = () => sendPreview();

    document.querySelectorAll('.size-btn').forEach((btn) => {
      btn.onclick = () => {
        document.querySelectorAll('.size-btn').forEach((s) => s.classList.remove('active'));
        btn.classList.add('active');
        pad.setSize(Number(btn.dataset.size));
        pad.setEraser(false);
        syncTools();
      };
    });

    $('#eraserBtn').onclick = () => { pad.setEraser(!pad.eraser); syncTools(); };
    $('#undoBtn').onclick = () => {
      if (state.locked) return;
      pad.undo();
      sendPreview();
    };
    $('#clearBtn').onclick = () => {
      if (state.locked) return;
      if (!pad.isEmpty() && !confirm('Clear the whole canvas?')) return;
      pad.reset();
      sendPreview();
    };
    $('#submitBtn').onclick = () => submit(false);
    $('#editAgainBtn').onclick = () => $('#doneCard').classList.add('hidden');
    $('#galleryBtn').onclick = showGallery;
    $('#galleryClose').onclick = () => $('#galleryCard').classList.add('hidden');
  }

  function syncTools() {
    const pad = state.pad;
    $('#eraserBtn').classList.toggle('active', !!pad.eraser);
    $('#submitBtn').textContent = state.locked ? 'Locked' : (state.submitted ? 'Resubmit' : 'Submit');
    $('#submitBtn').disabled = !!state.locked;
    $('#undoBtn').disabled = !!state.locked;
    $('#clearBtn').disabled = !!state.locked;
  }

  /* ------------------------------------------------------------ relay */

  function connect() {
    state.bus = ID.bus.open({
      code: state.code,
      onStatus(s) {
        if (s === 'online') {
          setHost('online');
          sendHello();
        } else if (s === 'connecting') {
          setHost('connecting');
        } else {
          setHost('reconnecting');
        }
      },
      onMessage(msg) {
        handle(msg);
      },
    });
  }

  function sendHello() {
    state.bus.publish({ t: 'hello', pid: state.id, name: state.name });
  }

  function handle(msg) {
    if (msg.t === 'host-ping' || msg.t === 'host-hello') {
      setHost('online');
      // a (re)connected presenter may have missed us
      sendHello();
      if (state.submitted && state.lastArt) {
        state.bus.publish({ t: 'submit', pid: state.id, name: state.name, data: state.lastArt });
      }
    } else if (msg.t === 'state') {
      setPrompt(msg.prompt);
      applyLock(!!msg.locked || !!msg.ended);
      if (typeof msg.ended === 'boolean') state.ended = msg.ended;
    } else if (msg.t === 'timer') {
      setTimer(msg);
    } else if (msg.t === 'lock') {
      applyLock(!!msg.locked);
      if (msg.locked) {
        if (!state.pad.isEmpty()) {
          submit(true);
          ID.toast('Time is up — your drawing was submitted');
        } else {
          ID.toast('Time is up');
        }
      }
    } else if (msg.t === 'ended') {
      state.ended = true;
      applyLock(true);
      $('#galleryBtn').classList.remove('hidden');
    } else if (msg.t === 'reopen') {
      state.ended = false;
      applyLock(false);
      $('#galleryCard').classList.add('hidden');
      $('#doneCard').classList.add('hidden');
      $('#galleryBtn').classList.add('hidden');
      state.gallery = [];
      ID.toast('The presenter reopened the space');
    } else if (msg.t === 'ack') {
      if (state.pending && state.pending.mid === msg.mid) state.pending = null;
    } else if (msg.t === 'gallery') {
      state.bus.publish({ t: 'gack', gid: msg.id });
      addGalleryItem(msg);
    } else if (msg.t === 'host-bye') {
      setHost('offline');
    } else if (msg.t === 'deleted') {
      state.ended = true;
      state.locked = true;
      state.pad.setLocked(true);
      syncTools();
      setHost('deleted');
      $('#statusPill').innerHTML = '<span class="dot"></span> Closed';
      showDeleted();
    }
  }

  function showDeleted() {
    if (document.getElementById('deletedVeil')) return;
    const veil = document.createElement('div');
    veil.id = 'deletedVeil';
    veil.className = 'deleted-veil';
    veil.innerHTML = `
      <div class="dv-card">
        <h3>Space deleted</h3>
        <p>The presenter deleted this space. Your drawing was not saved.</p>
        <a class="btn btn-primary" href="index.html">Back to start</a>
      </div>`;
    document.body.appendChild(veil);
  }

  function applyLock(on) {
    state.locked = !!on;
    state.pad.setLocked(state.locked);
    syncTools();
    $('#statusPill').innerHTML = '<span class="dot"></span> ' + (state.locked ? 'Locked' : (state.submitted ? 'Submitted' : 'Drawing'));
  }

  function setPrompt(text) {
    const el = $('#promptText');
    el.textContent = text || '';
    el.title = text || '';
    el.classList.toggle('hidden', !text);
  }

  function setTimer(msg) {
    const pill = $('#timerPill');
    if (!msg || !msg.duration) {
      pill.classList.add('hidden');
      return;
    }
    pill.classList.remove('hidden');
    const ms = Math.max(0, msg.remaining || 0);
    $('#timerText').textContent = ID.fmtClock(ms);
    pill.classList.toggle('live', !!msg.running);
    pill.style.color = ms <= 30000 ? 'var(--danger)' : '';
    pill.style.borderColor = ms <= 30000 ? 'rgba(224,82,96,.4)' : '';
  }

  /* ------------------------------------------------------------ drawing out */

  function schedulePreview() {
    if (state.locked || !state.bus) return;
    const wait = Math.max(0, 1100 - (Date.now() - lastPreviewAt));
    clearTimeout(previewTimer);
    previewTimer = setTimeout(sendPreview, wait);
  }

  function sendPreview() {
    if (!state.bus || !state.pad) return;
    lastPreviewAt = Date.now();
    state.bus.publish({ t: 'preview', pid: state.id, name: state.name, data: state.pad.preview() });
  }

  async function submit(auto) {
    if (state.locked && !auto) return;
    if (!state.pad || state.pad.isEmpty()) {
      ID.toast('Draw something first');
      return;
    }
    if (!state.bus || !state.bus.ready) {
      ID.toast('Still connecting — try again in a second');
      return;
    }
    const full = state.pad.exportPNG();
    const data = await ID.resize(full, 900, 0.82);
    state.lastArt = data;
    state.submitted = true;

    const mid = ID.randomId(8);
    state.pending = { mid, tries: 1 };
    sendSubmit(mid);
    scheduleRetry(mid);

    $('#doneCard').classList.remove('hidden');
    $('#statusPill').innerHTML = '<span class="dot"></span> Submitted';
    syncTools();
    if (!auto) ID.toast('Submitted');
  }

  function sendSubmit(mid) {
    if (!state.lastArt) return;
    state.bus.publish({ t: 'submit', pid: state.id, name: state.name, mid, data: state.lastArt });
  }

  /** The relay is best-effort, so resend until the presenter confirms. */
  function scheduleRetry(mid) {
    setTimeout(() => {
      if (!state.pending || state.pending.mid !== mid) return;
      if (state.pending.tries >= 4) {
        state.pending = null;
        ID.toast('Could not reach the presenter — check that their screen is open');
        return;
      }
      state.pending.tries += 1;
      sendSubmit(mid);
      scheduleRetry(mid);
    }, 4500);
  }

  /* ------------------------------------------------------------ gallery */

  function addGalleryItem(msg) {
    if (state.gallery.some((g) => g.id === msg.id)) return;
    state.gallery.push({ id: msg.id, name: msg.name, data: msg.data });
    if ($('#galleryCard').classList.contains('hidden') === false) renderGallery();
    if (state.gallery.length >= (msg.n || 1)) {
      showGallery();
    }
  }

  function renderGallery() {
    const grid = $('#galleryGrid');
    grid.innerHTML = '';
    state.gallery.forEach((g) => {
      const fig = document.createElement('figure');
      const img = document.createElement('img');
      img.src = g.data;
      img.alt = g.name || 'artwork';
      const cap = document.createElement('figcaption');
      cap.textContent = g.name || 'Anonymous';
      fig.appendChild(img);
      fig.appendChild(cap);
      grid.appendChild(fig);
    });
  }

  function showGallery() {
    renderGallery();
    $('#galleryCard').classList.remove('hidden');
  }

  /* ------------------------------------------------------------ gate */

  function joinFlow() {
    const name = $('#nameInput').value.trim();
    if (!name) {
      $('#gateError').textContent = 'Please enter your name.';
      return;
    }
    let code = state.code;
    if (!code) {
      code = $('#codeInput').value.trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
      if (code.length < 6) {
        $('#gateError').textContent = 'Enter the 8-character space code.';
        return;
      }
      localStorage.setItem('impromptu.name', name);
      location.href = 'room.html?c=' + code;
      return;
    }
    state.name = name;
    localStorage.setItem('impromptu.name', name);
    $('#gate').classList.add('hidden');
    connect();
    syncTools();
  }

  /* ------------------------------------------------------------ boot */

  document.addEventListener('DOMContentLoaded', () => {
    const params = new URLSearchParams(location.search);
    state.code = (params.get('c') || params.get('code') || '').toUpperCase();

    initPad();
    buildColors();
    syncTools();

    if (state.code) {
      paintCodePill();
      setHost(hostKind);
      $('#gateTitle').textContent = 'Join ' + state.code;
      $('#codeField').classList.add('hidden');
    } else {
      $('#codeField').classList.remove('hidden');
      $('#gateTitle').textContent = 'Join a space';
      $('#gateSub').textContent = 'Enter the code shown on the presenter screen.';
    }

    $('#nameInput').value = localStorage.getItem('impromptu.name') || '';
    $('#joinBtn').onclick = joinFlow;
    $('#nameInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') joinFlow(); });
    $('#codeInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') joinFlow(); });

    /* On a phone an auto-focus pops the keyboard and hides the form. */
    if (window.matchMedia('(pointer: fine)').matches) {
      setTimeout(() => $('#nameInput').focus(), 200);
    }

    /* Rotating the phone (or the keyboard appearing) changes the width, and some
       browsers skip the media-query event — so listen for plain resizes too. */
    let relabelTimer = null;
    const relabel = () => {
      if (relabelTimer) return;
      relabelTimer = setTimeout(() => {
        relabelTimer = null;
        paintCodePill();
        setHost(hostKind);
      }, 60);
    };
    if (NARROW.addEventListener) NARROW.addEventListener('change', relabel);
    else if (NARROW.addListener) NARROW.addListener(relabel);
    window.addEventListener('resize', relabel);
    window.addEventListener('orientationchange', () => setTimeout(relabel, 250));

    window.addEventListener('beforeunload', () => {
      if (state.bus) state.bus.publish({ t: 'bye', pid: state.id });
    });
  });
})();
