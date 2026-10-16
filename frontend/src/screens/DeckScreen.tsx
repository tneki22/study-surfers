import { ChevronDown, Download, Pencil, Play, RefreshCw, Settings2, Shuffle, Sparkles, Trash2 } from "lucide-react";
import { useMemo, useState } from "react";
import { useNavigate, useParams } from "react-router";
import { api } from "../api/client";
import type { QuizItem, RegenerateMode } from "../api/types";
import { useRunLauncher } from "../app/launch";
import { Button, ConfirmDialog, ErrorState, LoadingState, Menu, StatusBadge, Switch } from "../components/ui";
import { useLoad, usePolling } from "../hooks/useLoad";
import { MarkdownInline } from "../markdown/MarkdownView";
import { errorText } from "./ai/useAiSettings";
import { DeckTitle } from "./deck/DeckTitle";
import { exportMenuItems } from "./deck/exportDeck";
import { ItemEditor } from "./deck/ItemEditor";
import { plural } from "./plural";

/** Понятная причина вместо внутренней формулировки проверки. */
function failureText(error: string): string {
  if (/Недостаточно вариантов/.test(error)) return "Модель прислала слишком мало подходящих неверных вариантов";
  if (/Цитата/.test(error)) return "Модель не подтвердила ответ цитатой из материалов";
  return error;
}

interface ItemActions {
  onToggle: (enabled: boolean) => void;
  onEdit: () => void;
  onRegenerate: (mode: RegenerateMode) => Promise<void>;
  onDelete: () => void;
}

