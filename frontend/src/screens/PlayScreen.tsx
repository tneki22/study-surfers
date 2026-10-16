import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router";
import { api } from "../api/client";
import { loadItemPages } from "../api/itemPages";
import type { QuizItem, RunIn } from "../api/types";
import { useRunLauncher } from "../app/launch";
import { usePreferences, useSession, type Launch } from "../app/stores";
import { Button, ErrorState, LoadingState } from "../components/ui";
import { Hud } from "../game/hud/Hud";
import { useGameAudio } from "../game/audio/useGameAudio";
import { Results } from "../game/hud/Results";
import { computeLayout } from "../game/layout";
import { submitRun } from "../game/runLog";
import { obstaclesMode } from "../game/engine/settings";
import { GameRuntime } from "../game/runtime";
import { RuntimeContext } from "../game/scene/context";
import { GameCanvas } from "../game/scene/GameCanvas";
import { preloadCharacter } from "../game/scene/runner/ModelRunner";
import { useHud } from "../game/store";
import { useGameInput } from "../game/useGameInput";

const LIVE_POLL_MS = 4000;
const FILTER_EMPTY: Record<string, string> = {
  weak: "Слабых карточек пока нет — сначала пробеги колоду целиком.",
  last_mistakes: "В прошлом забеге ошибок не было.",
};

