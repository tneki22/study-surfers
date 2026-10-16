import { RoundedBox } from "@react-three/drei";
import { useFrame } from "@react-three/fiber";
import { useEffect, useMemo, useReducer, useRef } from "react";
import { AdditiveBlending, Color, DoubleSide, type Group, MeshBasicMaterial, MeshStandardMaterial, ShaderMaterial } from "three";
import { FEEDBACK, GROUND_Y, LANE_LETTERS, LANE_WIDTH, laneX } from "../constants";
import type { ActiveGate } from "../runtime";
import { useRuntime } from "./context";
import { bannerTexture, letterTexture } from "./textures";
import { worldLaneColors } from "../worlds";

const GATE_HEIGHT = 3.3;

/** Энергетическая завеса ворот: бегущие строки развёртки, яркие края, вспышка при ответе. */
function curtainMaterial(color: string): ShaderMaterial {
  return new ShaderMaterial({
    transparent: true,
    depthWrite: false,
    side: DoubleSide,
    blending: AdditiveBlending,
    toneMapped: false,
    uniforms: {
      uColor: { value: new Color(color) },
      uTime: { value: 0 },
      uIntensity: { value: 1 },
      uFlash: { value: 0 },
    },
    vertexShader: /* glsl */ `
      varying vec2 vUv;
      void main() {
        vUv = uv;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: /* glsl */ `
      uniform vec3 uColor;
      uniform float uTime;
      uniform float uIntensity;
      uniform float uFlash;
      varying vec2 vUv;
      void main() {
        float edge = pow(1.0 - min(vUv.x, 1.0 - vUv.x) * 2.0, 6.0);
        float scan = 0.5 + 0.5 * sin(vUv.y * 46.0 - uTime * 7.0);
        float band = smoothstep(0.85, 1.0, fract(vUv.y * 1.5 - uTime * 0.6));
        float fade = smoothstep(0.0, 0.12, vUv.y) * (0.55 + 0.45 * vUv.y);
        float alpha = (0.07 + 0.07 * scan + 0.22 * band + 0.5 * edge) * fade * uIntensity + uFlash * 0.45 * fade;
        gl_FragColor = vec4(uColor * (1.0 + uFlash * 1.5), alpha);
        #include <colorspace_fragment>
      }
    `,
  });
}

/** Ворота одного вопроса: арка над каждым треком в его цвете, светящаяся буква сверху. */
function QuestionGate({ active }: { active: ActiveGate }) {
  const runtime = useRuntime();
  const group = useRef<Group>(null);
  const lanes = runtime.lanes;
  const colors = worldLaneColors(runtime.settings.world);
  const materials = useMemo(() => Array.from({ length: lanes }, (_, lane) => {
    const glow = new Color(colors[lane]).multiplyScalar(2.6);
    return {
      curtain: curtainMaterial(colors[lane]),
      strip: new MeshBasicMaterial({ color: glow, toneMapped: false }),
      letter: new MeshBasicMaterial({ map: letterTexture(LANE_LETTERS[lane], colors[lane]), transparent: true, toneMapped: false, color: new Color(1.5, 1.5, 1.5), depthWrite: false }),
      base: new Color(colors[lane]),
      glow,
    };
  }), [lanes, colors]);
  const frame = useMemo(() => new MeshStandardMaterial({ color: "#1c2338", roughness: 0.35, metalness: 0.6 }), []);
  const green = useMemo(() => new Color(FEEDBACK.correct), []);
  const red = useMemo(() => new Color(FEEDBACK.wrong), []);

  useEffect(() => () => {
    materials.forEach((m) => {
      m.curtain.dispose();
      m.strip.dispose();
      m.letter.dispose();
    });
    frame.dispose();
  }, [materials, frame]);

  useFrame(() => {
    if (!group.current) return;
    const z = -(active.distance - runtime.distance);
    group.current.position.z = z;
    // Сразу за бегуном ворота исчезают: между ним и камерой они только заслоняли бы экран.
    group.current.visible = z < 2.5;
    // Буквы гаснут на подлёте — ответы уже подписаны на карточках.
    const letterOpacity = Math.min(1, Math.max(0, (-z - 1) / 5));
    // Ворота «встают» из земли, когда до них ~ 160 м.
    const rise = Math.min(1, Math.max(0, (175 + z) / 30));
    group.current.scale.y = 0.03 + rise * 0.97;
    const since = active.chosenLane === null ? -1 : runtime.clock - active.judgedClock;
    materials.forEach((m, lane) => {
      m.curtain.uniforms.uTime.value = runtime.clock + lane * 0.37;
      m.letter.opacity = letterOpacity;
      if (since < 0) return;
      const isCorrect = lane === active.gate.correctLane;
      const isChosen = lane === active.chosenLane;
      const flash = Math.max(0, 1 - since * 2.2);
      if (isCorrect) {
        (m.curtain.uniforms.uColor.value as Color).copy(green);
        m.curtain.uniforms.uIntensity.value = 2.2;
        m.curtain.uniforms.uFlash.value = flash + 0.25 * Math.max(0, Math.sin(since * 16));
        m.strip.color.copy(green).multiplyScalar(3);
      } else if (isChosen) {
        (m.curtain.uniforms.uColor.value as Color).copy(red);
        m.curtain.uniforms.uIntensity.value = 1.6 + Math.sin(since * 40) * 0.6;
        m.curtain.uniforms.uFlash.value = flash;
        m.strip.color.copy(red).multiplyScalar(3);
      } else {
        m.curtain.uniforms.uIntensity.value = Math.max(0, 1 - since * 3);
        m.strip.color.copy(m.base).multiplyScalar(Math.max(0.5, 2.6 - since * 6));
      }
    });
  });

  const half = (LANE_WIDTH / 2) * 0.93;
  return (
    <group ref={group}>
      {Array.from({ length: lanes }, (_, lane) => (
        <group key={lane} position={[laneX(lane, lanes), GROUND_Y, 0]}>
          {[-half, half].map((x) => (
            <group key={x} position-x={x}>
              <RoundedBox args={[0.16, GATE_HEIGHT, 0.2]} radius={0.05} smoothness={2} position-y={GATE_HEIGHT / 2} material={frame} castShadow />
              <mesh material={materials[lane].strip} position={[-Math.sign(x) * 0.085, GATE_HEIGHT / 2, 0]}>
                <boxGeometry args={[0.025, GATE_HEIGHT * 0.94, 0.07]} />
              </mesh>
            </group>
          ))}
          <RoundedBox args={[half * 2 + 0.16, 0.22, 0.24]} radius={0.06} smoothness={2} position-y={GATE_HEIGHT} material={frame} castShadow />
          <mesh material={materials[lane].strip} position-y={GATE_HEIGHT - 0.12}>
            <boxGeometry args={[half * 2 - 0.1, 0.025, 0.08]} />
          </mesh>
          <mesh material={materials[lane].curtain} position-y={GATE_HEIGHT / 2}>
            <planeGeometry args={[half * 2 - 0.16, GATE_HEIGHT - 0.1]} />
          </mesh>
          <mesh material={materials[lane].letter} position={[0, GATE_HEIGHT + 0.68, 0]}>
            <planeGeometry args={[1.05, 1.05]} />
          </mesh>
        </group>
      ))}
    </group>
  );
}

/** Надувная арка старта или финиша поперёк всей трассы с гирляндой огней. */
function Arch({ at, kind }: { at: () => number | null; kind: "start" | "finish" }) {
  const runtime = useRuntime();
  const group = useRef<Group>(null);
  const span = runtime.lanes * LANE_WIDTH + 2.6;
  const texture = bannerTexture(kind === "start" ? "СТАРТ" : "ФИНИШ", kind);
  const materials = useMemo(() => ({
    pillar: new MeshStandardMaterial({ color: kind === "start" ? "#2b8ff0" : "#e2472c", roughness: 0.4 }),
    ring: new MeshStandardMaterial({ color: "#ffffff", roughness: 0.4 }),
    banner: new MeshBasicMaterial({ map: texture, toneMapped: false, color: new Color(1.15, 1.15, 1.15) }),
    back: new MeshStandardMaterial({ color: "#1d2540", roughness: 0.5 }),
    bulb: new MeshBasicMaterial({ color: new Color(3, 2.4, 1.2), toneMapped: false }),
  }), [kind, texture]);
  useEffect(() => () => Object.values(materials).forEach((m) => m.dispose()), [materials]);
  const bulbs = Math.round(span / 0.7);

  useFrame(() => {
    if (!group.current) return;
    const distance = at();
    group.current.visible = distance !== null && runtime.distance - distance < 30;
    if (distance !== null) group.current.position.z = -(distance - runtime.distance);
    const pulse = 0.7 + 0.3 * Math.sin(runtime.clock * 6);
    materials.bulb.color.setRGB(3 * pulse, 2.4 * pulse, 1.2 * pulse);
  });

  return (
    <group ref={group} visible={false}>
      {[-1, 1].map((side) => (
        <group key={side} position-x={side * span / 2}>
          <mesh material={materials.pillar} position-y={2.9} castShadow>
            <capsuleGeometry args={[0.42, 5, 8, 16]} />
          </mesh>
          {[0.9, 2.3, 3.7, 5.1].map((y) => (
            <mesh key={y} material={materials.ring} position-y={y} rotation-x={Math.PI / 2}>
              <torusGeometry args={[0.43, 0.06, 8, 20]} />
            </mesh>
          ))}
        </group>
      ))}
      <mesh position-y={5.75} material={materials.back} castShadow>
        <boxGeometry args={[span + 0.4, 1.4, 0.36]} />
      </mesh>
      {[0.19, -0.19].map((z) => (
        <mesh key={z} material={materials.banner} position={[0, 5.75, z]} rotation-y={z < 0 ? Math.PI : 0}>
          <planeGeometry args={[span + 0.3, 1.3]} />
        </mesh>
      ))}
      {Array.from({ length: bulbs + 1 }, (_, i) => (
        <mesh key={i} material={materials.bulb} position={[-span / 2 - 0.1 + ((span + 0.2) / bulbs) * i, 6.55, 0.2]}>
          <sphereGeometry args={[0.07, 8, 6]} />
        </mesh>
      ))}
    </group>
  );
}

const START_DISTANCE = 5;

export function Gates() {
  const runtime = useRuntime();
  const [, refresh] = useReducer((n: number) => n + 1, 0);

  useEffect(() => runtime.on((event) => {
    if (event.type === "question" || event.type === "answer" || event.type === "phase") refresh();
  }), [runtime]);

  const shown = [...runtime.passed, ...(runtime.gate ? [runtime.gate] : [])];
  return (
    <group>
      {shown.map((active) => <QuestionGate key={active.gate.key} active={active} />)}
      {!runtime.night && <><Arch kind="start" at={() => START_DISTANCE} />
      <Arch kind="finish" at={() => runtime.finishDistance} /></>}
    </group>
  );
}
