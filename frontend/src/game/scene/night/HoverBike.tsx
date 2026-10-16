import { useFrame } from "@react-three/fiber";
import { useEffect, useMemo, useRef } from "react";
import {
  AdditiveBlending, BufferAttribute, BufferGeometry, Color, ConeGeometry, DoubleSide, type Group, LatheGeometry, type Material, Matrix4, type Mesh, type MeshBasicMaterial,
  MeshBasicMaterial as BasicMaterial, Object3D, type PointLight, ShaderMaterial, Vector2, Vector3,
} from "three";
import { GROUND_Y } from "../../constants";
import { MAGNET_REACH } from "../../engine/modifiers";
import { NIGHT_LANE_COLORS } from "../../worlds";
import { useRuntime } from "../context";
import { SHAPES, toShape } from "../kit/batch";
import { NIGHT, NightBuilder, type NightGeometry, type NightMaterials } from "./kit";
import { NightMesh } from "./NightMesh";
import { energyShellMaterial } from "./energyShell";

/** Мотогондола: воздухозаборник спереди (−z), сопло сзади. */
const nacelle = (() => {
  const points = [[0.12, -1.02], [0.2, -0.98], [0.245, -0.8], [0.26, -0.35], [0.25, 0.45], [0.215, 0.82], [0.18, 0.96], [0.12, 0.98]].map(([r, y]) => new Vector2(r, y));
  const geometry = new LatheGeometry(points, 18).rotateX(Math.PI / 2);
  const shape = toShape(geometry);
  geometry.dispose();
  return shape;
})();
const NACELLE_X = 0.64;
const MAGNET_GOLD = new Color("#ffd36b").multiplyScalar(1.6);
const CHARGE_CYAN = new Color("#9ff3ff").multiplyScalar(2);
const PULSE_CYAN = new Color("#b5f7ff").multiplyScalar(1.8);
/** Правая грипса руля; левая — зеркально по x. */
const GRIP = new Vector3(0.37, 0.73, -0.48);

function bikeGeometry() {
  const b = new NightBuilder();
  // Каплевидный корпус, бак-обтекатель, седло, хвост.
  b.sphere("solid", [0, 0.27, -0.2], [0.4, 0.25, 1.28], NIGHT.pale);
  b.sphere("metal", [0, 0.17, -0.25], [0.36, 0.17, 1.15], NIGHT.dark);
  b.soft("solid", [0, 0.44, -0.2], [0.46, 0.22, 0.92], "#e8eef2");
  b.soft("solid", [0, 0.54, 0.44], [0.4, 0.12, 0.78], "#1a2028");
  b.soft("solid", [0, 0.45, 0.98], [0.46, 0.2, 0.58], NIGHT.pale, [-0.28, 0, 0]);
  b.sphere("glass", [0, 0.6, -0.74], [0.29, 0.15, 0.5], "#10303a", [-0.38, 0, 0]);
  b.sphere("metal", [0, 0.2, -1.24], [0.22, 0.13, 0.42], "#1d2630");
  // Руль: перекладина на стойке и обрезиненные грипсы, за них держится пилот.
  b.box("metal", [0, GRIP.y - 0.02, GRIP.z], [GRIP.x * 2 - 0.12, 0.04, 0.05], "#2a3440");
  b.rounded("metal", [0, GRIP.y - 0.1, GRIP.z + 0.03], [0.08, 0.16, 0.06], "#2a3440", [0.3, 0, 0]);
  for (const side of [-1, 1]) {
    b.cylinder("solid", [side * GRIP.x, GRIP.y, GRIP.z], [0.065, 0.15, 0.065], "#11161c", [0, 0, Math.PI / 2]);
    b.cylinder("metal", [side * (GRIP.x + 0.08), GRIP.y, GRIP.z], [0.075, 0.02, 0.075], "#5a6878", [0, 0, Math.PI / 2]);
    // Подножки между корпусом и гондолами.
    b.rounded("metal", [side * 0.37, 0.36, 0.33], [0.15, 0.03, 0.22], "#3a4756");
    b.shape("metal", nacelle, [side * NACELLE_X, 0.12, -0.05], [1, 1, 1], "#5a6878");
    b.shape("solid", nacelle, [side * NACELLE_X, 0.15, -0.3], [1.02, 0.86, 0.62], "#e8eef2");
    b.cylinder("metal", [side * NACELLE_X, 0.12, -1.0], [0.36, 0.05, 0.36], "#0c1218", [Math.PI / 2, 0, 0]);
    b.cylinder("metal", [side * NACELLE_X, 0.12, 0.2], [0.53, 0.18, 0.53], "#2a3440", [Math.PI / 2, 0, 0]);
    b.box("metal", [side * NACELLE_X, 0.36, 0.25], [0.04, 0.16, 0.7], "#2a3440", [0.15, 0, 0]);
    // Пилоны крепления гондол к корпусу.
    b.rounded("metal", [side * 0.35, 0.18, -0.45], [0.42, 0.08, 0.42], "#2f3a46");
    b.rounded("metal", [side * 0.35, 0.16, 0.45], [0.42, 0.08, 0.36], "#2f3a46");
    // Фары и стоп-сигнал.
    b.box("glow", [side * 0.12, 0.24, -1.6], [0.12, 0.035, 0.03], "#e8f6ff", [0, side * 0.3, 0]);
    b.box("glow", [side * 0.16, 0.48, 1.27], [0.15, 0.04, 0.02], "#ff2a3a");
    for (let i = 0; i < 4; i++) b.box("metal", [side * 0.26, 0.47, 0.05 + i * 0.12], [0.04, 0.03, 0.05], "#56636e");
  }
  return b.build();
}

