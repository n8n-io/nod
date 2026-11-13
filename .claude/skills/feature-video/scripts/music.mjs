import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const [configPath, outPath] = process.argv.slice(2);
if (!configPath || !outPath) {
  console.error('usage: node music.mjs <config.mjs|config.json> <out.wav>');
  process.exit(1);
}
const loaded = configPath.endsWith('.json')
  ? JSON.parse((await import('node:fs')).readFileSync(configPath, 'utf8'))
  : (await import(pathToFileURL(resolve(configPath)).href)).default;
const cfg = {
  bpm: 120,
  dropAt: 4,
  overrides: {},
  kicks: [],
  groove: [],
  introHats: [],
  softHats: [],
  breakdown: [],
  silence: [],
  rolls: [],
  fills: [],
  risers: [],
  impacts: [],
  sfx: [],
  ...loaded,
  mix: {
    kick: 0.78,
    bass: 0.28,
    sub: 0.45,
    impactSub: 0.55,
    lowcut: 48,
    pads: 1,
    arp: 1,
    hats: 1,
    ...(loaded.mix ?? {}),
  },
};

const SR = 44100;
const DUR = cfg.duration;
const N = Math.ceil(SR * DUR);
const TAU = Math.PI * 2;
const BEAT = 60 / cfg.bpm;
const BAR = BEAT * 4;
const STEP = BEAT / 4;

