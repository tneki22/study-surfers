/*
 * Mock-бэкенд в памяти браузера (`npm run dev:mock`). Держит демо-колоду из
 * fixtures/ и имитирует быструю загрузку: стадии задачи и постепенное
 * появление карточек. Нужен, чтобы игру и экраны можно было делать и
 * проверять без бэкенда; поведение повторяет контракт из contract/.
 */
import demoDeckJson from "@fixtures/demo-deck.ssdeck.json";
import type { Api } from "./client";
import { ApiError } from "./http";
import { mockAi, mockGeneratorReady } from "./mockAi";
import type {
  DeckDetail,
  DeckFile,
  DeckQuestion,
  DeckStats,
  DeckSummary,
  Job,
  QuizItem,
  RunDetail,
  RunIn,
  RunSummary,
} from "./types";

const demoDeck = demoDeckJson as unknown as DeckFile;

interface MockDeck {
  detail: Omit<DeckDetail, "item_count" | "enabled_item_count" | "status" | "active_job_id" | "runs_count" | "best_score" | "last_played_at" | "weak_count" | "best_by_setup">;
  questions: DeckQuestion[];
  items: QuizItem[];
  runs: RunDetail[];
  job: MockJob | null;
}

interface MockJob {
  id: string;
  deckId: string;
  startedAt: number;
  pending: QuizItem[];
  cancelled: boolean;
}

const decks = new Map<string, MockDeck>();
const jobs = new Map<string, MockJob>();

const STAGES = [
  { until: 1200, state: "extracting", label: "Читаю файлы" },
  { until: 3200, state: "structuring", label: "Разбираю материал" },
] as const;
const ITEM_EVERY_MS = 450;
const MIN_PLAYABLE = 8;

const now = () => new Date().toISOString();
const delay = <T>(value: T, ms = 120): Promise<T> => new Promise((resolve) => setTimeout(() => resolve(value), ms));
const clone = <T>(value: T): T => structuredClone(value);

function notFound(what: string): never {
  throw new ApiError(404, `${what} не найдено`, "not_found");
}

function deckItems(file: DeckFile, deckId: string, questionIds: Map<string, string>): QuizItem[] {
  return file.items.map((item, index) => {
    const question = file.questions.find((q) => q.uid === item.question_uid);
    return {
      id: crypto.randomUUID(),
      deck_id: deckId,
      question_id: item.question_uid ? questionIds.get(item.question_uid) ?? null : null,
      question_ordinal: question?.ordinal ?? null,
      seq: index + 1,
      prompt: item.prompt,
      correct: item.correct,
      distractors: clone(item.distractors),
      explanation: item.explanation,
      source: item.source,
      evidence_quote: item.evidence_quote ?? null,
      section: question?.section ?? null,
      enabled: item.enabled ?? true,
      edited: false,
      stats: null,
      created_at: now(),
      updated_at: now(),
    };
  });
}

function createDeck(file: DeckFile, sourceKind: DeckDetail["source_kind"], title = file.deck.title, id: string = crypto.randomUUID()): MockDeck {
  const questionIds = new Map(file.questions.map((q) => [q.uid, crypto.randomUUID()]));
  const items = deckItems(file, id, questionIds);
  const deck: MockDeck = {
    detail: {
      id,
      title,
      description: file.deck.description,
      source_kind: sourceKind,
      question_count: file.questions.length,
      options: {},
      questions_summary: { total: file.questions.length, done: file.questions.length, failed: 0, pending: 0 },
      sources: [],
      created_at: now(),
      updated_at: now(),
    },
    questions: file.questions.map((q) => ({
      id: questionIds.get(q.uid)!,
      ordinal: q.ordinal,
      number_label: q.number_label,
      section: q.section ?? null,
      text: q.text,
      has_answer: Boolean(q.answer_text),
      match_method: "exact",
      status: "done",
      error: null,
      item_count: items.filter((item) => item.question_id === questionIds.get(q.uid)).length,
    })),
    items,
    runs: [],
    job: null,
  };
  decks.set(id, deck);
  return deck;
}

