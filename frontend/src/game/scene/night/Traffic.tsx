import { useFrame } from "@react-three/fiber";
import { useEffect, useMemo, useRef } from "react";
import { AdditiveBlending, BoxGeometry, BufferAttribute, Color, type InstancedMesh, MeshBasicMaterial, Object3D } from "three";
import { LANE_WIDTH } from "../../constants";
import { createRng } from "../../engine/random";
import { useRuntime } from "../context";
import { districtAt } from "./Districts";
import { NIGHT, NightBuilder, type NightMaterials } from "./kit";

/** Летучая машина: нос к −z, фары спереди, стоп-сигналы сзади, подсветка днища. */
function carGeometry() {
  const b = new NightBuilder();
  b.soft("solid", [0, 0, 0], [1.7, 0.5, 3.8], "#2a3446");
  b.soft("glass", [0, 0.36, 0.1], [1.3, 0.42, 1.9], "#0f1d2a");
  for (const side of [-1, 1]) {
    b.soft("metal", [side * 1.0, -0.12, 0.5], [0.42, 0.3, 1.6], "#1a2230");
    b.box("glow", [side * 1.0, -0.28, 0.5], [0.24, 0.03, 1.3], side < 0 ? NIGHT.cyan : NIGHT.magenta);
    b.box("glow", [side * 0.55, 0.02, -1.92], [0.42, 0.1, 0.04], "#f2f7ff");
    b.box("glow", [side * 0.6, 0.06, 1.92], [0.5, 0.08, 0.04], "#ff2a3a");
  }
  return b.build();
}

/** Световой шлейф: яркий у машины, гаснет к хвосту (аддитивно, чёрное не видно). */
function trailGeometry() {
  const g = new BoxGeometry(1, 1, 1).translate(0, 0, 0.5);
  const position = g.attributes.position;
  const colors = new Float32Array(position.count * 3);
  for (let i = 0; i < position.count; i++) {
    const t = 1 - position.getZ(i);
    colors.set([t, t, t], i * 3);
  }
  g.setAttribute("color", new BufferAttribute(colors, 3));
  return g;
}

interface Car { x: number; y: number; z: number; dir: number; speed: number; tilt: number }

function SkyTraffic({ count, materials }: { count: number; materials: NightMaterials }) {
  const runtime = useRuntime();
  const geometry = useMemo(carGeometry, []);
  const trail = useMemo(trailGeometry, []);
  const trailMaterial = useMemo(() => new MeshBasicMaterial({ vertexColors: true, color: new Color(1.6, 0.25, 0.3), transparent: true, blending: AdditiveBlending, depthWrite: false, toneMapped: false }), []);
  const meshes = useRef<(InstancedMesh | null)[]>([]);
  const trails = useRef<InstancedMesh>(null);
  const dummy = useMemo(() => new Object3D(), []);
  const cars = useMemo<Car[]>(() => {
    const rng = createRng(909);
    const lanes = [[18, 10], [23, 14], [30, 19], [40, 24], [55, 30], [16, 21], [70, 36]];
    return Array.from({ length: count }, (_, i) => {
      const [x, y] = lanes[i % lanes.length];
      const side = i % 2 ? 1 : -1;
      return { x: side * (x + rng() * 4), y: y + rng() * 2, z: 60 - rng() * 360, dir: (i >> 1) % 2 ? 1 : -1, speed: 22 + rng() * 20, tilt: 0 };
    });
  }, [count]);
  const channels = useMemo(() => [...geometry.keys()], [geometry]);
  useEffect(() => () => { geometry.forEach(g => g.dispose()); trail.dispose(); trailMaterial.dispose(); }, [geometry, trail, trailMaterial]);
  useFrame((_, delta) => {
    const dt = runtime.phase === "paused" ? 0 : Math.min(delta, 0.05);
    cars.forEach((car, i) => {
      car.z += (runtime.speed - car.dir * car.speed) * dt;
      if (car.z < -300) car.z = 60 + (i % 5) * 6;
      else if (car.z > 75) car.z = -295;
      dummy.position.set(car.x, car.y + Math.sin(runtime.clock * 0.7 + i) * 0.3, car.z);
      dummy.rotation.set(0, car.dir > 0 ? 0 : Math.PI, Math.sin(runtime.clock * 0.5 + i * 2) * 0.06);
      dummy.scale.setScalar(1);
      dummy.updateMatrix();
      meshes.current.forEach(mesh => mesh?.setMatrixAt(i, dummy.matrix));
      // Шлейф тянется из-за кормы назад, в сторону, откуда машина прилетела.
      dummy.position.z = car.z + car.dir * 1.9;
      dummy.scale.set(0.9, 0.12, 9 + car.speed * 0.25);
      dummy.updateMatrix();
      trails.current?.setMatrixAt(i, dummy.matrix);
    });
    meshes.current.forEach(mesh => { if (mesh) mesh.instanceMatrix.needsUpdate = true; });
    if (trails.current) trails.current.instanceMatrix.needsUpdate = true;
  });
  return <>
    {channels.map((channel, j) => <instancedMesh key={channel} ref={node => { meshes.current[j] = node; }} args={[geometry.get(channel), materials[channel], count]} frustumCulled={false} />)}
    <instancedMesh ref={trails} args={[trail, trailMaterial, count]} frustumCulled={false} />
  </>;
}

