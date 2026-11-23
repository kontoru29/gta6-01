// audio.js — Solmar Bay synthesised sound, no audio files at all, rebuilt.
//
// Every sound is built live with the Web Audio API: a low engine hum that
// rises with speed, a two-tone police siren, a sharp gunshot crack, a deep
// shotgun blast, a soft pickup blip, a mission-complete jingle, and a slow
// golden-hour pad loop for ambient music. Nothing here loads a file,
// touches the network, or decides game logic — main.js just calls these
// methods when things happen. The context is created lazily on the first
// user gesture, so browsers that block autoplay never throw; every method
// is safe to call before that.
//
// New this round: a helicopter rotor loop that thumps in once the wanted
// level hits five stars and stops when the heat clears, and a shotgun
// blast — a deeper, longer noise burst than the pistol crack — for the
// new weapon.

const NOTE_FREQ = {
  C3: 130.81, D3: 146.83, E3: 164.81, F3: 174.61, G3: 196.0, A3: 220.0,
  B3: 246.94, C4: 261.63, D4: 293.66, E4: 329.63, F4: 349.23, G4: 392.0,
  A4: 440.0, B4: 493.88, C5: 523.25, E5: 659.25, G5: 783.99,
};

// A slow, warm chord walk for the ambient pad (Am – F – C – G).
const PAD_CHORDS = [
  ['A3', 'C4', 'E4'],
  ['F3', 'A3', 'C4'],
  ['C3', 'E3', 'G3'],
  ['G3', 'B3', 'D4'],
];

export class AudioEngine {
  constructor() {
    this.ctx = null;
    this.master = null;
    this.muted = false;
    this.volume = 0.55; // master volume, 0..1; mute restores to this
    this.engineOsc = null;
    this.engineGain = null;
    this.engineFilter = null;
    this.sirenOsc = null;
    this.sirenGain = null;
    this.sirenTimer = null;
    this.sirenHigh = false;
    this.rotorOsc = null;
    this.rotorGain = null;
    this.rotorLfo = null;
    this.padTimer = null;
    this.padChordIndex = 0;
    this.noiseBuffer = null;
    this.started = false;
  }

  // Create the context on a user gesture (start button, first key press).
  // Safe to call repeatedly; later calls are no-ops.
  ensure() {
    if (this.ctx) {
      if (this.ctx.state === 'suspended') {
        this.ctx.resume().catch(() => {});
      }
      return true;
    }
    try {
      const Ctor = window.AudioContext || window.webkitAudioContext;
      if (!Ctor) return false;
      this.ctx = new Ctor();
      this.master = this.ctx.createGain();
      this.master.gain.value = this.muted ? 0 : 0.55;
      this.master.connect(this.ctx.destination);
      const len = this.ctx.sampleRate * 0.5;
      this.noiseBuffer = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
      const data = this.noiseBuffer.getChannelData(0);
      for (let i = 0; i < len; i += 1) data[i] = Math.random() * 2 - 1;
      this.startEngineHum();
      return true;
    } catch {
      this.ctx = null;
      return false;
    }
  }

  setMuted(muted) {
    this.muted = Boolean(muted);
    if (this.master && this.ctx) {
      this.master.gain.setTargetAtTime(this.muted ? 0 : this.volume, this.ctx.currentTime, 0.05);
    }
    return this.muted;
  }

  // Master volume, 0..1. Clamped, stored so mute can restore it, and
  // applied to the master gain the same way mute does.
  setMasterVolume(level) {
    const volume = Math.max(0, Math.min(1, Number(level) || 0));
    this.volume = volume;
    if (this.master && this.ctx) {
      this.master.gain.setTargetAtTime(this.muted ? 0 : volume, this.ctx.currentTime, 0.05);
    }
    return volume;
  }

  isMuted() {
    return this.muted;
  }

  // --- engine hum: a sawtooth pair through a low-pass, pitch follows speed.
  startEngineHum() {
    if (!this.ctx || this.engineOsc) return;
    this.engineOsc = this.ctx.createOscillator();
    this.engineOsc.type = 'sawtooth';
    this.engineOsc.frequency.value = 52;
    const sub = this.ctx.createOscillator();
    sub.type = 'sine';
    sub.frequency.value = 26;
    this.engineFilter = this.ctx.createBiquadFilter();
    this.engineFilter.type = 'lowpass';
    this.engineFilter.frequency.value = 320;
    this.engineGain = this.ctx.createGain();
    this.engineGain.gain.value = 0.0;
    this.engineOsc.connect(this.engineFilter);
    sub.connect(this.engineFilter);
    this.engineFilter.connect(this.engineGain);
    this.engineGain.connect(this.master);
    this.engineOsc.start();
    sub.start();
    this.engineOsc._sub = sub;
  }

