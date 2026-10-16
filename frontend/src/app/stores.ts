import { create } from "zustand";
import { persist } from "zustand/middleware";
import { DEFAULT_SETTINGS, type SessionSettings } from "../game/engine/settings";
import { DEFAULT_CHARACTER, type CharacterId } from "../game/scene/runner/characters";
import { DEFAULT_DAY_TRACK, DEFAULT_NIGHT_TRACK, getMusicTrack, type MusicTrackId } from "../game/audio/music";

/** Запуск забега: какая колода, с какими настройками, при необходимости — конкретные карточки. */
export interface Launch {
  /** Растёт с каждым запуском: экран забега пересоздаётся, даже если колода та же. */
  id: number;
  deckId: string;
  settings: SessionSettings;
  /** «Повторить ошибки»: играть только эти карточки. */
  itemIds?: string[];
  /** Колода ещё генерируется: догружать новые карточки во время забега. */
  live?: boolean;
}

interface SessionStore {
  /** Последние настройки — их берёт «Быстрый старт». */
  settings: SessionSettings;
  launch: Launch | null;
  saveSettings: (settings: SessionSettings) => void;
  setLaunch: (launch: Omit<Launch, "id">) => void;
}

export const useSession = create<SessionStore>()(
  persist(
    (set) => ({
      settings: DEFAULT_SETTINGS,
      launch: null,
      saveSettings: (settings) => set({ settings }),
      setLaunch: (launch) => set((state) => ({
        launch: { ...launch, id: (state.launch?.id ?? 0) + 1 },
        settings: launch.itemIds ? state.settings : launch.settings,
      })),
    }),
    {
      name: "ss:session",
      version: 1,
      partialize: (state) => ({ settings: state.settings }),
      merge: (persisted, current) => ({
        ...current,
        settings: { ...DEFAULT_SETTINGS, ...(persisted as Partial<SessionStore> | undefined)?.settings },
      }),
    },
  ),
);

export type Quality = "auto" | "low" | "medium" | "high";

export interface Preferences {
  quality: Quality;
  musicVolume: number;
  sfxVolume: number;
  musicEnabled: boolean;
  dayMusic: MusicTrackId;
  nightMusic: MusicTrackId;
  reducedMotion: boolean;
  keyHints: boolean;
  character: CharacterId;
  /** Счётчик кадров и имя видеокарты в забеге. */
  showFps: boolean;
  /** Свои пресеты поля «Промпт»; само поле при каждом открытии начинается с пресета по умолчанию. */
  learnerPrompts: CustomPrompt[];
}

export interface CustomPrompt {
  id: string;
  label: string;
  text: string;
}

export const DEFAULT_PREFERENCES: Preferences = {
  quality: "auto",
  musicVolume: 0.35,
  sfxVolume: 0.7,
  musicEnabled: true,
  dayMusic: DEFAULT_DAY_TRACK,
  nightMusic: DEFAULT_NIGHT_TRACK,
  reducedMotion: typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches,
  keyHints: true,
  character: DEFAULT_CHARACTER,
  showFps: false,
  learnerPrompts: [],
};

interface PreferencesStore extends Preferences {
  update: (patch: Partial<Preferences>) => void;
}

export const usePreferences = create<PreferencesStore>()(
  persist(
    (set) => ({ ...DEFAULT_PREFERENCES, update: (patch) => set(patch) }),
    {
      name: "ss:preferences", version: 3,
      migrate: (persisted, version) => {
        const { learnerPrompt, ...saved } = persisted as Partial<Preferences> & { learnerPrompt?: string | null };
        return {
          ...saved,
          ...(version < 2 ? { dayMusic: DEFAULT_DAY_TRACK, nightMusic: DEFAULT_NIGHT_TRACK } : {}),
          // Единственный «Мой» из прошлых версий становится первым своим пресетом.
          learnerPrompts: learnerPrompt ? [{ id: "mine", label: "Мой", text: learnerPrompt }] : saved.learnerPrompts ?? [],
        };
      },
      merge: (persisted, current) => {
        const saved = persisted as Partial<Preferences> | undefined;
        return { ...current, ...saved,
          dayMusic: getMusicTrack(saved?.dayMusic ?? DEFAULT_DAY_TRACK).id,
          nightMusic: getMusicTrack(saved?.nightMusic ?? DEFAULT_NIGHT_TRACK).id,
        };
      },
    },
  ),
);