/** Поток машин по улицам под виадуком: только светящиеся штрихи фар и стоп-сигналов. */
function StreetTraffic({ count }: { count: number }) {
  const runtime = useRuntime();
  const mesh = useRef<InstancedMesh>(null);
  const dummy = useMemo(() => new Object3D(), []);
  const material = useMemo(() => new MeshBasicMaterial({ transparent: true, blending: AdditiveBlending, depthWrite: false, toneMapped: false }), []);
  const H = runtime.lanes * LANE_WIDTH / 2;
  const cars = useMemo(() => {
    const rng = createRng(31);
    return Array.from({ length: count }, (_, i) => {
      const side = i % 2 ? 1 : -1;
      const lane = (i >> 1) % 2;
      return { x: side * (H + 11.6 + lane * 2.8), dir: lane ? 1 : -1, z: 40 - rng() * 300, speed: 9 + rng() * 9 };
    });
  }, [count, H]);
  useEffect(() => {
    const white = new Color(2.2, 2.2, 2.4);
    const red = new Color(2.4, 0.25, 0.3);
    cars.forEach((car, i) => mesh.current?.setColorAt(i, car.dir > 0 ? red : white));
    if (mesh.current?.instanceColor) mesh.current.instanceColor.needsUpdate = true;
  }, [cars]);
  useEffect(() => () => material.dispose(), [material]);
  useFrame((_, delta) => {
    if (!mesh.current) return;
    const dt = runtime.phase === "paused" ? 0 : Math.min(delta, 0.05);
    cars.forEach((car, i) => {
      car.z += (runtime.speed - car.dir * car.speed) * dt;
      if (car.z < -260) car.z = 40;
      else if (car.z > 40) car.z = -260;
      const shown = districtAt(runtime.distance - car.z) === "viaduct";
      dummy.position.set(car.x, -43.75, car.z);
      dummy.scale.set(shown ? 0.35 : 0, 0.12, 2.6 + car.speed * 0.15);
      dummy.updateMatrix();
      mesh.current!.setMatrixAt(i, dummy.matrix);
    });
    mesh.current.instanceMatrix.needsUpdate = true;
  });
  return <instancedMesh ref={mesh} args={[undefined, material, count]} frustumCulled={false}><boxGeometry /></instancedMesh>;
}

export function Traffic({ tier, materials }: { tier: "low" | "medium" | "high"; materials: NightMaterials }) {
  if (tier === "low") return null;
  return <>
    <SkyTraffic count={tier === "high" ? 42 : 26} materials={materials} />
    <StreetTraffic count={tier === "high" ? 72 : 44} />
  </>;
}
