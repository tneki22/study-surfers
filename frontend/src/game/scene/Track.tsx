import { useFrame } from "@react-three/fiber";
import { useEffect, useLayoutEffect, useMemo, useRef } from "react";
import {
  BoxGeometry,
  Color,
  ExtrudeGeometry,
  type Group,
  type InstancedMesh,
  type MeshStandardMaterial,
  Object3D,
  Shape,
  type Texture,
} from "three";
import { GROUND_Y, LANE_WIDTH, laneX, TRACK_FAR, TRACK_NEAR } from "../constants";
import { createRng } from "../engine/random";
import { useRuntime } from "./context";
import { grassTexture, gravelTexture, pavingTexture } from "./textures";

const LENGTH = TRACK_NEAR - TRACK_FAR;
const MID = (TRACK_NEAR + TRACK_FAR) / 2;
const SLEEPER_SPACING = 1.2;
const GAUGE = 1.1;
const BED_TOP = 0.11;
const SLEEPER_HEIGHT = GROUND_Y - BED_TOP;
const SIDE_TRACK = 3.8;

/** Профиль рельса: подошва, шейка, головка. Выдавливается вдоль всей трассы. */
function railGeometry(): ExtrudeGeometry {
  const s = new Shape();
  const points: [number, number][] = [
    [-0.07, 0], [0.07, 0], [0.07, 0.022], [0.013, 0.034], [0.013, 0.1], [0.036, 0.108],
    [0.036, 0.145], [-0.036, 0.145], [-0.036, 0.108], [-0.013, 0.1], [-0.013, 0.034], [-0.07, 0.022],
  ];
  s.moveTo(...points[0]);
  points.slice(1).forEach((point) => s.lineTo(...point));
  s.closePath();
  const geometry = new ExtrudeGeometry(s, { depth: LENGTH, bevelEnabled: false, steps: 1 });
  geometry.translate(0, 0, TRACK_FAR);
  return geometry;
}

/** Своя копия текстуры с повтором в метрах: смещение по дистанции у каждой поверхности своё. */
function useScrolling(source: () => Texture, tile: number, width: number, length: number) {
  const texture = useMemo(() => {
    const copy = source().clone();
    copy.needsUpdate = true;
    copy.repeat.set(width / tile, length / tile);
    return copy;
  }, [source, tile, width, length]);
  useEffect(() => () => texture.dispose(), [texture]);
  return { texture, tile };
}

/**
 * Земля и пути. Всё, что одинаково вдоль трассы (насыпь, рельсы, провода,
 * тротуары), стоит на месте; движение читается по шпалам и текстурам —
 * они сдвигаются на пройденную дистанцию, узор бесшовный.
 */