function PlaySession({ launch, onRestart }: { launch: Launch; onRestart: () => void }) {
  const navigate = useNavigate();
  const launcher = useRunLauncher();
  const quality = usePreferences((s) => s.quality);
  const reducedMotion = usePreferences((s) => s.reducedMotion);
  const container = useRef<HTMLDivElement>(null);
  const [runtime, setRuntime] = useState<GameRuntime | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loadingLabel, setLoadingLabel] = useState("Готовим забег…");
  const [saveState, setSaveState] = useState<"saving" | "saved" | "offline">("saving");
  const { deckId, settings } = launch;

  // Загрузка карточек и создание забега.
  useEffect(() => {
    let cancelled = false;
    let poll: ReturnType<typeof setTimeout> | undefined;
    let wake: (() => void) | undefined;
    const wanted = launch.itemIds ? new Set(launch.itemIds) : null;
    const playable = (items: QuizItem[]) => items.filter((item) => item.enabled
      && (!wanted || wanted.has(item.id)) && (settings.includeAiItems || item.source !== "ai_knowledge"));
    const filter = launch.itemIds ? "all" : settings.filter;
    const load = (since = 0) => loadItemPages(api.listItems, deckId, { filter, since }, () => cancelled);
    (async () => {
      let [page, deck] = await Promise.all([
        load(),
        api.getDeck(deckId),
        // Надписи в 3D рисуются на canvas — шрифт должен успеть загрузиться.
        document.fonts.load('700 64px "Unbounded Variable"').catch(() => undefined),
        document.fonts.load('700 96px "Shantell Sans Variable"').catch(() => undefined),
        // Модель героя грузится вместе с карточками, чтобы на старте стоял он, а не запасной бегун.
        settings.world === "night-maglev" ? Promise.resolve() : preloadCharacter(usePreferences.getState().character),
      ]);
      if (cancelled) return;
      // Для строгого порядка нужно дождаться всех вопросов: seq — порядок готовности,
      // а ещё не готовый вопрос может находиться раньше уже загруженного в программе.
      while (launch.live && !wanted && page.job_active && (settings.order === "program" || !playable(page.items).length)) {
        setLoadingLabel(settings.order === "program"
          ? "Ждём окончания генерации, чтобы сохранить порядок программы…"
          : "Ждём карточки, подходящие под настройки забега…");
        await new Promise<void>((resolve) => { wake = resolve; poll = setTimeout(resolve, LIVE_POLL_MS); });
        wake = undefined;
        if (cancelled) return;
        const next = await load(page.next_since);
        page = { ...next, items: [...page.items, ...next.items] };
      }
      const selected = wanted ? page.items.filter((item) => wanted.has(item.id)) : page.items;
      const items = playable(selected);
      const live = Boolean(launch.live && page.job_active && !wanted);
      if (!items.length && !live) {
        setError(selected.length && !settings.includeAiItems
          ? "Все подходящие карточки помечены «ответ ИИ». Включи их в настройках забега."
          : FILTER_EMPTY[settings.filter] ?? "В колоде нет включённых карточек.");
        return;
      }
      const created = new GameRuntime({
        settings,
        items,
        live,
        // Мир и препятствия меняют монеты и штрафы — рекорд сравнивается только с такими же забегами.
        previousBest: deck.best_by_setup.find((best) => best.world === settings.world && best.obstacles === obstaclesMode(settings))?.score ?? null,
        onComplete: (result, answers, startedAt, finishedAt) => {
          const run: RunIn = {
            id: crypto.randomUUID(),
            deck_id: deckId,
            settings: {
              lanes: settings.lanes,
              difficulty: settings.difficulty,
              filter: launch.itemIds ? "all" : settings.filter,
              pace: settings.pace === "custom" ? `custom:${settings.customSeconds}` : settings.pace,
              lives: settings.lives || null,
              world: settings.world,
              obstacles: obstaclesMode(settings),
            },
            started_at: startedAt.toISOString(),
            finished_at: finishedAt.toISOString(),
            score: result.score,
            distance: Math.round(created.distance),
            max_streak: result.maxStreak,
            answers,
          };
          if (!answers.length) {
            setSaveState("saved");
            return;
          }
          setSaveState("saving");
          submitRun(run).then(setSaveState);
        },
      });
      setRuntime(created);
      created.start();
      // Живые экземпляры stores нужны стенду: повторный import после HMR может
      // получить другой экземпляр модуля и менять уже не показанный забег.
      if (import.meta.env.DEV) Object.assign(window, { __run: created, __session: useSession, __preferences: usePreferences });

      // Генерация ещё идёт: подтягиваем новые карточки прямо в забег.
      if (live) {
        let since = page.next_since;
        const refresh = async () => {
          try {
            const next = await load(since);
            if (cancelled) return;
            since = next.next_since;
            created.appendItems(next.items);
            if (!next.job_active) {
              created.endLive();
              return;
            }
          } catch {
            // Временный сбой сети — попробуем на следующем тике.
          }
          if (!cancelled) poll = setTimeout(refresh, LIVE_POLL_MS);
        };
        poll = setTimeout(refresh, LIVE_POLL_MS);
      }
    })().catch((reason: unknown) => {
      if (!cancelled) setError(reason instanceof Error ? reason.message : String(reason));
    });
    return () => {
      cancelled = true;
      clearTimeout(poll);
      wake?.();
    };
  }, [deckId, launch, settings]);

  // Раскладка табло и карточек под размер окна.
  useLayoutEffect(() => {
    const element = container.current;
    if (!element) return;
    const update = () => {
      const { width, height } = element.getBoundingClientRect();
      if (width > 0 && height > 0) useHud.setState({ layout: computeLayout(width, height, settings.lanes) });
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(element);
    return () => observer.disconnect();
  }, [settings.lanes, runtime]);

  useGameInput(runtime);
  const audio = useGameAudio(runtime);

  if (error) {
    return (
      <div className="play-loading">
        <div className="play-error">
          <ErrorState message={error} title="Забег не начался">
            <div className="play-error-actions">
              {settings.filter !== "all" && (
                <Button onClick={() => launcher.start(deckId, { settings: { ...settings, filter: "all" } })}>Бежать по всем карточкам</Button>
              )}
              <Button variant="secondary" onClick={() => navigate("/")}>В меню</Button>
            </div>
          </ErrorState>
        </div>
      </div>
    );
  }

  return (
    <div className="play-screen" ref={container} data-quality={quality} data-world={settings.world ?? "classic"} data-reduced-motion={reducedMotion}>
      {runtime ? (
        <RuntimeContext.Provider value={runtime}>
          <GameCanvas
            runtime={runtime}
            quality={quality}
            reducedMotion={reducedMotion}
            onTrainPass={(side) => audio?.trainPass(side)}
          />
          <Hud onRestart={onRestart} onExit={() => navigate("/")} />
          <Results
            saveState={saveState}
            onRetryMistakes={(itemIds) => launcher.start(deckId, {
              settings: { ...settings, count: "all", order: "shuffle", retryMistakes: false },
              itemIds,
            })}
            onAgain={onRestart}
            onSetup={() => navigate(`/decks/${deckId}/setup`)}
            onExit={() => navigate("/")}
          />
        </RuntimeContext.Provider>
      ) : (
        <div className="play-loading"><LoadingState label={loadingLabel} /></div>
      )}
    </div>
  );
}

export default function PlayScreen() {
  const { deckId = "" } = useParams();
  const launch = useSession((s) => s.launch);
  const savedSettings = useSession((s) => s.settings);
  const [restarts, setRestarts] = useState(0);
  const [fallback] = useState<Launch>(() => ({ id: 0, deckId, settings: savedSettings }));
  const current = useMemo(() => (launch && launch.deckId === deckId ? launch : { ...fallback, deckId }), [launch, deckId, fallback]);

  return <PlaySession key={`${current.id}:${restarts}`} launch={current} onRestart={() => setRestarts((n) => n + 1)} />;
}
