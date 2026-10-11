/*
 * Live Tower Battle — procedural audio engine.
 *
 * All sound is synthesized with the Web Audio API (no audio files, no assets to
 * host, no licensing issues): a small synthwave loop for ambience, dramatic SFX
 * for hits/crits/bursts, a victory fanfare and UI chimes.
 *
 * Browsers only allow audio after a user gesture, so the engine stays silent
 * until unlock() is called from a click/keypress listener (game.js does this).
 * Everything degrades to silence if Web Audio is unavailable.
 *
 * API (window.LTBAudio):
 *   unlock()          create/resume context, start the music scheduler
 *   setMuted(bool)    ramp the master gain
 *   musicMode(m)      'normal' | 'sd' | 'ended'
 *   hit(power)        tower hit, power 0..1
 *   crit()            critical hit
 *   explosion()       tower burst
 *   like()            like burst pop
 *   gift()            gift thank-you ding
 *   powerOn()         power mode started
 *   powerOff()        power mode expired
 *   comboFull()       team chain completed
 *   suddenDeath()     sudden death alarm
 *   fanfare()         match-end fanfare
 *   resetChime()      new match chime
 *   coin()            bonus pool win
 *   vip()             VIP supporter chime
 */
(function () {
  'use strict';

  const api = {
    unlocked: false,
  };

  let ctx = null;
  let master = null;
  let sfxBus = null;
  let musicBus = null;
  let noiseBuf = null;
  let muted = false;

  // ---------------- music scheduler ----------------
  const BPM = 106;
  const SPB = 60 / BPM; // seconds per beat
  const STEP = SPB / 4; // sixteenth note
  const LOOKAHEAD = 0.1; // seconds scheduled ahead
  const SCHED_MS = 25; // scheduler tick
  let schedTimer = null;
  let nextStepTime = 0;
  let stepIndex = 0;
  let musicMode = 'normal'; // 'normal' | 'sd' | 'ended'
  let pendingMusicMode = null;
  let drone = null;

  // 4-bar loop in A minor: Am, F, C, G
  const CHORDS = [
    { bass: 45, pad: [45, 48, 52], arp: [57, 60, 64, 69] }, // Am
    { bass: 41, pad: [41, 45, 48], arp: [53, 57, 60, 65] }, // F
    { bass: 36, pad: [48, 52, 55], arp: [55, 60, 64, 67] }, // C
    { bass: 31, pad: [43, 47, 50], arp: [55, 59, 62, 67] }, // G
  ];
  const BASS_N = [0, -1, 0, -1, 12, -1, 0, -1, 0, -1, 0, -1, 12, -1, 0, -1];
  const BASS_SD = [0, 12, 0, 12, 0, 12, 0, 12, 0, 12, 0, 12, 0, 12, 0, 12];
  const ARP_PAT = [0, 1, 2, 3, 2, 3, 1, 2, 0, 1, 2, 3, 2, 1, 3, 2];
  const KICK_PAT = [1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0];
  const SNARE_PAT = [0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0];
  const HAT_N = [0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0];
  const HAT_SD = [0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1];

  function freq(midi) {
    return 440 * Math.pow(2, (midi - 69) / 12);
  }

  function makeNoiseBuffer() {
    const len = Math.floor(ctx.sampleRate * 1);
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    return buf;
  }

  function noiseSrc(t, dur) {
    const s = ctx.createBufferSource();
    s.buffer = noiseBuf;
    s.loop = true;
    s.start(t);
    s.stop(t + dur + 0.05);
    return s;
  }

  // ---- instruments (all target musicBus unless told otherwise) ----

  function padChord(tones, t, dur) {
    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = musicMode === 'sd' ? 2200 : 1100;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(musicMode === 'sd' ? 0.075 : 0.055, t + 0.5);
    g.gain.setValueAtTime(musicMode === 'sd' ? 0.075 : 0.055, t + dur - 0.6);
    g.gain.linearRampToValueAtTime(0.0001, t + dur);
    filter.connect(g);
    g.connect(musicBus);
    for (let i = 0; i < tones.length; i++) {
      for (let d = 0; d < 2; d++) {
        const o = ctx.createOscillator();
        o.type = 'sawtooth';
        o.frequency.value = freq(tones[i]);
        o.detune.value = d === 0 ? -5 : 5;
        o.connect(filter);
        o.start(t);
        o.stop(t + dur + 0.05);
      }
    }
  }

  function bassNote(midi, t, dur) {
    const o = ctx.createOscillator();
    o.type = 'triangle';
    o.frequency.value = freq(midi);
    const o2 = ctx.createOscillator();
    o2.type = 'sine';
    o2.frequency.value = freq(midi - 12);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(0.16, t + 0.006);
    g.gain.exponentialRampToValueAtTime(0.05, t + dur * 0.7);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    const g2 = ctx.createGain();
    g2.gain.value = 0.5;
    o.connect(g);
    o2.connect(g2);
    g2.connect(g);
    g.connect(musicBus);
    o.start(t);
    o.stop(t + dur + 0.05);
    o2.start(t);
    o2.stop(t + dur + 0.05);
  }

  function arpNote(midi, t) {
    const o = ctx.createOscillator();
    o.type = 'square';
    o.frequency.value = freq(midi);
    const f = ctx.createBiquadFilter();
    f.type = 'lowpass';
    f.frequency.value = 3200;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(0.032, t + 0.004);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.13);
    o.connect(f);
    f.connect(g);
    g.connect(musicBus);
    o.start(t);
    o.stop(t + 0.16);
  }

  function kick(t) {
    const o = ctx.createOscillator();
    o.type = 'sine';
    o.frequency.setValueAtTime(150, t);
    o.frequency.exponentialRampToValueAtTime(42, t + 0.12);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.4, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.2);
    o.connect(g);
    g.connect(musicBus);
    o.start(t);
    o.stop(t + 0.22);
  }

  function snare(t) {
    const n = noiseSrc(t, 0.18);
    const f = ctx.createBiquadFilter();
    f.type = 'bandpass';
    f.frequency.value = 1800;
    f.Q.value = 0.9;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.22, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.16);
    n.connect(f);
    f.connect(g);
    g.connect(musicBus);
    const o = ctx.createOscillator();
    o.type = 'sine';
    o.frequency.value = 190;
    const g2 = ctx.createGain();
    g2.gain.setValueAtTime(0.12, t);
    g2.gain.exponentialRampToValueAtTime(0.001, t + 0.07);
    o.connect(g2);
    g2.connect(musicBus);
    o.start(t);
    o.stop(t + 0.08);
  }

  function hat(t, open) {
    const n = noiseSrc(t, open ? 0.25 : 0.05);
    const f = ctx.createBiquadFilter();
    f.type = 'highpass';
    f.frequency.value = 7500;
    const g = ctx.createGain();
    g.gain.setValueAtTime(open ? 0.12 : 0.09, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + (open ? 0.24 : 0.045));
    n.connect(f);
    f.connect(g);
    g.connect(musicBus);
  }

  function startDrone() {
    if (drone || !ctx) return;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, ctx.currentTime);
    g.gain.linearRampToValueAtTime(0.05, ctx.currentTime + 0.8);
    const f = ctx.createBiquadFilter();
    f.type = 'lowpass';
    f.frequency.value = 220;
    f.connect(g);
    g.connect(musicBus);
    const oscs = [];
    [33, 34].forEach(function (m) {
      const o = ctx.createOscillator();
      o.type = 'sawtooth';
      o.frequency.value = freq(m);
      o.connect(f);
      o.start();
      oscs.push(o);
    });
    drone = { g: g, oscs: oscs, f: f };
  }

  function stopDrone() {
    if (!drone || !ctx) return;
    const d = drone;
    drone = null;
    try {
      d.g.gain.cancelScheduledValues(ctx.currentTime);
      d.g.gain.setValueAtTime(d.g.gain.value, ctx.currentTime);
      d.g.gain.linearRampToValueAtTime(0.0001, ctx.currentTime + 0.6);
      d.oscs.forEach(function (o) {
        o.stop(ctx.currentTime + 0.7);
      });
    } catch (e) {}
  }

  function scheduleStep(step, t) {
    if (musicMode === 'ended') return;
    const sd = musicMode === 'sd';
    const bar = Math.floor(step / 16) % CHORDS.length;
    const s16 = step % 16;
    const ch = CHORDS[bar];

    if (s16 === 0) padChord(ch.pad, t, SPB * 4);

    const bp = sd ? BASS_SD : BASS_N;
    if (bp[s16] >= 0) bassNote(ch.bass + bp[s16], t, STEP * (sd ? 0.9 : 0.92));

    arpNote(ch.arp[ARP_PAT[s16]], t);

    const kp = KICK_PAT;
    if (kp[s16]) kick(t);
    if (SNARE_PAT[s16]) snare(t);
    const hp = sd ? HAT_SD : HAT_N;
    if (hp[s16]) hat(t, !sd && s16 === 14);
  }

  function startScheduler() {
    if (schedTimer) return;
    nextStepTime = ctx.currentTime + 0.15;
    stepIndex = 0;
    schedTimer = setInterval(function () {
      if (!ctx) return;
      if (nextStepTime < ctx.currentTime) nextStepTime = ctx.currentTime + 0.05;
      while (nextStepTime < ctx.currentTime + LOOKAHEAD) {
        scheduleStep(stepIndex, nextStepTime);
        nextStepTime += STEP;
        stepIndex++;
      }
    }, SCHED_MS);
    if (typeof schedTimer.unref === 'function') schedTimer.unref();
  }

  // ---------------- SFX helpers ----------------

  const lastPlay = Object.create(null);
  function canPlay(name, ms) {
    const n = performance.now();
    if (lastPlay[name] && n - lastPlay[name] < ms) return false;
    lastPlay[name] = n;
    return true;
  }

  function sfx(dest) {
    return dest || sfxBus;
  }

  function tone(opts) {
    // opts: type, f0, f1?, t (start, default now), dur, peak, sus?, dest
    const t0 = opts.t != null ? opts.t : ctx.currentTime;
    const o = ctx.createOscillator();
    o.type = opts.type || 'sine';
    o.frequency.setValueAtTime(opts.f0, t0);
    if (opts.f1) o.frequency.exponentialRampToValueAtTime(Math.max(20, opts.f1), t0 + opts.dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.linearRampToValueAtTime(opts.peak, t0 + (opts.attack || 0.005));
    if (opts.sus != null) {
      g.gain.setValueAtTime(opts.peak, t0 + opts.dur - 0.05);
    }
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + opts.dur);
    let node = o;
    if (opts.filter) {
      const f = ctx.createBiquadFilter();
      f.type = opts.filter.type;
      f.frequency.setValueAtTime(opts.filter.f0, t0);
      if (opts.filter.f1) f.frequency.exponentialRampToValueAtTime(opts.filter.f1, t0 + opts.dur);
      if (opts.filter.q) f.Q.value = opts.filter.q;
      o.connect(f);
      node = f;
    }
    node.connect(g);
    g.connect(sfx(opts.dest));
    o.start(t0);
    o.stop(t0 + opts.dur + 0.05);
  }

  function burst(opts) {
    // noise burst: t, dur, peak, filter {type,f0,f1?,q?}
    const t0 = opts.t != null ? opts.t : ctx.currentTime;
    const n = noiseSrc(t0, opts.dur);
    const f = ctx.createBiquadFilter();
    f.type = (opts.filter && opts.filter.type) || 'lowpass';
    f.frequency.setValueAtTime((opts.filter && opts.filter.f0) || 4000, t0);
    if (opts.filter && opts.filter.f1) f.frequency.exponentialRampToValueAtTime(opts.filter.f1, t0 + opts.dur);
    if (opts.filter && opts.filter.q) f.Q.value = opts.filter.q;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.linearRampToValueAtTime(opts.peak, t0 + (opts.attack || 0.004));
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + opts.dur);
    n.connect(f);
    f.connect(g);
    g.connect(sfx(opts.dest));
  }

  // ---------------- SFX recipes ----------------

  function sfxHit(power) {
    if (!canPlay('hit', 130)) return;
    const p = Math.max(0, Math.min(1, power || 0.3));
    tone({ type: 'sine', f0: 130, f1: 46, dur: 0.17, peak: 0.22 + 0.34 * p });
    burst({ dur: 0.05, peak: 0.07 + 0.13 * p, filter: { type: 'highpass', f0: 2800 } });
  }

  function sfxCrit() {
    if (!canPlay('crit', 280)) return;
    const t0 = ctx.currentTime;
    tone({ type: 'sine', f0: 95, f1: 26, dur: 0.5, peak: 0.55, t: t0 });
    burst({ t: t0, dur: 0.45, peak: 0.28, filter: { type: 'bandpass', f0: 420, q: 0.8 } });
    tone({ type: 'triangle', f0: 1568, dur: 0.5, peak: 0.11, t: t0 + 0.02 });
    tone({ type: 'sine', f0: 2093, dur: 0.4, peak: 0.06, t: t0 + 0.05 });
  }

  function sfxExplosion() {
    if (!canPlay('boom', 240)) return;
    const t0 = ctx.currentTime;
    burst({ t: t0, dur: 0.8, peak: 0.5, filter: { type: 'lowpass', f0: 3800, f1: 90 } });
    tone({ type: 'sine', f0: 65, f1: 24, dur: 0.65, peak: 0.55, t: t0 });
  }

  function sfxLike() {
    if (!canPlay('like', 500)) return;
    const t0 = ctx.currentTime;
    tone({ type: 'sine', f0: 740, f1: 1180, dur: 0.07, peak: 0.06, t: t0 });
    tone({ type: 'sine', f0: 1180, f1: 1560, dur: 0.06, peak: 0.045, t: t0 + 0.05 });
  }

  function sfxGift() {
    if (!canPlay('gift', 250)) return;
    const t0 = ctx.currentTime;
    tone({ type: 'triangle', f0: 659, dur: 0.1, peak: 0.14, t: t0 });
    tone({ type: 'triangle', f0: 880, dur: 0.2, peak: 0.14, t: t0 + 0.08 });
  }

  function sfxPowerOn() {
    if (!canPlay('powerOn', 400)) return;
    const t0 = ctx.currentTime;
    tone({
      type: 'sawtooth',
      f0: 180,
      f1: 760,
      dur: 0.45,
      peak: 0.16,
      t: t0,
      filter: { type: 'lowpass', f0: 600, f1: 2400 },
    });
    [440, 554, 659].forEach(function (f) {
      tone({ type: 'triangle', f0: f, dur: 0.5, peak: 0.09, t: t0 + 0.35 });
    });
  }

  function sfxPowerOff() {
    if (!canPlay('powerOff', 400)) return;
    tone({ type: 'sine', f0: 420, f1: 150, dur: 0.5, peak: 0.14 });
  }

  function sfxComboFull() {
    if (!canPlay('combo', 600)) return;
    const t0 = ctx.currentTime;
    burst({ t: t0, dur: 0.35, peak: 0.13, filter: { type: 'bandpass', f0: 500, f1: 2600, q: 0.7 } });
    [440, 554, 659, 880].forEach(function (f, i) {
      tone({ type: 'square', f0: f, dur: 0.07, peak: 0.07, t: t0 + 0.08 + i * 0.055 });
    });
  }

  function sfxSuddenDeath() {
    if (!canPlay('sd', 1000)) return;
    const t0 = ctx.currentTime;
    [0, 0.3, 0.6].forEach(function (dt) {
      tone({ type: 'sine', f0: 75, f1: 38, dur: 0.35, peak: 0.5, t: t0 + dt });
    });
    tone({
      type: 'sawtooth',
      f0: 70,
      f1: 190,
      dur: 0.9,
      peak: 0.12,
      t: t0,
      filter: { type: 'lowpass', f0: 300, f1: 700 },
    });
  }

  function sfxFanfare() {
    if (!canPlay('fanfare', 1500)) return;
    const t0 = ctx.currentTime;
    tone({ type: 'sine', f0: 90, f1: 28, dur: 0.7, peak: 0.5, t: t0 });
    burst({ t: t0, dur: 0.5, peak: 0.2, filter: { type: 'lowpass', f0: 300 } });
    const mel = [
      [64, 0.55, 0.16], // E4
      [67, 0.71, 0.16], // G4
      [69, 0.87, 0.16], // A4
      [72, 1.03, 0.32], // C5
    ];
    mel.forEach(function (n) {
      tone({ type: 'triangle', f0: freq(n[0]), dur: n[2], peak: 0.2, t: t0 + n[1] });
      tone({ type: 'sine', f0: freq(n[0] + 12), dur: n[2], peak: 0.07, t: t0 + n[1] });
    });
    [69, 72, 76, 81].forEach(function (m) {
      tone({ type: 'triangle', f0: freq(m), dur: 0.7, peak: 0.13, t: t0 + 1.45 });
    });
    tone({ type: 'square', f0: freq(57), dur: 0.7, peak: 0.05, t: t0 + 1.45 });
    burst({ t: t0 + 1.45, dur: 0.5, peak: 0.14, filter: { type: 'highpass', f0: 6000 } });
  }

  function sfxResetChime() {
    if (!canPlay('reset', 800)) return;
    const t0 = ctx.currentTime;
    const seq = [
      [523, 0, 0.14],
      [659, 0.16, 0.14],
      [784, 0.32, 0.26],
    ];
    seq.forEach(function (n) {
      tone({ type: 'triangle', f0: n[0], dur: n[2], peak: 0.13, t: t0 + n[1] });
    });
  }

  function sfxCoin() {
    if (!canPlay('coin', 400)) return;
    const t0 = ctx.currentTime;
    tone({ type: 'square', f0: 988, dur: 0.06, peak: 0.09, t: t0 });
    tone({ type: 'square', f0: 1319, dur: 0.16, peak: 0.09, t: t0 + 0.06 });
  }

  function sfxVip() {
    const t0 = ctx.currentTime;
    tone({ type: 'sine', f0: 523, f1: 784, dur: 0.3, peak: 0.14, t: t0 });
    tone({ type: 'sine', f0: 1568, dur: 0.35, peak: 0.05, t: t0 + 0.05 });
  }

  // ---------------- public API ----------------

  api.unlock = function () {
    if (api.unlocked) return;
    api.unlocked = true;
    try {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      if (!Ctx) return;
      ctx = new Ctx();
      master = ctx.createGain();
      master.gain.value = muted ? 0.0001 : 0.9;
      master.connect(ctx.destination);
      sfxBus = ctx.createGain();
      sfxBus.gain.value = 0.9;
      sfxBus.connect(master);
      musicBus = ctx.createGain();
      musicBus.gain.value = 0.6;
      musicBus.connect(master);
      noiseBuf = makeNoiseBuffer();
      if (ctx.state === 'suspended') {
        ctx.resume().catch(function () {});
      }
      startScheduler();
      if (pendingMusicMode) {
        musicMode = pendingMusicMode;
        pendingMusicMode = null;
      }
      if (musicMode === 'sd') startDrone();
    } catch (e) {
      ctx = null;
    }
  };

  api.setMuted = function (m) {
    muted = !!m;
    if (!ctx || !master) return;
    try {
      const t = ctx.currentTime;
      master.gain.cancelScheduledValues(t);
      master.gain.setValueAtTime(master.gain.value, t);
      master.gain.linearRampToValueAtTime(muted ? 0.0001 : 0.9, t + 0.15);
    } catch (e) {}
  };

  api.musicMode = function (m) {
    if (m !== 'normal' && m !== 'sd' && m !== 'ended') return;
    if (!ctx) {
      pendingMusicMode = m;
      return;
    }
    if (m === musicMode) return;
    const prev = musicMode;
    musicMode = m;
    try {
      const t = ctx.currentTime;
      if (m === 'ended') {
        musicBus.gain.cancelScheduledValues(t);
        musicBus.gain.setValueAtTime(musicBus.gain.value, t);
        musicBus.gain.linearRampToValueAtTime(0.0001, t + 0.8);
        stopDrone();
      } else {
        musicBus.gain.cancelScheduledValues(t);
        musicBus.gain.setValueAtTime(musicBus.gain.value, t);
        musicBus.gain.linearRampToValueAtTime(0.6, t + 0.8);
        if (prev !== 'normal' && m === 'normal') {
          nextStepTime = ctx.currentTime + 0.1;
          stepIndex = 0;
        }
        if (m === 'sd' && prev !== 'sd') startDrone();
        if (prev === 'sd') stopDrone();
      }
    } catch (e) {}
  };

  api.hit = sfxHit;
  api.crit = sfxCrit;
  api.explosion = sfxExplosion;
  api.like = sfxLike;
  api.gift = sfxGift;
  api.powerOn = sfxPowerOn;
  api.powerOff = sfxPowerOff;
  api.comboFull = sfxComboFull;
  api.suddenDeath = sfxSuddenDeath;
  api.fanfare = sfxFanfare;
  api.resetChime = sfxResetChime;
  api.coin = sfxCoin;
  api.vip = sfxVip;

  window.LTBAudio = api;
})();
