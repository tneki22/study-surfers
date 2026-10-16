import { Music2, Volume2, VolumeX } from "lucide-react";
import { Popover } from "radix-ui";
import { useEffect, useRef, type CSSProperties } from "react";
import { DEFAULT_PREFERENCES, usePreferences } from "../../app/stores";
import { useMediaQuery } from "../../hooks/useMediaQuery";

function AudioChannel({ label, value, muted, onToggle, onChange, music = false }: {
  label: string;
  value: number;
  muted: boolean;
  onToggle: () => void;
  onChange: (value: number) => void;
  music?: boolean;
}) {
  const percent = muted ? 0 : Math.round(value * 100);
  return (
    <div className="hud-audio-channel">
      <button type="button" className="hud-audio-mute" aria-label={`${muted ? "Включить" : "Выключить"} ${music ? "музыку" : "эффекты"}`}
        aria-pressed={muted} title={muted ? "Вернуть громкость" : "Выключить"} onClick={onToggle}>
        {muted ? <VolumeX size={18} /> : music ? <Music2 size={18} /> : <Volume2 size={18} />}
      </button>
      <label className="hud-audio-level">
        <span className="hud-audio-label">{label}<span>{percent}%</span></span>
        <input type="range" min={0} max={100} step={1} value={percent} aria-label={`Громкость ${music ? "музыки" : "эффектов"}`}
          style={{ "--audio-level": `${percent}%` } as CSSProperties}
          onChange={event => onChange(Number(event.target.value) / 100)} />
      </label>
    </div>
  );
}

/** На телефоне — прежняя кнопка музыки; на компьютере — компактный микшер. */
export function AudioControls() {
  const compact = useMediaQuery("(max-width: 600px), (pointer: coarse)");
  const musicEnabled = usePreferences(s => s.musicEnabled);
  const musicVolume = usePreferences(s => s.musicVolume);
  const sfxVolume = usePreferences(s => s.sfxVolume);
  const update = usePreferences(s => s.update);
  const lastMusic = useRef(musicVolume || DEFAULT_PREFERENCES.musicVolume);
  const lastSfx = useRef(sfxVolume || DEFAULT_PREFERENCES.sfxVolume);
  useEffect(() => { if (musicVolume > 0) lastMusic.current = musicVolume; }, [musicVolume]);
  useEffect(() => { if (sfxVolume > 0) lastSfx.current = sfxVolume; }, [sfxVolume]);
  const musicMuted = !musicEnabled || musicVolume === 0;
  const toggleMusic = () => update(musicMuted
    ? { musicEnabled: true, musicVolume: musicVolume || lastMusic.current }
    : { musicEnabled: false });

  if (compact) return (
    <button type="button" className="hud-button" onClick={toggleMusic}
      aria-label={musicMuted ? "Включить музыку" : "Выключить музыку"}>
      {musicMuted ? <VolumeX size={18} /> : <Volume2 size={18} />}
    </button>
  );

  return (
    <Popover.Root>
      <Popover.Trigger asChild>
        <button type="button" className="hud-button" aria-label="Громкость" title="Громкость музыки и эффектов"
          onKeyDown={event => { if (event.code === "Space") event.stopPropagation(); }}>
          {musicMuted && sfxVolume === 0 ? <VolumeX size={18} /> : <Volume2 size={18} />}
        </button>
      </Popover.Trigger>
      <Popover.Content className="hud-audio-panel" side="bottom" align="end" sideOffset={10} collisionPadding={12}
        aria-label="Громкость музыки и эффектов" data-game-controls onEscapeKeyDown={event => event.stopPropagation()}>
        <AudioChannel label="Музыка" value={musicVolume} muted={musicMuted} music onToggle={toggleMusic}
          onChange={value => update({ musicVolume: value, musicEnabled: value > 0 })} />
        <AudioChannel label="Эффекты" value={sfxVolume} muted={sfxVolume === 0}
          onToggle={() => update({ sfxVolume: sfxVolume > 0 ? 0 : lastSfx.current })}
          onChange={value => update({ sfxVolume: value })} />
      </Popover.Content>
    </Popover.Root>
  );
}
