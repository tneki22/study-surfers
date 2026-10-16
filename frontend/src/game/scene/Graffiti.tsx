import { useTexture } from "@react-three/drei";
import { createPortal, useFrame } from "@react-three/fiber";
import { Fragment, useEffect, useMemo, useRef } from "react";
import { CanvasTexture, Group, MeshBasicMaterial, MeshStandardMaterial, SRGBColorSpace } from "three";
import { LANE_WIDTH, SEGMENT_LENGTH } from "../constants";
import { useRuntime } from "./context";

const LOGO_URL = `${import.meta.env.BASE_URL}branding/study-surfers-graffiti.png`;
const LOGO_ASPECT = 1448 / 1086;
const mod = (n: number, divisor: number) => ((n % divisor) + divisor) % divisor;

/** Небольшой соседний тег: нарисован кодом, исходные изображения не меняет. */
function tagTexture() {
  const canvas = document.createElement("canvas");
  canvas.width = 768;
  canvas.height = 384;
  const ctx = canvas.getContext("2d")!;
  ctx.translate(384, 192);
  ctx.rotate(-0.07);
  ctx.lineJoin = "round";
  ctx.lineCap = "round";
  ctx.font = '700 96px "Shantell Sans Variable", sans-serif';
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.lineWidth = 15;
  ctx.strokeStyle = "#142644";
  ctx.strokeText("ЗАЧЁТ!", 0, 20);
  ctx.fillStyle = "#ff7bba";
  ctx.fillText("ЗАЧЁТ!", 0, 20);
  // Корона и росчерк связывают тег с рисунком Study Surfers.
  ctx.strokeStyle = "#ffe53b";
  ctx.lineWidth = 12;
  ctx.beginPath();
  ctx.moveTo(-65, -75); ctx.lineTo(-85, -130); ctx.lineTo(-25, -108);
  ctx.lineTo(5, -158); ctx.lineTo(35, -108); ctx.lineTo(90, -136); ctx.lineTo(65, -75);
  ctx.closePath(); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(-220, 104); ctx.quadraticCurveTo(20, 70, 224, 103); ctx.stroke();
  ctx.strokeStyle = "#46d8ee";
  ctx.lineWidth = 8;
  for (const [x, y, r] of [[-280, -60, 22], [270, 30, 30]] as const) {
    ctx.beginPath(); ctx.moveTo(x - r, y); ctx.lineTo(x + r, y);
    ctx.moveTo(x, y - r); ctx.lineTo(x, y + r); ctx.stroke();
  }
  const texture = new CanvasTexture(canvas);
  texture.colorSpace = SRGBColorSpace;
  return texture;
}

function usePaint() {
  const logo = useTexture(LOGO_URL);
  const paint = useMemo(() => {
    logo.colorSpace = SRGBColorSpace;
    logo.anisotropy = 4;
    const tag = tagTexture();
    const shutterCanvas = document.createElement("canvas");
    shutterCanvas.width = 32; shutterCanvas.height = 128;
    const ctx = shutterCanvas.getContext("2d")!;
    ctx.fillStyle = "#34465a"; ctx.fillRect(0, 0, 32, 128);
    ctx.fillStyle = "#26384b";
    for (let y = 0; y < 128; y += 10) ctx.fillRect(0, y, 32, 2);
    const shutter = new CanvasTexture(shutterCanvas);
    shutter.colorSpace = SRGBColorSpace;
    const material = (map: typeof logo) => new MeshBasicMaterial({
      map, transparent: true, depthWrite: false, alphaTest: 0.03,
      toneMapped: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
    });
    return { logo: material(logo), tag: material(tag), tagTexture: tag,
      shutter: new MeshStandardMaterial({ map: shutter, roughness: 0.95 }), shutterTexture: shutter };
  }, [logo]);
  useEffect(() => () => {
    paint.logo.dispose(); paint.tag.dispose(); paint.tagTexture.dispose();
    paint.shutter.dispose(); paint.shutterTexture.dispose();
  }, [paint]);
  return paint;
}

