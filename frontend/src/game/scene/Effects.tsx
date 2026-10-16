import { useFrame, useThree } from "@react-three/fiber";
import { useEffect, useMemo, useRef } from "react";
import {
  AdditiveBlending,
  type Blending,
  BufferAttribute,
  BufferGeometry,
  Color,
  DoubleSide,
  type InstancedMesh,
  type Mesh,
  MeshBasicMaterial,
  NormalBlending,
  Object3D,
  type PerspectiveCamera,
  Points,
  ShaderMaterial,
} from "three";
import { FEEDBACK, GROUND_Y, LANE_COLORS, laneX } from "../constants";
import { useHud } from "../store";
import { useRuntime } from "./context";
import { softDotTexture } from "./textures";

/*
 * Частицы и вспышки: пыль из-под ног и при приземлении, искры монет и ворот,
 * огненный след на комбо ×3+, линии скорости, кольцо-волна под бегуном,
 * конфетти. Всё — несколько вызовов отрисовки на весь экран.
 */

export interface Spawn {
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  color: Color;
  size: number;
  life: number;
  gravity?: number;
  drag?: number;
  /** Рост размера в секунду (отрицательный — частица тает). */
  grow?: number;
  /** Частица лежит в мире и уезжает вместе с ним. */
  world?: boolean;
  alpha?: number;
}

const POINT_VERTEX = /* glsl */ `
attribute float pSize;
attribute float pAlpha;
attribute vec3 pColor;
uniform float uScale;
varying float vAlpha;
varying vec3 vColor;
void main() {
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * mv;
  gl_PointSize = pSize * uScale / max(0.1, -mv.z);
  vAlpha = pAlpha;
  vColor = pColor;
}
`;

const POINT_FRAGMENT = /* glsl */ `
uniform sampler2D uMap;
varying float vAlpha;
varying vec3 vColor;
void main() {
  float a = texture2D(uMap, gl_PointCoord).a * vAlpha;
  if (a < 0.004) discard;
  gl_FragColor = vec4(vColor, a);
  #include <colorspace_fragment>
}
`;

/** Кольцевой буфер частиц в одном Points: позиция, скорость, цвет, размер, прозрачность. */
export class ParticlePool {
  readonly points: Points;
  readonly material: ShaderMaterial;
  private readonly capacity: number;
  private cursor = 0;
  private readonly position: Float32Array;
  private readonly velocity: Float32Array;
  private readonly color: Float32Array;
  private readonly size: Float32Array;
  private readonly alpha: Float32Array;
  private readonly baseAlpha: Float32Array;
  private readonly age: Float32Array;
  private readonly life: Float32Array;
  private readonly gravity: Float32Array;
  private readonly drag: Float32Array;
  private readonly grow: Float32Array;
  private readonly world: Uint8Array;
  private readonly geometry: BufferGeometry;

  constructor(capacity: number, blending: Blending) {
    this.capacity = capacity;
    this.position = new Float32Array(capacity * 3);
    this.velocity = new Float32Array(capacity * 3);
    this.color = new Float32Array(capacity * 3);
    this.size = new Float32Array(capacity);
    this.alpha = new Float32Array(capacity);
    this.baseAlpha = new Float32Array(capacity);
    this.age = new Float32Array(capacity);
    this.life = new Float32Array(capacity);
    this.gravity = new Float32Array(capacity);
    this.drag = new Float32Array(capacity);
    this.grow = new Float32Array(capacity);
    this.world = new Uint8Array(capacity);
    this.geometry = new BufferGeometry();
    this.geometry.setAttribute("position", new BufferAttribute(this.position, 3));
    this.geometry.setAttribute("pColor", new BufferAttribute(this.color, 3));
    this.geometry.setAttribute("pSize", new BufferAttribute(this.size, 1));
    this.geometry.setAttribute("pAlpha", new BufferAttribute(this.alpha, 1));
    this.material = new ShaderMaterial({
      vertexShader: POINT_VERTEX,
      fragmentShader: POINT_FRAGMENT,
      uniforms: { uMap: { value: softDotTexture() }, uScale: { value: 500 } },
      transparent: true,
      depthWrite: false,
      blending,
    });
    this.points = new Points(this.geometry, this.material);
    this.points.frustumCulled = false;
  }

