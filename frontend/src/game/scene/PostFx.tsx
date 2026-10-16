import { Bloom, EffectComposer, N8AO, SMAA, ToneMapping, Vignette } from "@react-three/postprocessing";
import { ToneMappingMode } from "postprocessing";
import { HalfFloatType } from "three";

export type FxLevel = "medium" | "high";

/**
 * Постобработка на среднем и высоком качестве: мягкое затенение углов (AO)
 * даёт простым формам объём, блум — свечение ворот, фонарей и солнца,
 * нейтральный тонмаппинг сохраняет яркие цвета, виньетка собирает взгляд к центру.
 */
export function PostFx({ level, ao = true }: { level: FxLevel; ao?: boolean }) {
  const high = level === "high";
  return (
    <EffectComposer multisampling={high ? 4 : 0} frameBufferType={HalfFloatType} enableNormalPass={false}>
      {ao ? <N8AO
        aoRadius={2.2}
        distanceFalloff={0.8}
        intensity={high ? 2.4 : 2}
        quality={high ? "medium" : "low"}
        halfRes={!high}
        depthAwareUpsampling
        color="#1b2338"
      /> : <></>}
      <Bloom mipmapBlur luminanceThreshold={1} luminanceSmoothing={0.25} intensity={0.75} radius={0.7} />
      <ToneMapping mode={ToneMappingMode.NEUTRAL} />
      <Vignette offset={0.32} darkness={0.42} eskil={false} />
      {!high && <SMAA />}
    </EffectComposer>
  );
}