function ItemRow({ item, actions, aiAvailable }: { item: QuizItem; actions: ItemActions; aiAvailable: boolean }) {
  const [open, setOpen] = useState(false);
  const [regenerating, setRegenerating] = useState<RegenerateMode | null>(null);
  const regenerate = async (mode: RegenerateMode) => {
    setRegenerating(mode);
    try {
      await actions.onRegenerate(mode);
    } finally {
      setRegenerating(null);
    }
  };
  const stats = item.stats;
  return (
    <li className={`item-row ${item.enabled ? "" : "is-disabled"}`.trim()}>
      <button type="button" className="item-row-main" onClick={() => setOpen(!open)} aria-expanded={open}>
        <span className="item-row-prompt"><MarkdownInline text={item.prompt} /></span>
        <span className="item-row-answer"><MarkdownInline text={item.correct} /></span>
        <span className="item-row-badges">
          {item.source === "ai_knowledge" && <StatusBadge tone="info">ответ ИИ</StatusBadge>}
          {item.edited && <StatusBadge tone="neutral">правлена</StatusBadge>}
          {stats && stats.seen > 0 && (
            <StatusBadge tone={stats.streak >= 2 ? "success" : stats.correct < stats.seen ? "warning" : "neutral"}>
              {stats.correct}/{stats.seen}
            </StatusBadge>
          )}
        </span>
        <ChevronDown size={16} className={`item-row-chevron ${open ? "is-open" : ""}`} aria-hidden="true" />
      </button>
      {open && (
        <div className="item-row-details">
          <div className="distractor-columns">
            {(["near", "far"] as const).map((kind) => (
              <div key={kind}>
                <h4>{kind === "near" ? "Похожие неверные" : "Явно неверные"}</h4>
                <ul>
                  {item.distractors.filter((d) => d.kind === kind).map((d) => (
                    <li key={d.text}>
                      <MarkdownInline text={d.text} />
                      <small> — <MarkdownInline text={d.why_wrong} /></small>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
          {item.explanation && <p className="item-explanation"><MarkdownInline text={item.explanation} /></p>}
          {item.evidence_quote && <blockquote className="item-quote"><MarkdownInline text={item.evidence_quote} /></blockquote>}
          <div className="item-row-actions">
            <Switch label="В забегах" checked={item.enabled} onCheckedChange={actions.onToggle} />
            <Button variant="ghost" onClick={actions.onEdit}><Pencil size={15} aria-hidden="true" /> Изменить</Button>
            {aiAvailable && (
              <>
                <Button variant="ghost" disabled={regenerating !== null} onClick={() => regenerate("distractors")}>
                  <Shuffle size={15} aria-hidden="true" className={regenerating === "distractors" ? "spin" : ""} /> Новые неверные варианты
                </Button>
                <Button variant="ghost" disabled={regenerating !== null} onClick={() => regenerate("full")}>
                  <RefreshCw size={15} aria-hidden="true" className={regenerating === "full" ? "spin" : ""} /> Пересоздать
                </Button>
              </>
            )}
            <Button variant="ghost" onClick={actions.onDelete}><Trash2 size={15} aria-hidden="true" /> Удалить</Button>
          </div>
        </div>
      )}
    </li>
  );
}

export function DeckScreen() {
  const { deckId = "" } = useParams();
  const navigate = useNavigate();
  const launcher = useRunLauncher();
  const deck = useLoad(() => api.getDeck(deckId), [deckId]);
  const items = useLoad(() => api.listItems(deckId, { includeDisabled: true }), [deckId]);
  const stats = useLoad(() => api.getDeckStats(deckId), [deckId]);
  const questions = useLoad(() => api.listQuestions(deckId), [deckId]);
  const health = useLoad(() => api.health(), []);
  const [editing, setEditing] = useState<QuizItem | null>(null);
  const [deleting, setDeleting] = useState<QuizItem | null>(null);
  const [itemError, setItemError] = useState<string | null>(null);
  const generating = deck.data?.status === "generating";
  const [confirmDelete, setConfirmDelete] = useState(false);
  usePolling(() => {
    deck.reload();
    items.reload();
    questions.reload();
  }, 3000, generating);

  const sections = useMemo(() => {
    const groups = new Map<string, QuizItem[]>();
    for (const item of items.data?.items ?? []) {
      const key = item.section ?? "Без раздела";
      groups.set(key, [...(groups.get(key) ?? []), item]);
    }
    return [...groups.entries()];
  }, [items.data]);

  if (deck.error) return <div className="screen-narrow"><ErrorState message={deck.error} /></div>;
  if (!deck.data) return <LoadingState label="Загружаю колоду" placement="page" />;

  const refresh = () => {
    items.reload();
    deck.reload();
  };
  const actionsFor = (item: QuizItem): ItemActions => ({
    onToggle: async (enabled) => {
      await api.patchItem(item.id, { enabled });
      refresh();
    },
    onEdit: () => setEditing(item),
    onRegenerate: async (mode) => {
      setItemError(null);
      try {
        await api.regenerateItem(item.id, mode);
        refresh();
      } catch (reason) {
        setItemError(errorText(reason));
      }
    },
    onDelete: () => setDeleting(item),
  });
  const rename = async (title: string) => {
    await api.renameDeck(deckId, title);
    deck.reload();
  };
  const summary = stats.data;
  const unfinished = (questions.data ?? []).filter((q) => q.status === "failed" || (q.status !== "done" && generating));
  const retry = async (questionId: string) => {
    setItemError(null);
    try {
      await api.regenerateQuestion(deckId, questionId);
      deck.reload();
      questions.reload();
    } catch (reason) {
      setItemError(errorText(reason));
    }
  };

  return (
    <div className="screen-wide deck-screen">
      <div className="deck-topbar">
        <div className="deck-head-actions">
          <Button variant="ghost" onClick={() => setConfirmDelete(true)}><Trash2 size={16} aria-hidden="true" /> Удалить</Button>
          {!api.mock && (
            <Menu
              label="Экспорт колоды"
              trigger={<Button variant="ghost"><Download size={16} aria-hidden="true" /> Экспорт</Button>}
              items={exportMenuItems(deckId)}
            />
          )}
          <Button variant="secondary" onClick={() => launcher.setup(deckId, generating)}>
            <Settings2 size={16} aria-hidden="true" /> Настроить
          </Button>
          <Button className="cta-button" disabled={!deck.data.enabled_item_count} onClick={() => launcher.run(deckId, generating)}>
            <Play size={18} aria-hidden="true" fill="currentColor" /> Бежать
          </Button>
        </div>
      </div>
      <div className="deck-head">
        <h1>
          <DeckTitle title={deck.data.title} onRename={rename} />
          {generating && <StatusBadge tone="info"><Sparkles size={13} aria-hidden="true" /> генерация идёт</StatusBadge>}
        </h1>
      </div>

      <ul className="deck-stats">
        <li><strong>{deck.data.enabled_item_count}</strong><span>{plural(deck.data.enabled_item_count, "карточка", "карточки", "карточек").replace(/^\d+\s/, "")} в забегах</span></li>
        <li><strong>{deck.data.question_count}</strong><span>{plural(deck.data.question_count, "вопрос", "вопроса", "вопросов").replace(/^\d+\s/, "")}</span></li>
        {summary && summary.runs_count > 0 && (
          <>
            <li><strong>{summary.runs_count}</strong><span>забегов</span></li>
            <li><strong>{summary.seen_count}/{summary.item_count}</strong><span>карточек встречалось</span></li>
            <li><strong>{summary.mastered_count}</strong><span>выучено (2 верно подряд)</span></li>
            <li><strong>{summary.weak_count}</strong><span>слабых</span></li>
            {summary.best_score !== null && <li><strong>{summary.best_score}</strong><span>рекорд</span></li>}
          </>
        )}
      </ul>
      {unfinished.length > 0 && (
        <section className="deck-section unfinished-questions">
          <h2>Вопросы без карточек</h2>
          <ul className="item-list">
            {unfinished.map((question) => (
              <li key={question.id} className="item-row">
                <div className="unfinished-row">
                  <span className="item-row-prompt">{question.number_label && `${question.number_label} `}{question.text}</span>
                  {question.status === "failed" ? (
                    <>
                      {question.error && <small className="unfinished-error" title={question.error}>{failureText(question.error)}</small>}
                      <Button variant="ghost" disabled={!health.data?.ai_ready} onClick={() => retry(question.id)}>
                        <RefreshCw size={15} aria-hidden="true" /> Повторить
                      </Button>
                    </>
                  ) : (
                    <StatusBadge tone="info">готовится</StatusBadge>
                  )}
                </div>
              </li>
            ))}
          </ul>
        </section>
      )}
      {itemError && <p className="form-error" role="alert">{itemError}</p>}
      {items.loading && !items.data && <LoadingState label="Загружаю карточки" />}
      {sections.map(([section, sectionItems]) => (
        <section key={section} className="deck-section">
          <h2>{section}</h2>
          <ul className="item-list">
            {sectionItems.map((item) => (
              <ItemRow key={item.id} item={item} actions={actionsFor(item)} aiAvailable={Boolean(health.data?.ai_ready)} />
            ))}
          </ul>
        </section>
      ))}

      <ItemEditor
        item={editing}
        onClose={() => setEditing(null)}
        onSaved={() => {
          setEditing(null);
          refresh();
        }}
      />
      <ConfirmDialog
        open={deleting !== null}
        onOpenChange={(open) => !open && setDeleting(null)}
        title="Удалить карточку?"
        confirmLabel="Удалить"
        destructive
        onConfirm={async () => {
          if (deleting) await api.deleteItem(deleting.id);
          setDeleting(null);
          refresh();
        }}
      >
        <p>Чтобы просто не показывать её в забегах, достаточно выключить «В забегах».</p>
      </ConfirmDialog>
      <ConfirmDialog
        open={confirmDelete}
        onOpenChange={setConfirmDelete}
        title="Удалить колоду?"
        confirmLabel="Удалить колоду"
        destructive
        onConfirm={async () => {
          await api.deleteDeck(deckId);
          navigate("/");
        }}
      >
        <p>Карточки и статистика забегов исчезнут. Файлы на диске не трогаются.</p>
      </ConfirmDialog>
    </div>
  );
}
