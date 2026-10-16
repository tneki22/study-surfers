/*
 * Звук забега: Web Audio для музыкальной петли и сигналов, локальные записи
 * Kenney для механики. Огибающие начинаются и кончаются около нуля —
 * так нет щелчков. Всё идёт через компрессор, чтобы аккорды не клиппили.
 */

import type { Severity } from "../engine/impact";
import type { ModifierKind } from "../engine/modifiers";
import { DEFAULT_DAY_TRACK, DEFAULT_NIGHT_TRACK, getMusicTrack, Music, type MusicTrackId } from "./music";
import { LegacyMusic } from "./legacyMusic";

const midi = (note: number) => 440 * 2 ** ((note - 69) / 12);

interface FilterSpec {
  type: BiquadFilterType;
  freq: number;
  to?: number;
  q?: number;
}

interface VoiceSpec {
  type: OscillatorType;
  freq: number;
  /** Глиссандо к этой частоте за `glide` секунд. */
  to?: number;
  glide?: number;
  at?: number;
  attack?: number;
  decay: number;
  /** Удержание перед затуханием (пэды). */
  hold?: number;
  gain: number;
  detune?: number;
  filter?: FilterSpec;
  pan?: number;
  /** Доля в реверб. */
  reverb?: number;
  /** Доля в эхо. */
  echo?: number;
  out?: AudioNode;
}

interface NoiseSpec {
  at?: number;
  attack?: number;
  decay: number;
  gain: number;
  filter: FilterSpec;
  pan?: number;
  reverb?: number;
  out?: AudioNode;
}

/**
 * Записанные звуки Kenney Impact Sounds (CC0, public/sounds): шаги, приземления
 * и удары. Синтез хорош для «игровых» сигналов, а у касаний нужен настоящий материал.
 * У каждого набора несколько вариантов — подряд не звучит один и тот же.
 */
const SAMPLES = {
  stepGround: ["footstep_concrete_000", "footstep_concrete_001", "footstep_concrete_002", "footstep_concrete_003", "footstep_concrete_004"],
  stepDeck: ["footstep_wood_000", "footstep_wood_001", "footstep_wood_002", "footstep_wood_003", "footstep_wood_004"],
  landGround: ["impactSoft_heavy_000", "impactSoft_heavy_001", "impactSoft_heavy_002"],
  plank: ["impactPlank_medium_000", "impactPlank_medium_001", "impactPlank_medium_002"],
  metalHeavy: ["impactMetal_heavy_000", "impactMetal_heavy_001", "impactMetal_heavy_002"],
  metalLight: ["impactMetal_light_000", "impactMetal_light_001", "impactMetal_light_002"],
} as const;
const NIGHT_SAMPLES = {
  magnet: ["engineCircular_000"], field: ["forceField_000"], thruster: ["thrusterFire_000"],
  door: ["doorOpen_000"], nightMetal: ["impactMetal_000"],
} as const;
type SampleSet = keyof typeof SAMPLES | keyof typeof NIGHT_SAMPLES;

export interface AudioLevels {
  sfxVolume: number;
  musicVolume: number;
  musicEnabled: boolean;
}

export class GameAudio {
  readonly ctx: AudioContext;
  private readonly master: GainNode;
  private readonly sfx: GainNode;
  readonly musicOut: GainNode;
  private readonly musicVolume: GainNode;
  private readonly musicFade: GainNode;
  private readonly musicTone: BiquadFilterNode;
  readonly reverbIn: GainNode;
  readonly echoIn: GainNode;
  private readonly noise: AudioBuffer;
  readonly music: Music | LegacyMusic;
  private disposed = false;
  private readonly samples = new Map<SampleSet, AudioBuffer[]>();
  private readonly lastVariant = new Map<SampleSet, number>();
  readonly night: boolean;
  private readonly ambience: GainNode;
  private readonly driveTone: BiquadFilterNode;
  private readonly driveOscillator: OscillatorNode | null;
  private readonly driveGain: GainNode;
  private engine: AudioBufferSourceNode | null = null;
  private readonly modifierTone: OscillatorNode;
  private readonly modifierGain: GainNode;