  spawn(p: Spawn) {
    const i = this.cursor;
    this.cursor = (this.cursor + 1) % this.capacity;
    this.position.set([p.x, p.y, p.z], i * 3);
    this.velocity.set([p.vx, p.vy, p.vz], i * 3);
    this.color.set([p.color.r, p.color.g, p.color.b], i * 3);
    this.size[i] = p.size;
    this.baseAlpha[i] = p.alpha ?? 1;
    this.alpha[i] = this.baseAlpha[i];
    this.age[i] = 0;
    this.life[i] = p.life;
    this.gravity[i] = p.gravity ?? 0;
    this.drag[i] = p.drag ?? 0;
    this.grow[i] = p.grow ?? 0;
    this.world[i] = p.world ? 1 : 0;
  }

  update(dt: number, worldSpeed: number) {
    for (let i = 0; i < this.capacity; i += 1) {
      if (this.alpha[i] <= 0) continue;
      this.age[i] += dt;
      const t = this.age[i] / this.life[i];
      if (t >= 1) {
        this.alpha[i] = 0;
        continue;
      }
      const k = Math.exp(-this.drag[i] * dt);
      const j = i * 3;
      this.velocity[j + 1] += this.gravity[i] * dt;
      this.velocity[j] *= k;
      this.velocity[j + 1] *= k;
      this.velocity[j + 2] *= k;
      this.position[j] += this.velocity[j] * dt;
      this.position[j + 1] = Math.max(GROUND_Y, this.position[j + 1] + this.velocity[j + 1] * dt);
      this.position[j + 2] += (this.velocity[j + 2] + (this.world[i] ? worldSpeed : 0)) * dt;
      this.size[i] = Math.max(0, this.size[i] + this.grow[i] * dt);
      this.alpha[i] = this.baseAlpha[i] * (1 - t * t);
    }
    for (const name of ["position", "pColor", "pSize", "pAlpha"]) this.geometry.attributes[name].needsUpdate = true;
  }

  dispose() {
    this.geometry.dispose();
    this.material.dispose();
  }
}

const CONFETTI = 180;
const CONFETTI_LIFE = 1.3;
const PALETTE = [...LANE_COLORS, "#ffd166", "#ffffff", "#22c55e"].map((c) => new Color(c));
const SPEED_LINES = 46;

const hdr = (hex: string, boost: number) => new Color(hex).multiplyScalar(boost);
const COLORS = {
  dust: new Color("#cbbfae"),
  gold: hdr("#ffcf4a", 2.6),
  green: hdr(FEEDBACK.correct, 2.4),
  red: hdr(FEEDBACK.wrong, 2.4),
  fire: [hdr("#ff7a18", 3), hdr("#ffd166", 3), hdr("#ff3d6e", 2.6)],
  white: hdr("#ffffff", 2),
};

interface Confetto {
  alive: boolean;
  age: number;
  x: number; y: number; z: number;
  vx: number; vy: number; vz: number;
  spin: number;
}