/** Детали в цвет трека: кольца заборников, сопла, подсветка днища, полосы на бортах. */
function accentGeometry() {
  const b = new NightBuilder();
  for (const side of [-1, 1]) {
    b.shape("glow", SHAPES.ring, [side * NACELLE_X, 0.12, -1.02], [0.44, 0.44, 0.5], "#ffffff");
    b.cylinder("glow", [side * NACELLE_X, 0.12, 0.985], [0.2, 0.02, 0.2], "#ffffff", [Math.PI / 2, 0, 0]);
    b.box("glow", [side * NACELLE_X, -0.13, -0.05], [0.14, 0.02, 1.4], "#ffffff");
    b.box("glow", [side * 0.395, 0.3, -0.35], [0.012, 0.03, 1.0], "#ffffff", [0, side * 0.08, 0]);
    b.box("glow", [side * (NACELLE_X + 0.255), 0.14, -0.15], [0.012, 0.04, 0.95], "#ffffff");
  }
  b.box("glow", [0, 0.585, -0.67], [0.26, 0.022, 0.15], "#ffffff");
  return b.build();
}

/*
 * Пилот-робот в спортивной посадке. Ноги неподвижны (колени у бака, ботинки
 * на подножках), корпус с головой наклоняется от бедра, а руки каждый кадр
 * решаются двухзвенной IK от плеча до грипсы — кисти всегда на руле.
 * Точки заданы в координатах байка в исходной позе.
 */
const HIP = new Vector3(0, 0.74, 0.2);
const NECK = new Vector3(0, 1.3, -0.14);
const SHOULDER = new Vector3(0.25, 1.2, -0.07);
const UPPER_ARM = 0.355;
const FOREARM = 0.355;
type V3 = [number, number, number];
const shift = (geometry: NightGeometry, by: Vector3) => { geometry.forEach(g => g.translate(-by.x, -by.y, -by.z)); return geometry; };

/** Ноги: бёдра к баку, голени назад к подножкам, наколенники и щитки голени. */
function legsGeometry() {
  const b = new NightBuilder();
  for (const side of [-1, 1]) {
    const hip: V3 = [side * 0.15, 0.74, 0.2];
    const knee: V3 = [side * 0.28, 0.6, -0.15];
    const ankle: V3 = [side * 0.36, 0.47, 0.3];
    b.bone("solid", hip, knee, 0.085, "#222c38");
    b.bone("solid", knee, ankle, 0.065, "#141a22");
    b.beam("solid", [side * 0.31, 0.6, -0.14], [side * 0.38, 0.5, 0.2], 0.09, "#c4d2dc", 0.05);
    b.sphere("metal", [side * 0.29, 0.61, -0.17], [0.075, 0.075, 0.075], "#5a6878");
    b.rounded("solid", [side * 0.36, 0.42, 0.34], [0.12, 0.1, 0.26], "#2b3542");
  }
  return b.build();
}

