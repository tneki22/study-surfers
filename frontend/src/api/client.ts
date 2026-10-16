import { realAi, realTentex, type AiApi, type TentexApi } from "./ai";
import { request } from "./http";
import { mockApi } from "./mock";
import type {
  DeckDetail,
  DeckQuestion,
  DeckStats,
  DeckSummary,
  ExportFormat,
  FlashcardImported,
  FlashcardOptions,
  FlashcardPreview,
  Health,
  ImportStarted,
  ItemsFilter,
  ItemsPage,
  ItemsPerQuestion,
  Job,
  LearnerPresets,
  QuickImportOptions,
  QuizItem,
  RegenerateMode,
  RunDetail,
  RunIn,
  RunSummary,
} from "./types";

export interface ItemsQuery {
  since?: number;
  filter?: ItemsFilter;
  includeDisabled?: boolean;
  limit?: number;
}

/** Страница архива забегов: `limit` (по умолчанию 20) и сдвиг от самого нового. */
export interface RunsQuery {
  limit?: number;
  offset?: number;
}

export type ItemPatch = Partial<Pick<QuizItem, "prompt" | "correct" | "distractors" | "explanation" | "enabled">>;

/** Всё, что фронтенд просит у бэкенда. Две реализации: настоящая (`/api`) и mock на демо-колоде. */
export interface Api {
  readonly mock: boolean;
  readonly ai: AiApi;
  readonly tentex: TentexApi;
  health(): Promise<Health>;
  listDecks(): Promise<DeckSummary[]>;
  getDeck(id: string): Promise<DeckDetail>;
  renameDeck(id: string, title: string): Promise<DeckDetail>;
  deleteDeck(id: string): Promise<void>;
  listQuestions(deckId: string): Promise<DeckQuestion[]>;
  listItems(deckId: string, query?: ItemsQuery): Promise<ItemsPage>;
  patchItem(id: string, patch: ItemPatch): Promise<QuizItem>;
  deleteItem(id: string): Promise<void>;
  regenerateItem(id: string, mode: RegenerateMode): Promise<QuizItem>;
  regenerateQuestion(deckId: string, questionId: string, itemsPerQuestion?: ItemsPerQuestion): Promise<{ job_id: string }>;
  /** Пресеты поля «Промпт» над колодами: уровень игрока и что спрашивать. */
  learnerPresets(): Promise<LearnerPresets>;
  quickImport(files: File[], text: string, options: QuickImportOptions): Promise<ImportStarted>;
  getJob(id: string): Promise<Job>;
  confirmJob(id: string): Promise<Job>;
  cancelJob(id: string): Promise<Job>;
  resumeJob(id: string): Promise<Job>;
  listDeckJobs(deckId: string, active?: boolean): Promise<Job[]>;
  postRun(run: RunIn): Promise<RunDetail>;
  /** Забеги колоды от новых к старым; без `query` — как раньше, последние 20. */
  listRuns(deckId: string, query?: RunsQuery): Promise<RunSummary[]>;
  getRun(id: string): Promise<RunDetail>;
  getDeckStats(deckId: string): Promise<DeckStats>;
  exportDeckUrl(deckId: string, format?: ExportFormat): string;
  importDeckFile(file: File): Promise<DeckDetail>;
  /** Мастер импорта Anki/Quizlet/CSV: поля, план и примеры без сохранения. */
  previewFlashcards(file: File, options: FlashcardOptions): Promise<FlashcardPreview>;
  importFlashcards(file: File, options: FlashcardOptions): Promise<FlashcardImported>;
}

const json = (body: unknown): RequestInit => ({ body: JSON.stringify(body) });

function itemsQuery(query: ItemsQuery): string {
  const params = new URLSearchParams();
  if (query.since !== undefined) params.set("since", String(query.since));
  if (query.filter) params.set("filter", query.filter);
  if (query.includeDisabled) params.set("include_disabled", "true");
  if (query.limit !== undefined) params.set("limit", String(query.limit));
  const text = params.toString();
  return text ? `?${text}` : "";
}

function runsQuery(query: RunsQuery): string {
  const params = new URLSearchParams();
  if (query.limit !== undefined) params.set("limit", String(query.limit));
  if (query.offset !== undefined) params.set("offset", String(query.offset));
  const text = params.toString();
  return text ? `?${text}` : "";
}

const realApi: Api = {
  mock: false,
  ai: realAi,
  tentex: realTentex,
  health: () => request("/api/health"),
  listDecks: () => request("/api/decks"),
  getDeck: (id) => request(`/api/decks/${id}`),
  renameDeck: (id, title) => request(`/api/decks/${id}`, { method: "PATCH", ...json({ title }) }),
  deleteDeck: (id) => request(`/api/decks/${id}`, { method: "DELETE" }),
  listQuestions: (deckId) => request(`/api/decks/${deckId}/questions`),
  listItems: (deckId, query = {}) => request(`/api/decks/${deckId}/items${itemsQuery(query)}`),
  patchItem: (id, patch) => request(`/api/items/${id}`, { method: "PATCH", ...json(patch) }),
  deleteItem: (id) => request(`/api/items/${id}`, { method: "DELETE" }),
  regenerateItem: (id, mode) => request(`/api/items/${id}/regenerate`, { method: "POST", ...json({ mode }) }),
  regenerateQuestion: (deckId, questionId, itemsPerQuestion) => request(`/api/decks/${deckId}/questions/${questionId}/regenerate`, {
    method: "POST",
    ...json({ items_per_question: itemsPerQuestion ?? null }),
  }),
  learnerPresets: () => request("/api/imports/learner-presets"),
  quickImport: (files, text, options) => {
    const form = new FormData();
    for (const file of files) form.append("files", file);
    if (text.trim()) form.append("text", text);
    form.append("options", JSON.stringify(options));
    return request("/api/imports/quick", { method: "POST", body: form });
  },
  getJob: (id) => request(`/api/jobs/${id}`),
  confirmJob: (id) => request(`/api/jobs/${id}/confirm`, { method: "POST" }),
  cancelJob: (id) => request(`/api/jobs/${id}/cancel`, { method: "POST" }),
  resumeJob: (id) => request(`/api/jobs/${id}/resume`, { method: "POST" }),
  listDeckJobs: (deckId, active) => request(`/api/decks/${deckId}/jobs${active ? "?active=true" : ""}`),
  postRun: (run) => request("/api/runs", { method: "POST", ...json(run) }),
  listRuns: (deckId, query = {}) => request(`/api/decks/${deckId}/runs${runsQuery(query)}`),
  getRun: (id) => request(`/api/runs/${id}`),
  getDeckStats: (deckId) => request(`/api/decks/${deckId}/stats`),
  exportDeckUrl: (deckId, format = "ssdeck") => `/api/decks/${deckId}/export${format === "anki" ? "?format=anki" : ""}`,
  importDeckFile: (file) => {
    const form = new FormData();
    form.append("file", file);
    return request("/api/decks/import", { method: "POST", body: form });
  },
  previewFlashcards: (file, options) => request("/api/imports/flashcards?dry_run=true", { method: "POST", body: flashcardsForm(file, options) }),
  importFlashcards: (file, options) => request("/api/imports/flashcards", { method: "POST", body: flashcardsForm(file, options) }),
};

function flashcardsForm(file: File, options: FlashcardOptions): FormData {
  const form = new FormData();
  form.append("file", file);
  form.append("options", JSON.stringify(options));
  return form;
}

export const api: Api = import.meta.env.VITE_API_MOCK === "1" ? mockApi : realApi;