  constructor(night = false, track: MusicTrackId = night ? DEFAULT_NIGHT_TRACK : DEFAULT_DAY_TRACK) {
    this.night = night;
    this.ctx = new AudioContext({ latencyHint: "interactive" });
    const ctx = this.ctx;

    const compressor = ctx.createDynamicsCompressor();
    compressor.threshold.value = -16;
    compressor.knee.value = 12;
    compressor.ratio.value = 4;
    compressor.attack.value = 0.004;
    compressor.release.value = 0.2;
    compressor.connect(ctx.destination);

    this.master = ctx.createGain();
    this.master.gain.value = 0.9;
    this.master.connect(compressor);

    this.sfx = ctx.createGain();
    this.modifierGain = ctx.createGain();
    this.modifierGain.gain.value = 0;
    this.modifierGain.connect(this.sfx);
    this.modifierTone = ctx.createOscillator();
    this.modifierTone.type = "sine";
    this.modifierTone.frequency.value = 110;
    this.modifierTone.connect(this.modifierGain);
    this.modifierTone.start();
    this.sfx.connect(this.master);
    this.ambience = ctx.createGain();
    this.ambience.gain.value = 0;
    this.ambience.connect(this.sfx);
    this.driveTone = ctx.createBiquadFilter();
    this.driveTone.type = "lowpass";
    this.driveTone.frequency.value = 550;
    this.driveTone.connect(this.ambience);
    this.driveGain = ctx.createGain();
    this.driveGain.gain.value = 0.028;
    this.driveGain.connect(this.driveTone);
    this.driveOscillator = night ? ctx.createOscillator() : null;
    if (this.driveOscillator) { this.driveOscillator.type = "triangle"; this.driveOscillator.frequency.value = 62; this.driveOscillator.connect(this.driveGain); this.driveOscillator.start(); }

    // Музыка: громкость из настроек → затухание старта/стопа → «приглушение» фильтром на паузе.
    this.musicTone = ctx.createBiquadFilter();
    this.musicTone.type = "lowpass";
    this.musicTone.frequency.value = 18000;
    this.musicTone.connect(this.master);
    this.musicVolume = ctx.createGain();
    this.musicVolume.connect(this.musicTone);
    this.musicFade = ctx.createGain();
    this.musicFade.gain.value = 0;
    this.musicFade.connect(this.musicVolume);
    this.musicOut = ctx.createGain();
    this.musicOut.connect(this.musicFade);

    // Реверб из сгенерированного импульса: затухающий стереошум.
    const reverb = ctx.createConvolver();
    reverb.buffer = this.impulse(1.9);
    const reverbReturn = ctx.createGain();
    reverbReturn.gain.value = 0.32;
    reverb.connect(reverbReturn).connect(this.master);
    this.reverbIn = ctx.createGain();
    this.reverbIn.connect(reverb);

    // Эхо на 3/16 такта с затемнением повторов.
    const delay = ctx.createDelay(1);
    delay.delayTime.value = (60 / (track === "classic" && night ? 100 : getMusicTrack(track).bpm)) * 0.75;
    const feedback = ctx.createGain();
    feedback.gain.value = 0.33;
    const darken = ctx.createBiquadFilter();
    darken.type = "lowpass";
    darken.frequency.value = 2600;
    delay.connect(darken).connect(feedback).connect(delay);
    const echoReturn = ctx.createGain();
    echoReturn.gain.value = 0.42;
    darken.connect(echoReturn).connect(this.musicTone);
    this.echoIn = ctx.createGain();
    this.echoIn.connect(delay);

    this.noise = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
    const data = this.noise.getChannelData(0);
    for (let i = 0; i < data.length; i += 1) data[i] = Math.random() * 2 - 1;

    this.music = track === "classic" ? new LegacyMusic(this) : new Music(this, track);
    void this.loadSamples();
  }

  private async loadSamples() {
    const base = import.meta.env.BASE_URL;
    await Promise.all((Object.entries(this.night ? NIGHT_SAMPLES : SAMPLES) as [SampleSet, readonly string[]][]).map(async ([set, names]) => {
      const buffers = await Promise.all(names.map(async (name) => {
        try {
          const response = await fetch(`${base}sounds/${this.night ? "night/" : ""}${name}.ogg`);
          if (!response.ok || this.disposed) return null;
          return await this.ctx.decodeAudioData(await response.arrayBuffer());
        } catch {
          return null;
        }
      }));
      const ready = buffers.filter((buffer): buffer is AudioBuffer => buffer !== null);
      if (ready.length && !this.disposed) this.samples.set(set, ready);
      if (set === "magnet" && ready[0] && !this.disposed) {
        const source = this.ctx.createBufferSource(); source.buffer = ready[0]; source.loop = true;
        const gain = this.ctx.createGain(); gain.gain.value = 0.05;
        source.connect(gain).connect(this.driveTone); source.start(); this.engine = source;
      }
    }));
  }

