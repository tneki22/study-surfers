import { useFrame } from "@react-three/fiber";
import { useEffect, useMemo, useRef } from "react";
import { Color, type Group, type Mesh, MeshBasicMaterial } from "three";
import { GROUND_Y } from "../../constants";
import { useRuntime } from "../context";
import { softDotTexture } from "../textures";

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));

/**
 * Общее для обеих моделей бегуна: мягкая тень-пятно под ногами (на шпалах
 * или на крыше вагонетки) и «звёздочки» над головой после удара о препятствие.
 */
export function RunnerFx({ starsHeight }: { starsHeight: number }) {
  const runtime = useRuntime();
  const shadow = useRef<Mesh>(null);
  const stars = useRef<Group>(null);
  const materials = useMemo(() => ({
    shadow: new MeshBasicMaterial({ map: softDotTexture(), color: "#0b1020", transparent: true, opacity: 0.4, depthWrite: false }),
    star: new MeshBasicMaterial({ color: new Color(2.2, 1.9, 0.5), toneMapped: false }),
  }), []);
  useEffect(() => () => Object.values(materials).forEach((m) => m.dispose()), [materials]);

  useFrame(() => {
    const support = runtime.support();
    const lift = Math.max(0, runtime.feet - support);
    const sliding = runtime.slideDepth() > 0.3;
    if (shadow.current) {
      shadow.current.position.set(runtime.runnerX, GROUND_Y + support + 0.012, sliding ? -0.35 : 0);
      shadow.current.scale.setScalar(Math.max(0.4, 1.3 - lift * 0.35) * (sliding ? 1.4 : 1));
      materials.shadow.opacity = Math.max(0.08, 0.42 - lift * 0.17);
    }
    if (stars.current) {
      // Звёздочки — только после удара и крушения: задел обходится спотыканием.
      const t = runtime.clock - runtime.bumpClock;
      const span = runtime.bumpSeverity === "crash" ? 1.7 : 1.1;
      stars.current.visible = runtime.bumpSeverity !== "graze" && t >= 0 && t < span;
      stars.current.position.set(runtime.runnerX, GROUND_Y + runtime.feet + starsHeight, 0);
      stars.current.rotation.y = t * 7;
      stars.current.scale.setScalar(clamp01(t * 6) * clamp01((span - t) * 4) * (runtime.bumpSeverity === "crash" ? 1.3 : 1));
    }
  });

  return (
    <>
      <mesh ref={shadow} rotation-x={-Math.PI / 2} material={materials.shadow} renderOrder={1}>
        <planeGeometry args={[1, 1]} />
      </mesh>
      <group ref={stars} visible={false}>
        {[0, 1, 2].map((i) => (
          <mesh
            key={i}
            material={materials.star}
            position={[Math.cos((i / 3) * Math.PI * 2) * 0.32, Math.sin(i * 2.1) * 0.05, Math.sin((i / 3) * Math.PI * 2) * 0.32]}
          >
            <octahedronGeometry args={[0.07, 0]} />
          </mesh>
        ))}
      </group>
    </>
  );
}
