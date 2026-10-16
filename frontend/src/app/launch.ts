import { useNavigate } from "react-router";
import type { SessionSettings } from "../game/engine/settings";
import { useSession } from "./stores";
import { useRecentProject } from "./recentProject";
import { useSkipSetup } from "./skipSetup";

interface StartOptions {
  settings?: SessionSettings;
  itemIds?: string[];
  live?: boolean;
}

/**
 * Запуск забега из любого экрана. `start` сохраняет настройки как «последние»
 * (по ним работает быстрый старт) и уходит на трассу; `setup` — на экран настроек;
 * `run` — настройки, а на трассу сразу только для колод с галочкой «Запомнить».
 */
export function useRunLauncher() {
  const navigate = useNavigate();
  const setLaunch = useSession((state) => state.setLaunch);
  const lastSettings = useSession((state) => state.settings);

  return {
    start(deckId: string, options: StartOptions = {}) {
      useRecentProject.getState().remember(deckId);
      setLaunch({ deckId, settings: options.settings ?? lastSettings, itemIds: options.itemIds, live: options.live });
      navigate(`/play/${deckId}`);
    },
    /** Кнопка «Бежать» у колоды: сначала настройки, если их не отключили галочкой на экране настроек. */
    run(deckId: string, live = false) {
      if (useSkipSetup.getState().deckIds.includes(deckId)) this.start(deckId, { live });
      else this.setup(deckId, live);
    },
    setup(deckId: string, live = false) {
      useRecentProject.getState().remember(deckId);
      navigate(`/decks/${deckId}/setup${live ? "?live=1" : ""}`);
    },
  };
}
