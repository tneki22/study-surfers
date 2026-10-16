import type { ItemsFilter, ItemsPage } from "./types";

type PageQuery = { since?: number; filter?: ItemsFilter; limit?: number };
type ListItems = (deckId: string, query: PageQuery) => Promise<ItemsPage>;

/** Читает весь доступный хвост курсора, в том числе после окончания генерации. */
export async function loadItemPages(
  listItems: ListItems,
  deckId: string,
  query: PageQuery = {},
  cancelled: () => boolean = () => false,
): Promise<ItemsPage> {
  const limit = query.limit ?? 500;
  let since = query.since ?? 0;
  const items: ItemsPage["items"] = [];
  while (!cancelled()) {
    const page = await listItems(deckId, { ...query, since, limit });
    if (cancelled()) throw new DOMException("Загрузка отменена", "AbortError");
    items.push(...page.items);
    if (page.items.length < limit) return { ...page, items };
    if (page.next_since <= since) throw new Error("Не удалось продолжить загрузку карточек: курсор не изменился.");
    since = page.next_since;
  }
  throw new DOMException("Загрузка отменена", "AbortError");
}