  /** Проиграть случайный вариант из набора; пока не загрузилось — тишина, игра не ждёт. */
  sample(set: SampleSet, spec: { gain: number; rate?: number; pan?: number; reverb?: number; at?: number }) {
    const buffers = this.samples.get(set);
    if (!buffers?.length) return;
    let index = Math.floor(Math.random() * buffers.length);
    if (buffers.length > 1 && index === this.lastVariant.get(set)) index = (index + 1) % buffers.length;
    this.lastVariant.set(set, index);
    const at = spec.at ?? this.now;
    const source = this.ctx.createBufferSource();
    source.buffer = buffers[index];
    source.playbackRate.value = (spec.rate ?? 1) * (0.94 + Math.random() * 0.12);
    const gain = this.ctx.createGain();
    gain.gain.value = spec.gain;
    this.route(source.connect(gain), spec);
    source.start(at);
  }

  private impulse(seconds: number): AudioBuffer {
    const length = Math.floor(this.ctx.sampleRate * seconds);
    const buffer = this.ctx.createBuffer(2, length, this.ctx.sampleRate);
    for (let channel = 0; channel < 2; channel += 1) {
      const data = buffer.getChannelData(channel);
      for (let i = 0; i < length; i += 1) data[i] = (Math.random() * 2 - 1) * (1 - i / length) ** 3.2;
    }
    return buffer;
  }

  get now(): number {
    return this.ctx.currentTime + 0.005;
  }

  setLevels({ sfxVolume, musicVolume, musicEnabled }: AudioLevels) {
    const t = this.ctx.currentTime;
    this.sfx.gain.setTargetAtTime(sfxVolume, t, 0.03);
    this.musicVolume.gain.setTargetAtTime(musicEnabled ? musicVolume : 0, t, 0.08);
  }

  resume() {
    if (!this.disposed && this.ctx.state === "suspended") void this.ctx.resume();
  }

  suspend() {
    if (!this.disposed && this.ctx.state === "running") void this.ctx.suspend();
  }

  dispose() {
    this.disposed = true;
    this.music.dispose();
    this.engine?.stop(); this.driveOscillator?.stop();
    this.modifierTone.stop();
    void this.ctx.close();
  }

  fadeMusic(target: number, seconds: number) {
    const gain = this.musicFade.gain;
    const t = this.ctx.currentTime;
    gain.cancelScheduledValues(t);
    gain.setValueAtTime(gain.value, t);
    gain.linearRampToValueAtTime(target, t + Math.max(0.01, seconds));
  }

  /** Пауза: музыка уходит «за стену», но не замолкает. */
  muffle(on: boolean) {
    const t = this.ctx.currentTime;
    this.musicTone.frequency.cancelScheduledValues(t);
    this.musicTone.frequency.setTargetAtTime(on ? 420 : 18000, t, on ? 0.08 : 0.15);
  }

  /** Подвеска и ветер читают скорость, без шагов и React-перерисовок. */
  motion(speed: number, active: boolean, reading: boolean) {
    if (!this.night || this.disposed) return;
    const at = this.ctx.currentTime;
    const factor = Math.max(0, speed / 14);
    this.ambience.gain.setTargetAtTime(active ? (reading ? 0.4 : 0.8) : 0, at, 0.15);
    this.driveOscillator?.frequency.setTargetAtTime(48 + factor * 20, at, 0.12);
    this.engine?.playbackRate.setTargetAtTime(0.75 + factor * 0.25, at, 0.18);
    this.driveTone.frequency.setTargetAtTime(400 + factor * 450, at, 0.1);
    this.musicOut.gain.setTargetAtTime(reading ? 0.65 : 1, at, 0.15);
  }

  // --- Примитивы ---

  /** Тихая тяга/резонанс поля. Пауза и окончание плавно убирают гул. */
  modifierMotion(kind: ModifierKind | null, reading: boolean) {
    const at = this.now;
    this.modifierGain.gain.setTargetAtTime(kind ? (reading ? 0.009 : 0.018) : 0, at, 0.08);
    this.modifierTone.frequency.setTargetAtTime(kind === "jetpack" ? 92 : kind === "phase" ? 147 : kind === "shield" ? 196 : 220, at, 0.12);
  }

