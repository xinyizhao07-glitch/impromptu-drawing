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
  let textAnchor = { x: 70, y: 80 };
  let editTarget = null;   // the text block currently selected for moving / editing

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
        if (editTarget && state.pad.hasSelection()) state.pad.restyleSelected();
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
      if (editTarget && state.pad.hasSelection()) state.pad.restyleSelected();
    });
    box.appendChild(custom);
  }

  function initPad() {
    const pad = new SketchPad($('#pad'));
    state.pad = pad;
    pad.onChange = () => schedulePreview();
    pad.onStrokeEnd = () => sendPreview();
    pad.setTextSize(fontForStroke(12));
    pad.onTextTap = (p) => {
      /* Tapping bare paper starts a fresh block; tapping a block selects it. */
      textAnchor = { x: p.x, y: p.y };
      const wasEditing = !!editTarget;
      if (wasEditing) {
        editTarget = null;
        pad.selectText(null);
      }
      if (!composerOpen()) { openComposer('new'); return; }
      if (wasEditing) {
        /* Leaving the selected block behind: start with a clean box. */
        const box = $('#textInput');
        box.value = '';
        setComposerMode('new');
        autoGrow(box);
      }
      refreshGhost();
    };
    pad.onSelectText = (item) => {
      if (editTarget === item && composerOpen()) return;
      editTarget = item;
      openComposer('edit');
      syncTools();
    };

    document.querySelectorAll('.size-btn').forEach((btn) => {
      btn.onclick = () => {
        document.querySelectorAll('.size-btn').forEach((s) => s.classList.remove('active'));
        btn.classList.add('active');
        pad.setSize(Number(btn.dataset.size));
        pad.setEraser(false);
        pad.setTextSize(fontForStroke(Number(btn.dataset.size)));
        if (editTarget && pad.hasSelection()) pad.restyleSelected();
        else if (composerOpen()) refreshGhost();
        syncTools();
      };
    });

    $('#textBtn').onclick = () => {
      if (state.locked) return;
      const on = !pad.textMode;
      pad.setTextMode(on);
      if (on) openComposer(pad.hasSelection() ? 'edit' : 'new');
      else closeComposer();
      syncTools();
    };
    $('#textAdd').onclick = () => commitText();
    $('#textDelete').onclick = () => {
      pad.deleteSelected();
      editTarget = null;
      closeComposer();
      sendPreview();
      syncTools();
    };
    $('#textCancel').onclick = () => { pad.setTextMode(false); closeComposer(); syncTools(); };

    const ta = $('#textInput');
    ta.addEventListener('input', () => {
      autoGrow(ta);
      if (editTarget) pad.replaceSelectedText(ta.value);
      else refreshGhost();
    });
    ta.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); commitText(); }
      else if (e.key === 'Escape') { pad.setTextMode(false); closeComposer(); syncTools(); }
    });

    const vv = window.visualViewport;
    if (vv) {
      vv.addEventListener('resize', placeComposer);
      vv.addEventListener('scroll', placeComposer);
    }
    window.addEventListener('resize', placeComposer);

    $('#eraserBtn').onclick = () => {
      pad.setEraser(!pad.eraser);
      if (pad.eraser) closeComposer();
      syncTools();
    };
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
    $('#textBtn').disabled = !!state.locked;
    $('#textBtn').classList.toggle('active', !!state.pad.textMode);
    const cv = $('#pad');
    if (cv) {
      cv.classList.toggle('text-mode', !!state.pad.textMode);
      cv.classList.toggle('has-sel', !!state.pad.hasSelection());
    }
  }

  /* ------------------------------------------------------------ text tool */

  /* The brush-size buttons double as the text size: fine / medium / bold. */
  function fontForStroke(size) {
    return Math.round(24 + size * 2.4);
  }

  function composerOpen() {
    const el = $('#textComposer');
    return !!el && !el.classList.contains('hidden');
  }

  /* Keeps the composer sitting right on top of the on-screen keyboard. */
  function placeComposer() {
    const el = $('#textComposer');
    if (!el) return;
    const vv = window.visualViewport;
    let offset = 0;
    if (vv) offset = Math.max(0, window.innerHeight - vv.height - vv.offsetTop);
    el.style.bottom = (offset + 10) + 'px';
  }

  function autoGrow(ta) {
    ta.style.height = 'auto';
    ta.style.height = Math.min(110, ta.scrollHeight) + 'px';
  }

  /* Two modes: 'new' is an empty box waiting to be placed, 'edit' means an
     existing block is selected — it can be dragged around the paper. */
  function setComposerMode(mode) {
    const editing = mode === 'edit';
    $('#textAdd').textContent = editing ? 'Update' : 'Add';
    $('#textDelete').classList.toggle('hidden', !editing);
    const hint = $('#textHint');
    if (hint) {
      hint.textContent = editing
        ? 'Drag the box on the canvas to move it · change colour or size to restyle'
        : 'Tap the canvas to place it · Enter starts a new line';
    }
  }

  function openComposer(mode) {
    const el = $('#textComposer');
    const ta = $('#textInput');
    const editing = mode === 'edit' && editTarget;
    if (editing) {
      if (ta.value !== editTarget.text) ta.value = editTarget.text;
    } else if (mode !== 'edit') {
      ta.value = '';
    }
    el.classList.remove('hidden');
    setComposerMode(editing ? 'edit' : 'new');
    placeComposer();
    autoGrow(ta);
    if (editing) state.pad.setGhost(null);
    else refreshGhost();
    /* Only focus for a brand-new block: in edit mode the keyboard would cover
       the canvas the user is about to drag on. */
    if (!editing) {
      setTimeout(() => {
        try { ta.focus({ preventScroll: true }); } catch (err) { ta.focus(); }
      }, 80);
    } else if (document.activeElement === ta) {
      ta.blur();
    }
  }

  function closeComposer() {
    const el = $('#textComposer');
    const ta = $('#textInput');
    el.classList.add('hidden');
    ta.value = '';
    ta.style.height = 'auto';
    if (document.activeElement === ta) ta.blur();
    editTarget = null;
    if (state.pad) {
      state.pad.setGhost(null);
      state.pad.clearSelection();
    }
  }

  function refreshGhost() {
    if (!state.pad) return;
    state.pad.setGhostText($('#textInput').value, textAnchor.x, textAnchor.y);
  }

  function commitText() {
    const ta = $('#textInput');
    const raw = ta.value;

    /* Editing an existing block: rewrite it in place and keep it selected so
       the user can still drag it around. */
    if (editTarget && state.pad.hasSelection()) {
      state.pad.replaceSelectedText(raw);
      if (document.activeElement === ta) ta.blur();
      sendPreview();
      syncTools();
      return;
    }

    if (!raw.trim()) { closeComposer(); return; }
    state.pad.setGhost(null);
    const ok = state.pad.addText(raw, textAnchor.x, textAnchor.y);
    if (ok) {
      /* The new block stays selected — it is now a movable text box. */
      editTarget = state.pad.sel;
      ta.value = '';
      ta.style.height = 'auto';
      if (document.activeElement === ta) ta.blur();
      openComposer('edit');
      sendPreview();
    } else {
      closeComposer();
    }
    syncTools();
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
    if (state.locked) closeComposer();
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
    /* While a brand-new block is being typed the canvas carries a translucent
       ghost — don't leak that onto the presenter's wall. A selected (movable)
       block is fine: the dashed frame is stripped inside preview(). */
    if (composerOpen() && !editTarget) return;
    lastPreviewAt = Date.now();
    state.bus.publish({ t: 'preview', pid: state.id, name: state.name, data: state.pad.preview() });
  }

  async function submit(auto) {
    if (state.locked && !auto) return;
    closeComposer();                      // drop the ghost before exporting
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
