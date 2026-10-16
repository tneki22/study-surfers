/*
 * Чистая логика раздела «История»: параметры адреса, отбор и порядок колод,
 * группировка забегов по дням, расчёты аналитики. Без React и без запросов —
 * поэтому проверяется unit-тестами.
 */
import type { DeckStats, DeckSummary, ItemsFilter, QuizItem, RunSettings, RunSummary } from "../../api/types";
import { DIFFICULTY_LABEL, PACE_LABEL, type Pace } from "../../game/engine/settings";

export const RUNS_PAGE_SIZE = 20;
/** Сколько частых ошибок видно сразу; остальные раскрываются кнопкой. */
export const FREQUENT_PREVIEW = 5;
/** Уже этой ширины список колод и выбранная колода показываются по очереди. */
export const WIDE_QUERY = "(min-width: 900px)";

// --- Параметры адреса ---------------------------------------------------------------

export type HistoryTab = "runs" | "analytics";

export interface HistoryView {
  deck: string | null;
  tab: HistoryTab;
  /** Раскрытый забег; имеет смысл только на вкладке «Забеги». */
  run: string | null;
}

export function readHistoryView(params: URLSearchParams): HistoryView {
  const tab: HistoryTab = params.get("tab") === "analytics" ? "analytics" : "runs";
  return {
    deck: params.get("deck") || null,
    tab,
    run: tab === "runs" ? params.get("run") || null : null,
  };
}

/** Адресная строка для состояния: значения по умолчанию в адрес не попадают. */
export function historySearch(view: Partial<HistoryView>): string {
  const params = new URLSearchParams();
  if (view.deck) params.set("deck", view.deck);
  if (view.tab === "analytics") params.set("tab", "analytics");
  else if (view.run) params.set("run", view.run);
  const text = params.toString();
  return text ? `?${text}` : "";
}

// --- Колоды ----------------------------------------------------------------------------

const time = (iso: string | null): number => (iso ? Date.parse(iso) : Number.NEGATIVE_INFINITY);

/** Только колоды с забегами, последняя сыгранная — первой. */
export function decksWithRuns(decks: DeckSummary[]): DeckSummary[] {
  return decks
    .filter((deck) => deck.runs_count > 0)
    .sort((a, b) => time(b.last_played_at) - time(a.last_played_at) || a.title.localeCompare(b.title, "ru"));
}

const fold = (text: string): string => text.toLocaleLowerCase("ru").replaceAll("ё", "е").replace(/\s+/g, " ").trim();

export function filterDecks(decks: DeckSummary[], query: string): DeckSummary[] {
  const needle = fold(query);
  return needle ? decks.filter((deck) => fold(deck.title).includes(needle)) : decks;
}

/**
 * Какая колода открыта. Колоды из адреса, которой нет в истории, нет; на широком
 * экране тогда открывается первая, на узком — остаётся список.
 */
export function resolveSelectedDeck(decks: DeckSummary[], requested: string | null, wide: boolean): DeckSummary | null {
  const found = requested ? decks.find((deck) => deck.id === requested) : undefined;
  return found ?? (wide ? decks[0] ?? null : null);
}

// --- Забеги ------------------------------------------------------------------------------

/** Доля верных ответов; без ответов её нет — и деления на ноль тоже. */
export function accuracy(correct: number, wrong: number): number | null {
  const answered = correct + wrong;
  return answered > 0 ? correct / answered : null;
}

export function percent(value: number | null): string {
  return value === null ? "—" : `${Math.round(value * 100)} %`;
}

/** Следующая страница дописывается в конец; забеги, уже показанные при сдвиге архива, пропускаются. */
export function mergeRunPages(current: RunSummary[], page: RunSummary[]): RunSummary[] {
  const known = new Set(current.map((run) => run.id));
  return [...current, ...page.filter((run) => !known.has(run.id))];
}

export function formatDuration(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const rest = seconds % 60;
  if (hours > 0) return `${hours} ч ${String(minutes).padStart(2, "0")} мин`;
  if (minutes > 0) return `${minutes} мин ${String(rest).padStart(2, "0")} с`;
  return `${rest} с`;
}

const clock = new Intl.DateTimeFormat("ru-RU", { hour: "2-digit", minute: "2-digit" });
const dayMonth = new Intl.DateTimeFormat("ru-RU", { day: "numeric", month: "long" });
const dayMonthYear = new Intl.DateTimeFormat("ru-RU", { day: "numeric", month: "long", year: "numeric" });
const shortDate = new Intl.DateTimeFormat("ru-RU", { day: "numeric", month: "short" });
const shortDateYear = new Intl.DateTimeFormat("ru-RU", { day: "numeric", month: "short", year: "numeric" });

export const formatClock = (iso: string): string => clock.format(new Date(iso));

