(() => {
  if (customElements.get('nod-drift-row')) return;
  const reduced = () =>
    !!(window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches);
  const ease = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
  class NodDriftRow extends HTMLElement {
    connectedCallback() {
      if (this._on) return;
      this._on = true;
      Object.assign(this.style, {
        display: 'block',
        touchAction: 'pan-y',
        userSelect: 'none',
        webkitUserSelect: 'none',
        cursor: 'grab',
      });
      if (!this.shadowRoot) {
        const sr = this.attachShadow({ mode: 'open' });
        sr.innerHTML =
          '<style>[data-clones] *,[data-clones] *::before,[data-clones] *::after{box-sizing:border-box}</style><div data-track style="display:flex;width:max-content;will-change:transform"><slot></slot><div data-clones style="display:contents"></div></div>';
      }
      this.track = this.shadowRoot.querySelector('[data-track]');
      this.cl = this.shadowRoot.querySelector('[data-clones]');
      this.track.style.gap = getComputedStyle(this).columnGap || '18px';
      this.rm = reduced();
      this.interval = (+this.getAttribute('interval') || 2800) / 1000;
      this.dur = (+this.getAttribute('duration') || 1400) / 1000;
      this.k = 0;
      this.x = 0;
      this.W = 0;
      this.t = 0;
      this.wait = this.interval;
      this.tw = null;
      this.drag = null;
      this.hover = false;
      this.sp = [];
      this.pv = 0;
      this.a = 0;
      this.v = 0;
      this._mo = new MutationObserver(() => {
        clearTimeout(this._mt);
        this._mt = setTimeout(() => this._clone(), 120);
      });
      this._mo.observe(this, { childList: true });
      if ('ResizeObserver' in window) {
        this._ro = new ResizeObserver(() => this._measure());
        this._ro.observe(this);
        this._ro.observe(this.track);
      }
      this._clone();
      this.addEventListener('pointerenter', () => {
        this.hover = true;
      });
      this.addEventListener('pointerleave', () => {
        this.hover = false;
      });
      this.addEventListener('pointerdown', (e) => {
        if (e.button !== 0) return;
        this.tw = null;
        this.drag = { id: e.pointerId, sx: e.clientX, x0: this.x };
        this.setPointerCapture(e.pointerId);
        this.style.cursor = 'grabbing';
      });
      this.addEventListener('pointermove', (e) => {
        const d = this.drag;
        if (d && e.pointerId === d.id) this.x = d.x0 + (e.clientX - d.sx);
      });
      const end = (e) => {
        if (!this.drag || e.pointerId !== this.drag.id) return;
        const moved = e.clientX - this.drag.sx;
        this.drag = null;
        this.style.cursor = 'grab';
        let k = Math.round((this.off - this.x) / this.S);
        if (Math.abs(moved) > 30 && k === this.k) k += moved < 0 ? 1 : -1;
        this._go(k, 0.9);
      };
      this.addEventListener('pointerup', end);
      this.addEventListener('pointercancel', end);
      this._last = performance.now();
      const tick = (now) => {
        this._tick(now);
        this._raf = requestAnimationFrame(tick);
      };
      this._raf = requestAnimationFrame(tick);
    }
    disconnectedCallback() {
      this._on = false;
      cancelAnimationFrame(this._raf);
      if (this._mo) this._mo.disconnect();
      if (this._ro) this._ro.disconnect();
    }
    _clone() {
      this.cl.replaceChildren();
      const orig = [...this.children];
      for (let k = 0; k < 2; k++)
        orig.forEach((c) => {
          const n = c.cloneNode(true);
          n.querySelectorAll('[data-nod-own]').forEach((s) => s.remove());
          n.setAttribute('data-drift-clone', '');
          n.setAttribute('aria-hidden', 'true');
          n.inert = true;
          this.cl.appendChild(n);
        });
      this._n = orig.length;
      this._measure();
    }
    _measure() {
      const o = this.children[0],
        c = this.cl.children[0];
      if (!o || !c) return;
      this.W = c.getBoundingClientRect().left - o.getBoundingClientRect().left;
      this.S = this.W / this._n;
      this.off = this.clientWidth / 2 - o.offsetWidth / 2 - this.W;
      if (!this.tw && !this.drag) this.x = this.off - this.k * this.S;
    }
    _go(k, dur) {
      this.tw = { from: this.x, to: this.off - k * this.S, t0: this.t, d: dur || this.dur };
      this.k = k;
    }
    _tick(now) {
      const dt = Math.min(0.05, Math.max(0.004, (now - this._last) / 1000));
      this._last = now;
      this.t += dt;
      if (!this.W) this._measure();
      if (!this.W) return;
      let acc = 0;
      if (this.tw) {
        const p = Math.min(1, (this.t - this.tw.t0) / this.tw.d),
          D = this.tw.to - this.tw.from;
        this.x = this.tw.from + D * (0.5 - 0.5 * Math.cos(Math.PI * p));
        acc = (D * 0.5 * Math.PI * Math.PI * Math.cos(Math.PI * p)) / (this.tw.d * this.tw.d);
        if (p >= 1) {
          this.tw = null;
          this.wait = this.interval;
          acc = 0;
        }
      } else if (this.drag) {
        const vx = (this.x - this.pv) / dt;
        acc = Math.max(-5000, Math.min(5000, (vx - this.v) / dt));
        this.v = vx;
      } else if (!this.rm) {
        if (!this.hover) this.wait -= dt;
        if (this.wait <= 0) this._go(this.k + 1);
      }
      if (!this.drag) this.v = 0;
      if (!this.drag && this.k >= this._n) {
        this.k -= this._n;
        this.x += this.W;
        if (this.tw) {
          this.tw.from += this.W;
          this.tw.to += this.W;
        }
      } else if (!this.drag && this.k < 0) {
        this.k += this._n;
        this.x -= this.W;
        if (this.tw) {
          this.tw.from -= this.W;
          this.tw.to -= this.W;
        }
      }
      this.pv = this.x;
      this.track.style.transform = `translate3d(${this.x.toFixed(2)}px,0,0)`;
      if (this.rm) return;
      const kids = [...this.children, ...this.cl.children];
      const n = this._n || 1;
      for (let j = 0; j < n; j++) {
        let s = this.sp[j];
        const el = kids[j];
        if (!el) continue;
        if (!s)
          s = this.sp[j] = {
            ang: +el.getAttribute('data-tilt') || 0,
            vel: 0,
            w: 4.3 + (j % 3) * 0.18,
            c: 2.6 + (j % 2) * 0.3,
            ph: j * 1.7,
          };
        const wind =
          Math.sin(this.t * 0.6 + s.ph) * 0.35 + Math.sin(this.t * 1.5 + s.ph * 2.3) * 0.12;
        const rest = (+el.getAttribute('data-tilt') || 0) + wind;
        const f = -s.w * s.w * (s.ang - rest) - s.c * s.vel + acc * 0.09;
        s.vel += f * dt;
        s.ang = Math.max(-6, Math.min(6, s.ang + s.vel * dt));
        s.tf = `rotate(${s.ang.toFixed(2)}deg)`;
      }
      for (let i = 0; i < kids.length; i++) {
        const s = this.sp[i % n];
        if (!s) continue;
        const el = kids[i];
        if (el.style.transformOrigin !== '50% -20%') el.style.transformOrigin = '50% -20%';
        el.style.transform = s.tf;
      }
    }
  }
  customElements.define('nod-drift-row', NodDriftRow);
})();
