import type { GameAudio } from "./synth";

const midi = (note: number) => 440 * 2 ** ((note - 69) / 12);

// --- Музыка ---

const BPM = 122;
const LOOKAHEAD = 0.14;

/** Am – F – C – G: корень баса и голоса пэда с плавным ведением. */
const CHORDS = [
  { bass: 45, pad: [57, 60, 64] },
  { bass: 41, pad: [57, 60, 65] },
  { bass: 48, pad: [55, 60, 64] },
  { bass: 43, pad: [55, 59, 62] },
];

/** Мелодия на два такта: [шаг, нота, длина в шагах]. */
const HOOK: [number, number, number][] = [
  [0, 76, 2], [2, 74, 2], [4, 72, 2], [6, 74, 5], [12, 72, 2], [14, 69, 2],
  [16, 72, 2], [18, 74, 2], [20, 76, 3], [24, 79, 2], [26, 76, 2], [28, 74, 4],
];

/**
 * Петля на 4 такта со step-секвенсором и упреждающим планированием.
 * Слои добавляются с ростом интенсивности: 0 — интро (пэд и тарелки),
 * 1 — бег (бочка, бас, хлопки), 2 — комбо ×2 (арпеджио), 3 — ×3+ (мелодия).
 */
export class LegacyMusic {
  private readonly audio: GameAudio;
  private timer: ReturnType<typeof setInterval> | null = null;
  private nextTime = 0;
  private step = 0;
  private level = 0;
  private readonly stepSeconds: number;
  private readonly pump: GainNode;

  constructor(audio: GameAudio) {
    this.audio = audio;
    this.stepSeconds = 60 / (audio.night ? 100 : BPM) / 4;
    this.pump = audio.ctx.createGain();
    this.pump.connect(audio.musicOut);
  }

  get playing(): boolean {
    return this.timer !== null;
  }

  start(level = 0) {
    this.level = level;
    if (this.timer) return;
    this.step = 0;
    this.nextTime = this.audio.ctx.currentTime + 0.08;
    this.audio.fadeMusic(1, 1.2);
    this.timer = setInterval(() => this.schedule(), 25);
    this.schedule();
  }

  setLevel(level: number) {
    this.level = level;
  }

  stop(fade = 0.8) {
    if (!this.timer) return;
    this.audio.fadeMusic(0, fade);
    clearInterval(this.timer);
    this.timer = null;
  }

  dispose() {
    this.stop(0);
    this.pump.disconnect();
  }

  private schedule() {
    const ctx = this.audio.ctx;
    // Вкладка долго спала — не догоняем пропущенные такты пачкой.
    if (this.nextTime < ctx.currentTime - 0.2) this.nextTime = ctx.currentTime + 0.05;
    while (this.nextTime < ctx.currentTime + LOOKAHEAD) {
      this.playStep(this.step, this.nextTime);
      this.nextTime += this.stepSeconds;
      this.step = (this.step + 1) % 64;
    }
  }

  private playStep(step: number, t: number) {
    const STEP = this.stepSeconds;
    const a = this.audio;
    const out = a.musicOut;
    const bar = Math.floor(step / 16);
    const inBar = step % 16;
    const chord = this.audio.night ? [
      { bass: 38, pad: [57, 60, 64] }, { bass: 41, pad: [57, 60, 67] },
      { bass: 36, pad: [55, 59, 64] }, { bass: 43, pad: [55, 60, 62] },
    ][bar] : CHORDS[bar];
    const level = this.audio.night ? Math.min(2, this.level) : this.level;

    if (inBar === 0) {
      for (const note of chord.pad) {
        for (const detune of [-7, 7]) {
          a.voice({
            type: "sawtooth", freq: midi(note), detune, at: t, attack: 0.35, hold: STEP * 16 - 0.45, decay: 0.6,
            gain: level === 0 ? 0.022 : 0.016, filter: { type: "lowpass", freq: 1150, q: 0.4 }, out: this.pump, reverb: 0.25,
          });
        }
      }
    }

    // Пэд «качается» от бочки — классический sidechain.
    if (inBar % 4 === 0) {
      const gain = this.pump.gain;
      gain.cancelScheduledValues(t);
      gain.setValueAtTime(level >= 1 ? 0.35 : 1, t);
      gain.linearRampToValueAtTime(1, t + STEP * 2.4);
    }

    if (level >= 1 && inBar % 4 === 0) {
      a.voice({ type: "sine", freq: 155, to: 44, glide: 0.11, at: t, decay: 0.26, gain: this.audio.night ? 0.22 : 0.5, out });
      a.noiseHit({ at: t, decay: 0.02, gain: 0.05, filter: { type: "highpass", freq: 2500 }, out });
    }
    if (level >= 1 && (inBar === 4 || inBar === 12)) {
      for (const offset of [0, 0.011, 0.023]) {
        a.noiseHit({ at: t + offset, decay: offset ? 0.03 : 0.16, gain: 0.13, filter: { type: "bandpass", freq: 1450, q: 0.9 }, out, reverb: 0.15 });
      }
    }

    const offbeat = inBar % 4 === 2;
    if (offbeat || (level >= 3 && inBar % 2 === 1)) {
      a.noiseHit({ at: t, decay: offbeat ? 0.075 : 0.03, gain: (offbeat ? 0.055 : 0.025) * (level === 0 ? 0.6 : 1), filter: { type: "highpass", freq: 7600 }, out });
    }

    if (level >= 1 && (offbeat || (level >= 2 && inBar === 0))) {
      a.voice({
        type: "sawtooth", freq: midi(chord.bass + 12 * (inBar === 0 ? 0 : 1) - 12), at: t, decay: 0.17, gain: 0.13,
        filter: { type: "lowpass", freq: 560, q: 2 }, out,
      });
    }

    if (level >= 2) {
      const tones = [...chord.pad, chord.pad[0] + 12];
      const pattern = [0, 1, 2, 3, 2, 1, 2, 3];
      a.voice({
        type: "triangle", freq: midi(tones[pattern[inBar % 8]] + 12), at: t, decay: 0.11, gain: 0.036,
        filter: { type: "lowpass", freq: 4200 }, out, echo: 0.35,
      });
    }

    if (level >= 3) {
      const hookStep = step % 32;
      const note = HOOK.find(([at]) => at === hookStep);
      if (note) {
        a.voice({
          type: "square", freq: midi(note[1]), at: t, attack: 0.01, hold: STEP * note[2] * 0.6, decay: STEP * note[2] * 0.5,
          gain: 0.032, filter: { type: "lowpass", freq: 2600 }, out, reverb: 0.25, echo: 0.25,
        });
      }
    }
  }
}
