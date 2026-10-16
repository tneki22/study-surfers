import { PerformanceMonitor } from "@react-three/drei";
import { Canvas, useFrame } from "@react-three/fiber";
import { lazy, Suspense, useMemo, useRef, useState } from "react";
import { NeutralToneMapping } from "three";
import type { Quality } from "../../app/stores";
import { CAMERA, FOG } from "../constants";
import { gpuInfo, weakGpu } from "../gpu";
import type { GameRuntime } from "../runtime";
import { useHud } from "../store";
import { Billboard } from "./Billboard";
import { CameraRig } from "./CameraRig";
import { ClearanceProbe } from "./debug/ClearanceProbe";
import { RuntimeContext, useRuntime } from "./context";
import { daylight, updateDaylight } from "./daylight";
import { Effects } from "./Effects";
import { Gates } from "./Gates";
import { Lighting } from "./Lighting";
import { updateSceneMaterials } from "./materials";
import { Chaser } from "./Chaser";
import { Obstacles } from "./Obstacles";
import { ModifierPickups } from "./ModifierPickups";
import { PostFx } from "./PostFx";
import { Runner } from "./Runner";
import { Scenery } from "./Scenery";
import { Sky } from "./Sky";
import { Track } from "./Track";
import { Trains } from "./Trains";
const NightScene = lazy(() => import("./night/NightScene"));
const NightPostFx = lazy(() => import("./night/NightScene").then(module => ({ default: module.NightPostFx })));

/** Один тик логики забега за кадр — раньше всех, кто рисует. Заодно двигает время суток. */
function GameLoop() {
  const runtime = useRuntime();
  const progress = useRef(0);
  useFrame(({ clock }, delta) => {
    // В dev скрипт скриншотов может вести время забега сам (window.__manualClock).
    if (!(import.meta.env.DEV && (window as unknown as { __manualClock?: boolean }).__manualClock)) runtime.update(delta);
    if (runtime.settings.world === "night-maglev") return;
    const hud = useHud.getState();
    const target = hud.plannedTotal ? hud.timeline.length / hud.plannedTotal : 0;
    progress.current += (target - progress.current) * Math.min(1, delta * 1.2);
    updateDaylight(progress.current);
    updateSceneMaterials(clock.elapsedTime, daylight.dusk);
  });
  return null;
}

function RenderStats() {
  const runtime = useRuntime();
  useFrame(({ gl }, delta) => {
    if (import.meta.env.DEV) (window as unknown as { __nightMetrics: unknown }).__nightMetrics = {
      calls: gl.info.render.calls, triangles: gl.info.render.triangles,
      geometries: gl.info.memory.geometries, textures: gl.info.memory.textures,
      frameMs: delta * 1000, programs: gl.info.programs?.length,
      world: runtime.settings.world, lanes: runtime.lanes, clock: runtime.clock,
    };
    gl.info.reset();
  }, 3);
  return null;
}

type Tier = Exclude<Quality, "auto">;

const DPR: Record<Tier, [number, number]> = {
  low: [0.75, 1],
  medium: [1, 1.5],
  high: [1, 2],
};