  modifier(kind: ModifierKind, action: "pickup" | "end") {
    if (action === "end") {
      this.voice({ type: "sine", freq: 660, to: 330, glide: 0.2, decay: 0.23, gain: 0.035 });
      return;
    }
    const root = kind === "jetpack" ? 57 : kind === "gravity-shoes" ? 76 : kind === "magnet" ? 69 : kind === "phase" ? 62 : 74;
    [0, 7, 12].forEach((step, i) => this.voice({ type: kind === "phase" ? "sine" : "triangle", freq: midi(root + step), at: this.now + i * 0.06, attack: 0.012, decay: 0.3, gain: 0.075, reverb: 0.2 }));
    if (kind === "jetpack") this.noiseHit({ attack: 0.09, decay: 0.55, gain: 0.12, filter: { type: "bandpass", freq: 280, to: 1600, q: 0.6 } });
    if (kind === "phase") this.voice({ type: "sine", freq: 440, to: 110, glide: 0.5, decay: 0.5, gain: 0.1, echo: 0.2 });
    if (kind === "magnet") this.voice({ type: "sine", freq: 180, to: 720, glide: 0.25, decay: 0.32, gain: 0.07 });
  }

  shieldPulse() {
    this.voice({ type: "sine", freq: 160, to: 60, glide: 0.22, decay: 0.32, gain: 0.2 });
    this.voice({ type: "triangle", freq: 880, to: 1320, glide: 0.15, decay: 0.22, gain: 0.07, reverb: 0.2 });
    this.noiseHit({ attack: 0.01, decay: 0.2, gain: 0.14, filter: { type: "bandpass", freq: 1800, to: 500, q: 0.7 } });
  }

  private filter(spec: FilterSpec, at: number, length: number): BiquadFilterNode {
    const node = this.ctx.createBiquadFilter();
    node.type = spec.type;
    node.frequency.setValueAtTime(spec.freq, at);
    if (spec.to) node.frequency.exponentialRampToValueAtTime(spec.to, at + length);
    if (spec.q !== undefined) node.Q.value = spec.q;
    return node;
  }

  private envelope(at: number, attack: number, hold: number, decay: number, peak: number): GainNode {
    const gain = this.ctx.createGain();
    gain.gain.setValueAtTime(0.0001, at);
    gain.gain.linearRampToValueAtTime(peak, at + attack);
    if (hold > 0) gain.gain.setValueAtTime(peak, at + attack + hold);
    gain.gain.exponentialRampToValueAtTime(0.0001, at + attack + hold + decay);
    return gain;
  }

  private route(node: AudioNode, spec: { pan?: number; reverb?: number; echo?: number; out?: AudioNode }) {
    let tail = node;
    if (spec.pan) {
      const panner = this.ctx.createStereoPanner();
      panner.pan.value = spec.pan;
      tail.connect(panner);
      tail = panner;
    }
    tail.connect(spec.out ?? this.sfx);
    if (spec.reverb) {
      const send = this.ctx.createGain();
      send.gain.value = spec.reverb;
      tail.connect(send).connect(this.reverbIn);
    }
    if (spec.echo) {
      const send = this.ctx.createGain();
      send.gain.value = spec.echo;
      tail.connect(send).connect(this.echoIn);
    }
  }

  voice(spec: VoiceSpec) {
    const at = spec.at ?? this.now;
    const attack = spec.attack ?? 0.005;
    const hold = spec.hold ?? 0;
    const end = at + attack + hold + spec.decay;
    const osc = this.ctx.createOscillator();
    osc.type = spec.type;
    osc.frequency.setValueAtTime(spec.freq, at);
    if (spec.to) osc.frequency.exponentialRampToValueAtTime(spec.to, at + (spec.glide ?? spec.decay));
    if (spec.detune) osc.detune.value = spec.detune;
    let node: AudioNode = osc;
    if (spec.filter) node = node.connect(this.filter(spec.filter, at, end - at));
    node = node.connect(this.envelope(at, attack, hold, spec.decay, spec.gain));
    this.route(node, spec);
    osc.start(at);
    osc.stop(end + 0.05);
  }