/** Один материал и текстура на все стены. Пул едет с миром без React-обновлений на кадрах. */
export function GraffitiTrail({ night = false }: { night?: boolean }) {
  const runtime = useRuntime();
  const paint = usePaint();
  const slots = useRef<(Group | null)[]>([]);
  const H = runtime.lanes * LANE_WIDTH / 2;
  const length = night ? 48 : SEGMENT_LENGTH;

  useFrame(() => {
    const origin = Math.floor(runtime.distance / length) - 1;
    slots.current.forEach((slot, i) => {
      if (!slot) return;
      const index = origin + i;
      const district = mod(Math.floor(index / 3), 4);
      // На виадуке сохраняем открытый вид. В тоннеле рисуем по существующей стене.
      slot.visible = night ? district !== 1 && mod(index, 2) === 0 : mod(index, 4) === 1;
      slot.position.z = runtime.distance - index * length;
      slot.children.forEach(child => {
        if (child.name === "service-mural") child.visible = !night || district !== 3;
        if (child.name === "tunnel-mural") child.visible = night && district === 3;
      });
    });
  });

  return <group>{Array.from({ length: 7 }, (_, i) => <group key={i} ref={node => { slots.current[i] = node; }}>
    {[-1, 1].map(side => <group key={side} name="service-mural"
      position={[side * (H + (night ? 3.0 : 5.9)), night ? 2.8 : 2.05, night ? -16 : -22]}
      rotation-y={-side * (night ? 0.34 : Math.PI / 2)}>
      {night && <>
        <mesh position={[0, 0, -0.63]} material={paint.shutter} receiveShadow><boxGeometry args={[4.0, 3.8, 1.2]} /></mesh>
        <mesh position={[0, 1.95, -0.1]}><boxGeometry args={[4.25, 0.18, 1.65]} /><meshStandardMaterial color="#43566c" roughness={0.8} /></mesh>
      </>}
      <mesh material={paint.logo} position={[0, night ? 0.22 : 0, night ? 0.015 : 0.205]}>
        <planeGeometry args={[(night ? 2.7 : 3.1) * LOGO_ASPECT, night ? 2.7 : 3.1]} />
      </mesh>
      <mesh material={paint.tag} position={[night ? 1.1 : 4.0, night ? -1.35 : -0.65, night ? 0.02 : 0.21]} rotation-z={-0.07}>
        <planeGeometry args={[night ? 1.4 : 2.9, night ? 0.7 : 1.45]} />
      </mesh>
    </group>)}
    {night && [-1, 1].map(side => <group key={`tunnel-${side}`} name="tunnel-mural"
      position={[side * (H + 9.1), 2.8, -15]} rotation-y={-side * Math.PI / 2}>
      <mesh position={[0, -0.1, -0.12]} material={paint.shutter}><boxGeometry args={[5.3, 4.2, 0.18]} /></mesh>
      <mesh material={paint.logo}><planeGeometry args={[3.5 * LOGO_ASPECT, 3.5]} /></mesh>
      <mesh material={paint.tag} position={[3.8, -0.7, 0.02]}><planeGeometry args={[2.8, 1.4]} /></mesh>
    </group>)}
  </group>)}</group>;
}

/** Наклейки краской на нижних боковых панелях вагонов, вместе с геометрией поезда. */
export function TrainGraffiti({ groups }: { groups: readonly Group[] }) {
  const paint = usePaint();
  return <>{groups.map(group => <Fragment key={group.uuid}>{createPortal(<group>
    {[-1, 1].map(side => <group key={side} position={[side * 1.425, 1.72, 0]} rotation-y={side * Math.PI / 2}>
      {[-21.25, -9.55, 2.15, 13.85].map((z, j) => <mesh key={z} material={j % 2 ? paint.tag : paint.logo} position={[z, 0, 0]}>
        <planeGeometry args={[j % 2 ? 2.4 : 1.8, j % 2 ? 1.2 : 1.8 / LOGO_ASPECT]} />
      </mesh>)}
    </group>)}
  </group>, group)}</Fragment>)}</>;
}
