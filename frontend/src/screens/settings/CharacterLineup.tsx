import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { Suspense, useEffect, useMemo } from "react";
import { AdditiveBlending, Color, DoubleSide, MeshBasicMaterial, type PerspectiveCamera } from "three";
import { usePreferences } from "../../app/stores";
import { GROUND_Y } from "../../game/constants";
import { ModifierState } from "../../game/engine/modifiers";
import type { GameRuntime } from "../../game/runtime";
import { RuntimeContext } from "../../game/scene/context";
import { CHARACTERS, type CharacterId } from "../../game/scene/runner/characters";
import { ModelRunner } from "../../game/scene/runner/ModelRunner";
import { ProceduralRunner } from "../../game/scene/runner/ProceduralRunner";

/** Расстояние между героями в ряду, м. Колонка подписи под каждым — той же ширины. */
const SPACING = 1.3;
const FOV = 28;
const STRIDE = 6.8;
/** Поле по краям ряда (в долях колонки): бегущий герой с краю не упирается в границу холста. */
const MARGIN = 0.3;

/**
 * Для превью герою не нужен забег: только поля, которые читают модели бегуна.
 * Выбранный бежит на месте, остальные стоят в ожидании старта.
 */
class PreviewRunner {
  phase: "countdown" | "running" = "countdown";
  clock = Math.random() * 3;
  phaseClock = 10;
  speed = 0;
  stride = 0;
  feet = 0;
  runnerX = 0;
  runnerVX = 0;
  airborne = false;
  flying = false;
  superJump = false;
  flightAt = -10;
  landingAt = -10;
  targetLane = 1;
  lanes = 3;
  readonly modifiers = new ModifierState();
  // Превью не создаёт игровые события, но экипировка подписывается и здесь.
  on: GameRuntime["on"] = () => () => {};
  bumpClock = -10;
  bumpSeverity = "hit" as const;
  hitClock = -10;
  successClock = -10;
  landClock = -10;
  jumpClock = -10;
  jumpProgress() { return -1; }
  slideProgress() { return -1; }
  slideDepth() { return 0; }
  landImpact() { return 0; }
  support() { return 0; }

  tick(dt: number, active: boolean) {
    this.clock += dt;
    if (active && this.phase !== "running") this.successClock = this.clock;
    this.phase = active ? "running" : "countdown";
    // Разгон и остановка плавные: ноги не дёргаются при переключении героя.
    this.speed += ((active ? 7.5 : 0) - this.speed) * Math.min(1, dt * 5);
    this.stride += (this.speed * dt) / STRIDE;
  }
}

/** Камера отъезжает так, чтобы ряд героев занял ширину холста и встал над колонками подписей. */
function LineupCamera({ count }: { count: number }) {
  const camera = useThree((state) => state.camera) as PerspectiveCamera;
  const aspect = useThree((state) => state.size.width / Math.max(1, state.size.height));
  useEffect(() => {
    // Ряд — по ширине, рост с шляпой мага (≈2,6 м от шпал) — по высоте; берём дальнюю из двух.
    const tan = Math.tan((FOV * Math.PI) / 360);
    const distance = Math.max(((count + 2 * MARGIN) * SPACING) / 2 / (tan * aspect), 1.45 / tan);
    camera.position.set(0, 1.45, distance);
    camera.lookAt(0, 1.3, 0);
    camera.updateProjectionMatrix();
  }, [camera, aspect, count]);
  return null;
}

function Hero({ id, index, count, selected }: { id: CharacterId; index: number; count: number; selected: boolean }) {
  const runner = useMemo(() => new PreviewRunner(), []);
  const ring = useMemo(() => new MeshBasicMaterial({
    color: new Color("#ffb347").multiplyScalar(1.6), transparent: true, opacity: 0, blending: AdditiveBlending, depthWrite: false, side: DoubleSide,
  }), []);
  useEffect(() => () => ring.dispose(), [ring]);
  useFrame((_, delta) => {
    const dt = Math.min(delta, 1 / 20);
    runner.tick(dt, selected);
    ring.opacity += ((selected ? 0.85 : 0) - ring.opacity) * Math.min(1, dt * 8);
  });
  return (
    <RuntimeContext.Provider value={runner as unknown as GameRuntime}>
      {/* Модели бегуна смотрят от камеры: разворачиваем к зрителю вполоборота. */}
      <group position-x={(index - (count - 1) / 2) * SPACING} rotation-y={Math.PI - 0.32}>
        {id === "student" ? (
          <ProceduralRunner reducedMotion />
        ) : (
          <Suspense fallback={null}>
            <ModelRunner hero={id} reducedMotion />
          </Suspense>
        )}
        <mesh rotation-x={-Math.PI / 2} position-y={GROUND_Y + 0.004} material={ring}>
          <ringGeometry args={[0.42, 0.52, 48]} />
        </mesh>
      </group>
    </RuntimeContext.Provider>
  );
}

/**
 * Превью персонажей: все герои в одной 3D-сцене (один WebGL-контекст на всех).
 * Выбранный бежит на месте, остальные ждут старта. Клик по колонке выбирает героя.
 */
export function CharacterLineup() {
  const character = usePreferences((s) => s.character);
  const update = usePreferences((s) => s.update);
  const count = CHARACTERS.length;
  return (
    <div className="character-lineup" style={{ ["--lineup-count" as string]: count, ["--lineup-margin" as string]: `${(MARGIN / (count + 2 * MARGIN)) * 100}%` }}>
      <Canvas
        className="character-lineup-canvas"
        dpr={[1, 2]}
        camera={{ fov: FOV, near: 0.1, far: 60 }}
        gl={{ antialias: true, alpha: true, powerPreference: "high-performance" }}
        aria-hidden="true"
      >
        <LineupCamera count={count} />
        <hemisphereLight args={["#eaf2ff", "#3a3550", 1.6]} />
        <directionalLight position={[3, 6, 5]} intensity={2.2} color="#fff4e6" />
        <directionalLight position={[-4, 3, -4]} intensity={0.9} color="#9cc8ff" />
        {CHARACTERS.map((hero, index) => (
          <Hero key={hero.id} id={hero.id} index={index} count={count} selected={hero.id === character} />
        ))}
      </Canvas>
      <div className="character-lineup-names" role="radiogroup" aria-label="Кем бежать">
        {CHARACTERS.map((hero) => (
          <button
            key={hero.id}
            type="button"
            role="radio"
            aria-checked={hero.id === character}
            className={`character-lineup-name ${hero.id === character ? "is-selected" : ""}`}
            title={hero.hint}
            onClick={() => update({ character: hero.id })}
          >
            <strong>{hero.name}</strong>
          </button>
        ))}
      </div>
    </div>
  );
}
