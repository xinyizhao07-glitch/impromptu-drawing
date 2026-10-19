/* Presenter side — Impromptu Drawing (serverless edition) */
(function () {
  'use strict';

  const $ = ID.$;
  const state = {
    code: null,
    title: '',
    prompt: '',
    ended: false,
    locked: false,
    createdAt: Date.now(),
    order: [],
    people: new Map(), // id -> {id,name,status,ts,data}
    previews: new Map(), // id -> dataURL
    thumbs: new Map(), // id -> small dataURL for the end gallery
    galleryAcks: new Set(),
  };

  let bus = null;
  let heartbeat = null;
  let deletedFlag = false;

  /* ------------------------------------------------------------ relay */

  function connect() {
    bus = ID.bus.open({
      code: state.code,
      onStatus(s, url) {
        const pill = $('#relayPill');
        const text = $('#relayText');
        if (s === 'online') {
          pill.classList.add('live');
          const host = (url || '').replace('wss://', '').replace('/mqtt', '');
          text.textContent = 'Relay ' + host;
          publishState();
          ID.toast('Space ' + state.code + ' is open');
        } else if (s === 'connecting') {
          pill.classList.remove('live');
          text.textContent = 'Connecting…';
        } else {
          pill.classList.remove('live');
          text.textContent = 'Reconnecting…';
        }
      },
      onMessage(msg) {
        handle(msg);
      },
    });

    clearInterval(heartbeat);
    heartbeat = setInterval(() => {
      bus.publish({ t: 'host-ping' });
    }, 15000);
  }

  function publishState() {
    if (!bus) return;
    bus.publish({
      t: 'state',
      code: state.code,
      title: state.title,
      prompt: state.prompt,
      ended: state.ended,
      locked: state.locked,
      roster: [...state.people.values()].map((p) => ({ id: p.id, name: p.name, status: p.status })),
    });
  }

  function handle(msg) {
    if (msg.t === 'hello') {
      const p = state.people.get(msg.pid) || { id: msg.pid };
      p.name = msg.name || p.name || 'Anonymous';
      p.status = p.status || 'drawing';
      if (!state.people.has(msg.pid)) state.order.push(msg.pid);
      state.people.set(msg.pid, p);
      renderWall();
      publishState();
    } else if (msg.t === 'preview') {
      state.previews.set(msg.pid, msg.data);
      const p = state.people.get(msg.pid);
      if (p) updateTile(p);
    } else if (msg.t === 'submit') {
      const p = state.people.get(msg.pid) || { id: msg.pid };
      p.name = msg.name || p.name || 'Anonymous';
      p.status = 'submitted';
      p.data = msg.data;
      p.ts = Date.now();
      if (!state.people.has(msg.pid)) state.order.push(msg.pid);
      state.people.set(msg.pid, p);
      state.previews.delete(msg.pid);
      ID.store.save(state.code, { id: p.id, name: p.name, data: p.data, ts: p.ts }).catch(() => {});
      renderWall();
      if (lb) paintLightbox();
      if (bus && msg.mid) bus.publish({ t: 'ack', mid: msg.mid, pid: msg.pid });
    } else if (msg.t === 'gack') {
      state.galleryAcks.add(msg.gid);
    } else if (msg.t === 'bye') {
      state.people.delete(msg.pid);
      state.order = state.order.filter((id) => id !== msg.pid);
      renderWall();
    }
  }

  /* ------------------------------------------------------------ wall */

  function imageFor(p) {
    return (p.status === 'submitted' && p.data) ? p.data : (state.previews.get(p.id) || null);
  }

  function viewList() {
    return state.order.map((id) => state.people.get(id)).filter((p) => p && imageFor(p));
  }

  function ensureTile(p) {
    const wall = $('#wall');
    let tile = wall.querySelector(`[data-id="${p.id}"]`);
    if (tile) return tile;

    tile = document.createElement('div');
    tile.className = 'tile';
    tile.dataset.id = p.id;
    tile.innerHTML = `
      <div class="thumb">
        <span class="badge-live"><i></i> LIVE</span>
        <img alt="" class="hidden" />
        <div class="empty-hint">Not started yet</div>
      </div>
      <div class="meta">
        <span class="nm"></span>
        <span class="st"></span>
      </div>`;
    tile.addEventListener('click', () => {
      const list = viewList();
      const idx = list.findIndex((x) => x.id === p.id);
      if (idx >= 0) openLightbox(idx, false);
    });
    wall.appendChild(tile);
    return tile;
  }

  function updateTile(p) {
    const tile = ensureTile(p);
    const src = imageFor(p);
    const img = tile.querySelector('img');
    const hint = tile.querySelector('.empty-hint');
    const badge = tile.querySelector('.badge-live');

    if (src && img.getAttribute('src') !== src) img.setAttribute('src', src);
    img.classList.toggle('hidden', !src);
    hint.classList.toggle('hidden', !!src);
    badge.style.display = p.status === 'submitted' || !src ? 'none' : '';

    tile.querySelector('.nm').textContent = p.name || 'Anonymous';
    const st = tile.querySelector('.st');
    if (p.status === 'submitted') {
      st.className = 'st done';
      st.textContent = 'Submitted ' + ID.fmtTime(p.ts || Date.now());
    } else {
      st.className = 'st drawing';
      st.textContent = src ? 'Drawing…' : 'Ready';
    }
  }

  function renderWall() {
    state.order.forEach((id) => {
      const p = state.people.get(id);
      if (p) updateTile(p);
    });
    const done = [...state.people.values()].filter((p) => p.status === 'submitted').length;
    $('#statJoined').textContent = state.people.size;
    $('#statDone').textContent = done;
    $('#wallCount').textContent = `${done} artwork${done === 1 ? '' : 's'}`;
    $('#emptyWall').classList.toggle('hidden', state.people.size > 0);
  }

  /* ------------------------------------------------------------ lightbox */

  let lb = null;
  let lbIndex = 0;
  let lbTimer = null;

  function openLightbox(index, autoplay) {
    closeLightbox();
    const list = viewList();
    if (!list.length) return ID.toast('No artwork yet');
    lbIndex = Math.max(0, Math.min(index, list.length - 1));

    lb = document.createElement('div');
    lb.className = 'lightbox';
    lb.innerHTML = `
      <div class="lb-top">
        <h3 class="lb-name"></h3>
        <span class="pill lb-count" style="background:rgba(255,255,255,.12);border-color:rgba(255,255,255,.18);color:#fff;"></span>
        <span class="spacer"></span>
        <button class="ghost-btn lb-prev">Prev</button>
        <button class="ghost-btn lb-next">Next</button>
        <button class="ghost-btn lb-play">Play</button>
        <button class="ghost-btn lb-close">Close</button>
      </div>
      <div class="lb-stage"><img alt="" /></div>
      <div class="lb-bottom"><span class="lb-tip">Use ← → to browse · Esc to close</span></div>`;
    document.body.appendChild(lb);
    document.body.classList.add('lb-open');

    $('.lb-close', lb).onclick = closeLightbox;
    $('.lb-prev', lb).onclick = () => step(-1);
    $('.lb-next', lb).onclick = () => step(1);
    $('.lb-play', lb).onclick = () => toggleAutoplay();
    lb.addEventListener('click', (e) => {
      if (e.target === lb || e.target.classList.contains('lb-stage')) closeLightbox();
    });

    document.addEventListener('keydown', onKey);
    paintLightbox();
    if (autoplay) startAutoplay();
  }

  function paintLightbox() {
    if (!lb) return;
    const list = viewList();
    if (!list.length) return closeLightbox();
    lbIndex = (lbIndex + list.length) % list.length;
    const p = list[lbIndex];
    $('.lb-name', lb).textContent = p.name || 'Anonymous';
    $('.lb-count', lb).textContent = `${lbIndex + 1} / ${list.length}`;
    $('.lb-stage img', lb).setAttribute('src', imageFor(p));
    const play = $('.lb-play', lb);
    if (play) play.textContent = lbTimer ? 'Pause' : 'Play';
  }

  function step(d) { lbIndex += d; paintLightbox(); }

  function startAutoplay() {
    stopAutoplay();
    lbTimer = setInterval(() => { lbIndex += 1; paintLightbox(); }, 6000);
    paintLightbox();
  }

  function stopAutoplay() {
    if (lbTimer) clearInterval(lbTimer);
    lbTimer = null;
    if (lb) { const pl = $('.lb-play', lb); if (pl) pl.textContent = 'Play'; }
  }

  function toggleAutoplay() { if (lbTimer) stopAutoplay(); else startAutoplay(); }

  function closeLightbox() {
    stopAutoplay();
    document.removeEventListener('keydown', onKey);
    if (lb) lb.remove();
    lb = null;
    document.body.classList.remove('lb-open');
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
  }

  function onKey(e) {
    if (!lb) return;
    if (e.key === 'Escape') closeLightbox();
    else if (e.key === 'ArrowRight') step(1);
    else if (e.key === 'ArrowLeft') step(-1);
  }

  /* ------------------------------------------------------------ timer */

  const timer = { duration: 300000, remaining: 300000, running: false, last: 0, raf: null, sent: 0 };

  function timerSet(ms) {
    timer.duration = ms;
    timer.remaining = ms;
    timer.running = false;
    timerPush(true);
    timerRender();
  }

  function timerRender() {
    $('#timerDisplay').textContent = ID.fmtClock(timer.remaining);
    $('#timerDisplay').classList.toggle('over', timer.remaining <= 0);
    $('#timerToggle').textContent = timer.running ? 'Pause' : (timer.remaining <= 0 ? 'Restart' : 'Start');
  }

  function timerPush(force) {
    const now = Date.now();
    if (!force && now - timer.sent < 1000) return;
    timer.sent = now;
    if (bus) bus.publish({ t: 'timer', duration: timer.duration, remaining: Math.max(0, Math.round(timer.remaining)), running: timer.running });
  }

  function timerLoop() {
    if (!timer.running) return;
    const now = performance.now();
    const dt = timer.last ? now - timer.last : 0;
    timer.last = now;
    timer.remaining -= dt;
    if (timer.remaining <= 0) {
      timer.remaining = 0;
      timer.running = false;
      timerPush(true);
      timerRender();
      setLocked(true);
      ID.toast('Time is up — canvases locked');
      return;
    }
    timerRender();
    timerPush();
    timer.raf = requestAnimationFrame(timerLoop);
  }

  function timerToggle() {
    if (timer.remaining <= 0) timer.remaining = timer.duration;
    timer.running = !timer.running;
    timer.last = 0;
    cancelAnimationFrame(timer.raf);
    if (timer.running) timer.raf = requestAnimationFrame(timerLoop);
    timerPush(true);
    timerRender();
  }

  /* ------------------------------------------------------------ actions */

  function setLocked(on) {
    state.locked = !!on;
    if (bus) bus.publish({ t: 'lock', locked: !!on });
    publishState();
  }

  async function endSpace() {
    state.ended = true;
    state.locked = true;
    timer.running = false;
    cancelAnimationFrame(timer.raf);
    $('#endBtn').textContent = 'Reopen';
    $('#livePill').classList.remove('live');
    $('#livePill').innerHTML = '<span class="dot"></span> Ended';

    if (bus) bus.publish({ t: 'ended' });
    publishState();

    const items = [...state.people.values()].filter((p) => p.data);
    const thumbs = [];
    for (const p of items) {
      let thumb = state.thumbs.get(p.id);
      if (!thumb) {
        thumb = await ID.resize(p.data, 460, 0.68);
        state.thumbs.set(p.id, thumb);
      }
      thumbs.push({ id: p.id, name: p.name, data: thumb });
    }

    // the relay is best-effort: resend whatever participants did not confirm
    for (let round = 0; round < 3; round += 1) {
      const left = thumbs.filter((t) => !state.galleryAcks.has(t.id));
      if (!left.length || !bus) break;
      for (const t of left) {
        bus.publish({ t: 'gallery', i: thumbs.indexOf(t), n: thumbs.length, id: t.id, name: t.name, data: t.data });
        await new Promise((r) => setTimeout(r, 220));
      }
      await new Promise((r) => setTimeout(r, 4000));
    }
  }

  function reopenSpace() {
    state.ended = false;
    state.locked = false;
    $('#endBtn').textContent = 'End';
    $('#livePill').classList.add('live');
    $('#livePill').innerHTML = '<span class="dot"></span> Live';
    if (bus) bus.publish({ t: 'reopen' });
    publishState();
    ID.toast('Space reopened');
  }

  /* ------------------------------------------------------------ delete space */

  function stopTimer() {
    timer.running = false;
    if (timer.raf) cancelAnimationFrame(timer.raf);
    timer.raf = null;
  }

  async function wipeSpace(code) {
    try {
      await ID.store.clear(code);
    } catch (err) { /* storage unavailable */ }
    ID.spaces.remove(code);
  }

  async function deleteCurrentSpace() {
    const code = state.code;
    const count = [...state.people.values()].filter((p) => p.data).length;
    const msg = `Delete space ${code}?\n\n`
      + `${count} artwork(s) stored in this browser will be removed.\n`
      + `Participants in this space will be told it was deleted.\n\n`
      + `This cannot be undone.`;
    if (!confirm(msg)) return;

    closeLightbox();
    stopTimer();
    deletedFlag = true;
    state.ended = true;
    state.locked = true;
    if (bus) {
      bus.publish({ t: 'deleted', code });
      await new Promise((r) => setTimeout(r, 350));
      try { bus.close(); } catch (err) { /* already gone */ }
      bus = null;
    }
    if (heartbeat) { clearInterval(heartbeat); heartbeat = null; }

    await wipeSpace(code);
    location.href = `index.html?deleted=${code}`;
  }

  async function deleteOtherSpace(code) {
    if (!confirm(`Delete space ${code}? Its stored artworks will be removed. This cannot be undone.`)) return;
    await wipeSpace(code);
    renderSpaces();
    renderSpacesList();
    ID.toast('Space ' + code + ' deleted');
  }

  function openSpaces() {
    $('#spacesModal').classList.remove('hidden');
    renderSpacesList();
  }

  function closeSpaces() {
    $('#spacesModal').classList.add('hidden');
  }

  async function renderSpacesList() {
    const box = $('#spacesList');
    const all = ID.spaces.list();
    if (!all.length) {
      box.innerHTML = '<div class="sp-empty">No saved spaces yet.</div>';
      return;
    }
    box.innerHTML = all.map((s) => `
      <div class="sp-row${s.code === state.code ? ' is-current' : ''}" data-code="${s.code}">
        <div class="sp-main">
          <div class="sp-code">${s.code}${s.code === state.code ? ' · current' : ''}</div>
          <div class="sp-sub">${s.title ? escapeHtml(s.title) + ' · ' : ''}${s.createdAt ? new Date(s.createdAt).toLocaleString() : ''} · <span class="sp-count">…</span></div>
        </div>
        <div class="sp-actions">
          <button class="btn btn-sm sp-open">Open</button>
          <button class="btn btn-sm btn-danger sp-del">Delete</button>
        </div>
      </div>`).join('');

    box.querySelectorAll('.sp-row').forEach((row) => {
      const code = row.dataset.code;
      row.querySelector('.sp-open').onclick = () => {
        if (code === state.code) closeSpaces();
        else location.href = 'presenter.html?c=' + code;
      };
      row.querySelector('.sp-del').onclick = () => (
        code === state.code ? deleteCurrentSpace() : deleteOtherSpace(code)
      );
    });

    // artwork counts load from IndexedDB, one space at a time
    for (const row of box.querySelectorAll('.sp-row')) {
      const code = row.dataset.code;
      const items = await ID.store.all(code).catch(() => []);
      const el = row.querySelector('.sp-count');
      if (el) el.textContent = `${items.length} artwork${items.length === 1 ? '' : 's'}`;
    }
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  async function exportZip() {
    const items = [...state.people.values()].filter((p) => p.data);
    if (!items.length) return ID.toast('Nothing to export yet');

    const zip = new JSZip();
    const folder = zip.folder('artworks');
    const manifest = [
      `Impromptu Drawing — space ${state.code}`,
      `Title: ${state.title || 'Untitled'}`,
      `Created: ${new Date(state.createdAt).toLocaleString()}`,
      '',
    ];
    items.forEach((p, i) => {
      const n = String(i + 1).padStart(2, '0');
      const safe = String(p.name || 'anonymous').replace(/[\\/:*?"<>|]/g, '_');
      const base64 = String(p.data).split(',')[1] || '';
      folder.file(`${n}-${safe}.jpg`, base64, { base64: true });
      manifest.push(`${n}  ${p.name}`);
    });
    zip.file('manifest.txt', manifest.join('\n'));

    const blob = await zip.generateAsync({ type: 'blob' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `impromptu-${state.code}.zip`;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => {
      URL.revokeObjectURL(a.href);
      a.remove();
    }, 1000);
    ID.toast('Exported ' + items.length + ' artworks');
  }

  /* ------------------------------------------------------------ boot */

  async function loadSpace(code) {
    state.code = code;
    state.people.clear();
    state.previews.clear();
    state.thumbs.clear();
    state.order = [];
    state.createdAt = Date.now();
    state.ended = false;
    state.locked = false;
    $('#wall').innerHTML = '';
    $('#codeValue').textContent = code;
    $('#codePill').textContent = 'SPACE ' + code.split('').join(' ');

    const joinUrl = new URL('room.html?c=' + code, location.href).href;
    $('#joinLink').value = joinUrl;
    $('#qrImg').setAttribute('src', ID.qrDataURL(joinUrl));

    // restore anything already collected for this space
    try {
      const saved = await ID.store.all(code);
      saved.forEach((item) => {
        state.order.push(item.id);
        state.people.set(item.id, { id: item.id, name: item.name, status: 'submitted', data: item.data, ts: item.ts });
      });
      if (saved.length) ID.toast('Restored ' + saved.length + ' artworks');
    } catch (err) { /* storage unavailable */ }

    renderWall();
    $('#localNotice').classList.toggle('hidden', !isLocalAddress());
    connect();
  }

  function renderSpaces() {
    const sel = $('#spaceSelect');
    const all = ID.spaces.list();
    sel.innerHTML = '<option value="">Switch space…</option>';
    all.forEach((s) => {
      const opt = document.createElement('option');
      opt.value = s.code;
      opt.textContent = s.code + (s.title ? ' · ' + s.title : '');
      if (s.code === state.code) opt.selected = true;
      sel.appendChild(opt);
    });
  }

  function isLocalAddress() {
    const h = location.hostname;
    return h === 'localhost' || h === '127.0.0.1' || h === '::1'
      || /^10\./.test(h) || /^192\.168\./.test(h) || /^172\.(1[6-9]|2\d|3[01])\./.test(h);
  }

  async function boot() {
    const params = new URLSearchParams(location.search);
    let code = (params.get('c') || params.get('code') || '').toUpperCase();
    if (!/^[A-Z0-9]{6,12}$/.test(code)) code = ID.makeCode(8);
    ID.spaces.add({ code, title: '', createdAt: Date.now() });
    history.replaceState(null, '', 'presenter.html?c=' + code);
    await loadSpace(code);
    renderSpaces();
    timerSet(5 * 60 * 1000);
    setInterval(() => {
      $('#statTime').textContent = ID.fmtClock(Date.now() - state.createdAt);
    }, 1000);
  }

  /* ------------------------------------------------------------ events */

  document.addEventListener('DOMContentLoaded', () => {
    $('#copyCodeBtn').onclick = () => ID.copy(state.code);
    $('#copyLinkBtn').onclick = () => ID.copy($('#joinLink').value);

    $('#spaceSelect').onchange = (e) => {
      const c = e.target.value;
      if (c && c !== state.code) location.href = 'presenter.html?c=' + c;
    };
    $('#newSpaceBtn').onclick = () => {
      const c = ID.makeCode(8);
      ID.spaces.add({ code: c, title: '', createdAt: Date.now() });
      location.href = 'presenter.html?c=' + c;
    };

    $('#manageBtn').onclick = openSpaces;
    $('#closeSpacesBtn').onclick = closeSpaces;
    $('#spacesModal').addEventListener('click', (e) => {
      if (e.target.id === 'spacesModal') closeSpaces();
    });
    $('#deleteBtn').onclick = deleteCurrentSpace;

    $('#exportBtn').onclick = exportZip;
    $('#presentBtn').onclick = () => {
      openLightbox(0, true);
      if (document.documentElement.requestFullscreen) {
        document.documentElement.requestFullscreen().catch(() => {});
      }
    };
    $('#endBtn').onclick = () => {
      if (state.ended) reopenSpace();
      else if (confirm('End this space? Participants will see the gallery.')) endSpace();
    };

    document.querySelectorAll('[data-min]').forEach((btn) => {
      btn.onclick = () => timerSet(Number(btn.dataset.min) * 60 * 1000);
    });
    $('#timerToggle').onclick = timerToggle;
    $('#timerReset').onclick = () => timerSet(timer.duration);

    let t1 = null;
    $('#titleInput').addEventListener('input', (e) => {
      state.title = e.target.value;
      clearTimeout(t1);
      t1 = setTimeout(publishState, 300);
    });

    let t2 = null;
    $('#promptInput').addEventListener('input', (e) => {
      state.prompt = e.target.value;
      clearTimeout(t2);
      t2 = setTimeout(publishState, 300);
    });

    window.addEventListener('beforeunload', () => {
      if (bus && !deletedFlag) bus.publish({ t: 'host-bye' });
    });

    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && !$('#spacesModal').classList.contains('hidden')) closeSpaces();
    });
  });

  boot();
})();