// Роли файлов mock-задачи: «Авто» определяет их чуть позже начала разбора.
const MOCK_SOURCES: Job["sources"] = [
  { filename: "Билеты.pdf", role: "questions" },
  { filename: "Лекции.pdf", role: "notes" },
];
const ROLES_KNOWN_AT = 1800;

// Постоянный id демо-колоды: перезагрузка страницы забега в mock-режиме не теряет колоду.
createDeck(demoDeck, "demo", demoDeck.deck.title, "00000000-0000-4000-8000-00000000de30");

const MOCK_TENTEX = [
  { id: "p1", name: "Матанализ — экзамен", status: "active", question_count: 42, answer_count: 40, card_count: 120, updated_at: "2026-10-01T10:00:00Z" },
  { id: "p2", name: "Теория вероятностей", status: "active", question_count: 25, answer_count: 0, card_count: 0, updated_at: "2026-09-12T10:00:00Z" },
];
const MOCK_LAST = { deckId: "" };

/** Новая колода из демо-фикстуры с имитацией постепенной генерации. */
function startMockJob(title: string, sourceKind: DeckDetail["source_kind"]): Promise<{ deck_id: string; job_id: string }> {
  const deck = createDeck(demoDeck, sourceKind, title);
  const job: MockJob = { id: crypto.randomUUID(), deckId: deck.detail.id, startedAt: Date.now(), pending: deck.items, cancelled: false };
  deck.items = [];
  deck.job = job;
  jobs.set(job.id, job);
  MOCK_LAST.deckId = deck.detail.id;
  return delay({ deck_id: deck.detail.id, job_id: job.id }, 400);
}

/** Продвигает имитацию генерации: по времени «готовит» очередные карточки. */
function tick(job: MockJob) {
  const deck = decks.get(job.deckId);
  if (!deck || job.cancelled) return;
  const elapsed = Date.now() - job.startedAt - STAGES[STAGES.length - 1].until;
  const due = elapsed < 0 ? 0 : Math.min(job.pending.length + deck.items.length, Math.floor(elapsed / ITEM_EVERY_MS) + 1);
  while (deck.items.length < due && job.pending.length) {
    const item = job.pending.shift()!;
    deck.items.push({ ...item, seq: deck.items.length + 1, created_at: now() });
  }
  if (!job.pending.length && deck.job === job) deck.job = null;
}

function jobView(job: MockJob): Job {
  tick(job);
  const deck = decks.get(job.deckId)!;
  const elapsed = Date.now() - job.startedAt;
  const total = deck.items.length + job.pending.length;
  const finished = !job.pending.length;
  const stage = STAGES.find((s) => elapsed < s.until);
  const state: Job["state"] = job.cancelled ? "cancelled" : finished ? "done" : stage ? stage.state : "generating";
  return {
    id: job.id,
    deck_id: job.deckId,
    kind: "quick_import",
    state,
    stage_label: stage && !finished ? stage.label : `Карточки ${deck.items.length} из ${total}`,
    done: deck.items.length,
    total,
    ready_items: deck.items.length,
    failed_questions: 0,
    can_play: deck.items.length >= MIN_PLAYABLE || (finished && deck.items.length > 0),
    warnings: [
      { code: "questions_without_answer", message: "1 вопрос без ответа в материалах — ответит ИИ", context: { count: 1 } },
    ],
    error: null,
    estimate: null,
    usage: { input_tokens: 0, output_tokens: 0, cost_usd: null },
    sources: MOCK_SOURCES.map((source) => (elapsed < ROLES_KNOWN_AT ? { ...source, role: null } : source)),
    created_at: new Date(job.startedAt).toISOString(),
    finished_at: finished ? now() : null,
  };
}

function summary(deck: MockDeck): DeckDetail {
  if (deck.job) tick(deck.job);
  const scores = deck.runs.map((run) => run.score);
  const generating = deck.job !== null;
  return {
    ...clone(deck.detail),
    status: generating ? "generating" : deck.items.length ? "ready" : "empty",
    item_count: deck.items.length,
    enabled_item_count: deck.items.filter((item) => item.enabled).length,
    active_job_id: deck.job?.id ?? null,
    runs_count: deck.runs.length,
    best_score: scores.length ? Math.max(...scores) : null,
    last_played_at: deck.runs.at(-1)?.finished_at ?? null,
    weak_count: deck.items.filter(isWeak).length,
    best_by_setup: bestBySetup(deck.runs),
  };
}