export function GameCanvas({ runtime, quality, reducedMotion, onTrainPass }: {
  runtime: GameRuntime;
  quality: Quality;
  reducedMotion: boolean;
  onTrainPass?: (side: -1 | 1) => void;
}) {
  const gpu = useMemo(gpuInfo, []);
  const weak = weakGpu(gpu);
  // «Авто» стартует по видеокарте: дискретная — высокое, встроенная — низкое. При просадке кадров
  // сначала уходят тяжёлые эффекты высокого, затем чёткость, затем постобработка.
  const [autoTier, setAutoTier] = useState<Tier>(() => gpu.kind === "discrete" ? "high" : weak ? "low" : "medium");
  const [autoDpr, setAutoDpr] = useState(() => gpu.kind === "discrete" ? 1.5 : weak ? 1 : 1.25);
  const tier: Tier = quality === "auto" ? autoTier : quality;
  const night = runtime.settings.world === "night-maglev";
  // Встроенной графике экран 2560×1600 в полном разрешении обходится дороже всех эффектов вместе.
  const dprCap = weak ? (tier === "high" ? 1.25 : 1) : Infinity;
  const tierDpr = night && tier !== "low" ? [1, tier === "high" ? 1.5 : 1.25] as [number, number] : DPR[tier];
  const dpr = quality === "auto" ? Math.min(autoDpr, dprCap) : [Math.min(tierDpr[0], dprCap), Math.min(tierDpr[1], dprCap)] as [number, number];
  const maxAutoDpr = autoTier === "low" ? 1 : night && autoTier === "medium" ? 1.25 : 1.5;
  // Тени переключать на лету дорого (перекомпиляция материалов) — решаем один раз по настройке.
  const shadows = night ? tier !== "low" : quality !== "low";
  const post = tier !== "low";
  // Экранное затенение (AO) — самый дорогой проход: на встроенной графике он один съедает десятки миллисекунд.
  const ao = !weak;

  return (
    <Canvas
      className="game-canvas"
      shadows={shadows ? "percentage" : false}
      dpr={dpr}
      camera={{ fov: CAMERA.fov, near: CAMERA.near, far: CAMERA.far, position: [...CAMERA.position] }}
      // Со сглаживанием постобработки MSAA холста только тратит память и полосу встроенной графики.
      gl={{ antialias: !(post && weak), powerPreference: "high-performance", toneMapping: NeutralToneMapping }}
      onCreated={({ gl, scene, camera }) => {
        if (night && import.meta.env.DEV) gl.info.autoReset = false;
        if (import.meta.env.DEV) (window as unknown as { __gl?: unknown }).__gl = gl;
        if (import.meta.env.DEV) Object.assign(window, { __scene: scene, __camera: camera });
      }}
    >
      <RuntimeContext.Provider value={runtime}>
        {quality === "auto" && (
          <PerformanceMonitor
            bounds={() => night ? [52, 59] : [45, 58]}
            flipflops={night ? 6 : Infinity}
            onIncline={() => setAutoDpr((v) => Math.min(maxAutoDpr, v + 0.25))}
            onDecline={() => {
              if (autoTier === "high") {
                setAutoTier("medium");
                setAutoDpr((v) => Math.min(v, night ? 1.25 : 1.5));
              } else if (autoDpr > 0.85) setAutoDpr((v) => Math.max(0.75, v - 0.25));
              else setAutoTier("low");
            }}
            onFallback={() => { setAutoTier("low"); if (night) setAutoDpr(0.75); }}
          />
        )}
        {!night && <fog attach="fog" args={["#cfe9ff", FOG.near, FOG.far]} />}
        <GameLoop />
        <CameraRig reducedMotion={reducedMotion} />
        {night ? <Suspense fallback={null}><NightScene tier={tier} shadows={shadows} reducedMotion={reducedMotion} onTrainPass={onTrainPass} /></Suspense> : <>
        <Lighting shadows={shadows} shadowSize={tier === "high" ? 2048 : 1024} />
        <Sky />
        <Track shadows={shadows} />
        <Scenery shadows={shadows} />
        <Trains shadows={shadows} onPass={onTrainPass} />
        </>}
        <Gates />
        {runtime.settings.modifiers && <ModifierPickups quiet={reducedMotion || tier === "low"} />}
        {runtime.settings.obstacles && <Chaser night={night} reducedMotion={reducedMotion} />}
        {!night && <><Obstacles /><Runner reducedMotion={reducedMotion} quietEffects={reducedMotion || tier === "low"} />
        {import.meta.env.DEV && <ClearanceProbe />}
        <Effects reducedMotion={reducedMotion} /></>}
        {post && (night ? <Suspense fallback={null}><NightPostFx high={tier === "high"} ao={ao} /></Suspense> : <PostFx level={tier === "high" ? "high" : "medium"} ao={ao} />)}
        <Billboard renderPriority={post ? 2 : 1} reducedMotion={reducedMotion} />
        {night && import.meta.env.DEV && <RenderStats />}
      </RuntimeContext.Provider>
    </Canvas>
  );
}
