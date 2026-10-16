"""Авторская музыка Study Surfers: детерминированный синтез без сэмплов.

Запуск из корня: python frontend/scripts/synthesize-music.py
Нужны numpy, scipy и ffmpeg в PATH. Результат: frontend/public/music/*.ogg.
32 такта, стерео 44,1 кГц; хвосты эффектов завёрнуты в начало петли.
"""

from pathlib import Path
import subprocess
import tempfile
import wave

import numpy as np
from scipy.signal import butter, sosfilt

RATE = 44100
OUT = Path(__file__).resolve().parents[1] / "public" / "music"
TRACKS = {
    "sunline": (118, 710, "house"),
    "afterglow": (104, 220, "synthwave"),
}


def hz(note):
    return 440 * 2 ** ((note - 69) / 12)


def filt(signal, cutoff, kind="lowpass", order=2):
    return sosfilt(butter(order, cutoff, btype=kind, fs=RATE, output="sos"), signal)


class Studio:
    def __init__(self, bpm, seed, style):
        self.beat = 60 / bpm
        self.frames = round(128 * self.beat * RATE)
        self.rng = np.random.default_rng(seed)
        self.style = style
        self.buses = {name: np.zeros((self.frames, 2), np.float32)
                      for name in ("drums", "bass", "chords", "lead", "space")}
        self.kicks = []

    def add(self, signal, beat, bus, volume=1, pan=0, send=0):
        # Равномощная панорама; ноты и хвосты пересекают границу петли.
        stereo = np.asarray(signal[:, None] * np.array([
            np.cos((pan + 1) * np.pi / 4), np.sin((pan + 1) * np.pi / 4)
        ]) * volume, dtype=np.float32)
        start = round(beat * self.beat * RATE) % self.frames
        first = min(len(stereo), self.frames - start)
        for name, gain in ((bus, 1), ("space", send)):
            if not gain:
                continue
            self.buses[name][start:start + first] += stereo[:first] * gain
            if first < len(stereo):
                self.buses[name][:len(stereo) - first] += stereo[first:] * gain

    def note(self, note, beat, duration, voice, volume, pan=0, send=.12):
        seconds = duration * self.beat
        release = .7 if voice == "pad" else .22
        t = np.arange(round((seconds + release) * RATE)) / RATE
        frequency = hz(note)
        if voice == "keys":
            # Мягкое FM-пиано: яркая атака постепенно уступает основному тону.
            wavelet = np.sin(2 * np.pi * frequency * t + 2.2 * np.exp(-t * 9)
                             * np.sin(2 * np.pi * frequency * 2 * t))
            wavelet += .22 * np.sin(2 * np.pi * frequency * 3 * t) * np.exp(-t * 8)
            envelope = (1 - np.exp(-t * 350)) * np.exp(-t * 2.2)
        elif voice == "pad":
            wavelet = np.zeros_like(t)
            for detune in (-.003, .003):
                for harmonic in range(1, 7):
                    wavelet += np.sin(2 * np.pi * frequency * (1 + detune)
                                      * harmonic * t) / harmonic ** 1.7
            wavelet *= .42
            envelope = np.minimum(t / .23, 1) * (.85 + .15 * np.sin(2 * np.pi * .27 * t))
        elif voice == "bass":
            wavelet = np.sin(2 * np.pi * frequency * t)
            for harmonic in range(2, 9):
                wavelet += .45 / harmonic * np.sin(2 * np.pi * frequency * harmonic * t) * np.exp(-t * 7)
            envelope = (1 - np.exp(-t * 260)) * np.exp(-t * 1.5)
        elif voice == "pluck":
            wavelet = np.sin(2 * np.pi * frequency * t)
            wavelet += .35 * np.sin(2 * np.pi * frequency * 2 * t) * np.exp(-t * 11)
            wavelet += .17 * np.sin(2 * np.pi * frequency * 3 * t)
            envelope = (1 - np.exp(-t * 500)) * np.exp(-t * 7)
        else:
            wavelet = np.zeros_like(t)
            for harmonic in range(1, 9):
                wavelet += np.sin(2 * np.pi * frequency * harmonic * t
                                  + .012 * harmonic * np.sin(2 * np.pi * 5 * t)) / harmonic ** 1.55
            envelope = (1 - np.exp(-t * 100)) * np.exp(-t * .9)
        envelope *= np.where(t < seconds, 1, np.exp(-(t - seconds).clip(0) * (7 if voice == "pad" else 28)))
        envelope[-150:] *= np.linspace(1, 0, 150)
        bus = "bass" if voice == "bass" else "chords" if voice in ("pad", "keys") else "lead"
        self.add(wavelet * envelope, beat, bus, volume, pan, send)

    def drum(self, kind, beat, velocity=1, pan=0):
        length = {"kick": .48, "snare": .25, "clap": .23, "hat": .075,
                  "open": .24, "shaker": .095, "rim": .07, "crash": 1.4}[kind]
        t = np.arange(round(length * RATE)) / RATE
        noise = self.rng.normal(0, 1, len(t))
        if kind == "kick":
            frequency = 46 + 125 * np.exp(-t * 38)
            signal = np.sin(2 * np.pi * np.cumsum(frequency) / RATE) * np.exp(-t * 10)
            signal += filt(noise, 2200) * np.exp(-t * 200) * .17
            gain = .68
            self.kicks.append(beat)
        elif kind in ("snare", "clap"):
            body = np.sin(2 * np.pi * 184 * t) * np.exp(-t * 26)
            texture = filt(filt(noise, 900, "highpass"), 8200)
            envelope = np.exp(-t * 22)
            if kind == "clap":
                envelope += sum(np.where(t >= offset, np.exp(-(t - offset).clip(0) * 220), 0)
                                for offset in (.012, .025, .038))
            signal = texture * envelope * .55 + body * (.23 if kind == "snare" else .06)
            gain = .42
        elif kind == "rim":
            signal = (np.sin(2 * np.pi * 870 * t) + .5 * np.sin(2 * np.pi * 1560 * t)) * np.exp(-t * 85)
            gain = .13
        else:
            signal = filt(noise, 6800 if kind != "shaker" else 4800, "highpass")
            signal += sum(np.sin(2 * np.pi * f * t) for f in (4211, 5381, 6737)) * .035
            decay = {"hat": 65, "open": 18, "shaker": 45, "crash": 4}[kind]
            signal *= (1 - np.exp(-t * 1800)) * np.exp(-t * decay)
            gain = .12 if kind == "crash" else .095
        signal[:90] *= np.linspace(0, 1, 90)
        signal[-120:] *= np.linspace(1, 0, 120)
        self.add(signal, beat, "drums", gain * velocity, pan,
                 .15 if kind in ("snare", "clap", "crash") else 0)

    def arrange(self):
        # Восьмитактовая гармония с обращениями и септимами; A / A' / B / A''.
        if self.style == "house":
            chords = [(41, [57, 60, 64, 67]), (43, [55, 59, 62, 69]),
                      (45, [57, 60, 64, 71]), (40, [55, 59, 62, 64]),
                      (41, [57, 60, 64, 67]), (48, [55, 59, 64, 67]),
                      (38, [57, 60, 64, 65]), (43, [55, 59, 62, 69])]
        elif self.style == "synthwave":
            chords = [(38, [57, 60, 64, 65]), (34, [53, 57, 60, 64]),
                      (41, [53, 57, 60, 67]), (36, [55, 58, 62, 64]),
                      (38, [57, 60, 64, 69]), (34, [57, 60, 62, 65]),
                      (43, [55, 58, 62, 65]), (45, [55, 61, 64, 69])]
        else:
            chords = [(40, [55, 59, 62, 66]), (43, [54, 57, 59, 62]),
                      (45, [55, 59, 60, 64]), (38, [54, 57, 60, 64]),
                      (40, [55, 59, 62, 66]), (47, [54, 57, 62, 66]),
                      (48, [55, 59, 62, 64]), (38, [54, 57, 60, 64])]
        for bar in range(32):
            base = bar * 4
            root, chord = chords[bar % 8]
            section = bar // 8
            breakdown = section == 2 and bar % 8 < 4
            # Полный характер слышен с начала; середина даёт передышку.
            for i, note in enumerate(chord):
                self.note(note, base, 3.8, "pad", .026 if self.style != "synthwave" else .042,
                          (i - 1.5) * .45, .28)
            if self.style == "house":
                kicks = [0, 1, 2, 3] if not breakdown else [0, 2]
                snares = [1, 3]
                bass_pattern = [(0, 0, .5), (.75, 12, .25), (1.5, 0, .38),
                                (2, 0, .5), (2.75, 7, .25), (3.5, 12, .35)]
                stabs = [.5, 1.75, 2.5, 3.25]
            elif self.style == "synthwave":
                kicks = [0, 1.75, 2.5] if bar % 2 else [0, 2, 2.75]
                snares = [1, 3]
                bass_pattern = [(i * .5, 12 if i % 4 == 3 else 0, .38) for i in range(8)]
                stabs = [0, 2.5]
            else:
                kicks = [0, 1.5, 2.75] if bar % 2 else [0, 1.75, 2.5, 3.5]
                snares = [1, 3]
                bass_pattern = [(0, 0, .65), (1.25, 12, .2), (1.75, 0, .4),
                                (2.5, 7, .3), (3.25, 0, .45)]
                stabs = [.25, 1.5, 2.75]
            for at in kicks:
                if not breakdown or at == 0:
                    self.drum("kick", base + at)
            for at in snares:
                if not breakdown or at == 3:
                    self.drum("clap" if self.style == "house" else "snare", base + at + .012,
                              .85 + self.rng.random() * .15, -.08)
            for i in range(8):
                at = i * .5 + (.035 if i % 2 and self.style != "synthwave" else 0)
                self.drum("open" if i % 2 and self.style == "house" else "hat", base + at,
                          (.65 if i % 2 == 0 else 1) * (.5 if breakdown else 1), .3)
            if section in (1, 3) or self.style == "breakbeat":
                for i in range(16):
                    self.drum("shaker", base + i * .25 + .025, .32 if i % 2 == 0 else .62, -.45)
            if self.style == "breakbeat" and not breakdown:
                for at in (1.75, 2.25, 3.75):
                    self.drum("rim", base + at + .013, .38, -.25)
            for at, interval, duration in bass_pattern:
                if not breakdown or at < 1:
                    self.note(root + interval, base + at, duration, "bass", .19, send=0)
            for at in stabs:
                if not breakdown:
                    for i, note in enumerate(chord):
                        self.note(note, base + at + i * .012, .6 if self.style == "breakbeat" else .35,
                                  "keys", .047, (i - 1.5) * .28, .22)
            # Вопрос-ответ: мотив меняет окончание каждые два такта.
            motifs = [[(0, 2, .6), (.75, 3, .3), (1.5, 1, .8), (3, 0, .65)],
                      [(.5, 1, .45), (1.25, 2, .5), (2.5, 3, 1)],
                      [(0, 3, .8), (1.5, 2, .4), (2.25, 1, .45), (3.25, 2, .6)],
                      [(.5, 2, .5), (1.5, 1, .8), (3, 0, .8)]]
            if not breakdown and (bar % 4 != 3 or section == 3):
                for at, degree, duration in motifs[(bar + section) % 4]:
                    self.note(chord[degree] + (12 if self.style != "synthwave" else 0), base + at,
                              duration, "lead" if self.style == "synthwave" else "pluck", .065,
                              -.12 if bar % 2 else .12, .4)
            if self.style == "synthwave" or section == 3:
                for i in range(8):
                    if breakdown and i % 2:
                        continue
                    self.note(chord[[0, 2, 1, 3, 2, 1, 3, 1][i]] + 12,
                              base + i * .5 + .25, .23, "pluck", .026,
                              .55 if i % 2 else -.55, .45)
            if bar % 8 == 7:
                for i in range(4):
                    self.drum("snare", base + 3 + i * .25, .2 + i * .12, i * .1 - .2)
            if bar % 8 == 0:
                self.drum("crash", base, .65, -.3)

    def mix(self):
        # Сайдчейн по реальным ударам бочки, а не неизменный метроном.
        duck = np.ones(self.frames, np.float32)
        length = round(.32 * RATE)
        curve = 1 - .48 * np.exp(-np.arange(length) / RATE * 13)
        for beat in self.kicks:
            indices = (round(beat * self.beat * RATE) + np.arange(length)) % self.frames
            duck[indices] = np.minimum(duck[indices], curve)
        dry = self.buses["drums"].copy()
        for name in ("bass", "chords", "lead"):
            dry += self.buses[name] * duck[:, None]
        space = self.buses["space"]
        for tap in range(1, 5):
            delayed = np.roll(space, round(self.beat * .75 * tap * RATE), axis=0)
            dry += delayed[:, ::-1] * (.32 ** tap)
        # Диффузные короткие отражения, периодическая обработка стыка.
        for channel in range(2):
            padded = np.tile(space[:, channel], 2)
            dark = filt(padded, 4200)[self.frames:]
            for delay, gain in ((.043, .16), (.079, .13), (.127, .1), (.193, .075), (.307, .05)):
                dry[:, channel] += np.roll(dark, round((delay + channel * .009) * RATE)) * gain
        dry -= dry.mean(axis=0)
        dry = np.tanh(dry * 1.25)
        # Единая средняя громкость для честного сравнения трёх вариантов.
        dry *= min(.145 / np.sqrt(np.mean(dry ** 2)), .84 / np.max(np.abs(dry)))
        return dry


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    for name, (bpm, seed, style) in TRACKS.items():
        studio = Studio(bpm, seed, style)
        studio.arrange()
        audio = studio.mix()
        with tempfile.TemporaryDirectory(prefix="study-surfers-music-") as directory:
            wav = Path(directory) / "render.wav"
            with wave.open(str(wav), "wb") as output:
                output.setnchannels(2)
                output.setsampwidth(2)
                output.setframerate(RATE)
                output.writeframes((audio * 32767).astype("<i2").tobytes())
            subprocess.run(["ffmpeg", "-hide_banner", "-loglevel", "error", "-y", "-i", str(wav),
                            "-c:a", "libvorbis", "-q:a", "5", "-map_metadata", "-1",
                            str(OUT / f"{name}.ogg")], check=True)
        print(f"{name}: {studio.frames / RATE:.3f} s, {bpm} BPM, "
              f"peak {20 * np.log10(np.max(np.abs(audio))):.2f} dBFS, "
              f"RMS {20 * np.log10(np.sqrt(np.mean(audio ** 2))):.2f} dBFS", flush=True)


if __name__ == "__main__":
    main()