function bestBySetup(runs: RunDetail[]): DeckDetail["best_by_setup"] {
  const best = new Map<string, DeckDetail["best_by_setup"][number]>();
  for (const run of runs) {
    const { world = "classic", obstacles = "normal" } = run.settings;
    const key = `${world}/${obstacles}`;
    const known = best.get(key);
    if (!known || run.score > known.score) best.set(key, { world, obstacles, score: run.score });
  }
  return [...best.values()];
}

function isWeak(item: QuizItem): boolean {
  const stats = item.stats;
  if (!stats || stats.seen === 0) return false;
  const wrong = stats.seen - stats.correct;
  return (wrong > 0 && stats.streak < 2) || stats.correct / stats.seen < 0.6;
}

function getDeck(id: string): MockDeck {
  return decks.get(id) ?? notFound("Колода");
}

/** Точность по темам, как у сервера: только включённые карточки, на которые уже отвечали. */
function sectionStats(deck: MockDeck): DeckStats["by_section"] {
  const sections = new Map<string | null, { seen: number; correct: number; count: number }>();
  for (const item of deck.items) {
    if (!item.enabled || !item.stats) continue;
    const record = sections.get(item.section) ?? { seen: 0, correct: 0, count: 0 };
    record.seen += item.stats.seen;
    record.correct += item.stats.correct;
    record.count += 1;
    sections.set(item.section, record);
  }
  return [...sections].map(([section, record]) => ({
    section,
    accuracy: record.seen ? record.correct / record.seen : 0,
    count: record.count,
  }));
}

function lastMistakeIds(deck: MockDeck): Set<string> {
  const last = deck.runs.at(-1);
  return new Set(last?.mistakes.map((m) => m.item_id).filter((id): id is string => id !== null) ?? []);
}

