export const MUSIC_TRACKS = [
  { id: "sunline", title: "Солнечная линия", style: "Мелодичный хаус", bpm: 118,
    description: "Упругий бас, мягкое электропиано и светлая мелодия. Для бодрого дневного забега.", color: "#dd8a29", beats: 128 },
  { id: "afterglow", title: "После заката", style: "Синтвейв", bpm: 104,
    description: "Пульсирующий бас и синтезаторы для поездки по ночному городу.", color: "#8c79d4", beats: 128 },
  { id: "classic", title: "В ритме", style: "Электроника", bpm: 122,
    description: "Быстрый бит и короткая мелодия. Чем выше комбо, тем насыщеннее звучание.", color: "#648793", beats: 16 },
] as const;

export type MusicTrackId = typeof MUSIC_TRACKS[number]["id"];
export const DEFAULT_DAY_TRACK: MusicTrackId = "sunline";
export const DEFAULT_NIGHT_TRACK: MusicTrackId = "sunline";

export function getMusicTrack(id: string) {
  return MUSIC_TRACKS.find((track) => track.id === id) ?? MUSIC_TRACKS[0];
}

export const musicUrl = (id: MusicTrackId) => `${import.meta.env?.BASE_URL ?? "/"}music/${getMusicTrack(id).id}.ogg`;

interface MusicHost {
  ctx: AudioContext;
  musicOut: GainNode;
  fadeMusic(target: number, seconds: number): void;
}

/** Готовая стереопетля: один источник вместо сотен осцилляторов в игровом кадре. */
export class Music {
  private source: AudioBufferSourceNode | null = null;
  private buffer: Promise<AudioBuffer> | null = null;
  private active = false;
  private disposed = false;
  private level = 0;
  private generation = 0;
  private readonly abort = new AbortController();
  private readonly tone: BiquadFilterNode;
  private readonly audio: MusicHost;
  private readonly track: MusicTrackId;

  constructor(audio: MusicHost, track: MusicTrackId) {
    this.audio = audio;
    this.track = track;
    this.tone = audio.ctx.createBiquadFilter();
    this.tone.type = "lowpass";
    this.tone.connect(audio.musicOut);
  }

  get playing() { return this.active; }

  start(level = 0) {
    this.setLevel(level);
    if (this.active || this.disposed) return;
    this.active = true;
    const generation = ++this.generation;
    this.buffer ??= fetch(musicUrl(this.track), { signal: this.abort.signal })
      .then((response) => {
        if (!response.ok) throw new Error(`Музыка: HTTP ${response.status}`);
        return response.arrayBuffer();
      })
      .then((bytes) => this.audio.ctx.decodeAudioData(bytes));
    void this.buffer.then((buffer) => {
      if (!this.active || this.disposed || generation !== this.generation) return;
      const source = this.audio.ctx.createBufferSource();
      source.buffer = buffer;
      source.loop = true;
      const track = getMusicTrack(this.track);
      source.loopEnd = Math.min(buffer.duration, track.beats * 60 / track.bpm);
      source.connect(this.tone);
      source.onended = () => source.disconnect();
      this.source = source;
      source.start();
      this.audio.fadeMusic(this.level === 0 ? .65 : 1, 1.2);
    }).catch((error: unknown) => {
      if (generation !== this.generation || this.disposed) return;
      this.active = false;
      this.buffer = null;
      console.warn("Не удалось загрузить музыку забега", error);
    });
  }

  setLevel(level: number) {
    this.level = level;
    if (this.disposed) return;
    this.tone.frequency.setTargetAtTime(level === 0 ? 1800 : level >= 2 ? 16000 : 10500,
      this.audio.ctx.currentTime, .3);
    if (this.active) this.audio.fadeMusic(level === 0 ? .65 : 1, .4);
  }

  stop(fade = .8) {
    this.active = false;
    this.generation += 1;
    this.audio.fadeMusic(0, fade);
    if (this.source) {
      this.source.stop(this.audio.ctx.currentTime + Math.max(0, fade));
      this.source = null;
    }
  }

  dispose() {
    this.stop(0);
    this.disposed = true;
    this.abort.abort();
    this.tone.disconnect();
  }
}