/** Корпус от бедра: таз, пресс, грудь с бронепластиной, спинной ранец, плечевые щитки. Светится — «хребет» и полосы на плечах. */
function torsoGeometry() {
  const b = new NightBuilder();
  const lean: V3 = [-0.55, 0, 0];
  b.soft("solid", [0, 0.72, 0.2], [0.38, 0.2, 0.3], "#1a212c");
  b.bone("solid", [0, 0.78, 0.17], [0, 1.0, 0.04], 0.12, "#11161d");
  for (const y of [0.84, 0.92]) b.rounded("metal", [0, y, 0.21 - (y - 0.78) * 0.6], [0.26, 0.035, 0.22], "#3a4756", lean);
  b.soft("solid", [0, 1.1, -0.03], [0.46, 0.3, 0.3], "#1d2633", lean);
  b.soft("solid", [0, 1.07, -0.17], [0.3, 0.2, 0.06], "#dfe6eb", lean);
  b.soft("metal", [0, 1.16, 0.11], [0.34, 0.34, 0.09], "#3a4756", lean);
  b.box("glow", [0, 1.16, 0.16], [0.035, 0.26, 0.012], "#ffffff", lean);
  b.bone("solid", [0, 1.22, -0.08], [0, 1.32, -0.15], 0.06, "#11161d");
  for (const side of [-1, 1]) {
    b.bone("metal", [side * 0.09, 1.02, 0.2], [side * 0.11, 1.2, 0.08], 0.045, "#2a3440");
    b.sphere("metal", [side * SHOULDER.x, SHOULDER.y, SHOULDER.z], [0.075, 0.075, 0.075], "#5a6878");
    b.soft("solid", [side * 0.28, 1.25, -0.06], [0.17, 0.1, 0.24], "#dfe6eb", [-0.4, 0, side * -0.35]);
    b.box("glow", [side * 0.335, 1.24, -0.06], [0.014, 0.03, 0.2], "#ffffff", [-0.4, 0, side * -0.35]);
  }
  return shift(b.build(), HIP);
}

/** Голова: шлем, тёмное стекло с полосой визора, «уши»-датчики, гребень и антенна. */
function headGeometry() {
  const b = new NightBuilder();
  b.sphere("solid", [0, 1.44, -0.2], [0.2, 0.2, 0.235], "#e9eef2");
  b.sphere("glass", [0, 1.43, -0.29], [0.175, 0.105, 0.17], "#0f2a33");
  b.box("glow", [0, 1.435, -0.455], [0.2, 0.022, 0.02], "#ffffff");
  b.rounded("solid", [0, 1.33, -0.3], [0.15, 0.06, 0.1], "#202833");
  b.soft("solid", [0, 1.6, -0.17], [0.045, 0.07, 0.26], "#202833");
  for (const side of [-1, 1]) {
    b.cylinder("metal", [side * 0.195, 1.43, -0.19], [0.1, 0.05, 0.1], "#5a6878", [0, 0, Math.PI / 2]);
    b.cylinder("glow", [side * 0.222, 1.43, -0.19], [0.055, 0.008, 0.055], "#ffffff", [0, 0, Math.PI / 2]);
  }
  b.beam("metal", [0.2, 1.45, -0.17], [0.24, 1.66, -0.08], 0.014, "#5a6878");
  b.bead("glow", [0.24, 1.67, -0.08], [0.022, 0.022, 0.022], "#ffffff");
  return shift(b.build(), NECK);
}

/** Плечо и предплечье вдоль +Y от сустава; +Z — наружная сторона руки, там светится полоса. */
function armGeometry() {
  const upper = new NightBuilder();
  upper.bone("solid", [0, 0, 0], [0, UPPER_ARM, 0], 0.055, "#1b232d");
  upper.soft("solid", [0, UPPER_ARM * 0.45, 0.012], [0.125, UPPER_ARM * 0.5, 0.12], "#dfe6eb");
  upper.sphere("solid", [0, UPPER_ARM, 0], [0.068, 0.068, 0.068], "#5a6878");
  const fore = new NightBuilder();
  fore.bone("solid", [0, 0, 0], [0, FOREARM, 0], 0.048, "#1b232d");
  fore.soft("solid", [0, FOREARM * 0.48, 0], [0.12, FOREARM * 0.56, 0.125], "#26303c");
  fore.box("glow", [0, FOREARM * 0.48, 0.064], [0.022, FOREARM * 0.4, 0.01], "#ffffff");
  fore.cylinder("solid", [0, FOREARM * 0.86, 0], [0.11, 0.035, 0.11], "#5a6878");
  fore.rounded("solid", [0, FOREARM + 0.01, 0], [0.11, 0.12, 0.12], "#2b3542");
  return { upper: upper.build(), fore: fore.build() };
}