export const mockApi: Api = {
  mock: true,
  ai: mockAi,
  tentex: {
    // Мнимый Tentex с двумя проектами: экран импорта можно посмотреть без настоящей базы.
    status: () => delay({ root: "C:\\Users\\demo\\Tentex", db_found: true, secret_found: true, running: false, projects_count: MOCK_TENTEX.length }),
    projects: () => delay(clone(MOCK_TENTEX)),
    importProject: (id, body) => {
      const project = MOCK_TENTEX.find((p) => p.id === id) ?? notFound("Проект Tentex");
      return startMockJob(body.title?.trim() || project.name, "tentex");
    },
    providers: () => delay([
      { tentex_id: "t1", label: "OpenRouter (Tentex)", base_url: "https://openrouter.ai/api/v1", catalog_profile: "openrouter", has_api_key: true, decryptable: true, model_count: 3, already_imported: false },
    ]),
    importProviders: async () => {
      await mockAi.createProvider({ label: "OpenRouter (Tentex)", base_url: "https://openrouter.ai/api/v1", catalog_profile: "openrouter", api_key: "mock" });
      const settings = await mockAi.settings();
      const imported = settings.providers.find((p) => p.label === "OpenRouter (Tentex)")!;
      await mockAi.addModel(imported.id, { model_id: "google/gemini-2.5-flash", display_name: "gemini-2.5-flash" });
      return mockAi.updateGlobal({ external_models_enabled: true, confirm_input_tokens: settings.confirm_input_tokens, confirm_cost_usd: settings.confirm_cost_usd });
    },
  },
  health: () => delay({ status: "ok", version: "mock", schema_version: 1, ai_ready: mockGeneratorReady() }),
  listDecks: () => delay([...decks.values()].map(summary) as DeckSummary[]),
  getDeck: (id) => delay(summary(getDeck(id))),
  renameDeck: (id, title) => {
    const deck = getDeck(id);
    deck.detail.title = title;
    return delay(summary(deck));
  },
  deleteDeck: (id) => {
    decks.delete(id);
    return delay(undefined);
  },
  listQuestions: (deckId) => delay(clone(getDeck(deckId).questions)),
  listItems: (deckId, query = {}) => {
    const deck = getDeck(deckId);
    if (deck.job) tick(deck.job);
    const since = query.since ?? 0;
    const mistakes = query.filter === "last_mistakes" ? lastMistakeIds(deck) : null;
    const matching = deck.items.filter((item) =>
      (query.includeDisabled || item.enabled)
      && (query.filter !== "weak" || isWeak(item))
      && (!mistakes || mistakes.has(item.id)));
    const items = matching.filter((item) => item.seq > since).sort((a, b) => a.seq - b.seq).slice(0, query.limit ?? 500);
    return delay({
      items: clone(items),
      next_since: items.at(-1)?.seq ?? since,
      total_ready: matching.length,
      job_active: deck.job !== null,
    });
  },
  patchItem: (id, patch) => {
    for (const deck of decks.values()) {
      const item = deck.items.find((candidate) => candidate.id === id);
      if (item) {
        Object.assign(item, patch, { edited: true, updated_at: now() });
        return delay(clone(item));
      }
    }
    return notFound("Карточка");
  },
  // Тексты пресетов — у бэкенда (app/pipeline/prompts.py); здесь сокращённые копии для вида экрана.
  learnerPresets: () => delay({
    default_id: "exam",
    max_length: 800,
    presets: [
      { id: "beginner", label: "Только начинаю", text: "Я только начинаю разбираться в теме. Спрашивай основу: главные определения, формулы и свойства. Объясняй простыми словами." },
      { id: "exam", label: "Готовлюсь к экзамену", text: "Готовлюсь к экзамену и тему в целом знаю. Спрашивай то, что спросит экзаменатор. В объяснении — почему верно и как запомнить." },
      { id: "advanced", label: "Знаю тему, хочу сложнее", text: "Тему знаю уверенно. Не спрашивай в лоб определения и основные формулы. Проверяй тонкости и границы применимости." },
    ],
  }),
  quickImport: (files, text, options) => {
    if (!files.length && !text.trim()) {
      return Promise.reject(new ApiError(422, "Добавьте файлы или вставьте текст", "import_empty"));
    }
    if (!mockGeneratorReady()) {
      return Promise.reject(new ApiError(409, "Не выбрана модель для генерации карточек", "ai_model_not_configured"));
    }
    const title = options.title?.trim()
      || files[0]?.name.replace(/\.[^.]+$/, "")
      || "Новая колода";
    const started = startMockJob(title, "upload");
    const deck = decks.get(MOCK_LAST.deckId)!;
    deck.detail.sources = files.map((file) => ({
      id: crypto.randomUUID(),
      filename: file.name,
      kind: (file.name.split(".").pop()?.toLowerCase() ?? "txt") as DeckDetail["sources"][number]["kind"],
      role: options.roles?.[file.name] ?? "combined",
      char_count: file.size,
      warnings: [],
    }));
    return started;
  },
  getJob: (id) => delay(jobView(jobs.get(id) ?? notFound("Задача"))),
  confirmJob: (id) => delay(jobView(jobs.get(id) ?? notFound("Задача"))),
  resumeJob: (id) => delay(jobView(jobs.get(id) ?? notFound("Задача"))),
  listDeckJobs: (deckId) => delay([...jobs.values()].filter((job) => job.deckId === deckId).map(jobView)),
  deleteItem: (id) => {
    for (const deck of decks.values()) {
      deck.items = deck.items.filter((item) => item.id !== id);
      for (const run of deck.runs) for (const mistake of run.mistakes) if (mistake.item_id === id) mistake.item_id = null;
    }
    return delay(undefined);
  },
  regenerateItem: (id) => {
    for (const deck of decks.values()) {
      const item = deck.items.find((candidate) => candidate.id === id);
      if (item) return delay(clone(item), 900);
    }
    return notFound("Карточка");
  },
  regenerateQuestion: () => Promise.reject(new ApiError(409, "В демо-режиме вопросы не перегенерируются", "job_state_conflict")),
  cancelJob: (id) => {
    const job = jobs.get(id) ?? notFound("Задача");
    job.cancelled = true;
    job.pending = [];
    const deck = decks.get(job.deckId);
    if (deck) deck.job = null;
    return delay(jobView(job));
  },
  postRun: (run: RunIn) => {
    const deck = getDeck(run.deck_id);
    const existing = deck.runs.find((r) => r.id === run.id);
    if (existing) return delay(clone(existing));
    for (const answer of run.answers) {
      const item = deck.items.find((candidate) => candidate.id === answer.item_id);
      if (!item) continue;
      const stats = item.stats ?? { seen: 0, correct: 0, streak: 0, last_wrong_at: null };
      stats.seen += 1;
      if (answer.correct) {
        stats.correct += 1;
        stats.streak += 1;
      } else {
        stats.streak = 0;
        stats.last_wrong_at = run.finished_at;
      }
      item.stats = stats;
    }
    const mistakes = run.answers.filter((a) => !a.correct).map((answer) => {
      const item = deck.items.find((candidate) => candidate.id === answer.item_id);
      return {
        item_id: answer.item_id,
        prompt: item?.prompt ?? "",
        correct: item?.correct ?? "",
        chosen_text: answer.chosen_text,
        chosen_kind: answer.chosen_kind,
        why_wrong: item?.distractors.find((d) => d.text === answer.chosen_text)?.why_wrong ?? null,
        explanation: item?.explanation ?? "",
        source: item?.source ?? "user_docs",
      };
    });
    const detail: RunDetail = {
      id: run.id,
      deck_id: run.deck_id,
      score: run.score,
      correct_count: run.answers.filter((a) => a.correct).length,
      wrong_count: mistakes.length,
      max_streak: run.max_streak,
      duration_ms: Date.parse(run.finished_at) - Date.parse(run.started_at),
      distance: run.distance,
      started_at: run.started_at,
      finished_at: run.finished_at,
      settings: run.settings,
      mistakes,
    };
    deck.runs.push(detail);
    return delay(clone(detail));
  },
  listRuns: (deckId, query = {}) => {
    const { limit = 20, offset = 0 } = query;
    // Порядок как у сервера: finished_at DESC, id DESC; разбор ошибок в сводку не входит.
    const newestFirst = [...getDeck(deckId).runs].sort(
      (a, b) => Date.parse(b.finished_at) - Date.parse(a.finished_at) || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0),
    );
    return delay(newestFirst.slice(offset, offset + limit).map(({ mistakes: _mistakes, ...run }) => clone(run) as RunSummary));
  },
  getRun: (id) => {
    for (const deck of decks.values()) {
      const run = deck.runs.find((candidate) => candidate.id === id);
      if (run) return delay(clone(run));
    }
    return notFound("Забег");
  },
  getDeckStats: (deckId) => {
    const deck = getDeck(deckId);
    const seen = deck.items.filter((item) => item.stats?.seen);
    const stats: DeckStats = {
      item_count: deck.items.length,
      seen_count: seen.length,
      mastered_count: seen.filter((item) => (item.stats?.streak ?? 0) >= 2).length,
      weak_count: deck.items.filter(isWeak).length,
      best_score: summary(deck).best_score,
      runs_count: deck.runs.length,
      last_run: deck.runs.at(-1) ?? null,
      by_section: sectionStats(deck),
    };
    return delay(stats);
  },
  exportDeckUrl: () => "#",
  importDeckFile: async (file) => {
    const parsed = JSON.parse(await file.text()) as DeckFile;
    if (parsed.format !== "study-surfers-deck") throw new ApiError(422, "Это не файл колоды Study Surfers", "deck_file_invalid");
    return summary(createDeck(parsed, "file"));
  },
  previewFlashcards: () => Promise.reject(new ApiError(501, "Импорт Anki работает только с настоящим сервером", "mock_unsupported")),
  importFlashcards: () => Promise.reject(new ApiError(501, "Импорт Anki работает только с настоящим сервером", "mock_unsupported")),
};
