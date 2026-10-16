import { Environment, Lightformer } from "@react-three/drei";
import { useFrame } from "@react-three/fiber";
import { useRef } from "react";
import type { DirectionalLight, HemisphereLight } from "three";
import { useRuntime } from "./context";
import { daylight } from "./daylight";

/**
 * Свет: солнце с тенью, которая едет за бегуном (карта теней покрывает
 * ближнюю зону), небо-полусфера и окружение из световых панелей — оно даёт
 * мягкий объём и блики на стекле и металле без HDR-файлов.
 */
export function Lighting({ shadows, shadowSize }: { shadows: boolean; shadowSize: number }) {
  const runtime = useRuntime();
  const sun = useRef<DirectionalLight>(null);
  const hemi = useRef<HemisphereLight>(null);

  useFrame(({ scene }) => {
    const light = sun.current;
    if (light) {
      const x = runtime.runnerX * 0.5;
      light.target.position.set(x, 0, -9);
      light.target.updateMatrixWorld();
      light.position.copy(daylight.sunDirection).multiplyScalar(60).add(light.target.position);
      light.color.copy(daylight.sun);
      light.intensity = daylight.sunIntensity;
    }
    if (hemi.current) {
      hemi.current.color.copy(daylight.hemiSky);
      hemi.current.groundColor.copy(daylight.hemiGround);
      hemi.current.intensity = daylight.hemiIntensity;
    }
    scene.environmentIntensity = 0.62 - daylight.dusk * 0.22;
  });

  return (
    <>
      <hemisphereLight ref={hemi} />
      <directionalLight
        ref={sun}
        castShadow={shadows}
        shadow-mapSize={[shadowSize, shadowSize]}
        shadow-camera-left={-20}
        shadow-camera-right={20}
        shadow-camera-top={24}
        shadow-camera-bottom={-24}
        shadow-camera-near={10}
        shadow-camera-far={130}
        shadow-bias={-0.0004}
        shadow-normalBias={0.04}
        shadow-radius={3}
      />
      <Environment resolution={128} frames={1}>
        <color attach="background" args={["#b9cde3"]} />
        <Lightformer form="rect" intensity={1.8} color="#eef6ff" position={[0, 30, 0]} scale={[90, 90, 1]} />
        <Lightformer form="circle" intensity={9} color="#fff1d6" position={[30, 26, -36]} scale={[14, 14, 1]} />
        <Lightformer form="rect" intensity={0.9} color="#a9c9ef" position={[-40, 8, 0]} scale={[70, 24, 1]} />
        <Lightformer form="rect" intensity={0.7} color="#ffd9b0" position={[0, 8, -60]} scale={[90, 20, 1]} />
        <Lightformer form="rect" intensity={0.45} color="#8fc47a" position={[0, -20, 0]} scale={[90, 90, 1]} />
      </Environment>
    </>
  );
}