export function Track({ shadows }: { shadows: boolean }) {
  const runtime = useRuntime();
  const lanes = runtime.lanes;
  const H = (lanes * LANE_WIDTH) / 2;
  const sleepersGroup = useRef<Group>(null);
  const mainSleepers = useRef<InstancedMesh>(null);
  const sideSleepers = useRef<InstancedMesh>(null);
  const rails = useRef<InstancedMesh>(null);
  const railTops = useRef<InstancedMesh>(null);
  const wires = useRef<InstancedMesh>(null);
  const wireMaterial = useRef<MeshStandardMaterial>(null);
  const perLane = Math.ceil(LENGTH / SLEEPER_SPACING) + 1;

  const grass = useScrolling(grassTexture, 7, 640, 640);
  const bed = useScrolling(gravelTexture, 1.6, H * 2 + 1.4, LENGTH);
  const shoulder = useScrolling(gravelTexture, 1.6, 2.1, LENGTH);
  const sideBed = useScrolling(gravelTexture, 1.6, 2.6, LENGTH);
  const paving = useScrolling(pavingTexture, 2.4, 3.3, LENGTH);
  const scrolling = [grass, bed, shoulder, sideBed, paving];

  const railX = useMemo(() => {
    const xs: number[] = [];
    for (let lane = 0; lane < lanes; lane += 1) xs.push(laneX(lane, lanes) - GAUGE / 2, laneX(lane, lanes) + GAUGE / 2);
    for (const side of [-1, 1]) xs.push(side * (H + SIDE_TRACK) - GAUGE / 2, side * (H + SIDE_TRACK) + GAUGE / 2);
    return xs;
  }, [lanes, H]);
  const railShape = useMemo(railGeometry, []);
  const railTop = useMemo(() => new BoxGeometry(0.05, 0.008, LENGTH), []);
  useEffect(() => () => {
    railShape.dispose();
    railTop.dispose();
  }, [railShape, railTop]);

  useLayoutEffect(() => {
    const dummy = new Object3D();
    const rng = createRng(3);
    const color = new Color();
    const place = (mesh: InstancedMesh | null, centers: number[], base: string) => {
      if (!mesh) return;
      let index = 0;
      for (const x of centers) {
        for (let i = 0; i < perLane; i += 1) {
          dummy.position.set(x, BED_TOP + SLEEPER_HEIGHT / 2, TRACK_NEAR - i * SLEEPER_SPACING);
          dummy.rotation.y = (rng() - 0.5) * 0.04;
          dummy.updateMatrix();
          mesh.setMatrixAt(index, dummy.matrix);
          mesh.setColorAt(index, color.set(base).multiplyScalar(0.85 + rng() * 0.25));
          index += 1;
        }
      }
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    };
    place(mainSleepers.current, Array.from({ length: lanes }, (_, lane) => laneX(lane, lanes)), "#8d877e");
    place(sideSleepers.current, [-(H + SIDE_TRACK), H + SIDE_TRACK], "#7a5a43");

    railX.forEach((x, index) => {
      dummy.position.set(x, GROUND_Y, 0);
      dummy.rotation.set(0, 0, 0);
      dummy.updateMatrix();
      rails.current?.setMatrixAt(index, dummy.matrix);
      dummy.position.set(x, GROUND_Y + 0.148, MID);
      dummy.updateMatrix();
      railTops.current?.setMatrixAt(index, dummy.matrix);
    });
    if (rails.current) rails.current.instanceMatrix.needsUpdate = true;
    if (railTops.current) railTops.current.instanceMatrix.needsUpdate = true;

    // Контактный провод над каждым треком и несущий трос над ним.
    let wire = 0;
    for (let lane = 0; lane < lanes; lane += 1) {
      for (const y of [5.3, 5.95]) {
        dummy.position.set(laneX(lane, lanes), y, MID);
        dummy.rotation.set(Math.PI / 2, 0, 0);
        dummy.updateMatrix();
        wires.current?.setMatrixAt(wire, dummy.matrix);
        wire += 1;
      }
    }
    if (wires.current) wires.current.instanceMatrix.needsUpdate = true;
  }, [lanes, perLane, railX, H]);

  useFrame((_, delta) => {
    if (sleepersGroup.current) sleepersGroup.current.position.z = runtime.distance % SLEEPER_SPACING;
    for (const { texture, tile } of scrolling) texture.offset.y = (runtime.distance / tile) % 1;
    // При высокой камере ближний контактный провод проходит прямо через силуэт.
    // Плавно приглушаем его, сохраняя опоры и перспективу всей трассы.
    if (wireMaterial.current && runtime.phase !== "paused") {
      const opacity = runtime.feet > 1.8 ? 0.12 : 1;
      wireMaterial.current.opacity += (opacity - wireMaterial.current.opacity) * (1 - Math.exp(-Math.min(delta, 0.05) * 9));
    }
  });

  return (
    <group>
      <mesh rotation-x={-Math.PI / 2} position={[0, 0, -80]} receiveShadow={shadows}>
        <planeGeometry args={[640, 640]} />
        <meshStandardMaterial map={grass.texture} roughness={0.95} color="#c9dcb8" />
      </mesh>

      {/* Насыпь главных путей и обочины */}
      <mesh position={[0, BED_TOP / 2, MID]} receiveShadow={shadows}>
        <boxGeometry args={[H * 2 + 1.4, BED_TOP, LENGTH]} />
        <meshStandardMaterial map={bed.texture} roughness={0.95} />
      </mesh>
      {[-1, 1].map((side) => (
        <group key={side}>
          <mesh rotation-x={-Math.PI / 2} position={[side * (H + 1.75), 0.03, MID]} receiveShadow={shadows}>
            <planeGeometry args={[2.1, LENGTH]} />
            <meshStandardMaterial map={shoulder.texture} roughness={0.95} color="#d9d2c6" />
          </mesh>
          {/* Кабельный лоток вдоль путей */}
          <mesh position={[side * (H + 1.0), 0.1, MID]} receiveShadow={shadows} castShadow={shadows}>
            <boxGeometry args={[0.42, 0.2, LENGTH]} />
            <meshStandardMaterial color="#bdb6aa" roughness={0.9} />
          </mesh>
          {/* Запасной путь */}
          <mesh position={[side * (H + SIDE_TRACK), 0.08, MID]} receiveShadow={shadows}>
            <boxGeometry args={[2.6, 0.16, LENGTH]} />
            <meshStandardMaterial map={sideBed.texture} roughness={0.95} color="#cfc8bc" />
          </mesh>
          {/* Тротуар с бордюром */}
          <mesh rotation-x={-Math.PI / 2} position={[side * (H + 7.75), 0.12, MID]} receiveShadow={shadows}>
            <planeGeometry args={[3.3, LENGTH]} />
            <meshStandardMaterial map={paving.texture} roughness={0.85} />
          </mesh>
          <mesh position={[side * (H + 6.1), 0.07, MID]} receiveShadow={shadows}>
            <boxGeometry args={[0.2, 0.14, LENGTH]} />
            <meshStandardMaterial color="#d8d3ca" roughness={0.8} />
          </mesh>
        </group>
      ))}

      <instancedMesh ref={rails} args={[railShape, undefined, railX.length]} castShadow={shadows} receiveShadow={shadows} frustumCulled={false}>
        <meshStandardMaterial color="#8e959e" metalness={0.85} roughness={0.38} />
      </instancedMesh>
      <instancedMesh ref={railTops} args={[railTop, undefined, railX.length]} frustumCulled={false}>
        <meshStandardMaterial color="#e6eaef" metalness={1} roughness={0.14} />
      </instancedMesh>
      <instancedMesh ref={wires} args={[undefined, undefined, lanes * 2]} frustumCulled={false}>
        <cylinderGeometry args={[0.014, 0.014, LENGTH, 5, 1]} />
        <meshStandardMaterial ref={wireMaterial} color="#2b2f36" metalness={0.6} roughness={0.5} transparent depthWrite={false} />
      </instancedMesh>

      <group ref={sleepersGroup}>
        <instancedMesh ref={mainSleepers} args={[undefined, undefined, lanes * perLane]} receiveShadow={shadows} castShadow={shadows} frustumCulled={false}>
          <boxGeometry args={[1.85, SLEEPER_HEIGHT, 0.26]} />
          <meshStandardMaterial roughness={0.9} />
        </instancedMesh>
        <instancedMesh ref={sideSleepers} args={[undefined, undefined, 2 * perLane]} receiveShadow={shadows} frustumCulled={false}>
          <boxGeometry args={[2.0, SLEEPER_HEIGHT * 0.8, 0.26]} />
          <meshStandardMaterial roughness={0.9} />
        </instancedMesh>
      </group>
    </group>
  );
}