let seed = cfg.seed ?? 7;
const rand = () => {
  seed |= 0;
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const noise = () => rand() * 2 - 1;
const mtof = (m) => 440 * 2 ** ((m - 69) / 12);
const inRanges = (t, ranges) => ranges.some(([a, b]) => t >= a - 1e-6 && t < b - 1e-6);

const bus = () => ({ L: new Float32Array(N), R: new Float32Array(N) });
const drums = bus(),
  music = bus(),
  sfx = bus(),
  verb = bus(),
  echo = bus();

function add(target, t0, mono, gain = 1, pan = 0, right) {
  const start = Math.round(t0 * SR);
  const gl = Math.cos(((pan + 1) * Math.PI) / 4) * gain * Math.SQRT2;
  const gr = Math.sin(((pan + 1) * Math.PI) / 4) * gain * Math.SQRT2;
  const r = right ?? mono;
  for (let i = 0; i < mono.length; i++) {
    const j = start + i;
    if (j < 0 || j >= N) continue;
    target.L[j] += mono[i] * gl;
    target.R[j] += r[i] * gr;
  }
}

function coeffs(type, f, Q) {
  const w = (TAU * Math.min(f, SR * 0.45)) / SR;
  const cos = Math.cos(w);
  const alpha = Math.sin(w) / (2 * Q);
  let b0, b1, b2;
  if (type === 'lp') [b0, b1, b2] = [(1 - cos) / 2, 1 - cos, (1 - cos) / 2];
  else if (type === 'hp') [b0, b1, b2] = [(1 + cos) / 2, -(1 + cos), (1 + cos) / 2];
  else [b0, b1, b2] = [alpha, 0, -alpha];
  const a0 = 1 + alpha;
  return [b0 / a0, b1 / a0, b2 / a0, (-2 * cos) / a0, (1 - alpha) / a0];
}

function filter(x, type, f, Q = 0.707) {
  const fn = typeof f === 'function' ? f : () => f;
  let x1 = 0,
    x2 = 0,
    y1 = 0,
    y2 = 0;
  let c = coeffs(type, fn(0), Q);
  const out = new Float32Array(x.length);
  for (let i = 0; i < x.length; i++) {
    if (i % 32 === 0) c = coeffs(type, fn(i / SR), Q);
    const y = c[0] * x[i] + c[1] * x1 + c[2] * x2 - c[3] * y1 - c[4] * y2;
    x2 = x1;
    x1 = x[i];
    y2 = y1;
    y1 = y;
    out[i] = y;
  }
  return out;
}

const buf = (seconds) => new Float32Array(Math.ceil(seconds * SR));
const saw = (ph) => 2 * (ph - Math.floor(ph + 0.5));

function kick(vel = 1) {
  const x = buf(0.45);
  let ph = 0;
  for (let i = 0; i < x.length; i++) {
    const t = i / SR;
    const f = 56 + 125 * Math.exp(-t / 0.03) + 60 * Math.exp(-t / 0.004);
    ph += (TAU * f) / SR;
    const amp = Math.min(1, t / 0.002) * Math.exp(-t / 0.16);
    x[i] = Math.tanh(1.6 * (Math.sin(ph) * amp + noise() * Math.exp(-t / 0.0015) * 0.35)) * vel;
  }
  return x;
}

function clap(vel = 1) {
  const n = buf(0.45).map(noise);
  const f = filter(filter(n, 'bp', 1150, 0.9), 'hp', 500);
  for (let i = 0; i < f.length; i++) {
    const t = i / SR;
    let e = 0;
    for (const k of [0, 0.011, 0.022]) if (t >= k) e = Math.max(e, Math.exp(-(t - k) / 0.006));
    if (t >= 0.03) e = Math.max(e, 0.75 * Math.exp(-(t - 0.03) / 0.1));
    f[i] *= e * vel * 2.2;
  }
  return f;
}

function snare(vel = 1) {
  const x = buf(0.3);
  const n = filter(x.map(noise), 'bp', 2600, 0.6);
  let ph = 0;
  for (let i = 0; i < x.length; i++) {
    const t = i / SR;
    ph += (TAU * (200 - 40 * Math.min(1, t / 0.05))) / SR;
    x[i] = (n[i] * 1.6 * Math.exp(-t / 0.085) + Math.sin(ph) * 0.45 * Math.exp(-t / 0.04)) * vel;
  }
  return x;
}

function hat(vel = 1, open = false) {
  const n = filter(filter(buf(open ? 0.38 : 0.09).map(noise), 'hp', 7800, 0.8), 'hp', 6000);
  for (let i = 0; i < n.length; i++) n[i] *= Math.exp(-(i / SR) / (open ? 0.12 : 0.022)) * vel;
  return n;
}

function bassNote(midi, dur) {
  const f = mtof(midi);
  const x = buf(dur + 0.08);
  let p = 0;
  for (let i = 0; i < x.length; i++) {
    const t = i / SR;
    p += f / SR;
    const env = Math.min(1, t / 0.004) * (t > dur ? Math.exp(-(t - dur) / 0.02) : 1);
    x[i] = (saw(p) * 0.65 + Math.sin(TAU * p) * cfg.mix.sub) * env;
  }
  return filter(x, 'lp', (t) => 300 + 1300 * Math.exp(-t / 0.07), 1.3).map((v) =>
    Math.tanh(v * 1.4),
  );
}

function supersaw(
  notes,
  dur,
  {
    attack = 0.01,
    release = 0.2,
    cutoff = 2500,
    envAmt = 0,
    envTime = 0.15,
    voices = 5,
    detune = 0.12,
    cut,
  } = {},
) {
  const len = dur + release + 0.05;
  const L = buf(len),
    R = buf(len);
  for (const m of notes) {
    for (let v = 0; v < voices; v++) {
      const spread = voices === 1 ? 0 : (v / (voices - 1)) * 2 - 1;
      const f = mtof(m + spread * detune);
      let p = rand();
      const pan = spread * 0.8;
      const gl = Math.cos(((pan + 1) * Math.PI) / 4),
        gr = Math.sin(((pan + 1) * Math.PI) / 4);
      for (let i = 0; i < L.length; i++) {
        p += f / SR;
        const s = saw(p);
        L[i] += s * gl;
        R[i] += s * gr;
      }
    }
  }
  const scale = 1 / Math.sqrt(notes.length * voices);
  const fc = cut ?? ((t) => cutoff * (1 + envAmt * Math.exp(-t / envTime)));
  const lf = filter(L, 'lp', fc, 0.9),
    rf = filter(R, 'lp', fc, 0.9);
  for (let i = 0; i < L.length; i++) {
    const t = i / SR;
    const env = Math.min(1, t / attack) * (t > dur ? Math.exp(-(t - dur) / (release / 3)) : 1);
    lf[i] *= env * scale;
    rf[i] *= env * scale;
  }
  return [lf, rf];
}

function pluck(midi, bright = 1) {
  const f = mtof(midi);
  const x = buf(0.45);
  let p = rand();
  for (let i = 0; i < x.length; i++) {
    p += f / SR;
    x[i] = (saw(p) * 0.5 + (saw(p) - saw(p + 0.5)) * 0.5) * Math.exp(-(i / SR) / 0.16);
  }
  return filter(x, 'lp', (t) => 500 + 4200 * bright * Math.exp(-t / 0.07), 1.2);
}

function riser(dur) {
  const y = filter(buf(dur).map(noise), 'bp', (t) => 300 * 30 ** (t / dur), 1.8);
  let p = 0;
  for (let i = 0; i < y.length; i++) {
    const k = i / y.length;
    p += (180 * 6 ** k) / SR;
    y[i] = (y[i] * 2.4 + saw(p) * 0.08 * k) * k * k;
  }
  return y;
}

function impact() {
  const x = buf(2.2);
  let p = 0;
  const n = filter(buf(2.2).map(noise), 'hp', 2800, 0.7);
  for (let i = 0; i < x.length; i++) {
    const t = i / SR;
    p += (40 + 45 * Math.exp(-t / 0.08)) / SR;
    x[i] =
      Math.tanh(1.4 * Math.sin(TAU * p) * Math.exp(-t / 0.4)) * cfg.mix.impactSub +
      n[i] * 0.6 * Math.exp(-t / 0.5);
  }
  return x;
}

function pop(freq, len = 0.22) {
  const x = buf(len);
  let p = 0;
  for (let i = 0; i < x.length; i++) {
    const t = i / SR;
    p += (freq * (1 + 0.9 * Math.exp(-t / 0.012))) / SR;
    x[i] =
      (Math.sin(TAU * p) + 0.18 * Math.sin(2 * TAU * p)) *
      Math.min(1, t / 0.002) *
      Math.exp(-t / 0.055);
  }
  return x;
}

function tick(freq = 2200) {
  const x = buf(0.05);
  for (let i = 0; i < x.length; i++) {
    const t = i / SR;
    x[i] =
      Math.sin(TAU * freq * t) * Math.exp(-t / 0.008) * 0.6 + noise() * Math.exp(-t / 0.0018) * 0.5;
  }
  return filter(x, 'hp', 900);
}

function mouseClick() {
  const x = buf(0.06);
  for (let i = 0; i < x.length; i++) {
    const t = i / SR;
    x[i] =
      noise() * Math.exp(-t / 0.003) * 0.8 + Math.sin(TAU * 1500 * t) * Math.exp(-t / 0.01) * 0.4;
  }
  return filter(x, 'bp', 2800, 0.8);
}

function whoosh(dur) {
  const y = filter(
    buf(dur).map(noise),
    'bp',
    (t) => 350 + 2600 * Math.sin(Math.PI * Math.min(1, t / dur)) ** 1.5,
    0.9,
  );
  for (let i = 0; i < y.length; i++) y[i] *= Math.sin(Math.PI * (i / y.length)) ** 2 * 1.6;
  return y;
}

function bell(freq, len = 0.9) {
  const x = buf(len);
  for (let i = 0; i < x.length; i++) {
    const t = i / SR;
    x[i] =
      (Math.sin(TAU * freq * t) +
        0.35 * Math.sin(TAU * freq * 2.01 * t) * Math.exp(-t / 0.15) +
        0.12 * Math.sin(TAU * freq * 3 * t) * Math.exp(-t / 0.08)) *
      Math.min(1, t / 0.003) *
      Math.exp(-t / 0.35);
  }
  return x;
}

const chordAt = (bar) => {
  const name =
    cfg.overrides[String(bar * BAR)] ??
    cfg.progression[
      (((bar - Math.round(cfg.dropAt / BAR)) % cfg.progression.length) + cfg.progression.length) %
        cfg.progression.length
    ];
  const chord = cfg.chords[name];
  if (!chord) throw new Error(`Chord ${name} is not defined in chords`);
  return chord;
};
const end = cfg.final?.time ?? DUR;
const groove = (t) => inRanges(t, cfg.groove);

const kicks = [];
for (const [a, b, v = 1] of cfg.kicks) for (let t = a; t < b - 1e-6; t += BEAT) kicks.push([t, v]);
if (cfg.final) kicks.push([cfg.final.time, 1]);
for (const [t, v] of kicks) add(drums, t, kick(v), cfg.mix.kick);
const sc = new Float32Array(N).fill(1);
for (const [t] of kicks) {
  const s = Math.round(t * SR);
  for (let i = 0; i < 0.3 * SR && s + i < N; i++)
    sc[s + i] = Math.min(sc[s + i], 0.32 + 0.68 * (i / (0.3 * SR)) ** 1.4);
}

for (let t = 0; t < end - 1e-6; t += STEP) {
  const s = Math.round((t % BAR) / STEP);
  if (groove(t)) {
    if (s === 4 || s === 12) {
      add(drums, t, clap(0.9), 0.5, 0.05);
      add(verb, t, clap(0.9), 0.18);
    }
    if (s % 4 === 2) add(drums, t, hat(0.9, true), 0.18 * cfg.mix.hats, 0.25);
    else add(drums, t, hat(s % 2 ? 0.45 : 0.75), 0.27 * cfg.mix.hats, -0.2);
  } else if (inRanges(t, cfg.introHats) && s % 2 === 0)
    add(drums, t, hat(s % 4 === 2 ? 0.8 : 0.4), 0.17 * cfg.mix.hats, -0.2);
  else if (inRanges(t, cfg.softHats) && s % 2 === 1)
    add(drums, t, hat(0.5), 0.13 * cfg.mix.hats, -0.2);
}

for (const [from, to, gain = 0.42] of cfg.rolls) {
  for (let t = from; t < to - 1e-6;) {
    const k = (t - from) / (to - from);
    add(drums, t, snare(0.35 + 0.65 * k), gain * (0.45 + 0.55 * k), 0.1);
    add(verb, t, snare(0.5), 0.1 * k);
    t += k < 0.5 ? STEP : k < 0.8 ? STEP / 2 : STEP / 4;
  }
}
for (const t of cfg.fills) for (let i = 0; i < 4; i++) add(drums, t + i * STEP, snare(0.6), 0.25);

const bars = Math.ceil(end / BAR);
for (let bar = 0; bar < bars; bar++) {
  const t0 = bar * BAR;
  const ch = chordAt(bar);
  const intro = t0 < cfg.dropAt;
  const breakdown = inRanges(t0, cfg.breakdown);
  const barLen = Math.min(BAR, end - t0);
  const cutStart = intro ? 600 + (t0 / Math.max(cfg.dropAt, 1)) * 2000 : breakdown ? 1400 : 2800;
  const cutEnd = intro ? 1100 + (t0 / Math.max(cfg.dropAt, 1)) * 2600 : breakdown ? 3600 : 2800;
  const [pl, pr] = supersaw(ch.notes, barLen, {
    attack: intro ? 0.25 : 0.02,
    release: 0.25,
    cut: (t) => cutStart + (cutEnd - cutStart) * Math.min(1, t / BAR),
  });
  add(music, t0, pl, (intro ? 0.34 : breakdown ? 0.5 : 0.3) * cfg.mix.pads, 0, pr);
  const [hl, hr] = supersaw(
    ch.notes.map((m) => m + 12),
    barLen,
    { attack: 0.3, release: 0.4, cutoff: intro ? 1500 : 4200, voices: 3, detune: 0.18 },
  );
  add(music, t0, hl, (intro ? 0.07 : breakdown ? 0.16 : 0.11) * cfg.mix.pads, 0, hr);
  const arpNotes = [...ch.notes.map((m) => m + 12), ch.notes[0] + 24];
  const pattern = [0, 2, 1, 3, 2, 4, 3, 1, 0, 2, 1, 3, 2, 4, 3, 2];
  for (let s = 0; s < 16; s++) {
    const t = t0 + s * STEP;
    if (t >= end - 1e-6 || inRanges(t, cfg.silence)) continue;
    const bright = intro
      ? 0.2 + 0.45 * (t / Math.max(cfg.dropAt, 1))
      : breakdown || !groove(t)
        ? 0.55
        : 0.85;
    const note = pluck(arpNotes[pattern[s]], bright);
    add(music, t, note, (breakdown ? 0.17 : 0.12) * cfg.mix.arp, s % 2 ? 0.3 : -0.3);
    add(echo, t, note, 0.05 * cfg.mix.arp);
  }
  for (const off of [1, 3, 5, 7]) {
    const t = t0 + off * (BEAT / 2);
    if (groove(t)) add(music, t, bassNote(ch.bass, 0.17), cfg.mix.bass);
  }
}

if (cfg.final) {
  const [fl, fr] = supersaw(cfg.final.chord, 0.15, {
    release: 1.6,
    cutoff: 3000,
    envAmt: 1.5,
    envTime: 0.3,
  });
  add(music, cfg.final.time, fl, 0.42, 0, fr);
  add(verb, cfg.final.time, fl, 0.3);
  add(music, cfg.final.time, bassNote(cfg.final.bass, 0.6), cfg.mix.bass * 1.1);
  add(drums, cfg.final.time, impact(), 0.45);
}
for (const [t, d, g = 0.32] of cfg.risers) add(sfx, t, riser(d), g);
for (const [t, g] of cfg.impacts) {
  add(drums, t, impact(), g);
  add(verb, t, impact(), g / 3);
}

const pick = (list, i) => list[i % list.length];
for (const e of cfg.sfx) {
  const g = e.gain ?? 0.2,
    pan = e.pan ?? 0;
  const place = (t, sound, gain = g, p = pan) => {
    add(sfx, t, sound, gain, p);
    if (e.verb) add(verb, t, sound, e.verb);
  };
  if (e.type === 'pop') place(e.t, pop(e.freq ?? 880, e.len ?? 0.22));
  else if (e.type === 'tick') place(e.t, tick(e.freq ?? 2200));
  else if (e.type === 'click') place(e.t, mouseClick());
  else if (e.type === 'enter') {
    place(e.t, mouseClick());
    place(e.t, pop(240, 0.12), g * 0.6);
  } else if (e.type === 'whoosh') place(e.t, whoosh(e.dur ?? 0.45), e.gain ?? 0.17);
  else if (e.type === 'chime')
    (e.notes ?? [880, 1046.5, 1396.9]).forEach((f, i) =>
      place(e.t + i * 0.08, bell(f), e.gain ?? 0.13),
    );
  else if (e.type === 'pops')
    (e.times ?? []).forEach((t, i) =>
      place(
        t,
        pop(pick(e.freqs ?? [880], i), e.len ?? 0.2),
        g,
        e.alternate ? (i % 2 ? pan : -pan) : pan,
      ),
    );
  else if (e.type === 'ticks')
    (e.times ?? []).forEach((t, i) => place(t, tick(pick(e.freqs ?? [2400], i)), g));
  else if (e.type === 'type') {
    const text = e.text ?? '';
    for (let k = 1; k <= text.length; k++) {
      if (text[k - 1] === ' ' && rand() < 0.5) continue;
      place(
        e.from + (k / text.length) * (e.to - e.from) - 0.01,
        tick(1800 + rand() * 900),
        e.gain ?? 0.07,
        rand() * 0.4 - 0.2,
      );
    }
  } else throw new Error(`Unknown sfx type ${e.type}`);
}

function reverb(input, wet) {
  const combs = [1116, 1188, 1277, 1356, 1422, 1491, 1557, 1617];
  const aps = [556, 441, 341, 225];
  const run = (x, offset) => {
    const out = new Float32Array(N);
    for (const d0 of combs) {
      const d = d0 + offset,
        line = new Float32Array(d);
      let idx = 0,
        lp = 0;
      for (let i = 0; i < N; i++) {
        const y = line[idx];
        lp = y * 0.75 + lp * 0.25;
        line[idx] = x[i] + lp * 0.83;
        idx = (idx + 1) % d;
        out[i] += y / combs.length;
      }
    }
    for (const d0 of aps) {
      const d = d0 + offset,
        line = new Float32Array(d);
      let idx = 0;
      for (let i = 0; i < N; i++) {
        const b = line[idx];
        const y = -out[i] + b;
        line[idx] = out[i] + b * 0.5;
        idx = (idx + 1) % d;
        out[i] = y;
      }
    }
    return out;
  };
  const mono = new Float32Array(N);
  for (let i = 0; i < N; i++) mono[i] = (input.L[i] + input.R[i]) * 0.5;
  return { L: run(mono, 0).map((v) => v * wet), R: run(mono, 23).map((v) => v * wet) };
}

function pingpong(input, time, fb) {
  const d = Math.round(time * SR);
  const L = new Float32Array(N),
    R = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    const inL = (input.L[i] + input.R[i]) * 0.5;
    L[i] = inL + (i >= d ? R[i - d] : 0) * fb;
    R[i] = (i >= d ? L[i - d] : 0) * fb;
  }
  return { L: filter(L, 'lp', 3500), R: filter(R, 'lp', 3500) };
}