/** Двухзвенная IK: локоть отводится в сторону полюса (наружу и чуть вниз), кисть — на грипсе. */
const ik = { d: new Vector3(), pole: new Vector3(), elbow: new Vector3(), hand: new Vector3(), x: new Vector3(), y: new Vector3(), z: new Vector3(), basis: new Matrix4() };
function solveArm(shoulder: Vector3, grip: Vector3, side: number, upper: Group, fore: Group) {
  const { d, pole, elbow, hand, x, y, z, basis } = ik;
  d.subVectors(grip, shoulder);
  const reach = Math.min(Math.max(d.length(), 0.02), UPPER_ARM + FOREARM - 1e-4);
  d.normalize();
  const along = (UPPER_ARM * UPPER_ARM - FOREARM * FOREARM + reach * reach) / (2 * reach);
  const out = Math.sqrt(Math.max(0, UPPER_ARM * UPPER_ARM - along * along));
  pole.set(side, -0.35, 0.15).addScaledVector(d, -pole.dot(d)).normalize();
  elbow.copy(shoulder).addScaledVector(d, along).addScaledVector(pole, out);
  hand.copy(shoulder).addScaledVector(d, reach);
  x.crossVectors(d, pole).normalize();
  for (const [bone, from, to] of [[upper, shoulder, elbow], [fore, elbow, hand]] as const) {
    y.subVectors(to, from).normalize();
    z.crossVectors(x, y);
    bone.position.copy(from);
    bone.quaternion.setFromRotationMatrix(basis.makeBasis(x, y, z));
  }
}

/** Реактивный факел: конус от сопла назад, яркий у основания и гаснущий к концу. */
function flameGeometry() {
  const g = new ConeGeometry(0.1, 1, 14, 1, true).translate(0, 0.5, 0);
  const position = g.attributes.position;
  const colors = new Float32Array(position.count * 3);
  for (let i = 0; i < position.count; i++) {
    const t = Math.pow(1 - position.getY(i), 1.5);
    colors.set([t, t, t], i * 3);
  }
  g.setAttribute("color", new BufferAttribute(colors, 3));
  return g.rotateX(Math.PI / 2);
}

/** Два световых шлейфа из сопел: точки пути пишутся каждые 0,2 м и гаснут к хвосту. */
const TRAIL = 18;
function useTrails() {
  return useMemo(() => {
    const geometry = new BufferGeometry();
    const vertices = 2 * TRAIL * 2;
    geometry.setAttribute("position", new BufferAttribute(new Float32Array(vertices * 3), 3));
    geometry.setAttribute("color", new BufferAttribute(new Float32Array(vertices * 3), 3));
    const index: number[] = [];
    for (let r = 0; r < 2; r++) for (let i = 0; i < TRAIL - 1; i++) {
      const a = (r * TRAIL + i) * 2;
      index.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
    }
    geometry.setIndex(index);
    const material = new BasicMaterial({ vertexColors: true, transparent: true, blending: AdditiveBlending, depthWrite: false, toneMapped: false, side: DoubleSide });
    const samples = Array.from({ length: TRAIL }, () => ({ x: 0, y: 0, d: -1e9 }));
    return { geometry, material, samples };
  }, []);
}

