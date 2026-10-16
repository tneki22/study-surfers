import type { Api } from "../api/client";
import type { Job } from "../api/types";

export interface GenerationTask {
  deckId: string;
  title: string;
  jobs: Job[];
  stale: boolean;
}

const ACTIVE_STATES = new Set<Job["state"]>(["queued", "extracting", "structuring", "awaiting_confirm", "awaiting_executor", "generating"]);

/** Несколько повторных генераций одного предмета объединяем в одну строку. */
export async function loadGenerationTasks(
  client: Pick<Api, "listDecks" | "listDeckJobs">,
  previous: GenerationTask[] = [],
): Promise<GenerationTask[]> {
  const decks = (await client.listDecks()).filter((deck) => deck.active_job_id);
  const results = await Promise.allSettled(decks.map((deck) => client.listDeckJobs(deck.id, true)));
  return decks.flatMap<GenerationTask>((deck, index) => {
    const result = results[index];
    if (result.status === "rejected") {
      const saved = previous.find((task) => task.deckId === deck.id);
      return saved ? [{ ...saved, title: deck.title, stale: true }] : [];
    }
    const jobs = result.value.filter((job) => ACTIVE_STATES.has(job.state));
    return jobs.length ? [{ deckId: deck.id, title: deck.title, jobs, stale: false }] : [];
  });
}

export function generationSummary({ jobs }: GenerationTask) {
  const done = jobs.reduce((sum, job) => sum + job.done, 0);
  const total = jobs.reduce((sum, job) => sum + job.total, 0);
  // ready_items — число готовых карточек предмета, общее для всех его задач.
  const cards = Math.max(0, ...jobs.map((job) => job.ready_items));
  const awaitingConfirm = jobs.some((job) => job.state === "awaiting_confirm");
  const state = awaitingConfirm ? "awaiting_confirm" : jobs.find((job) => job.state === "generating")?.state ?? jobs[0].state;
  const label = {
    queued: "В очереди",
    extracting: "Читаю файлы",
    structuring: "Разбираю вопросы",
    awaiting_confirm: "Нужно подтверждение",
    awaiting_executor: "Ожидаю модель через MCP",
    generating: "Генерация карточек",
    done: "Карточки готовы",
    failed: "Генерация остановлена",
    cancelled: "Генерация отменена",
    interrupted: "Генерация прервана",
  }[state];
  const jobId = jobs.find((job) => job.state === "awaiting_confirm")?.id ?? jobs[0].id;
  return { done, total, cards, awaitingConfirm, label, jobId };
}
