import { Bot, RotateCcw } from "lucide-react";
import { useEffect, useLayoutEffect, useRef } from "react";
import { MarkdownView } from "../../markdown/MarkdownView";
import { useHud } from "../store";
import { useRuntime } from "../scene/context";

/** Табло двигают дроны из 3D-сцены — им нужен прямой доступ к элементу без перерисовки React. */
export const boardElement: { current: HTMLDivElement | null } = { current: null };

const MAX_FONT = 30;
const MIN_FONT = 15;

/** Уменьшает кегль, пока текст не влезет в контейнер (формулы бывают высокими). */
export function useFitText(deps: unknown[], max: number, min: number) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    let size = max;
    element.style.fontSize = `${size}px`;
    while (size > min && (element.scrollHeight > element.clientHeight + 1 || element.scrollWidth > element.clientWidth + 1)) {
      size -= 1;
      element.style.fontSize = `${size}px`;
    }
  }, deps);
  return ref;
}

/** Текст вопроса поверх 3D-табло: номер, раздел, пометка «ответ ИИ» и полоса времени до ворот. */
export function QuestionBoard() {
  const runtime = useRuntime();
  const progressRef = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    let frame: number;
    const draw = () => {
      const hud = useHud.getState();
      const answered = Boolean(hud.gate && hud.lastResult?.key === hud.gate.key);
      if (progressRef.current) progressRef.current.style.transform = `scaleX(${answered ? 0 : 1 - runtime.gateProgress()})`;
      frame = requestAnimationFrame(draw);
    };
    frame = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(frame);
  }, [runtime]);
  const layout = useHud((s) => s.layout);
  const gate = useHud((s) => s.gate);
  const phase = useHud((s) => s.phase);
  const index = useHud((s) => s.gateIndex);
  const total = useHud((s) => s.plannedTotal);
  const waiting = useHud((s) => s.waiting);
  const resolved = useHud((s) => s.lastResult !== null && s.lastResult.key === s.gate?.key);
  const narrow = (layout?.width ?? 1000) < 560;
  const promptRef = useFitText([gate?.key, layout?.width, layout?.height], narrow ? 22 : MAX_FONT, narrow ? 12 : MIN_FONT);

  if (!layout) return null;
  const visible = phase !== "loading";
  const { left, top, width, height } = layout.billboard;

  return (
    <div
      className={`board ${visible ? "is-visible" : ""}`}
      style={{ left, top, width, height }}
      aria-live="polite"
      ref={(node) => { boardElement.current = node; }}
    >
      {gate ? (
        <>
          <div className="board-head">
            <span className="board-count">Вопрос {index}{total ? ` из ${total}` : ""}</span>
            {gate.item.section && <span className="board-section">{gate.item.section}</span>}
            {gate.retry && <span className="board-badge"><RotateCcw size={12} aria-hidden="true" /> повтор</span>}
            {gate.item.source === "ai_knowledge" && (
              <span className="board-badge is-ai" title="Этого ответа не было в твоих материалах — его дал ИИ">
                <Bot size={12} aria-hidden="true" /> ответ ИИ
              </span>
            )}
          </div>
          <div className="board-prompt" ref={promptRef} key={gate.key}>
            <MarkdownView text={gate.item.prompt} />
          </div>
          <div className="board-timer" aria-hidden="true">
            {!resolved && (
              <span
                ref={progressRef}
                key={gate.key}
                className="is-distance-driven"
                style={{ transformOrigin: "left" }}
              />
            )}
          </div>
        </>
      ) : (
        <div className="board-idle">
          {(phase === "intro" || phase === "countdown") && <span>Готов? Смотри на вопрос и вставай на трек с верным ответом</span>}
          {phase === "running" && (waiting ? <span>ИИ ещё готовит карточки — бежим дальше…</span> : <span>Следующий вопрос…</span>)}
          {phase === "finishing" && <span>Финишная прямая!</span>}
        </div>
      )}
    </div>
  );
}
