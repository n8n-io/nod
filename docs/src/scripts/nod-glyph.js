(() => {
  if (customElements.get('nod-glyph')) return;
  const TRAVEL = 'cubic-bezier(0.65, 0, 0.35, 1)';
  const reduced = () =>
    !!(window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches);
  const svg = (ink, style, heavy) =>
    `<svg viewBox="0 0 32 32" aria-hidden="true" style="${style}"><circle cx="16" cy="16" r="${heavy ? 8.95 : 10}" fill="none" stroke="${ink}" stroke-width="${heavy ? 6.1 : 4}"/><g data-r><circle data-d cx="25" cy="6" r="4" fill="#ff91ac"/></g></svg>`;

  class NodGlyph extends HTMLElement {
    static get observedAttributes() {
      return ['mood', 'nod-key', 'size', 'ink'];
    }
    connectedCallback() {
      if (!this._built) this._build();
      this._applyMood();
      if (!this._wired) this._wire();
    }
    disconnectedCallback() {
      this._wired = false;
      if (this._io) this._io.disconnect();
      if (this._uh) this._uh();
      clearTimeout(this._t);
      clearTimeout(this._t2);
      clearInterval(this._iv);
    }
    attributeChangedCallback(name, oldV, newV) {
      if (!this._built) return;
      if (name === 'nod-key') {
        if (newV && newV !== oldV) this.nod();
      } else if (name === 'mood') this._applyMood();
      else {
        this._build();
        this._applyMood();
      }
    }
    _host() {
      if (!this._sr) this._sr = this.attachShadow({ mode: 'open' });
      if (!this._root || this._root.parentNode !== this._sr) {
        this._sr.innerHTML = '';
        this._root = document.createElement('span');
        this._sr.appendChild(this._root);
      }
      return this._root;
    }
    _build() {
      const ink = this.getAttribute('ink') || '#191919';
      const host = this._host();
      if (this.hasAttribute('mark')) {
        if (!this.style.display) this.style.display = 'inline-block';
        this.setAttribute('role', 'img');
        this.setAttribute('aria-label', 'nod');
        host.style.display = 'inline';
        host.innerHTML = `<span style="display:inline-block;white-space:nowrap;font-weight:700;letter-spacing:-0.045em;line-height:1;color:${ink}">n${svg(ink, 'display:inline-block;width:0.74em;height:0.74em;vertical-align:-0.1em;margin:0 -0.035em 0 -0.035em;overflow:visible', true)}d</span>`;
      } else {
        const s = this.getAttribute('size') || 24;
        if (!this.style.display) this.style.display = 'inline-block';
        this.style.lineHeight = '0';
        this.style.flex = 'none';
        host.style.display = 'block';
        host.innerHTML = svg(ink, `display:block;width:${s}px;height:${s}px;overflow:visible`);
      }
      this._r = host.querySelector('[data-r]');
      this._d = host.querySelector('[data-d]');
      this._r.style.transformBox = 'view-box';
      this._r.style.transformOrigin = '16px 16px';
      this._d.style.transformBox = 'fill-box';
      this._d.style.transformOrigin = 'center';
      this._m = null;
      this._built = true;
    }
    _applyMood() {
      if (this._m) {
        this._m.cancel();
        this._m = null;
      }
      if (reduced() || !this._r) return;
      const mood = this.getAttribute('mood') || 'still';
      if (mood === 'idle') {
        this._m = this._d.animate(
          [
            { transform: 'scale(1)', opacity: 1 },
            { transform: 'scale(0.78)', opacity: 0.7 },
            { transform: 'scale(1)', opacity: 1 },
          ],
          { duration: 2400, iterations: Infinity, easing: 'ease-in-out' },
        );
      } else if (mood === 'working') {
        this._m = this._r.animate(
          [{ transform: 'rotate(0deg)' }, { transform: 'rotate(360deg)' }],
          { duration: 1400, iterations: Infinity, easing: TRAVEL },
        );
      }
    }
    nod() {
      if (reduced() || !this._r) return;
      if (this._n && this._n.playState === 'running') return;
      const d = +this.getAttribute('nod-depth') || 46;
      const kf = this.hasAttribute('nod-twice')
        ? [
            { transform: 'rotate(0deg)', easing: TRAVEL },
            { transform: `rotate(${d}deg)`, offset: 0.2, easing: TRAVEL },
            { transform: 'rotate(0deg)', offset: 0.44, easing: TRAVEL },
            { transform: `rotate(${d * 0.62}deg)`, offset: 0.62, easing: TRAVEL },
            { transform: 'rotate(0deg)' },
          ]
        : [
            { transform: 'rotate(0deg)', easing: TRAVEL },
            { transform: `rotate(${d}deg)`, offset: 0.42, easing: TRAVEL },
            { transform: 'rotate(0deg)' },
          ];
      this._n = this._r.animate(kf, { duration: this.hasAttribute('nod-twice') ? 1250 : 950 });
      this.dispatchEvent(new CustomEvent('nod', { bubbles: true }));
    }
    _wire() {
      this._wired = true;
      const on = (this.getAttribute('nod-on') || '').split(/\s+/);
      const delay = +this.getAttribute('delay') || 0;
      if (on.includes('load')) this._t = setTimeout(() => this.nod(), delay || 400);
      const every = +this.getAttribute('nod-every');
      if (every) {
        this._iv = setInterval(() => {
          if (!document.hidden) this.nod();
        }, every);
      }
      if (on.includes('view') && 'IntersectionObserver' in window) {
        this._io = new IntersectionObserver(
          (es) => {
            if (es.some((e) => e.isIntersecting)) {
              this._io.disconnect();
              this._t2 = setTimeout(() => this.nod(), delay);
            }
          },
          { threshold: 0.6 },
        );
        this._io.observe(this);
      }
      if (on.includes('hover')) {
        const t = this.closest('a,button') || this.parentElement;
        const h = () => this.nod();
        t.addEventListener('mouseenter', h);
        this._uh = () => t.removeEventListener('mouseenter', h);
      }
    }
  }
  customElements.define('nod-glyph', NodGlyph);

  class NodReveal extends HTMLElement {
    connectedCallback() {
      if (this._w) return;
      this._w = true;
      if (!this.style.display) this.style.display = 'block';
      if (reduced() || !('IntersectionObserver' in window)) return;
      const d = +this.getAttribute('delay') || 0;
      this.style.opacity = '0';
      this.style.transform = 'translateY(8px)';
      const show = () => {
        if (this._s) return;
        this._s = true;
        io.disconnect();
        this.style.transition = `opacity 500ms ease ${d}ms, transform 600ms cubic-bezier(0.2, 0.7, 0.2, 1) ${d}ms`;
        requestAnimationFrame(() =>
          requestAnimationFrame(() => {
            this.style.opacity = '1';
            this.style.transform = 'none';
          }),
        );
      };
      const io = new IntersectionObserver(
        (es) => {
          if (es.some((e) => e.isIntersecting)) show();
        },
        { threshold: 0.15 },
      );
      io.observe(this);
    }
  }
  customElements.define('nod-reveal', NodReveal);
  class NodGrow extends HTMLElement {
    connectedCallback() {
      if (this._w) return;
      this._w = true;
      this.style.display = 'block';
      if (reduced()) return;
      this.style.overflow = 'hidden';
      this.style.height = '0px';
      this.style.opacity = '0';
      this.style.transform = 'translateY(12px)';
      void this.offsetHeight;
      requestAnimationFrame(() => {
        const full = this.scrollHeight;
        this.style.transition =
          'height 620ms cubic-bezier(0.22, 0.8, 0.24, 1), opacity 520ms ease 140ms, transform 620ms cubic-bezier(0.22, 0.8, 0.24, 1)';
        this.style.height = full + 'px';
        this.style.opacity = '1';
        this.style.transform = 'none';
        const done = (e) => {
          if (e.target !== this || e.propertyName !== 'height') return;
          this.style.height = '';
          this.style.overflow = '';
          this.removeEventListener('transitionend', done);
        };
        this.addEventListener('transitionend', done);
      });
    }
  }
  customElements.define('nod-grow', NodGrow);
})();