  // speed01 is 0..1 (0 = parked, 1 = top speed). On foot the hum idles low.
  setEngine(speed01, driving) {
    if (!this.ctx || !this.engineOsc || !this.engineGain) return;
    const t = this.ctx.currentTime;
    const level = driving ? 0.05 + Math.min(1, speed01) * 0.075 : 0.018;
    const freq = 52 + Math.min(1, speed01) * 118;
    this.engineGain.gain.setTargetAtTime(level, t, 0.12);
    this.engineOsc.frequency.setTargetAtTime(freq, t, 0.1);
    if (this.engineOsc._sub) this.engineOsc._sub.frequency.setTargetAtTime(freq / 2, t, 0.1);
    if (this.engineFilter) {
      this.engineFilter.frequency.setTargetAtTime(280 + Math.min(1, speed01) * 900, t, 0.15);
    }
  }

  // --- two-tone siren: alternates 700 Hz / 950 Hz while wanted.
  setSiren(active) {
    if (!this.ctx) return;
    if (active && !this.sirenOsc) {
      this.sirenOsc = this.ctx.createOscillator();
      this.sirenOsc.type = 'triangle';
      this.sirenOsc.frequency.value = 720;
      this.sirenGain = this.ctx.createGain();
      this.sirenGain.gain.value = 0.0;
      this.sirenOsc.connect(this.sirenGain);
      this.sirenGain.connect(this.master);
      this.sirenOsc.start();
      this.sirenGain.gain.setTargetAtTime(0.05, this.ctx.currentTime, 0.2);
      this.sirenHigh = false;
      this.sirenTimer = window.setInterval(() => {
        if (!this.sirenOsc) return;
        this.sirenHigh = !this.sirenHigh;
        this.sirenOsc.frequency.setTargetAtTime(
          this.sirenHigh ? 950 : 700, this.ctx.currentTime, 0.03,
        );
      }, 420);
    } else if (!active && this.sirenOsc) {
      if (this.sirenTimer !== null) window.clearInterval(this.sirenTimer);
      this.sirenTimer = null;
      const osc = this.sirenOsc;
      const gain = this.sirenGain;
      this.sirenOsc = null;
      this.sirenGain = null;
      gain.gain.setTargetAtTime(0, this.ctx.currentTime, 0.08);
      window.setTimeout(() => {
        try { osc.stop(); } catch { /* already stopped */ }
      }, 300);
    }
  }

  // --- helicopter rotor: a low thump loop, only at five stars. A 55 Hz
  // square wave through a low-pass, chopped by a slow LFO so it thumps
  // instead of droning. Started and stopped from update().
  setRotor(active) {
    if (!this.ctx) return;
    if (active && !this.rotorOsc) {
      this.rotorOsc = this.ctx.createOscillator();
      this.rotorOsc.type = 'square';
      this.rotorOsc.frequency.value = 55;
      const filter = this.ctx.createBiquadFilter();
      filter.type = 'lowpass';
      filter.frequency.value = 220;
      this.rotorGain = this.ctx.createGain();
      this.rotorGain.gain.value = 0.0;
      this.rotorLfo = this.ctx.createOscillator();
      this.rotorLfo.type = 'sine';
      this.rotorLfo.frequency.value = 11;
      const lfoGain = this.ctx.createGain();
      lfoGain.gain.value = 0.03;
      this.rotorLfo.connect(lfoGain);
      lfoGain.connect(this.rotorGain.gain);
      this.rotorOsc.connect(filter);
      filter.connect(this.rotorGain);
      this.rotorGain.connect(this.master);
      this.rotorOsc.start();
      this.rotorLfo.start();
      this.rotorGain.gain.setTargetAtTime(0.045, this.ctx.currentTime, 0.4);
    } else if (!active && this.rotorOsc) {
      const osc = this.rotorOsc;
      const lfo = this.rotorLfo;
      const gain = this.rotorGain;
      this.rotorOsc = null;
      this.rotorLfo = null;
      this.rotorGain = null;
      gain.gain.setTargetAtTime(0, this.ctx.currentTime, 0.1);
      window.setTimeout(() => {
        try { osc.stop(); } catch { /* already stopped */ }
        try { lfo.stop(); } catch { /* already stopped */ }
      }, 300);
    }
  }

  // --- one-shot helpers ---------------------------------------------------
  blip(freq, dur, type, vol, when) {
    if (!this.ctx || !this.master) return;
    const t = this.ctx.currentTime + (when || 0);
    const osc = this.ctx.createOscillator();
    osc.type = type || 'sine';
    osc.frequency.value = freq;
    const gain = this.ctx.createGain();
    gain.gain.setValueAtTime(0, t);
    gain.gain.linearRampToValueAtTime(vol || 0.16, t + 0.012);
    gain.gain.exponentialRampToValueAtTime(0.001, t + dur);
    osc.connect(gain);
    gain.connect(this.master);
    osc.start(t);
    osc.stop(t + dur + 0.05);
  }