  noiseHit(spec: NoiseSpec) {
    const at = spec.at ?? this.now;
    const attack = spec.attack ?? 0.003;
    const end = at + attack + spec.decay;
    const source = this.ctx.createBufferSource();
    source.buffer = this.noise;
    const node = source
      .connect(this.filter(spec.filter, at, end - at))
      .connect(this.envelope(at, attack, 0, spec.decay, spec.gain));
    this.route(node, spec);
    source.start(at, Math.random() * 1.5);
    source.stop(end + 0.05);
  }

  // --- Эффекты ---

  lane(direction: -1 | 1) {
    this.noiseHit({ decay: 0.13, attack: 0.012, gain: 0.2, filter: { type: "bandpass", freq: 650, to: 2600, q: 1.3 }, pan: direction * 0.45 });
    this.voice({ type: "sine", freq: 470, to: 640, decay: 0.08, gain: 0.04, pan: direction * 0.3 });
  }

  jump() {
    this.voice({ type: "triangle", freq: 250, to: 760, glide: 0.16, decay: 0.22, gain: 0.15 });
    this.noiseHit({ decay: 0.16, attack: 0.02, gain: 0.05, filter: { type: "highpass", freq: 1800 } });
  }

  /** Шаг в такт ногам; на крыше вагонетки — по доскам. */
  step(onDeck: boolean) {
    if (onDeck) this.sample("stepDeck", { gain: 0.32, rate: 1.1 });
    else this.sample("stepGround", { gain: 0.24, rate: 1.05 });
  }

  /** Приземление тем гулче, чем быстрее касание (м/с). */
  land(impact = 5, onDeck = false) {
    const force = Math.min(1, Math.max(0.25, impact / 7));
    this.voice({ type: "sine", freq: 150, to: 52, decay: 0.15, gain: 0.22 * force });
    this.noiseHit({ decay: 0.08, gain: 0.07 * force, filter: { type: "lowpass", freq: 520 } });
    if (onDeck) {
      this.sample("plank", { gain: 0.45 * force, rate: 1.05 });
      this.sample("metalLight", { gain: 0.14 * force, rate: 0.9 });
    } else {
      this.sample("landGround", { gain: 0.55 * force });
    }
  }

  slide() {
    this.noiseHit({ decay: 0.4, attack: 0.025, gain: 0.18, filter: { type: "bandpass", freq: 950, to: 330, q: 0.8 } });
    this.voice({ type: "sine", freq: 120, to: 70, decay: 0.22, gain: 0.1 });
  }

  coin(chain: number) {
    const scale = [0, 2, 4, 5, 7, 9, 11, 12, 14, 16, 17, 19];
    const base = midi(83 + scale[Math.min(chain, scale.length - 1)]);
    const at = this.now;
    this.voice({ type: "square", freq: base, at, decay: 0.06, gain: 0.045, filter: { type: "lowpass", freq: 5200 } });
    this.voice({ type: "square", freq: base * 4 / 3, at: at + 0.055, decay: 0.26, gain: 0.045, filter: { type: "lowpass", freq: 5200 }, reverb: 0.25 });
    this.voice({ type: "sine", freq: base * 8 / 3, at: at + 0.055, decay: 0.18, gain: 0.025 });
  }

  question() {
    this.voice({ type: "sine", freq: midi(88), decay: 0.55, gain: 0.05, reverb: 0.4 });
    this.voice({ type: "sine", freq: midi(95), decay: 0.32, gain: 0.022 });
  }

  correct(multiplier: number) {
    const root = 72 + Math.min(multiplier - 1, 3) * 2;
    const at = this.now;
    [0, 4, 7, 12].forEach((step, index) => {
      const t = at + index * 0.055;
      this.voice({ type: "triangle", freq: midi(root + step), at: t, decay: 0.34, gain: 0.1, reverb: 0.3 });
      this.voice({ type: "sine", freq: midi(root + step + 12), at: t, decay: 0.2, gain: 0.03 });
    });
  }

  wrong() {
    this.voice({ type: "sawtooth", freq: 196, to: 138, glide: 0.3, decay: 0.32, gain: 0.09, filter: { type: "lowpass", freq: 950 } });
    this.voice({ type: "sawtooth", freq: 207.7, to: 146, glide: 0.3, decay: 0.32, gain: 0.07, filter: { type: "lowpass", freq: 950 } });
    this.noiseHit({ decay: 0.16, gain: 0.07, filter: { type: "lowpass", freq: 320 } });
  }

