import { Footprints, Ghost, Magnet, Rocket, Shield } from "lucide-react";
import { useEffect, useReducer, useRef, type CSSProperties } from "react";
import { MODIFIER_INFO, MODIFIER_SECONDS, type ActiveModifier } from "../engine/modifiers";
import { useRuntime } from "../scene/context";

const ICONS = { jetpack: Rocket, "gravity-shoes": Footprints, magnet: Magnet, phase: Ghost, shield: Shield };
function EffectBadge({ effect }: { effect: ActiveModifier }) {
  const runtime = useRuntime();
  const time = useRef<HTMLSpanElement>(null);
  const bar = useRef<HTMLSpanElement>(null);
  const badge = useRef<HTMLDivElement>(null);
  const Icon = ICONS[effect.kind];
  const info = MODIFIER_INFO[effect.kind];
  useEffect(() => {
    let frame = 0;
    const update = () => {
      const left = Math.max(0, effect.expiresAt - runtime.clock);
      if (time.current) time.current.textContent = `${left.toFixed(1).replace(".", ",")} с`;
      if (bar.current) bar.current.style.transform = `scaleX(${left / MODIFIER_SECONDS})`;
      if (badge.current) badge.current.dataset.expiring = String(left <= 1.5);
      frame = requestAnimationFrame(update);
    };
    update();
    return () => cancelAnimationFrame(frame);
  }, [effect, runtime]);
  return <div ref={badge} className="modifier-badge" data-kind={effect.kind} style={{ "--modifier-color": info.color } as CSSProperties}>
    <span className="modifier-badge-icon"><Icon size={21} strokeWidth={2.3} /></span>
    <span className="modifier-badge-text"><strong>{info.name}</strong><span>{effect.kind === "shield" ? "Автоматическая защита" : effect.kind === "jetpack" ? "← → выбор трека" : effect.kind === "gravity-shoes" ? "Прыжок выше" : effect.kind === "magnet" ? "Все треки · 10 м" : "Сквозь опасности"}</span></span>
    {effect.kind === "shield" && <span className="modifier-charges" aria-label={`Зарядов: ${effect.charges}`}>{[0, 1, 2].map(i => <i key={i} className={i < effect.charges ? "is-on" : ""} />)}</span>}
    <span ref={time} className="modifier-time" />
    <span className="modifier-meter"><span ref={bar} /></span>
  </div>;
}

/** Подписка на подбор/окончание; таймер обновляет только свой DOM и замирает на паузе. */
export function ModifierHud() {
  const runtime = useRuntime();
  const [, refresh] = useReducer(n => n + 1, 0);
  useEffect(() => runtime.on(event => { if (event.type === "modifier" || event.type === "shield-pulse") refresh(); }), [runtime]);
  return <div className="modifier-hud" aria-label="Активные модификаторы" role="status">
    {runtime.modifiers.active.map(effect => <EffectBadge key={`${effect.kind}:${effect.expiresAt}`} effect={effect} />)}
  </div>;
}
