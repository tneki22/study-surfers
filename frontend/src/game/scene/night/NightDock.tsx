import { useFrame } from "@react-three/fiber";
import { useEffect, useMemo, useRef } from "react";
import type { Group } from "three";
import { GROUND_Y, LANE_WIDTH } from "../../constants";
import { useRuntime } from "../context";
import { NIGHT, NightBuilder, type NightMaterials } from "./kit";
import { NightMesh } from "./NightMesh";

/** Пусковая и приемная площадки вместо праздничных арок классического мира. */
export function NightDock({ materials }: { materials: NightMaterials }) {
  const runtime = useRuntime();
  const docks = useRef<(Group | null)[]>([]);
  const lossAt = useRef<number | null>(null);
  const geometry = useMemo(() => {
    const b = new NightBuilder();
    const width = runtime.lanes * LANE_WIDTH;
    b.box("metal", [0, GROUND_Y - 0.07, 0], [width + 0.5, 0.14, 12], "#324953");
    for (const side of [-1, 1]) {
      b.rounded("solid", [side * (width / 2 + 0.8), 0.8, 0], [0.6, 1.6, 3], "#63808a");
      b.box("glow", [side * (width / 2 + 0.49), 0.85, 0], [0.035, 0.8, 2.4], NIGHT.cyan);
      b.rounded("metal", [side * (width / 2 + 1), 2.8, -4.5], [0.4, 5.6, 0.6], NIGHT.dark);
    }
    b.rounded("solid", [0, 5.6, -4.5], [width + 2.8, 0.4, 0.7], "#48636c");
    b.box("glow", [0, 5.37, -4.5], [width + 2.2, 0.035, 0.45], NIGHT.amber);
    for (let z = -5; z <= 5; z += 1.25) {
      b.box("glow", [0, GROUND_Y + 0.012, z], [width, 0.015, 0.025], "#417b7f");
      for (const side of [-1, 1]) b.box("glow", [side * width / 2, GROUND_Y + 0.02, z], [0.15, 0.02, 0.4], NIGHT.amber);
    }
    return b.build();
  }, [runtime.lanes]);
  useEffect(() => () => geometry.forEach(g => g.dispose()), [geometry]);
  useFrame(() => {
    if (runtime.phase === "gameover" && lossAt.current === null) lossAt.current = runtime.distance;
    const finish = lossAt.current ?? runtime.finishDistance;
    docks.current.forEach((dock, index) => {
      if (!dock) return;
      const at = index ? finish : 0;
      dock.visible = at !== null && Math.abs(runtime.distance - at) < 180;
      if (at !== null) dock.position.z = runtime.distance - at;
    });
  });
  return <>{[0, 1].map(index => <group key={index} ref={node => { docks.current[index] = node; }} visible={false}>
    <NightMesh geometry={geometry} materials={materials} />
  </group>)}</>;
}