  /** Новый множитель: арпеджио выше с каждым уровнем, с ×4 — аккорд снизу, на ×5 — ещё блеск сверху. */
  comboUp(multiplier: number) {
    const at = this.now + 0.18;
    const tier = Math.max(2, Math.min(multiplier, 5));
    const root = 79 + (tier - 2) * 2;
    [0, 2, 4, 7, 9, 12, 14, 16].forEach((step, index) => {
      this.voice({ type: "sine", freq: midi(root + step), at: at + index * 0.034, decay: 0.26, gain: 0.045, reverb: 0.5 });
    });
    this.noiseHit({ at, attack: 0.22, decay: 0.5, gain: 0.04, filter: { type: "highpass", freq: 5200 }, reverb: 0.5 });
    if (tier >= 4) {
      [0, 4, 7].forEach((step) => this.voice({ type: "triangle", freq: midi(root - 12 + step), at, decay: 0.7, gain: 0.05, reverb: 0.5 }));
    }
    if (tier >= 5) {
      [19, 24, 28, 31].forEach((step, index) => {
        this.voice({ type: "sine", freq: midi(root + step), at: at + 0.28 + index * 0.05, decay: 0.4, gain: 0.025, reverb: 0.6 });
      });
    }
  }

  /** Веха серии — другой звук, не арпеджио: удар печати, звон монет и колокол. */
  streakMilestone() {
    const at = this.now + 0.12;
    this.voice({ type: "sine", freq: 110, to: 55, glide: 0.25, at, decay: 0.45, gain: 0.16 });
    this.noiseHit({ at, attack: 0.005, decay: 0.18, gain: 0.08, filter: { type: "lowpass", freq: 900 } });
    [91, 88, 93, 89, 95, 91, 96].forEach((note, index) => {
      const t = at + 0.12 + index * 0.045;
      this.voice({ type: "square", freq: midi(note), at: t, decay: 0.07, gain: 0.03, filter: { type: "lowpass", freq: 6000 } });
      this.voice({ type: "sine", freq: midi(note + 12), at: t, decay: 0.12, gain: 0.018 });
    });
    [0, 7, 12, 16].forEach((step) => this.voice({ type: "triangle", freq: midi(72 + step), at: at + 0.1, decay: 1.1, gain: 0.04, reverb: 0.7 }));
  }

  /**
   * Столкновение по силе: задел — короткий шорох и стук, удар — доска, железо или борт,
   * крушение — тот же удар тяжелее, с гулким низом и долгим скрежетом.
   */
  bump(kind: "hurdle" | "bar" | "wagons" = "hurdle", severity: Severity = "hit") {
    if (severity === "graze") {
      if (this.night) this.sample("field", { gain: 0.05, rate: 1.3 });
      else this.sample(kind === "hurdle" ? "plank" : "metalHeavy", { gain: 0.28, rate: 1.35 });
      this.noiseHit({ decay: 0.12, gain: 0.12, filter: { type: "bandpass", freq: 2200, to: 900, q: 1.4 } });
      this.voice({ type: "sine", freq: 160, to: 90, decay: 0.12, gain: 0.16 });
      return;
    }
    const heavy = severity === "crash";
    if (this.night) { this.sample("nightMetal", { gain: heavy ? 0.24 : 0.16 }); this.sample("field", { gain: 0.055 }); }
    if (kind === "hurdle") this.sample("plank", { gain: 0.7, rate: 0.9 });
    else this.sample("metalHeavy", { gain: kind === "wagons" ? 0.75 : 0.6, rate: kind === "wagons" ? 0.75 : 1, reverb: 0.2 });
    this.voice({ type: "sine", freq: 125, to: 40, decay: heavy ? 0.5 : 0.26, gain: heavy ? 0.55 : 0.42 });
    this.noiseHit({ decay: 0.2, gain: 0.28, filter: { type: "lowpass", freq: 1500, to: 280 } });
    this.voice({ type: "square", freq: 92, decay: 0.09, gain: 0.05, filter: { type: "lowpass", freq: 600 } });
    if (heavy) {
      this.sample("metalHeavy", { gain: 0.5, rate: 0.6, reverb: 0.4 });
      this.noiseHit({ at: this.now + 0.05, attack: 0.02, decay: 0.9, gain: 0.16, filter: { type: "bandpass", freq: 700, to: 220, q: 0.9 }, reverb: 0.3 });
      this.voice({ type: "sawtooth", freq: 70, to: 32, decay: 0.7, gain: 0.08, filter: { type: "lowpass", freq: 400 } });
    }
  }

