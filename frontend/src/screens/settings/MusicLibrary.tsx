import { Pause, Play } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { usePreferences } from "../../app/stores";
import { Button, Select } from "../../components/ui";
import { getMusicTrack, MUSIC_TRACKS, musicUrl, type MusicTrackId } from "../../game/audio/music";

const options = MUSIC_TRACKS.map((track) => ({ value: track.id, label: track.title, description: track.style }));

export function MusicLibrary() {
  const dayMusic = usePreferences((state) => state.dayMusic);
  const nightMusic = usePreferences((state) => state.nightMusic);
  const volume = usePreferences((state) => state.musicVolume);
  const update = usePreferences((state) => state.update);
  const player = useRef<HTMLAudioElement>(null);
  const request = useRef(0);
  const [selected, setSelected] = useState<MusicTrackId>("sunline");
  const [playing, setPlaying] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (player.current) player.current.volume = volume;
  }, [volume]);

  useEffect(() => {
    const audio = player.current;
    const hide = () => { if (document.hidden) audio?.pause(); };
    document.addEventListener("visibilitychange", hide);
    return () => {
      request.current += 1;
      document.removeEventListener("visibilitychange", hide);
      audio?.pause();
      audio?.removeAttribute("src");
      audio?.load();
    };
  }, []);

  function preview(id: MusicTrackId) {
    const audio = player.current;
    if (!audio) return;
    const currentRequest = ++request.current;
    setError("");
    if (id === selected && !audio.paused) { audio.pause(); return; }
    if (id !== selected || !audio.getAttribute("src")) {
      audio.src = musicUrl(id);
      setSelected(id);
    }
    void audio.play().catch((cause: unknown) => {
      if (currentRequest !== request.current) return;
      if (cause instanceof DOMException && cause.name === "AbortError") return;
      setError("Не удалось включить трек. Нажми «Слушать», чтобы попробовать ещё раз.");
    });
  }

  return (
    <div className="music-library">
      <h3>Саундтрек забега</h3>
      <p className="settings-note">Три композиции без вокала. Сравни звучание и выбери музыку для каждого режима.</p>
      <div className="music-tracks">
        {MUSIC_TRACKS.map((track) => (
          <div className="music-track" key={track.id} style={{ borderInlineStartColor: track.color }}>
            <div className="music-track-copy">
              <strong>{track.title}</strong>
              <p>{track.description}</p>
            </div>
            <Button variant="secondary" aria-label={`${selected === track.id && playing ? "Пауза" : "Слушать"}: ${track.title}`}
              aria-pressed={selected === track.id && playing} onClick={() => preview(track.id)}>
              {selected === track.id && playing ? <Pause size={16} aria-hidden="true" /> : <Play size={16} aria-hidden="true" />}
              {selected === track.id && playing ? "Пауза" : "Слушать"}
            </Button>
          </div>
        ))}
      </div>
      <div className="music-preview">
        <span>Прослушивание: <b>{getMusicTrack(selected).title}</b></span>
        <audio ref={player} controls preload="none" aria-label={`Прослушивание: ${getMusicTrack(selected).title}`}
          onPlay={() => setPlaying(true)} onPause={() => setPlaying(false)} onEnded={() => setPlaying(false)}
          onError={() => setError("Аудиофайл недоступен. Обнови страницу и попробуй ещё раз.")} />
        <small>Громкость — ползунком «Громкость музыки» выше. Прослушивание доступно и при выключенной музыке в игре.</small>
        {error && <p role="alert">{error}</p>}
      </div>
      <div className="setting-row">
        <span className="setting-row-text"><span className="setting-row-label">Дневной город</span></span>
        <div className="setting-row-control"><Select value={getMusicTrack(dayMusic).id} options={options}
          ariaLabel="Музыка дневного режима" onValueChange={(value) => { if (value) update({ dayMusic: getMusicTrack(value).id }); }} /></div>
      </div>
      <div className="setting-row">
        <span className="setting-row-text"><span className="setting-row-label">Ночной город</span></span>
        <div className="setting-row-control"><Select value={getMusicTrack(nightMusic).id} options={options}
          ariaLabel="Музыка ночного режима" onValueChange={(value) => { if (value) update({ nightMusic: getMusicTrack(value).id }); }} /></div>
      </div>
      <p className="settings-note">Выбор сохраняется автоматически и применяется в следующем забеге.</p>
    </div>
  );
}
