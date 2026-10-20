/* Sketch pad — pointer drawing engine on a fixed-size backing store */
(function () {
  'use strict';

  const WHITE = '#ffffff';
  const TEXT_FONT = '"Segoe UI", system-ui, -apple-system, "Helvetica Neue", "PingFang SC", "Microsoft YaHei", Arial, sans-serif';
  const LINE_H = 1.24;

  /* Greedy wrap that breaks on spaces when the text has any, and falls back to
     breaking between characters so CJK (no spaces) still wraps. */
  function wrapLine(ctx, str, maxWidth) {
    const lines = [];
    let cur = '';
    let breakAt = -1;
    let i = 0;
    while (i < str.length) {
      const ch = str[i];
      if (/\s/.test(ch)) breakAt = cur.length;
      if (cur && ctx.measureText(cur + ch).width > maxWidth) {
        if (breakAt > 0) {
          lines.push(cur.slice(0, breakAt));
          cur = cur.slice(breakAt + 1);
        } else {
          lines.push(cur);
          cur = '';
        }
        breakAt = -1;
        continue;
      }
      cur += ch;
      i += 1;
    }
    if (cur) lines.push(cur);
    return lines.length ? lines : [''];
  }

  class SketchPad {
    constructor(canvas) {
      this.canvas = canvas;
      this.ctx = canvas.getContext('2d');
      this.W = canvas.width;
      this.H = canvas.height;
      this.strokes = [];
      this.current = null;
      this.activePointer = null;
      this.color = '#1f2430';
      this.size = 10;
      this.eraser = false;
      this.locked = false;
      this.textMode = false;
      this.ghost = null;          // live preview of the text being typed
      this.ghostAt = null;        // canvas coords of the pending text anchor
      this.textFontPx = 52;
      this.sel = null;            // the text block currently selected (movable)
      this.drag = null;           // active drag session for the selection
      this.onChange = null;
      this.onStrokeEnd = null;
      this.onTextTap = null;
      this.onSelectText = null;

      this.reset();
      this.bind();
    }

    /* ---------------------------------------------------- state */

    setColor(c) {
      this.color = c;
      this.eraser = false;
    }

    setSize(s) {
      this.size = s;
    }

    setEraser(on) {
      this.eraser = !!on;
      if (on) {
        this.textMode = false;
        this.setGhost(null);
        this.clearSelection();
      }
    }

    setTextMode(on) {
      this.textMode = !!on;
      if (on) this.eraser = false;
      else {
        this.setGhost(null);
        this.clearSelection();
      }
    }

    setTextSize(px) {
      this.textFontPx = px;
      if (this.ghost) this.refreshGhost();
    }

    setLocked(on) {
      this.locked = !!on;
      if (on) {
        this.endStroke();
        this.textMode = false;
        this.setGhost(null);
        this.clearSelection();
      }
    }

    /* ---------------------------------------------------- text */

    layoutText(text, boxW) {
      const ctx = this.ctx;
      const maxW = Math.max(90, boxW || this.W - 60);
      ctx.save();
      ctx.font = '600 ' + this.textFontPx + 'px ' + TEXT_FONT;
      const lines = String(text).split('\n')
        .reduce((acc, para) => acc.concat(wrapLine(ctx, para, maxW)), []);
      ctx.restore();
      return lines;
    }

    /* Measures a laid-out block so it can be hit-tested and dragged. */
    measureText(lines, size) {
      const ctx = this.ctx;
      ctx.save();
      ctx.font = '600 ' + size + 'px ' + TEXT_FONT;
      let w = 0;
      lines.forEach((ln) => {
        w = Math.max(w, ctx.measureText(ln).width);
      });
      ctx.restore();
      return w;
    }

    makeText(text, x, y, boxW) {
      const clean = String(text == null ? '' : text).replace(/[ \t]+$/gm, '');
      if (!clean.trim()) return null;
      const size = this.textFontPx;
      const bw = Math.max(90, boxW || (this.W - 46 - Math.max(14, x)));
      const lines = this.layoutText(clean, bw);
      const height = lines.length * size * LINE_H;
      const item = {
        kind: 'text',
        color: this.color,
        size: size,
        text: clean,
        lines: lines,
        boxW: bw,
        w: this.measureText(lines, size),
        h: height,
        x: Math.max(14, x),
        y: Math.max(14, y),
      };
      this.clampText(item);
      return item;
    }

    /* Keeps a text block fully on the paper. */
    clampText(item) {
      const pad = 14;
      const maxX = this.W - pad - item.w;
      const maxY = this.H - pad - item.h;
      item.x = Math.max(pad, Math.min(item.x, Math.max(pad, maxX)));
      item.y = Math.max(pad, Math.min(item.y, Math.max(pad, maxY)));
    }

    addText(text, x, y) {
      const item = this.makeText(text, x, y);
      if (!item) return false;
      this.strokes.push(item);
      this.selectText(item);
      if (this.onChange) this.onChange();
      if (this.onStrokeEnd) this.onStrokeEnd();
      return true;
    }

    /* ------------------------------------------- selected text (movable) */

    /* Topmost text block under the point, or null. The padding makes the box
       easy to grab with a finger instead of requiring pixel accuracy. */
    hitText(p) {
      const pad = 12;
      for (let i = this.strokes.length - 1; i >= 0; i -= 1) {
        const s = this.strokes[i];
        if (s.kind !== 'text') continue;
        if (p.x >= s.x - pad && p.x <= s.x + s.w + pad &&
            p.y >= s.y - pad && p.y <= s.y + s.h + pad) return s;
      }
      return null;
    }

    selectText(item) {
      this.sel = item || null;
      this.ghost = null;
      this.redraw();
    }

    clearSelection() {
      if (!this.sel && !this.drag) return;
      this.sel = null;
      this.drag = null;
      this.redraw();
    }

    hasSelection() {
      return !!this.sel && this.strokes.indexOf(this.sel) >= 0;
    }

    moveSelectionTo(x, y) {
      const it = this.sel;
      if (!it) return;
      it.x = x;
      it.y = y;
      this.clampText(it);
    }

    deleteSelected() {
      const i = this.strokes.indexOf(this.sel);
      if (i < 0) return false;
      this.strokes.splice(i, 1);
      this.sel = null;
      this.redraw();
      if (this.onChange) this.onChange();
      return true;
    }

    /* Re-writes the selected block, keeping its box width and position. */
    replaceSelectedText(text) {
      const it = this.sel;
      const i = this.strokes.indexOf(it);
      if (i < 0) return false;
      const clean = String(text == null ? '' : text).replace(/[ \t]+$/gm, '');
      if (!clean.trim()) return this.deleteSelected();
      const size = this.textFontPx;
      const lines = this.layoutText(clean, it.boxW);
      it.text = clean;
      it.lines = lines;
      it.size = size;
      it.color = this.color;
      it.w = this.measureText(lines, size);
      it.h = lines.length * size * LINE_H;
      this.clampText(it);
      this.redraw();
      if (this.onChange) this.onChange();
      return true;
    }

    /* Applies the current colour / size to the selected block in place. */
    restyleSelected() {
      const it = this.sel;
      if (!it || this.strokes.indexOf(it) < 0) return false;
      const size = this.textFontPx;
      const lines = this.layoutText(it.text, it.boxW);
      it.size = size;
      it.color = this.color;
      it.lines = lines;
      it.w = this.measureText(lines, size);
      it.h = lines.length * size * LINE_H;
      this.clampText(it);
      this.redraw();
      if (this.onChange) this.onChange();
      return true;
    }

    setGhost(ghost) {
      this.ghost = ghost || null;
      this.redraw();
    }

    /* Re-lays out the pending text after a colour / size change. */
    refreshGhost() {
      const g = this.ghost;
      if (!g || !g.raw) return;
      const item = this.makeText(g.raw, g.x, g.y);
      if (!item) { this.ghost = null; this.redraw(); return; }
      this.ghost = { raw: g.raw, x: g.x, y: g.y, item: item };
      this.redraw();
    }

    setGhostText(raw, x, y) {
      if (arguments.length > 1) {
        this.ghostAt = { x: x, y: y };
      }
      const at = this.ghostAt || { x: 60, y: 60 };
      const item = this.makeText(raw, at.x, at.y);
      this.ghost = item ? { raw: raw, x: at.x, y: at.y, item: item } : null;
      this.redraw();
    }

    reset() {
      this.strokes = [];
      this.sel = null;
      this.drag = null;
      this.redraw();
      if (this.onChange) this.onChange();
    }

    undo() {
      if (!this.strokes.length) return false;
      this.strokes.pop();
      if (this.sel && this.strokes.indexOf(this.sel) < 0) this.sel = null;
      this.redraw();
      if (this.onChange) this.onChange();
      return true;
    }

    isEmpty() {
      return this.strokes.length === 0;
    }

    /* ---------------------------------------------------- render */

    redraw() {
      const ctx = this.ctx;
      ctx.save();
      ctx.fillStyle = WHITE;
      ctx.fillRect(0, 0, this.W, this.H);
      ctx.restore();
      this.strokes.forEach((s) => this.paint(s));
      if (this.ghost && this.ghost.item) {
        ctx.save();
        ctx.globalAlpha = 0.42;
        this.paint(this.ghost.item);
        ctx.restore();
      }
      this.drawSelection();
    }

    /* Dashed frame + corner grips around the movable text block. */
    drawSelection() {
      const it = this.sel;
      if (!it || this.strokes.indexOf(it) < 0) return;
      const ctx = this.ctx;
      const pad = 9;
      const x = it.x - pad;
      const y = it.y - pad;
      const w = Math.max(24, it.w) + pad * 2;
      const h = Math.max(it.size, it.h) + pad * 2;
      ctx.save();
      ctx.lineWidth = 2;
      ctx.strokeStyle = 'rgba(108, 92, 255, .95)';
      ctx.setLineDash([9, 6]);
      ctx.strokeRect(x, y, w, h);
      ctx.setLineDash([]);
      const pts = [
        [x, y], [x + w, y], [x, y + h], [x + w, y + h],
      ];
      ctx.fillStyle = '#6c5cff';
      pts.forEach((p) => {
        ctx.beginPath();
        ctx.arc(p[0], p[1], 5.5, 0, Math.PI * 2);
        ctx.fill();
      });
      ctx.restore();
    }

    /* Runs an export with the selection frame temporarily removed so the
       dashed box never leaks into a submitted artwork or live preview. */
    withoutSelection(fn) {
      const had = this.sel;
      if (had) {
        this.sel = null;
        this.redraw();
      }
      const out = fn();
      if (had) {
        this.sel = had;
        this.redraw();
      }
      return out;
    }

    paint(s) {
      const ctx = this.ctx;
      const color = s.erase ? WHITE : s.color;
      ctx.save();
      ctx.strokeStyle = color;
      ctx.fillStyle = color;
      ctx.lineWidth = s.size;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';

      if (s.kind === 'text') {
        ctx.font = '600 ' + s.size + 'px ' + TEXT_FONT;
        ctx.textAlign = 'left';
        ctx.textBaseline = 'top';
        const lh = s.size * LINE_H;
        (s.lines || []).forEach((ln, i) => {
          if (ln) ctx.fillText(ln, s.x, s.y + i * lh);
        });
        ctx.restore();
        return;
      }

      const pts = s.points;
      if (!pts.length) {
        ctx.restore();
        return;
      }
      if (pts.length === 1) {
        ctx.beginPath();
        ctx.arc(pts[0].x, pts[0].y, s.size / 2, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();
        return;
      }

      ctx.beginPath();
      ctx.moveTo(pts[0].x, pts[0].y);
      for (let i = 1; i < pts.length - 1; i += 1) {
        const mx = (pts[i].x + pts[i + 1].x) / 2;
        const my = (pts[i].y + pts[i + 1].y) / 2;
        ctx.quadraticCurveTo(pts[i].x, pts[i].y, mx, my);
      }
      const last = pts[pts.length - 1];
      ctx.lineTo(last.x, last.y);
      ctx.stroke();
      ctx.restore();
    }

    /* ---------------------------------------------------- input */

    bind() {
      const c = this.canvas;
      let raf = null;
      let draf = null;

      const pos = (e) => {
        const r = c.getBoundingClientRect();
        return {
          x: ((e.clientX - r.left) / r.width) * this.W,
          y: ((e.clientY - r.top) / r.height) * this.H,
        };
      };

      /* Repainting is capped at one pass per frame: touch screens fire pointermove
         far more often than the display refreshes. */
      const flush = () => {
        raf = null;
        if (!this.current) return;
        this.paint(this.current);
        if (this.onChange) this.onChange();
      };
      const schedule = () => {
        if (raf) return;
        raf = requestAnimationFrame(flush);
      };
      const cancelFrame = () => {
        if (raf) cancelAnimationFrame(raf);
        raf = null;
      };

      const addPoint = (e) => {
        if (!this.current) return false;
        const p = pos(e);
        const pts = this.current.points;
        const prev = pts[pts.length - 1];
        if (!prev) {
          pts.push(p);
          return true;
        }
        if (Math.hypot(p.x - prev.x, p.y - prev.y) < 1.1) return false;
        pts.push(p);
        return true;
      };

      c.addEventListener('pointerdown', (e) => {
        if (this.locked) return;
        if (this.activePointer !== null) return;
        if (e.pointerType === 'mouse' && e.button !== 0) return;
        if (this.textMode) {
          const p = pos(e);
          /* Grabbing an existing block wins over starting a new one, so a text
             box can be repositioned by dragging anywhere inside it. */
          const hit = this.hitText(p);
          if (hit) {
            this.sel = hit;
            this.ghost = null;
            this.drag = { id: e.pointerId, ox: p.x - hit.x, oy: p.y - hit.y, moved: false };
            this.activePointer = e.pointerId;
            try { c.setPointerCapture(e.pointerId); } catch (err) { /* older Safari */ }
            this.redraw();
            if (this.onSelectText) this.onSelectText(hit);
            e.preventDefault();
            return;
          }
          if (this.onTextTap) this.onTextTap(p);
          e.preventDefault();
          return;
        }
        this.activePointer = e.pointerId;
        try { c.setPointerCapture(e.pointerId); } catch (err) { /* older Safari */ }
        this.current = {
          color: this.color,
          size: this.size,
          erase: this.eraser,
          points: [pos(e)],
        };
        this.strokes.push(this.current);
        this.paint(this.current);
        e.preventDefault();
      }, { passive: false });

      c.addEventListener('pointermove', (e) => {
        if (this.locked) return;
        if (this.drag && e.pointerId === this.drag.id) {
          const p = pos(e);
          this.drag.moved = true;
          this.moveSelectionTo(p.x - this.drag.ox, p.y - this.drag.oy);
          if (!draf) {
            draf = requestAnimationFrame(() => {
              draf = null;
              this.redraw();
              if (this.onChange) this.onChange();
            });
          }
          e.preventDefault();
          return;
        }
        if (!this.current || e.pointerId !== this.activePointer) return;
        /* Coalesced events recover the points the browser batched between frames,
           which is what makes quick finger strokes look smooth instead of jagged. */
        const batch = typeof e.getCoalescedEvents === 'function' ? e.getCoalescedEvents() : null;
        const list = batch && batch.length ? batch : [e];
        let added = false;
        for (let i = 0; i < list.length; i += 1) {
          if (addPoint(list[i])) added = true;
        }
        if (added) schedule();
        e.preventDefault();
      }, { passive: false });

      const finish = (e) => {
        if (this.drag && e.pointerId === this.drag.id) {
          const moved = this.drag.moved;
          this.drag = null;
          this.activePointer = null;
          if (moved) {
            this.redraw();
            if (this.onStrokeEnd) this.onStrokeEnd();
          }
          e.preventDefault();
          return;
        }
        if (e.pointerId !== this.activePointer) return;
        cancelFrame();
        if (this.current) this.paint(this.current);
        this.endStroke();
        if (this.onStrokeEnd) this.onStrokeEnd();
      };
      c.addEventListener('pointerup', finish);
      c.addEventListener('pointercancel', finish);
      /* Only a mouse "leaves" — a finger that slides past the edge keeps drawing. */
      c.addEventListener('pointerleave', (e) => {
        if (e.pointerType === 'mouse') finish(e);
      });
      c.addEventListener('contextmenu', (e) => e.preventDefault());
    }

    endStroke() {
      this.current = null;
      this.activePointer = null;
      this.drag = null;
    }

    /* ---------------------------------------------------- output */

    exportPNG() {
      return this.withoutSelection(() => this.canvas.toDataURL('image/png'));
    }

    preview(scale, quality) {
      return this.withoutSelection(() => {
        const s = scale || 0.42;
        const tmp = document.createElement('canvas');
        tmp.width = Math.round(this.W * s);
        tmp.height = Math.round(this.H * s);
        const tctx = tmp.getContext('2d');
        tctx.fillStyle = WHITE;
        tctx.fillRect(0, 0, tmp.width, tmp.height);
        tctx.drawImage(this.canvas, 0, 0, tmp.width, tmp.height);
        return tmp.toDataURL('image/jpeg', quality || 0.6);
      });
    }
  }

  window.SketchPad = SketchPad;
})();