  noiseBurst(dur, vol, filterFreq) {
    if (!this.ctx || !this.master || !this.noiseBuffer) return;
    const t = this.ctx.currentTime;
    const src = this.ctx.createBufferSource();
    src.buffer = this.noiseBuffer;
    const filter = this.ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = filterFreq || 1800;
    const gain = this.ctx.createGain();
    gain.gain.setValueAtTime(vol || 0.3, t);
    gain.gain.exponentialRampToValueAtTime(0.001, t + dur);
    src.connect(filter);
    filter.connect(gain);
    gain.connect(this.master);
    src.start(t);
    src.stop(t + dur + 0.02);
  }

  // --- game events --------------------------------------------------------
  shot() {
    this.noiseBurst(0.14, 0.5, 3200);
    this.blip(160, 0.09, 'square', 0.12);
  }

  // The shotgun: a longer, deeper blast than the pistol crack.
  shotgun() {
    this.noiseBurst(0.28, 0.65, 1400);
    this.blip(90, 0.16, 'square', 0.2);
    this.blip(60, 0.22, 'sine', 0.18, 0.03);
  }

  punch() {
    this.noiseBurst(0.09, 0.25, 900);
  }

  pickup() {
    this.blip(880, 0.12, 'sine', 0.18);
    this.blip(1318, 0.18, 'sine', 0.14, 0.08);
  }

  cash() {
    this.blip(1046, 0.1, 'triangle', 0.16);
    this.blip(1568, 0.16, 'triangle', 0.14, 0.07);
  }

  reload() {
    this.blip(320, 0.06, 'square', 0.1);
    this.blip(240, 0.06, 'square', 0.1, 0.12);
  }

  click() {
    this.blip(660, 0.05, 'sine', 0.1);
  }

  denied() {
    this.blip(180, 0.16, 'square', 0.12);
  }

  busted() {
    this.blip(392, 0.3, 'triangle', 0.18);
    this.blip(311, 0.45, 'triangle', 0.18, 0.25);
  }

  wasted() {
    this.blip(220, 0.4, 'sawtooth', 0.14);
    this.blip(165, 0.7, 'sawtooth', 0.14, 0.3);
  }

  // Mission complete: a short rising fanfare, C E G C.
  jingle() {
    const notes = ['C4', 'E4', 'G4', 'C5'];
    notes.forEach((name, i) => {
      this.blip(NOTE_FREQ[name], 0.28, 'triangle', 0.18, i * 0.11);
    });
    this.blip(NOTE_FREQ.E5, 0.4, 'triangle', 0.12, 0.48);
  }

  // --- ambient music: soft pad chords, one every few seconds. ------------
  startMusic() {
    if (!this.ctx || this.padTimer !== null) return;
    const playChord = () => {
      // Do not stack chords while the tab is hidden; the interval catches
      // up on its own when the player comes back.
      if (!this.ctx || this.muted || document.hidden) return;
      const chord = PAD_CHORDS[this.padChordIndex % PAD_CHORDS.length];
      this.padChordIndex += 1;
      const t = this.ctx.currentTime;
      for (const name of chord) {
        const osc = this.ctx.createOscillator();
        osc.type = 'sine';
        osc.frequency.value = NOTE_FREQ[name];
        const gain = this.ctx.createGain();
        gain.gain.setValueAtTime(0, t);
        gain.gain.linearRampToValueAtTime(0.035, t + 1.2);
        gain.gain.setValueAtTime(0.035, t + 3.4);
        gain.gain.linearRampToValueAtTime(0, t + 5.2);
        osc.connect(gain);
        gain.connect(this.master);
        osc.start(t);
        osc.stop(t + 5.4);
      }
    };
    playChord();
    this.padTimer = window.setInterval(playChord, 5200);
  }

  stopMusic() {
    if (this.padTimer !== null) {
      window.clearInterval(this.padTimer);
      this.padTimer = null;
    }
  }

  // Call once per frame from the game loop; keeps the engine hum honest,
  // the siren on while wanted, and the rotor thumping at five stars.
  update(speed01, driving, wanted) {
    if (!this.ctx) return;
    this.setEngine(speed01, driving);
    this.setSiren(wanted > 0);
    this.setRotor(wanted >= 5);
  }

  dispose() {
    this.stopMusic();
    this.setSiren(false);
    this.setRotor(false);
    if (this.ctx) {
      this.ctx.close().catch(() => {});
      this.ctx = null;
    }
  }
}

export default AudioEngine;
