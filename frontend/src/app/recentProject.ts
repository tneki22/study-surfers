import { create } from "zustand";
import { persist } from "zustand/middleware";
import type { DeckSummary } from "../api/types";

interface RecentProjectStore {
  deckId: string | null;
  remember: (deckId: string) => void;
}

/** Храним только идентификатор: название и доступность всегда берём с сервера. */
export const useRecentProject = create<RecentProjectStore>()(
  persist(
    (set, get) => ({
      deckId: null,
      remember: (deckId) => {
        if (get().deckId !== deckId) set({ deckId });
      },
    }),
    { name: "ss:recent-project", version: 1, partialize: ({ deckId }) => ({ deckId }) },
  ),
);

/** До первого открытия используем последний забег; удалённую колоду не предлагаем. */
export function selectRecentProject(decks: DeckSummary[], deckId: string | null): DeckSummary | null {
  const saved = decks.find((deck) => deck.id === deckId);
  if (saved) return saved;
  const playable = decks.filter((deck) => deck.enabled_item_count > 0);
  const candidates = playable.length ? playable : decks;
  return candidates.reduce<DeckSummary | null>((latest, deck) => {
    if (!latest) return deck;
    const time = deck.last_played_at ?? deck.updated_at;
    const latestTime = latest.last_played_at ?? latest.updated_at;
    // Сыгранная колода важнее недавно созданной, по которой ещё не было забегов.
    if (Boolean(deck.last_played_at) !== Boolean(latest.last_played_at)) return deck.last_played_at ? deck : latest;
    return time > latestTime ? deck : latest;
  }, null);
}
