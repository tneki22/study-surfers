import type { Job } from "../api/types";

type Source = Job["sources"][number];
type Role = NonNullable<Source["role"]>;

/** Роль с учётом того, как разбор обращается с файлом: ответы без списка вопросов делятся на темы, как конспект. */
function effectiveRole(role: Role, sources: Source[]): Role {
  return role === "answers" && !sources.some((s) => s.role === "questions") ? "notes" : role;
}

function known(sources: Source[]): boolean {
  return sources.length > 0 && sources.every((s) => s.role !== null);
}

/** Название среднего шага: пока «Авто» не определил файлы — общее, потом по тому, что найдено. */
export function analysisLabel(sources: Source[]): string {
  if (!known(sources)) return "Разбираю материал";
  const roles = new Set(sources.map((s) => effectiveRole(s.role!, sources)));
  const parts = [
    roles.has("questions") && "нахожу вопросы",
    roles.has("answers") && "сопоставляю ответы",
    roles.has("combined") && "разбираю вопросы с ответами",
    roles.has("notes") && "делю конспект на темы",
  ].filter((part): part is string => Boolean(part));
  const text = parts.length > 1 ? `${parts.slice(0, -1).join(", ")} и ${parts[parts.length - 1]}` : parts[0];
  return text[0].toUpperCase() + text.slice(1);
}

/** Карточки делаются по темам, если вопросов в материале нет вовсе — только конспект. */
export function byTopics(sources: Source[]): boolean {
  return known(sources) && sources.every((s) => effectiveRole(s.role!, sources) === "notes");
}

const ROLE_NAMES: Record<Role, string> = {
  questions: "вопросы",
  answers: "ответы",
  combined: "вопросы с ответами",
  notes: "конспект",
};

/** «Нашёл: билеты.pdf — вопросы, ЛР5.pdf — конспект»; null, пока роли не определены. */
export function foundLine(sources: Source[]): string | null {
  if (!known(sources)) return null;
  return `Нашёл: ${sources.map((s) => `${s.filename} — ${ROLE_NAMES[effectiveRole(s.role!, sources)]}`).join(", ")}`;
}