  cleared() {
    this.noiseHit({ decay: 0.2, attack: 0.03, gain: 0.06, filter: { type: "bandpass", freq: 1500, to: 3400, q: 1.1 } });
  }

  countdown(value: number) {
    if (value > 0) {
      this.voice({ type: "sine", freq: midi(76), decay: 0.2, gain: 0.15 });
      this.voice({ type: "triangle", freq: midi(88), decay: 0.08, gain: 0.035 });
      return;
    }
    [81, 85, 88].forEach((note) => this.voice({ type: "triangle", freq: midi(note), decay: 0.55, gain: 0.075, reverb: 0.35 }));
    this.noiseHit({ attack: 0.05, decay: 0.45, gain: 0.07, filter: { type: "bandpass", freq: 900, to: 5200, q: 0.8 } });
  }

  finish() {
    const at = this.now;
    [[72, 0], [76, 0.12], [79, 0.24]].forEach(([note, offset]) => {
      this.voice({ type: "triangle", freq: midi(note), at: at + offset, decay: 0.2, gain: 0.1 });
      this.voice({ type: "square", freq: midi(note), at: at + offset, decay: 0.12, gain: 0.025, filter: { type: "lowpass", freq: 3000 } });
    });
    [72, 76, 79, 84].forEach((note) => {
      this.voice({ type: "triangle", freq: midi(note), at: at + 0.36, attack: 0.02, hold: 0.35, decay: 0.9, gain: 0.07, reverb: 0.4 });
    });
    this.noiseHit({ at: at + 0.36, decay: 1.3, gain: 0.05, filter: { type: "highpass", freq: 3200 }, reverb: 0.3 });
  }

  gameover() {
    const at = this.now;
    [67, 64, 60, 55].forEach((note, index) => {
      this.voice({ type: "sawtooth", freq: midi(note), at: at + index * 0.2, decay: 0.38, gain: 0.07, filter: { type: "lowpass", freq: 1200 }, reverb: 0.3 });
    });
  }

  trainPass(side: -1 | 1) {
    this.noiseHit({ attack: 0.35, decay: 0.9, gain: 0.16, filter: { type: "lowpass", freq: 700, to: 260 }, pan: side * 0.7 });
    this.voice({ type: "sine", freq: 68, to: 52, attack: 0.3, decay: 0.8, gain: 0.05, pan: side * 0.5 });
  }

  /** Двухтоновый гудок челнока, тронувшегося навстречу: слышно, с какой стороны. */
  shuttleHorn(pan: number) {
    const at = this.now;
    const side = Math.max(-1, Math.min(1, pan));
    for (const [index, note] of [64, 60].entries()) {
      this.voice({ type: "sawtooth", freq: midi(note), at: at + index * 0.16, decay: 0.2, gain: 0.05, filter: { type: "lowpass", freq: 1500 }, pan: side, reverb: 0.25 });
    }
  }

  /** Колокольчик дрезины, тронувшейся навстречу: два быстрых удара с той стороны, где она едет. */
  handcarBell(pan: number) {
    const side = Math.max(-1, Math.min(1, pan));
    for (const offset of [0, 0.14]) {
      this.voice({ type: "triangle", freq: midi(88), at: this.now + offset, decay: 0.3, gain: 0.06, pan: side, reverb: 0.3 });
      this.voice({ type: "sine", freq: midi(95), at: this.now + offset, decay: 0.18, gain: 0.03, pan: side });
    }
  }

  /** Ускорительное кольцо: восходящий свист и шорох потока. */
  boost() {
    this.voice({ type: "sawtooth", freq: midi(60), to: midi(84), glide: 0.35, decay: 0.45, gain: 0.05, filter: { type: "lowpass", freq: 2600 }, reverb: 0.3 });
    this.noiseHit({ attack: 0.05, decay: 0.5, gain: 0.08, filter: { type: "bandpass", freq: 900, to: 4200, q: 0.9 } });
    this.sample("thruster", { gain: 0.08, rate: 1.5 });
  }

  magneticShift() { this.sample("field", { gain: 0.09, rate: 1.15 }); }
  hoverJump() { this.sample("thruster", { gain: 0.055, rate: 1.3 }); this.jump(); }
  hoverLand() { this.sample("field", { gain: 0.035, rate: 0.85 }); }
  hoverSlide() { this.sample("door", { gain: 0.04, rate: 1.1 }); }
}
