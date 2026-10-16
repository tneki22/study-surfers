import { Environment, Lightformer } from "@react-three/drei";
import { useFrame, useThree } from "@react-three/fiber";
import { useEffect, useMemo } from "react";
import { Bloom, ChromaticAberration, EffectComposer, FXAA, N8AO, ToneMapping, Vignette } from "@react-three/postprocessing";
import { ToneMappingMode } from "postprocessing";
import { Color, Fog } from "three";
import type { Quality } from "../../../app/stores";
import { useRuntime } from "../context";
import { Atmosphere } from "./Atmosphere";
import { districtAt, Districts, SEGMENT, SPAN, type District } from "./Districts";
import { Guideway } from "./Guideway";
import { HoverBike } from "./HoverBike";
import { NIGHT, NIGHT_SKY, nightFog, nightMaterials, nightUniforms } from "./kit";
import { Maglevs } from "./Maglevs";
import { NightDock } from "./NightDock";
import { NightObstacles } from "./NightObstacles";
import { NightSky } from "./NightSky";
import { neonAtlas, screenAtlas } from "./signs";
import { Skyline } from "./Skyline";
import { Traffic } from "./Traffic";

type Tier = Exclude<Quality, "auto">;
export { districtAt, type District };

/** Общие униформы: время, путь и «поток» — огни бегут вперёд быстрее байка. */
function NightClock({ reducedMotion }: { reducedMotion: boolean }) {
  const runtime = useRuntime();
  useFrame((_, delta) => {
    nightUniforms.uTime.value = runtime.clock;
    nightUniforms.uDistance.value = runtime.distance;
    nightUniforms.uMotion.value = reducedMotion ? 0 : 1;
    if (runtime.phase !== "paused") nightUniforms.uFlow.value += (runtime.speed + (reducedMotion ? 0 : 16)) * Math.min(delta, 0.05);
  });
  return null;
}

/** Туман и горизонт в тон района: станция холоднее, квартал — малиновый, тоннель — бирюзовый. */
function DistrictLight() {
  const runtime = useRuntime();
  const scene = useThree(state => state.scene);
  const colors = useMemo<Record<District, Color>>(() => ({
    station: new Color("#181a35"), viaduct: new Color(NIGHT_SKY.fog), canyon: new Color("#25122f"), gallery: new Color("#0f1d27"),
  }), []);
  useFrame(() => {
    const length = SEGMENT * SPAN;
    const origin = Math.floor(runtime.distance / length) * length;
    const t = Math.min(1, (runtime.distance - origin) / 24);
    nightFog.copy(colors[districtAt(origin - 1)]).lerp(colors[districtAt(origin)], t * t * (3 - 2 * t));
    if (scene.fog instanceof Fog) scene.fog.color.copy(nightFog);
    if (scene.background instanceof Color) scene.background.copy(nightFog);
  });
  return null;
}

export default function NightScene({ tier, shadows, reducedMotion, onTrainPass }: { tier: Tier; shadows: boolean; reducedMotion: boolean; onTrainPass?: (side: -1 | 1) => void }) {
  const textures = useMemo(() => ({ screens: screenAtlas(), neon: neonAtlas() }), []);
  const materials = useMemo(() => nightMaterials(textures, tier === "low"), [textures, tier]);
  useEffect(() => () => { textures.screens.dispose(); textures.neon.dispose(); Object.values(materials).forEach(m => m.dispose()); }, [textures, materials]);
  return <>
    <color attach="background" args={[NIGHT_SKY.fog]} />
    <fog attach="fog" args={[NIGHT_SKY.fog, 34, tier === "low" ? 160 : 235]} />
    <NightClock reducedMotion={reducedMotion} />
    <DistrictLight />
    <NightSky tier={tier} reducedMotion={reducedMotion} />
    <Skyline materials={materials} tier={tier} />
    <hemisphereLight args={["#7482b4", "#1c1a26", 0.62]} />
    {/* Лунный свет сзади-слева даёт тень байка, малиновый контровой — цветной блик спереди. */}
    <directionalLight position={[-8, 14, 5]} color="#c4cfff" intensity={1.8} castShadow={shadows}
      shadow-mapSize={[tier === "high" ? 2048 : 1024, tier === "high" ? 2048 : 1024]}
      shadow-camera-left={-15} shadow-camera-right={15} shadow-camera-top={24} shadow-camera-bottom={-18}
      shadow-camera-far={70} shadow-normalBias={0.05} shadow-bias={-0.0003} />
    {tier !== "low" && <>
      <directionalLight position={[7, 6, -18]} color="#ff7ac4" intensity={0.6} />
      <directionalLight position={[-9, 5, -16]} color="#5fe0ff" intensity={0.45} />
    </>}
    {/* Отражения: неоновые панели вокруг — глянцевое полотно и металл ловят цветные блики. */}
    <Environment resolution={256} frames={1} environmentIntensity={0.6}>
      <color attach="background" args={["#100d22"]} />
      <Lightformer form="rect" intensity={1.6} color="#6f7ce0" position={[0, 18, 0]} rotation-x={Math.PI / 2} scale={[44, 44, 1]} />
      <Lightformer form="rect" intensity={3.2} color={NIGHT.magenta} position={[-14, 4, -12]} rotation-y={Math.PI / 2} scale={[34, 2.5, 1]} />
      <Lightformer form="rect" intensity={3.6} color={NIGHT.cyan} position={[14, 4, -12]} rotation-y={-Math.PI / 2} scale={[34, 2.5, 1]} />
      <Lightformer form="rect" intensity={3} color={NIGHT.amber} position={[0, 7, -45]} scale={[36, 3, 1]} />
      <Lightformer form="rect" intensity={2.5} color={NIGHT.violet} position={[0, 7, 30]} rotation-y={Math.PI} scale={[30, 4, 1]} />
      <Lightformer form="ring" intensity={3} color="#dfe8ff" position={[24, 16, -30]} scale={7} />
    </Environment>
    <Guideway materials={materials} shadows={shadows} />
    <NightDock materials={materials} />
    <Districts materials={materials} tier={tier} shadows={shadows} />
    <Maglevs materials={materials} shadows={shadows} onPass={onTrainPass} />
    <Traffic tier={tier} materials={materials} />
    <HoverBike materials={materials} shadows={shadows} reducedMotion={reducedMotion} tier={tier} />
    <NightObstacles reducedMotion={reducedMotion} quiet={tier === "low" || reducedMotion} shadows={shadows} />
    <Atmosphere tier={tier} reducedMotion={reducedMotion} />
  </>;
}

/** Ночная постобработка: блум по неону, кинотонмаппинг (иначе HDR-свет обрезается), виньетка. */
export function NightPostFx({ high, ao }: { high: boolean; ao: boolean }) {
  return <EffectComposer multisampling={0} enableNormalPass={false}>
    {high && ao ? <N8AO aoRadius={1.2} intensity={1.2} quality="low" halfRes /> : <></>}
    <Bloom intensity={high ? 1.05 : 0.9} luminanceThreshold={0.85} luminanceSmoothing={0.3} mipmapBlur radius={0.78} />
    {high ? <ChromaticAberration offset={[0.0006, 0.0004]} radialModulation modulationOffset={0.45} /> : <></>}
    <ToneMapping mode={ToneMappingMode.ACES_FILMIC} />
    <Vignette offset={0.3} darkness={0.55} />
    <FXAA />
  </EffectComposer>;
}
