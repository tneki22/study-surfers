import { Check, X } from "lucide-react";
import type { CSSProperties } from "react";
import { MarkdownInline } from "../../markdown/MarkdownView";
import { LANE_LETTERS } from "../constants";
import { worldLaneColors } from "../worlds";
import { useRuntime } from "../scene/context";
import { useHud } from "../store";
import { useFitText } from "./QuestionBoard";

/**
 * Строчные формулы в вариантах рендерим в display-стиле: в строчном KaTeX
 * дроби и пределы ужимаются до нечитаемого размера, а читать надо на бегу.
 */
export function displayMath(text: string): string {
  return text.replace(/(?<!\$)\$(?!\$)([^$]+?)\$(?!\$)/g, (_, tex: string) => `$\\displaystyle ${tex}$`);
}

function LaneCard({ lane, text, centerX, width, top, state, delay, ghost }: {
  lane: number;
  text: string;
  centerX: number;
  width: number;
  top: number;
  state: "idle" | "current" | "correct" | "wrong" | "faded";
  delay: number;
  ghost: boolean;
}) {
  const runtime = useRuntime();
  const narrow = useHud((s) => (s.layout?.width ?? 1000) < 560);
  const fitRef = useFitText([text, width, narrow], narrow ? 15 : 21, narrow ? 10 : 13);
  const style = {
    left: centerX - width / 2,
    top,
    width,
    "--lane-color": worldLaneColors(runtime.settings.world)[lane],
    animationDelay: `${delay}ms`,
  } as CSSProperties;

  return (
    <button
      type="button"
      className={`lane-card is-${state} ${ghost ? "is-ghost" : ""} ${runtime.night && text.length > 90 ? "is-long" : ""}`}
      style={style}
      onClick={() => runtime.setLane(lane)}
      tabIndex={-1}
      aria-label={`Трек ${LANE_LETTERS[lane]}`}
    >
      <span className="lane-card-letter">
        {state === "correct" ? <Check size={16} strokeWidth={3} /> : state === "wrong" ? <X size={16} strokeWidth={3} /> : LANE_LETTERS[lane]}
      </span>
      <span className="lane-card-text" ref={fitRef}>
        <MarkdownInline text={displayMath(text)} />
      </span>
    </button>
  );
}

/**
 * Варианты ответа над треками. Стоят на месте всё время вопроса: позиция
 * считается проекцией центров треков (ScreenLayout), а камера по X не ходит.
 * После ворот верный подсвечивается зелёным, выбранный неверный — красным.
 */
export function AnswerCards() {
  const layout = useHud((s) => s.layout);
  const gate = useHud((s) => s.gate);
  const targetLane = useHud((s) => s.targetLane);
  const lastResult = useHud((s) => s.lastResult);
  const phase = useHud((s) => s.phase);
  const nightDangerNear = useHud((s) => s.nightDangerNear);

  if (!layout || !gate || phase === "finished" || phase === "gameover") return null;
  const resolved = lastResult?.key === gate.key ? lastResult : null;

  return (
    <div className={`lane-cards ${resolved ? "is-resolved" : ""} ${nightDangerNear ? "is-danger-near" : ""}`} key={gate.key}>
      {gate.options.map((option, lane) => {
        const slot = layout.cards[lane];
        if (!slot) return null;
        let state: "idle" | "current" | "correct" | "wrong" | "faded" = lane === targetLane ? "current" : "idle";
        if (resolved) {
          if (lane === resolved.correctLane) state = "correct";
          else if (lane === resolved.chosenLane) state = "wrong";
          else state = "faded";
        }
        return (
          <LaneCard
            key={lane}
            lane={lane}
            text={option.text}
            centerX={slot.centerX}
            width={slot.width}
            top={layout.cardsY}
            state={state}
            delay={lane * 60}
            ghost={false}
          />
        );
      })}
    </div>
  );
}
