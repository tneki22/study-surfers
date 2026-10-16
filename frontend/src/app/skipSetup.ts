import { create } from "zustand";
import { persist } from "zustand/middleware";

interface SkipSetupStore {
  /** Колоды, для которых настройка перед стартом отключена галочкой «Запомнить». */
  deckIds: string[];
  setSkip: (deckId: string, skip: boolean) => void;
}

export const useSkipSetup = create<SkipSetupStore>()(
  persist(
    (set, get) => ({
      deckIds: [],
      setSkip: (deckId, skip) => {
        const has = get().deckIds.includes(deckId);
        if (skip && !has) set({ deckIds: [...get().deckIds, deckId] });
        if (!skip && has) set({ deckIds: get().deckIds.filter((id) => id !== deckId) });
      },
    }),
    { name: "ss:skip-setup", version: 1, partialize: ({ deckIds }) => ({ deckIds }) },
  ),
);