/** «14 окт.» — год только для прошлых лет. */
export function formatShortDate(iso: string, now: Date = new Date()): string {
  const date = new Date(iso);
  return (date.getFullYear() === now.getFullYear() ? shortDate : shortDateYear).format(date);
}

/** «14 окт., 10:32» — дата и время одной строкой. */
export function formatMoment(iso: string, now: Date = new Date()): string {
  return `${formatShortDate(iso, now)}, ${clock.format(new Date(iso))}`;
}

const dayKey = (date: Date): string =>
  `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;

function dayLabel(date: Date, now: Date): string {
  const today = dayKey(now);
  const yesterday = dayKey(new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1));
  const key = dayKey(date);
  if (key === today) return "Сегодня";
  if (key === yesterday) return "Вчера";
  return (date.getFullYear() === now.getFullYear() ? dayMonth : dayMonthYear).format(date);
}

export interface RunDay {
  key: string;
  label: string;
  runs: RunSummary[];
}

/** Забеги в том порядке, как пришли (новые первыми), сгруппированные по дню окончания в часовом поясе пользователя. */
export function groupRunsByDay(runs: RunSummary[], now: Date = new Date()): RunDay[] {
  const days: RunDay[] = [];
  for (const run of runs) {
    const date = new Date(run.finished_at);
    const key = dayKey(date);
    const last = days.at(-1);
    if (last?.key === key) last.runs.push(run);
    else days.push({ key, label: dayLabel(date, now), runs: [run] });
  }
  return days;
}

// --- Сохранённые настройки забега ------------------------------------------------------------

export const FILTER_LABEL: Record<ItemsFilter, string> = {
  all: "Все карточки",
  weak: "Слабые",
  last_mistakes: "Ошибки прошлого забега",
};

export function describePace(pace: RunSettings["pace"]): string {
  if (typeof pace === "number") return `скорость ${pace}`;
  if (Object.hasOwn(PACE_LABEL, pace)) return PACE_LABEL[pace as Pace];
  const custom = /^custom:(\d+(?:[.,]\d+)?)$/.exec(pace);
  return custom ? `${PACE_LABEL.custom}: ${custom[1]} с` : pace;
}

export interface SettingFact {
  label: string;
  value: string;
}

export function settingFacts(settings: RunSettings): SettingFact[] {
  return [
    { label: "Треки", value: String(settings.lanes) },
    { label: "Сложность", value: DIFFICULTY_LABEL[settings.difficulty] ?? settings.difficulty },
    { label: "Какие карточки", value: FILTER_LABEL[settings.filter ?? "all"] ?? String(settings.filter) },
    { label: "Темп", value: describePace(settings.pace) },
    { label: "Жизни", value: settings.lives ? String(settings.lives) : "выключены" },
  ];
}

// --- Аналитика -----------------------------------------------------------------------------

export interface FrequentMistake {
  item: QuizItem;
  /** `seen − correct`: сколько раз карточка встретилась и не была угадана. */
  errors: number;
  seen: number;
}

const programOrder = (item: QuizItem): [number, number] => [item.question_ordinal ?? Number.MAX_SAFE_INTEGER, item.seq];

/**
 * Активные карточки с ошибками за всё время. Больше ошибок — выше; при равенстве выше та,
 * где ошибок больше доля, затем порядок программы, как в забеге «По программе».
 */
export function frequentMistakes(items: QuizItem[]): FrequentMistake[] {
  const rows: FrequentMistake[] = [];
  for (const item of items) {
    const stats = item.stats;
    if (!item.enabled || !stats) continue;
    const errors = stats.seen - stats.correct;
    if (errors > 0) rows.push({ item, errors, seen: stats.seen });
  }
  return rows.sort((a, b) => {
    const [aOrdinal, aSeq] = programOrder(a.item);
    const [bOrdinal, bSeq] = programOrder(b.item);
    return b.errors - a.errors || b.errors / b.seen - a.errors / a.seen || aOrdinal - bOrdinal || aSeq - bSeq;
  });
}

/** Точность карточки по всем показам; пока её не показывали, значения нет. */
export const itemAccuracy = (mistake: Pick<FrequentMistake, "errors" | "seen">): number | null =>
  accuracy(mistake.seen - mistake.errors, mistake.errors);

export interface TopicRow {
  key: string;
  label: string;
  accuracy: number;
  /** Карточек темы, на которые уже отвечали. */
  count: number;
}

export const NO_TOPIC = "Без темы";

/** Темы от слабой к сильной. Безымянная группа называется «Без темы». */
export function topicRows(sections: DeckStats["by_section"]): TopicRow[] {
  return sections
    .map((section, index) => ({
      key: `${index}:${section.section ?? ""}`,
      label: section.section?.trim() || NO_TOPIC,
      accuracy: section.accuracy,
      count: section.count,
    }))
    .sort((a, b) => a.accuracy - b.accuracy || b.count - a.count || a.label.localeCompare(b.label, "ru"));
}