for (let i = 0; i < N; i++) {
  verb.L[i] += music.L[i] * 0.12;
  verb.R[i] += music.R[i] * 0.12;
}
const rv = reverb(verb, 0.9);
const dl = pingpong(echo, BEAT * 0.75, 0.42);
const outL = new Float32Array(N),
  outR = new Float32Array(N);
for (let i = 0; i < N; i++) {
  outL[i] = drums.L[i] + (music.L[i] + dl.L[i]) * sc[i] + sfx.L[i] + rv.L[i];
  outR[i] = drums.R[i] + (music.R[i] + dl.R[i]) * sc[i] + sfx.R[i] + rv.R[i];
}
const hpL = filter(filter(outL, 'hp', cfg.mix.lowcut), 'hp', cfg.mix.lowcut);
const hpR = filter(filter(outR, 'hp', cfg.mix.lowcut), 'hp', cfg.mix.lowcut);
let peak = 0;
for (let i = 0; i < N; i++) peak = Math.max(peak, Math.abs(hpL[i]), Math.abs(hpR[i]));
const drive = 1.4,
  fadeStart = (DUR - 0.6) * SR;
const pcm = Buffer.alloc(N * 4);
for (let i = 0; i < N; i++) {
  const fade = i > fadeStart ? Math.max(0, 1 - (i - fadeStart) / (0.6 * SR)) : 1;
  const l = (Math.tanh((hpL[i] / peak) * drive) / Math.tanh(drive)) * 0.95 * fade;
  const r = (Math.tanh((hpR[i] / peak) * drive) / Math.tanh(drive)) * 0.95 * fade;
  pcm.writeInt16LE(Math.round(l * 32767), i * 4);
  pcm.writeInt16LE(Math.round(r * 32767), i * 4 + 2);
}
const header = Buffer.alloc(44);
header.write('RIFF', 0);
header.writeUInt32LE(36 + pcm.length, 4);
header.write('WAVE', 8);
header.write('fmt ', 12);
header.writeUInt32LE(16, 16);
header.writeUInt16LE(1, 20);
header.writeUInt16LE(2, 22);
header.writeUInt32LE(SR, 24);
header.writeUInt32LE(SR * 4, 28);
header.writeUInt16LE(4, 32);
header.writeUInt16LE(16, 34);
header.write('data', 36);
header.writeUInt32LE(pcm.length, 40);
writeFileSync(outPath, Buffer.concat([header, pcm]));
console.log(`wrote ${outPath} (${DUR}s)`);