export function HoverBike({ materials, shadows, reducedMotion, tier }: { materials: NightMaterials; shadows: boolean; reducedMotion: boolean; tier: "low" | "medium" | "high" }) {
  const runtime = useRuntime();
  const root = useRef<Group>(null);
  const torso = useRef<Group>(null);
  const head = useRef<Group>(null);
  const arms = useRef<(Group | null)[]>([]);
  const limbs = useMemo(() => ({ shoulder: new Vector3(), grip: new Vector3() }), []);
  const wings = useRef<(Group | null)[]>([]);
  const glow = useRef<Mesh>(null);
  const ring = useRef<Mesh>(null);
  const shield = useRef<Mesh>(null);
  const magnet = useRef<Group>(null);
  const field = useRef<(Mesh | null)[]>([]);
  const echoes = useRef<(Group | null)[]>([]);
  const charges = useRef<(Mesh | null)[]>([]);
  const pulse = useRef<Mesh>(null);
  const pulseClock = useRef(-10);
  const shellMaterial = useMemo(energyShellMaterial, []);
  const fieldMaterial = useMemo(() => new BasicMaterial({ color: new Color("#ffd36b").multiplyScalar(1.8), transparent: true, opacity: 0.75, blending: AdditiveBlending, depthWrite: false, toneMapped: false, side: DoubleSide }), []);
  const ghostMaterial = useMemo(() => new BasicMaterial({ color: new Color("#b48cff"), transparent: true, opacity: 0.2, blending: AdditiveBlending, depthWrite: false, toneMapped: false }), []);
  useEffect(() => () => { shellMaterial.dispose(); fieldMaterial.dispose(); ghostMaterial.dispose(); }, [shellMaterial, fieldMaterial, ghostMaterial]);
  const light = useRef<PointLight>(null);
  const accent = useMemo(() => new Color(NIGHT.cyan), []);
  const target = useMemo(() => new Color(), []);
  const accentMaterial = useMemo(() => new BasicMaterial({ vertexColors: true, toneMapped: false }), []);
  const spotTarget = useMemo(() => new Object3D(), []);
  const glowMaterial = useMemo(() => new ShaderMaterial({
    transparent: true, depthWrite: false, blending: AdditiveBlending, toneMapped: false,
    uniforms: { opacity: { value: 0 }, uColor: { value: new Color() } },
    vertexShader: `varying vec2 vUv;void main(){vUv=uv;gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0);}`,
    fragmentShader: `varying vec2 vUv;uniform float opacity;uniform vec3 uColor;void main(){float r=length((vUv-.5)*2.0);gl_FragColor=vec4(uColor,pow(max(0.0,1.0-r),2.0)*opacity);}`,
  }), []);
  const trails = useTrails();
  const bike = useMemo(bikeGeometry, []);
  // Отголоски фазы: тот же корпус одним полупрозрачным цветом.
  const ghostMaterials = useMemo(() => Object.fromEntries([...bike.keys()].map(channel => [channel, ghostMaterial])), [bike, ghostMaterial]);
  const accents = useMemo(accentGeometry, []);
  const rider = useMemo(() => ({ legs: legsGeometry(), torso: torsoGeometry(), head: headGeometry(), ...armGeometry() }), []);
  // Светящиеся детали пилота — в цвет трека, как акценты байка.
  // Собственные материалы: фазовый корпус не меняет прозрачность всей магистрали.
  const bodyMaterials = useMemo(() => ({ ...materials, solid: materials.solid.clone(), metal: materials.metal.clone(), glass: materials.glass.clone() }), [materials]);
  const riderMaterials = useMemo<Partial<Record<string, Material>>>(() => ({ ...bodyMaterials, glow: accentMaterial }), [bodyMaterials, accentMaterial]);
  useEffect(() => {
    const owned = [bodyMaterials.solid, bodyMaterials.metal, bodyMaterials.glass];
    owned.forEach(material => { material.transparent = true; material.needsUpdate = true; });
    return () => owned.forEach(material => material.dispose());
  }, [bodyMaterials]);
  useEffect(() => runtime.on(event => { if (event.type === "shield-pulse") pulseClock.current = runtime.clock; }), [runtime]);
  const flame = useMemo(flameGeometry, []);
  const flameMaterial = useMemo(() => new BasicMaterial({ vertexColors: true, transparent: true, blending: AdditiveBlending, depthWrite: false, toneMapped: false }), []);
  const flames = useRef<(Mesh | null)[]>([]);
  const accentMaterials = useMemo(() => ({ glow: accentMaterial }), [accentMaterial]);
  useEffect(() => () => {
    bike.forEach(g => g.dispose()); accents.forEach(g => g.dispose()); Object.values(rider).forEach(part => part.forEach(g => g.dispose()));
    glowMaterial.dispose(); accentMaterial.dispose(); trails.geometry.dispose(); trails.material.dispose(); flame.dispose(); flameMaterial.dispose();
  }, [bike, accents, rider, glowMaterial, accentMaterial, trails, flame, flameMaterial]);
  useFrame((_, delta) => {
    if (!root.current) return;
    if (runtime.phase === "paused") return;
    const t = runtime.clock;
    const intro = runtime.phase === "intro" ? Math.min(1, runtime.phaseClock / 2.6) : 1;
    const dock = runtime.phase === "finished" || runtime.phase === "gameover" ? Math.min(1, runtime.phaseClock / 1.4) : 0;
    const depth = runtime.slideDepth();
    const float = reducedMotion ? 0 : Math.sin(t * 2.8) * 0.025;
    const bump = Math.max(0, 1 - (t - runtime.bumpClock) / (runtime.bumpSeverity === "crash" ? 0.8 : 0.45)) * (runtime.bumpSeverity === "graze" ? 0.5 : runtime.bumpSeverity === "crash" ? 1.8 : 1);
    const y = GROUND_Y + 0.4 * intro * (1 - dock) + runtime.feetHeight() - depth * 0.2 + float;
    root.current.position.set(runtime.runnerX, y, 0);
    const lean = reducedMotion ? 0 : Math.max(-0.21, Math.min(0.21, -runtime.runnerVX * 0.055));
    root.current.rotation.z += (lean - root.current.rotation.z) * (1 - Math.exp(-delta * 18));
    root.current.rotation.x = (reducedMotion ? 0 : Math.max(-0.12, Math.min(0.12, -runtime.vy * 0.01)) + bump * Math.sin(t * 35) * 0.06) + depth * 0.05;
    // Пилот пригибается от бедра под балки и выпрямляется на финише; голова смотрит вперёд и в сторону перестроения.
    if (torso.current) {
      torso.current.rotation.x = -depth * 0.45 + dock * 0.15;
      torso.current.position.set(HIP.x, HIP.y - depth * 0.1, HIP.z);
      if (head.current) {
        const look = reducedMotion ? 0 : Math.max(-0.35, Math.min(0.35, -runtime.runnerVX * 0.07));
        head.current.rotation.y += (look - head.current.rotation.y) * (1 - Math.exp(-delta * 8));
        head.current.rotation.x = depth * 0.35 - dock * 0.1;
      }
      for (let i = 0; i < 2; i++) {
        const side = i ? 1 : -1;
        const upper = arms.current[i * 2], fore = arms.current[i * 2 + 1];
        if (!upper || !fore) continue;
        limbs.shoulder.set(side * SHOULDER.x, SHOULDER.y, SHOULDER.z).sub(HIP).applyEuler(torso.current.rotation).add(torso.current.position);
        solveArm(limbs.shoulder, limbs.grip.set(side * GRIP.x, GRIP.y, GRIP.z), side, upper, fore);
      }
    }
    wings.current.forEach((wing, index) => { if (wing) wing.rotation.z = (index === 0 ? -1 : 1) * (0.12 + dock * 0.5 + Math.max(0, runtime.feetHeight()) * 0.15); });

    // Акцент перетекает в цвет трека, на который встаёт байк.
    const phasing = runtime.modifiers.has("phase");
    target.set(phasing ? "#c5a3ff" : NIGHT_LANE_COLORS[runtime.targetLane] ?? NIGHT.cyan);
    const shimmer = reducedMotion ? 0 : Math.sin(t * 19) * 0.06 + Math.sin(t * 43) * 0.03;
    for (const material of [bodyMaterials.solid, bodyMaterials.metal, bodyMaterials.glass]) {
      material.opacity = phasing ? 0.4 + shimmer : 1;
      material.depthWrite = !phasing;
    }
    accent.lerp(target, 1 - Math.exp(-Math.min(delta, 0.05) * 7));
    const power = 0.35 + 0.65 * intro * (1 - dock);
    accentMaterial.color.copy(accent).multiplyScalar(2.1 * power);
    // Факел вытягивается с тягой и мелко дрожит.
    const thrust = Math.min(1.6, runtime.speed / 14) * power * (1 - dock);
    flameMaterial.color.copy(accent).multiplyScalar(1.3);
    flames.current.forEach((mesh, i) => {
      if (!mesh) return;
      const flicker = reducedMotion ? 1 : 0.85 + 0.15 * Math.sin(t * 47 + i * 2.1) + 0.08 * Math.sin(t * 91 + i);
      mesh.scale.set(1 + thrust * 0.15, 1 + thrust * 0.15, Math.max(0.01, (0.18 + thrust * 0.38) * flicker));
      mesh.visible = thrust > 0.02;
    });
    glowMaterial.uniforms.uColor.value.copy(accent);
    if (light.current) {
      light.current.color.copy(accent);
      light.current.intensity = 7 * power / (1 + Math.max(0, runtime.feetHeight()));
    }
    if (glow.current) {
      glow.current.position.x = runtime.runnerX;
      glow.current.scale.set(1 + runtime.speed / 50, 1.8, 1);
      glowMaterial.uniforms.opacity.value = 0.45 * intro * (1 - dock) / (1 + runtime.feetHeight());
    }
    if (ring.current) {
      const age = t - runtime.landClock;
      ring.current.visible = !reducedMotion && age < 0.45;
      ring.current.position.x = runtime.runnerX;
      ring.current.scale.setScalar(0.6 + age * 3);
      (ring.current.material as MeshBasicMaterial).opacity = Math.max(0, 0.4 - age);
      (ring.current.material as MeshBasicMaterial).color.copy(accent);
    }
    const shielded = runtime.modifiers.has("shield");
    const pulseAge = t - pulseClock.current;
    if (shield.current) {
      const strength = shielded ? 1 : phasing ? 0.9 : runtime.phase === "gameover" ? Math.max(0, 1 - runtime.phaseClock / 1.2) : bump * 0.4;
      const flash = pulseAge >= 0 && pulseAge < 0.35 ? 1 - pulseAge / 0.35 : 0;
      shield.current.visible = strength > 0 || flash > 0;
      shellMaterial.uniforms.uOpacity.value = strength * (0.75 + Math.sin(t * 5) * 0.08);
      shellMaterial.uniforms.uFlash.value = flash * 0.8;
      shellMaterial.uniforms.uTime.value = reducedMotion ? 0 : t;
      shellMaterial.uniforms.uMode.value = phasing && !shielded ? 1 : 0;
      shellMaterial.uniforms.uColor.value.set(phasing && !shielded ? "#b48cff" : NIGHT.cyan);
    }
    const magnetic = runtime.modifiers.has("magnet");
    if (magnet.current) { magnet.current.visible = magnetic; magnet.current.rotation.y = reducedMotion ? 0 : t * 2.2; }
    // Поле магнита: дуги через все треки бегут к байку от границы захвата в 10 м.
    field.current.forEach((arc, i) => {
      if (!arc) return;
      const k = reducedMotion ? 0.35 + i * 0.25 : (t * 1.3 + i / field.current.length) % 1;
      arc.visible = magnetic && tier !== "low";
      arc.position.set(runtime.runnerX, GROUND_Y + 0.04, -0.6);
      arc.scale.setScalar(Math.max(0.5, MAGNET_REACH * (1 - k)));
    });
    const chargeCount = runtime.modifiers.active.find(effect => effect.kind === "shield")?.charges ?? 0;
    charges.current.forEach((charge, i) => {
      if (!charge) return;
      charge.visible = i < chargeCount;
      const angle = (reducedMotion ? 0 : t * 2.4) + (i * Math.PI * 2) / 3;
      charge.position.set(Math.sin(angle) * 1.2, 0.85 + Math.sin(t * 3 + i) * 0.05, Math.cos(angle) * 1.45);
      charge.rotation.y = t * 3;
    });
    if (pulse.current) {
      pulse.current.visible = pulseAge >= 0 && pulseAge < 0.55;
      pulse.current.scale.setScalar(reducedMotion ? 1.3 : 0.8 + pulseAge * 5);
      (pulse.current.material as MeshBasicMaterial).opacity = Math.max(0, 0.9 - pulseAge / 0.6);
    }
    // Отголоски фазы догоняют байк с запаздыванием: видно смещение «сквозь» трассу.
    echoes.current.forEach((echo, i) => {
      if (!echo) return;
      echo.visible = phasing && !reducedMotion && tier !== "low";
      const lag = 1 - Math.exp(-delta * (i ? 6 : 11));
      echo.position.x += (runtime.runnerX - echo.position.x) * (echo.visible ? lag : 1);
      echo.position.y = y;
      echo.position.z = 0.75 * (i + 1);
    });
    ghostMaterial.opacity = 0.16 + shimmer;

    // Шлейфы: новая точка каждые 0,2 м пути, вершины считаются от текущей позиции.
    const samples = trails.samples;
    if (runtime.distance - samples[0].d >= 0.2 || samples[0].d < -1e8) {
      for (let i = TRAIL - 1; i > 0; i--) Object.assign(samples[i], samples[i - 1]);
      samples[0].d = runtime.distance;
    }
    samples[0].x = runtime.runnerX;
    samples[0].y = y;
    const position = trails.geometry.attributes.position as BufferAttribute;
    const color = trails.geometry.attributes.color as BufferAttribute;
    const fade = reducedMotion || tier === "low" ? 0 : Math.min(1, runtime.speed / 8) * power * (phasing ? 1.5 : 1);
    for (let r = 0; r < 2; r++) {
      const side = r ? 1 : -1;
      for (let i = 0; i < TRAIL; i++) {
        const sample = samples[Math.min(i, TRAIL - 1)];
        const valid = sample.d > -1e8;
        const z = 0.98 + Math.max(0, runtime.distance - sample.d);
        const x = (valid ? sample.x : runtime.runnerX) + side * NACELLE_X;
        const sy = (valid ? sample.y : y) + 0.12;
        const k = 1 - i / (TRAIL - 1);
        const half = 0.015 + 0.06 * k;
        const v = (r * TRAIL + i) * 2;
        position.setXYZ(v, x - half, sy, z);
        position.setXYZ(v + 1, x + half, sy, z);
        const c = Math.pow(k, 2) * fade * (valid ? 1 : 0) * 1.3;
        color.setXYZ(v, accent.r * c, accent.g * c, accent.b * c);
        color.setXYZ(v + 1, accent.r * c, accent.g * c, accent.b * c);
      }
    }
    position.needsUpdate = true;
    color.needsUpdate = true;
  });
  return <>
    <group ref={root} name="hover-bike">
      <NightMesh geometry={bike} materials={bodyMaterials} shadows={shadows} />
      <NightMesh geometry={accents} materials={accentMaterials} />
      <NightMesh geometry={rider.legs} materials={riderMaterials} shadows={shadows} />
      <group ref={torso} position={HIP.toArray()}>
        <NightMesh geometry={rider.torso} materials={riderMaterials} shadows={shadows} />
        <group ref={head} position={NECK.clone().sub(HIP).toArray()}>
          <NightMesh geometry={rider.head} materials={riderMaterials} shadows={shadows} />
        </group>
      </group>
      {[0, 1, 2, 3].map(i => <group key={i} ref={node => { arms.current[i] = node; }}>
        <NightMesh geometry={i % 2 ? rider.fore : rider.upper} materials={riderMaterials} shadows={shadows} />
      </group>)}
      {[-1, 1].map((side, i) => <mesh key={side} ref={node => { flames.current[i] = node; }} geometry={flame} material={flameMaterial} position={[side * NACELLE_X, 0.12, 0.99]} frustumCulled={false} />)}
      {[-1, 1].map((side, i) => <group key={side} position={[side * 0.5, 0.26, 0.72]} ref={node => { wings.current[i] = node; }}>
        <mesh material={bodyMaterials.metal} position-x={side * 0.2} castShadow={shadows}><boxGeometry args={[0.46, 0.035, 0.3]} /></mesh>
      </group>)}
      <mesh ref={shield} name="modifier-defence-shell" position-y={0.55} visible={false} scale={[1.05, 0.72, 1.45]} material={shellMaterial}>
        <sphereGeometry args={[1.3, 36, 20]} />
      </mesh>
      {/* Магнит: золотые сегменты кольца под байком и дуги поля на трассе */}
      <group ref={magnet} position-y={0.12} visible={false} name="modifier-magnet">
        {[0, 1, 2, 3].map(i => <mesh key={i} rotation={[Math.PI / 2, 0, (i * Math.PI) / 2]} scale={[1, 1.35, 1]}>
          <torusGeometry args={[1.05, tier === "low" ? 0.05 : 0.035, 5, 16, Math.PI / 3]} /><meshBasicMaterial color={MAGNET_GOLD} toneMapped={false} />
        </mesh>)}
      </group>
      {[0, 1, 2].map(i => <mesh key={i} name="modifier-shield-charge" ref={node => { charges.current[i] = node; }} visible={false}>
        <octahedronGeometry args={[0.11]} /><meshBasicMaterial color={CHARGE_CYAN} toneMapped={false} />
      </mesh>)}
      <mesh ref={pulse} position={[0, 0.6, -3]} visible={false}><torusGeometry args={[1, 0.06, 6, 40]} /><meshBasicMaterial color={PULSE_CYAN} transparent opacity={0.6} toneMapped={false} depthWrite={false} blending={AdditiveBlending} /></mesh>
      {tier === "high" && <pointLight ref={light} position={[0, -0.05, -0.2]} distance={7} decay={1.6} intensity={7} />}
      {tier === "high" && <>
        <primitive object={spotTarget} position={[0, -0.4, -16]} />
        <spotLight position={[0, 0.3, -1.5]} target={spotTarget} color="#dff2ff" intensity={30} distance={28} angle={0.42} penumbra={0.7} decay={1.4} />
      </>}
    </group>
    <mesh geometry={trails.geometry} material={trails.material} frustumCulled={false} />
    {[0, 1].map(i => <group key={i} ref={node => { echoes.current[i] = node; }} visible={false} scale={1 - i * 0.04}>
      <NightMesh geometry={bike} materials={ghostMaterials} />
    </group>)}
    {[0, 1, 2].map(i => <mesh key={i} ref={node => { field.current[i] = node; }} rotation-x={-Math.PI / 2} visible={false} material={fieldMaterial}>
      <ringGeometry args={[0.965, 1, 48, 1, Math.PI / 2 - 0.85, 1.7]} />
    </mesh>)}
    <mesh ref={glow} rotation-x={-Math.PI / 2} position-y={GROUND_Y + 0.015} material={glowMaterial}>
      <planeGeometry args={[3, 3]} />
    </mesh>
    <mesh ref={ring} rotation-x={-Math.PI / 2} position-y={GROUND_Y + 0.022} visible={false}>
      <ringGeometry args={[0.65, 0.7, 32]} /><meshBasicMaterial color={NIGHT.cyan} transparent depthWrite={false} blending={AdditiveBlending} />
    </mesh>
  </>;
}
