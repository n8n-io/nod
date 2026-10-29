(() => {
  if (customElements.get('nod-field')) return;
  const reduced = () =>
    !!(window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches);
  const VS = 'attribute vec2 p;void main(){gl_Position=vec4(p,0.,1.);}';
  const FS = `precision highp float;
uniform vec2 uRes,uS;uniform float uDpr,uT,uI,uMA,uCell,uCut,uShape,uAlpha,uDrift,uBreath,uScatter;uniform vec4 uRp[4];uniform vec3 uTr[20];
const float TAU=6.2831853;
float hash(vec2 p){p=fract(p*vec2(123.34,456.21));p+=dot(p,p+45.32);return fract(p.x*p.y);}
float vnoise(vec2 p){vec2 i=floor(p),f=fract(p);f=f*f*(3.-2.*f);return mix(mix(hash(i),hash(i+vec2(1.,0.)),f.x),mix(hash(i+vec2(0.,1.)),hash(i+vec2(1.,1.)),f.x),f.y);}
float ease(float x){x=clamp(x,0.,1.);return x<.5?4.*x*x*x:1.-pow(-2.*x+2.,3.)/2.;}
float nod1(float t){float u=t/.95;if(u<=0.||u>=1.)return 0.;return u<.42?ease(u/.42):1.-ease((u-.42)/.58);}
float env(vec2 q){
 if(uShape<.5){float bot=exp(-(pow((q.x-.5)/.5,2.)+pow(q.y/.36,2.)));float sid=max(exp(-(pow(q.x/.2,2.)+pow(q.y/.6,2.))),exp(-(pow((1.-q.x)/.2,2.)+pow(q.y/.6,2.))));return (bot*.8+sid*.7)*(1.-smoothstep(.4,.72,q.y));}
 if(uShape<1.5)return exp(-(pow((q.x-.5)/.55,2.)+pow(q.y/.3,2.)))*.9;
 return max(exp(-(pow(q.x/.16,2.)+pow((q.y-.2)/.7,2.))),exp(-(pow((1.-q.x)/.16,2.)+pow((q.y-.2)/.7,2.))))*.85;
}
float nodAt(vec2 p){
 float nd=0.;
 for(int i=0;i<20;i++){vec3 tr=uTr[i];float e=uT-tr.z;if(tr.z<0.||e<0.||e>1.)continue;vec2 dd=p-tr.xy;nd=max(nd,exp(-dot(dd,dd)/3000.)*nod1(e)*.35);}
 for(int i=0;i<4;i++){vec4 rp=uRp[i];if(rp.w<=0.)continue;float e=uT-rp.z-length(p-rp.xy)/700.;if(e<0.||e>1.)continue;nd=max(nd,nod1(e)*rp.w);}
 return nd;
}
void main(){
 vec2 f=gl_FragCoord.xy/uDpr;
 vec2 sc=vec2(uS.x,uRes.y-uS.y);
 float s=uCell;vec2 c;float k,G,nd=0.,szv=1.;
 vec2 C;float R=0.;
 if(uShape<.5)C=vec2(uRes.x*(.5+.06*uScatter),-uRes.y*.04);
 else if(uShape<1.5)C=vec2(uRes.x*.5,-uRes.y*.08);
 else if(uShape<2.5)C=f.x<uRes.x*.5?vec2(0.,uRes.y*.3):vec2(uRes.x,uRes.y*.3);
 else{float hc=uRes.x*.4375,sg=uRes.y*.86;R=(hc*hc+sg*sg)/(2.*sg);C=vec2(uRes.x*.5,sg-R);}
 {
  vec2 d=f-C;float r=length(d),th=atan(d.y,d.x);
  k=max(1.,floor(r/s+.5));float rr=k*s;
  float n=floor(TAU*k+.5),a=TAU/n;
  float ph=uShape>2.5?0.:uDrift*uT/rr*(mod(k,2.)<.5?1.:-1.)*mix(1.,.3+1.4*hash(vec2(k,.5)),uScatter);
  float d1=-nodAt(f)*.6*s/rr;
  float j=floor((th-ph-d1)/a+.5);
  float t0=ph+j*a;
  nd=nodAt(C+rr*vec2(cos(t0),sin(t0)));
  float tc=t0-nd*.6*s/rr;
  vec2 idk=vec2(k,mod(j,n));float h1=hash(idk),h2=hash(idk+7.3),h3=hash(idk+13.1);
  float tj=(h1-.5)*a*.4*uScatter,rj=(h2-.5)*s*.4*uScatter;
  c=C+(rr+rj)*vec2(cos(tc+tj),sin(tc+tj));
  vec2 q=c/uRes;
  if(uShape>2.5){
   float band=exp(-pow((rr-R)/s,2.)*.5);
   float a0=atan(R-uRes.y*.86,uRes.x*.4375),a1=3.14159-a0;
   float th_=a1-fract(uT/9.)*(a1-a0);
   float hl=exp(-pow((tc-th_)/.07,2.));
   G=band*(.45+.65*hl)*step(0.,c.y);
  }else{
   G=env(q);
   if(uShape<.5)G*=1.-.5*exp(-pow((c.x-uRes.x*.5)/uCut,2.))*smoothstep(0.,.08,q.y)*(1.-smoothstep(.45,.62,q.y));
   G*=1.-uBreath*.14*(.5+.5*sin(uT*.5-k*.2));
   if(uScatter>0.){
    float nz=vnoise(c/(uRes.x*.16)+vec2(uT*.02,-uT*.014))*.65+vnoise(c/(uRes.x*.06)-vec2(uT*.028,uT*.012))*.35;
    G*=mix(1.,.2+1.15*smoothstep(.15,.85,nz),uScatter);
    G*=mix(1.,step(.22,h3)*.92+.08,uScatter);
    szv=mix(1.,.5+.5*h2,uScatter);
   }
  }
 }
 vec2 ld=f-sc;float lens=exp(-dot(ld,ld)/30000.)*uMA;
 if(uShape<.5)lens*=1.-smoothstep(.45,.78,f.y/uRes.y);
 G=(G+lens*.06)*uI;
 float g=clamp(G,0.,1.);
 float rad=s*(.04+.3*smoothstep(0.,1.,g))*szv;
 float disk=1.-smoothstep(rad-.7,rad+.7,length(f-c));
 float A=disk*smoothstep(.02,.1,G)*uAlpha*.7;
 vec3 col=mix(vec3(1.,.816,.851),vec3(1.,.569,.675),smoothstep(.08,.5,g));
 col=mix(col,vec3(.53,0.,.235),nd*.9);
 float HA=uShape<.5?env(f/uRes)*.05*uI*uAlpha:0.;
 float LA=0.;
 if(uShape<2.5){
  float rl=length(f-C),kl=rl/s,m8=mod(kl+.5,8.)-.5;
  float line=1.-smoothstep(.4,1.,abs(m8)*s);
  float ge=clamp(env(f/uRes)*(uShape<.5?1.:.9),0.,1.);
  LA=line*smoothstep(.04,.3,ge)*(.12+.2*ge)*uAlpha;
  LA*=1.-disk*step(.1,G);
  LA*=mix(1.,.4*smoothstep(.3,.7,vnoise(f/(uRes.x*.2)+vec2(uT*.01,uT*.02))),uScatter);
 }
 vec3 hc=vec3(1.,.569,.675);
 vec3 o=col*A+hc*LA*(1.-A);float oa=A+LA*(1.-A);
 o+=hc*HA*(1.-oa);oa+=HA*(1.-oa);
 gl_FragColor=vec4(o,oa);
}`;
  const SHAPE = { field: 0, glow: 1, sides: 2, arc: 3 };
  const num = (el, a, d) => {
    const v = parseFloat(el.getAttribute(a));
    return isNaN(v) ? d : v;
  };
  function compile(gl, vs, fs) {
    const mk = (type, src) => {
      const s = gl.createShader(type);
      gl.shaderSource(s, src);
      gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) console.warn(gl.getShaderInfoLog(s));
      return s;
    };
    const p = gl.createProgram();
    gl.attachShader(p, mk(gl.VERTEX_SHADER, vs));
    gl.attachShader(p, mk(gl.FRAGMENT_SHADER, fs));
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) console.warn(gl.getProgramInfoLog(p));
    gl.useProgram(p);
    const u = {},
      n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS);
    for (let i = 0; i < n; i++) {
      const nm = gl.getActiveUniform(p, i).name;
      u[nm] = gl.getUniformLocation(p, nm);
    }
    return { p, u };
  }

  class NodField extends HTMLElement {
    static get observedAttributes() {
      return ['intensity', 'shape', 'cell', 'alpha', 'drift', 'breath', 'scatter'];
    }
    connectedCallback() {
      if (this._on) return;
      this._on = true;
      if (!this.style.display) this.style.display = 'block';
      this.time = 8;
      this.m = { x: -1e4, y: -1e4, a: 0, ta: 0 };
      this.sx = null;
      this.sy = null;
      this.rp = [];
      this.rpA = new Float32Array(16);
      this.tr = [];
      this.trA = new Float32Array(60);
      this.trLast = null;
      this._ro = new ResizeObserver(() => this._resize());
      this._ro.observe(this);
      if ('IntersectionObserver' in window) {
        this._io = new IntersectionObserver(
          (es) => {
            this._vis = es.some((e) => e.isIntersecting);
            this._vis ? this._acquire() : this._release();
          },
          { rootMargin: '200px' },
        );
        this._io.observe(this);
      } else {
        this._vis = true;
        this._acquire();
      }
      const host = this.parentElement;
      this._host = host;
      this._pm = (e) => {
        const r = this.getBoundingClientRect(),
          k = this.offsetWidth / (r.width || 1);
        this.m.x = (e.clientX - r.left) * k;
        this.m.y = (e.clientY - r.top) * k;
        this.m.ta = 1;
        const l = this.trLast;
        if (!l || Math.hypot(this.m.x - l.x, this.m.y - l.y) > 4) {
          this.trLast = { x: this.m.x, y: this.m.y, t: this.time };
          this.tr.push(this.trLast);
          if (this.tr.length > 20) this.tr.shift();
        }
      };
      this._pl = () => {
        this.m.ta = 0;
      };
      this._pd = (e) => {
        this._pm(e);
        this.ripple(this.m.x, this.m.y, 1);
      };
      this._nod = (e) => {
        if (!this.h || !e.target.getBoundingClientRect) return;
        const r = this.getBoundingClientRect(),
          g = e.target.getBoundingClientRect(),
          k = this.offsetWidth / (r.width || 1);
        this.ripple((g.left + g.width / 2 - r.left) * k, (g.top + g.height / 2 - r.top) * k, 1);
      };
      if (host) {
        host.addEventListener('pointermove', this._pm);
        host.addEventListener('pointerleave', this._pl);
        host.addEventListener('pointerdown', this._pd);
        if (this.hasAttribute('nod-waves')) host.addEventListener('nod', this._nod);
      }
    }
    ripple(x, y, s) {
      if (reduced() || !this.gl) return;
      this.rp.push({ x, y, t0: this.time, s });
      if (this.rp.length > 4) this.rp.shift();
    }
    _acquire() {
      if (this.gl || !this._on) {
        this._kick();
        return;
      }
      const c = document.createElement('canvas');
      c.setAttribute('aria-hidden', 'true');
      c.style.cssText =
        'position:absolute;inset:0;width:100%;height:100%;display:block;pointer-events:none';
      const gl = c.getContext('webgl', {
        alpha: true,
        premultipliedAlpha: true,
        antialias: false,
        preserveDrawingBuffer: true,
        powerPreference: 'low-power',
      });
      if (!gl) {
        console.warn('nod-field: no WebGL context');
        return;
      }
      c.addEventListener('webglcontextlost', (e) => {
        e.preventDefault();
        if (this._c === c) this._drop();
      });
      this.appendChild(c);
      this._c = c;
      this.gl = gl;
      this.P = compile(gl, VS, FS);
      const b = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, b);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
      const l = gl.getAttribLocation(this.P.p, 'p');
      gl.enableVertexAttribArray(l);
      gl.vertexAttribPointer(l, 2, gl.FLOAT, false, 0, 0);
      this._resize();
      this._kick();
    }
    _drop() {
      cancelAnimationFrame(this._raf);
      this._raf = 0;
      if (this._c) this._c.remove();
      this._c = null;
      this.gl = null;
    }
    _release() {
      if (!this.gl) return;
      const ext = this.gl.getExtension('WEBGL_lose_context');
      this._drop();
      if (ext) ext.loseContext();
    }
    disconnectedCallback() {
      this._on = false;
      this._release();
      if (this._ro) this._ro.disconnect();
      if (this._io) this._io.disconnect();
      const h = this._host;
      if (h) {
        h.removeEventListener('pointermove', this._pm);
        h.removeEventListener('pointerleave', this._pl);
        h.removeEventListener('pointerdown', this._pd);
        h.removeEventListener('nod', this._nod);
      }
    }
    attributeChangedCallback() {
      if (this.w && this.gl) this._draw(0);
    }
    _resize() {
      const w = this.offsetWidth,
        h = this.offsetHeight;
      if (!w || !h || !this.gl) return;
      const dpr = Math.min(1.5, window.devicePixelRatio || 1);
      this.dpr = dpr;
      this.w = w;
      this.h = h;
      this._c.width = Math.round(w * dpr);
      this._c.height = Math.round(h * dpr);
      this.gl.viewport(0, 0, this._c.width, this._c.height);
      this._draw(0);
    }
    _kick() {
      if (this._vis && !this._raf && !reduced() && this.gl && this._c) {
        this._last = performance.now();
        this._raf = requestAnimationFrame((t) => this._tick(t));
      }
    }
    _tick(t) {
      this._raf = 0;
      if (!this.gl || !this._vis) return;
      const dt = Math.min(0.05, (t - this._last) / 1000);
      this._last = t;
      this.time += dt;
      const m = this.m;
      m.a += (m.ta - m.a) * Math.min(1, dt * 4);
      this._draw(dt);
      this._raf = requestAnimationFrame((tt) => this._tick(tt));
    }
    _draw(dt) {
      if (!this.w || !this.gl) return;
      const gl = this.gl,
        u = this.P.u,
        m = this.m;
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
      if (this.sx == null || m.a < 0.02) {
        this.sx = m.x;
        this.sy = m.y;
      } else if (dt > 0) {
        const k = Math.min(1, dt * 10);
        this.sx += (m.x - this.sx) * k;
        this.sy += (m.y - this.sy) * k;
      }
      this.rp = this.rp.filter((r) => this.time - r.t0 < 4);
      this.rpA.fill(0);
      this.rp.forEach((r, i) => this.rpA.set([r.x, r.y, r.t0, r.s], i * 4));
      this.tr = this.tr.filter((r) => this.time - r.t < 1.1);
      this.trA.fill(-1);
      this.tr.forEach((r, i) => this.trA.set([r.x, r.y, r.t], i * 3));
      gl.uniform2f(u.uRes, this.w, this.h);
      gl.uniform1f(u.uDpr, this.dpr);
      gl.uniform1f(u.uT, this.time);
      gl.uniform1f(u.uI, num(this, 'intensity', 1));
      gl.uniform1f(u.uAlpha, num(this, 'alpha', 1));
      gl.uniform1f(u.uMA, m.a);
      gl.uniform2f(u.uS, this.sx, this.sy);
      gl.uniform1f(u.uCell, num(this, 'cell', 8));
      gl.uniform1f(u.uCut, Math.max(160, Math.min(300, this.w * 0.28)));
      gl.uniform1f(u.uDrift, reduced() ? 0 : num(this, 'drift', 3));
      gl.uniform1f(u.uBreath, reduced() ? 0 : num(this, 'breath', 1));
      gl.uniform1f(u.uShape, SHAPE[this.getAttribute('shape')] ?? 0);
      gl.uniform1f(u.uScatter, num(this, 'scatter', 0));
      gl.uniform4fv(u['uRp[0]'], this.rpA);
      gl.uniform3fv(u['uTr[0]'], this.trA);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    }
  }
  customElements.define('nod-field', NodField);
})();