export function Effects({ reducedMotion }: { reducedMotion: boolean }) {
  const runtime = useRuntime();
  const camera = useThree((state) => state.camera) as PerspectiveCamera;
  const gl = useThree((state) => state.gl);
  const confetti = useRef<InstancedMesh>(null);
  const lines = useRef<InstancedMesh>(null);
  const ring = useRef<Mesh>(null);

  const pools = useMemo(() => ({ dust: new ParticlePool(260, NormalBlending), sparks: new ParticlePool(520, AdditiveBlending) }), []);
  useEffect(() => () => {
    pools.dust.dispose();
    pools.sparks.dispose();
  }, [pools]);

  const confettiState = useMemo<Confetto[]>(
    () => Array.from({ length: CONFETTI }, () => ({ alive: false, age: 0, x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, spin: 0 })),
    [],
  );
  const lineState = useMemo(() => Array.from({ length: SPEED_LINES }, () => ({
    x: (Math.random() < 0.5 ? -1 : 1) * (2.8 + Math.random() * 7),
    y: 0.6 + Math.random() * 6,
    z: -90 + Math.random() * 100,
    length: 2 + Math.random() * 4,
  })), []);
  const dummy = useMemo(() => new Object3D(), []);
  const ringMaterial = useMemo(() => new MeshBasicMaterial({ transparent: true, depthWrite: false, blending: AdditiveBlending, toneMapped: false, side: DoubleSide }), []);
  const ringState = useRef({ age: 10, color: new Color() });
  useEffect(() => () => ringMaterial.dispose(), [ringMaterial]);

  useEffect(() => {
    if (!confetti.current) return;
    for (let i = 0; i < CONFETTI; i += 1) confetti.current.setColorAt(i, PALETTE[i % PALETTE.length]);
    if (confetti.current.instanceColor) confetti.current.instanceColor.needsUpdate = true;
  }, []);

  useEffect(() => {
    const rand = (spread: number) => (Math.random() - 0.5) * spread;
    const confettiBurst = (count: number, spread: number, origin: [number, number, number]) => {
      let spawned = 0;
      for (const p of confettiState) {
        if (spawned >= count) break;
        if (p.alive) continue;
        p.alive = true;
        p.age = 0;
        [p.x, p.y, p.z] = origin;
        const angle = Math.random() * Math.PI * 2;
        const speed = 2 + Math.random() * spread;
        p.vx = Math.cos(angle) * speed * 0.6;
        p.vz = Math.sin(angle) * speed * 0.6 - 1;
        p.vy = 3 + Math.random() * 4.5;
        p.spin = (Math.random() - 0.5) * 18;
        spawned += 1;
      }
    };
    const sparks = (count: number, x: number, y: number, z: number, speed: number, colors: Color[], life = 0.6, gravity = -5) => {
      for (let i = 0; i < count; i += 1) {
        const theta = Math.random() * Math.PI * 2;
        const phi = Math.acos(Math.random() * 2 - 1);
        const v = speed * (0.4 + Math.random() * 0.6);
        pools.sparks.spawn({
          x, y, z,
          vx: Math.sin(phi) * Math.cos(theta) * v,
          vy: Math.abs(Math.cos(phi)) * v * 0.9 + 0.6,
          vz: Math.sin(phi) * Math.sin(theta) * v,
          color: colors[i % colors.length], size: 0.13 + Math.random() * 0.1, life: life * (0.6 + Math.random() * 0.6),
          gravity, drag: 2.2, grow: -0.1,
        });
      }
    };
    const dust = (count: number, x: number, z: number, power: number) => {
      const y = GROUND_Y + runtime.support() + 0.08;
      for (let i = 0; i < count; i += 1) {
        pools.dust.spawn({
          x: x + rand(0.6), y, z: z + rand(0.4),
          vx: rand(2.4) * power, vy: 0.4 + Math.random() * 0.9 * power, vz: 0.4 + Math.random() * power,
          color: COLORS.dust, size: 0.35 + Math.random() * 0.3, life: 0.55 + Math.random() * 0.45,
          drag: 3, grow: 1.1, world: true, alpha: 0.42,
        });
      }
    };
    const pulse = (color: Color) => {
      ringState.current.age = 0;
      ringState.current.color.copy(color);
    };

    let foot = 0;
    return runtime.on((event) => {
      const x = runtime.runnerX;
      const floor = GROUND_Y + runtime.support();
      switch (event.type) {
        case "step": {
          // Пыль из-под ноги, которая только что коснулась опоры.
          foot += 1;
          if (runtime.speed < 4) break;
          const side = foot % 2 ? 0.11 : -0.11;
          for (let i = 0; i < 2; i += 1) {
            pools.dust.spawn({
              x: x + side + rand(0.15), y: floor + 0.05, z: 0.15,
              vx: rand(0.6), vy: 0.5 + Math.random() * 0.5, vz: 0.5 + Math.random() * 0.8,
              color: COLORS.dust, size: 0.26 + Math.random() * 0.15, life: 0.5, drag: 3, grow: 0.8, world: true,
              alpha: event.surface === "deck" ? 0.16 : 0.28,
            });
          }
          break;
        }
        case "answer":
          if (event.correct) {
            pulse(COLORS.green);
            // Новый множитель или веха — салют тем больше, чем выше множитель.
            const burst = event.milestone ? 4 : event.comboUp ? Math.min(event.multiplier, 5) - 1 : 0;
            sparks(36 + burst * 18, laneX(event.lane, runtime.lanes), floor + 1.6, -0.3, 4.5 + burst * 0.6, [COLORS.green, COLORS.gold, COLORS.white]);
            if (!reducedMotion) confettiBurst(30 + burst * 25, 2.5 + burst * 0.6, [x, floor + 1.6, -0.6]);
          } else {
            pulse(COLORS.red);
            sparks(22, laneX(event.lane, runtime.lanes), floor + 1.4, -0.3, 3.5, [COLORS.red]);
          }
          break;
        case "coin":
          sparks(9, laneX(event.lane, runtime.lanes), GROUND_Y + event.height, 0, 2.6, [COLORS.gold, COLORS.white], 0.45, -2);
          break;
        case "land":
          dust(Math.round(4 + Math.min(10, event.impact)), x, 0.1, Math.min(1.4, 0.5 + event.impact / 10));
          break;
        case "slide":
          dust(8, x, 0, 1.2);
          break;
        case "obstacle":
          if (event.hit) {
            // Задел — облачко, удар — пыль и искры, крушение — вдвое больше.
            const power = event.severity === "graze" ? 0.4 : event.severity === "crash" ? 2 : 1;
            dust(Math.round(18 * power), x, -0.4, 1.6 * Math.sqrt(power));
            const y = { hurdle: 0.45, bar: 1.45, wagons: 0.8, ramp: 0.5, slope: 0.5, handcar: 0.45 }[event.kind];
            sparks(Math.round(14 * power), x, GROUND_Y + y, -0.5, 3 * Math.sqrt(power), [COLORS.fire[0], COLORS.fire[1]]);
          }
          break;
        case "phase":
          if (event.phase === "finished" && !reducedMotion) {
            confettiBurst(CONFETTI, 5.5, [x, 2.6, -1.5]);
            sparks(90, x, 2.2, -1.5, 7, [COLORS.gold, COLORS.white, ...COLORS.fire], 1.1, -3);
          }
          break;
      }
    });
  }, [runtime, pools, confettiState, reducedMotion]);

  useFrame((_, rawDelta) => {
    if (runtime.phase === "paused") return;
    const dt = Math.min(rawDelta, 1 / 20);
    const speed = runtime.speed;
    const height = gl.domElement.height;
    const scale = height / (2 * Math.tan((camera.fov * Math.PI) / 360));
    pools.dust.material.uniforms.uScale.value = scale;
    pools.sparks.material.uniforms.uScale.value = scale;

    const sliding = runtime.slideDepth() > 0.3 && !runtime.airborne;
    const x = runtime.runnerX;
    const floor = GROUND_Y + runtime.support();

    if (sliding && speed > 4) {
      pools.dust.spawn({
        x: x + (Math.random() - 0.5) * 0.5, y: floor + 0.05, z: -0.4,
        vx: (Math.random() - 0.5) * 1.6, vy: 0.6 + Math.random() * 0.8, vz: 0.6,
        color: COLORS.dust, size: 0.4, life: 0.6, drag: 3, grow: 1.2, world: true, alpha: 0.4,
      });
    }

    // Огненный след из-под ног на комбо ×3 и выше.
    const multiplier = useHud.getState().multiplier;
    if (multiplier >= 3 && speed > 4 && !reducedMotion && runtime.phase === "running") {
      for (let i = 0; i < 2; i += 1) {
        pools.sparks.spawn({
          x: x + (Math.random() - 0.5) * 0.3, y: GROUND_Y + runtime.feet + 0.1 + Math.random() * 0.2, z: 0.2,
          vx: (Math.random() - 0.5) * 0.4, vy: 0.4 + Math.random() * 0.6, vz: 1 + Math.random(),
          color: COLORS.fire[Math.floor(Math.random() * 3)], size: 0.22 + Math.random() * 0.1, life: 0.42,
          grow: -0.35, world: true,
        });
      }
    }

    pools.dust.update(dt, speed);
    pools.sparks.update(dt, speed);

    // Кольцо-волна под бегуном при ответе.
    const ringInfo = ringState.current;
    ringInfo.age += dt;
    if (ring.current) {
      const t = ringInfo.age / 0.55;
      ring.current.visible = t < 1;
      if (t < 1) {
        ring.current.position.set(x, floor + 0.04, 0);
        ring.current.scale.setScalar(0.5 + t * 3.2);
        ringMaterial.color.copy(ringInfo.color).multiplyScalar(1 - t);
      }
    }

    // Конфетти летят в системе бегуна, мир под ними «уезжает» сам.
    const confettiMesh = confetti.current;
    if (confettiMesh) {
      confettiState.forEach((p, index) => {
        if (p.alive) {
          p.age += dt;
          if (p.age > CONFETTI_LIFE) p.alive = false;
          p.vy -= 9 * dt;
          p.vx *= Math.exp(-0.8 * dt);
          p.x += p.vx * dt;
          p.y = Math.max(0.05, p.y + p.vy * dt);
          p.z += p.vz * dt + speed * dt * 0.15;
        }
        const s = p.alive ? 0.13 * (1 - (p.age / CONFETTI_LIFE) ** 3) : 0;
        dummy.position.set(p.x, p.y, p.z);
        dummy.rotation.set(p.age * p.spin, p.age * p.spin * 0.7, 0);
        dummy.scale.setScalar(s);
        dummy.updateMatrix();
        confettiMesh.setMatrixAt(index, dummy.matrix);
      });
      confettiMesh.instanceMatrix.needsUpdate = true;
    }

    // Линии скорости: едва заметны всегда, ярче с ростом комбо.
    const linesMesh = lines.current;
    if (linesMesh) {
      const strength = reducedMotion || speed < 2 ? 0 : multiplier >= 3 ? 0.55 : multiplier >= 2 ? 0.32 : 0.16;
      const material = linesMesh.material as MeshBasicMaterial;
      material.opacity += (strength - material.opacity) * Math.min(1, dt * 3);
      linesMesh.visible = material.opacity > 0.01;
      lineState.forEach((line, index) => {
        line.z += speed * 2.6 * dt;
        if (line.z > 12) {
          const side = Math.random() < 0.5 ? -1 : 1;
          line.x = side * (2.8 + Math.random() * 7);
          line.y = 0.6 + Math.random() * 6;
          line.z = -60 - Math.random() * 30;
          line.length = 2 + Math.random() * 4;
        }
        dummy.position.set(line.x, line.y, line.z);
        dummy.rotation.set(0, 0, 0);
        dummy.scale.set(1, 1, line.length);
        dummy.updateMatrix();
        linesMesh.setMatrixAt(index, dummy.matrix);
      });
      linesMesh.instanceMatrix.needsUpdate = true;
    }
  });

  return (
    <>
      <primitive object={pools.dust.points} />
      <primitive object={pools.sparks.points} />
      <mesh ref={ring} rotation-x={-Math.PI / 2} material={ringMaterial} visible={false}>
        <ringGeometry args={[0.82, 1, 48]} />
      </mesh>
      <instancedMesh ref={confetti} args={[undefined, undefined, CONFETTI]} frustumCulled={false}>
        <planeGeometry args={[1, 0.6]} />
        <meshBasicMaterial side={DoubleSide} toneMapped={false} />
      </instancedMesh>
      <instancedMesh ref={lines} args={[undefined, undefined, SPEED_LINES]} frustumCulled={false}>
        <boxGeometry args={[0.025, 0.025, 1]} />
        <meshBasicMaterial color="#ffffff" transparent opacity={0} depthWrite={false} blending={AdditiveBlending} toneMapped={false} />
      </instancedMesh>
    </>
  );
}
