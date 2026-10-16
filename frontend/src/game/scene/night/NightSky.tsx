import { useFrame } from "@react-three/fiber";
import { useEffect, useMemo, useRef } from "react";
import { AdditiveBlending, BackSide, Color, CylinderGeometry, type Group, type Mesh, ShaderMaterial, Vector3 } from "three";
import { NIGHT_SKY, nightFog, nightUniforms } from "./kit";

/** Луна справа от табло: там её не закрывают ни карточки, ни счёт. */
export const MOON_DIRECTION = new Vector3(0.62, 0.2, -0.76).normalize();

/**
 * Небо — сфера вокруг камеры: градиент с подсветкой города у горизонта,
 * мерцающие звёзды, луна с ореолом, облака, подсвеченные снизу,
 * и бесконечно далёкий силуэт мегаполиса с огоньками окон.
 */
function SkyDome({ clouds }: { clouds: boolean }) {
  const mesh = useRef<Mesh>(null);
  const material = useMemo(() => new ShaderMaterial({
    side: BackSide, depthWrite: false, fog: false,
    defines: clouds ? { CLOUDS: 1 } : {},
    uniforms: {
      uTime: nightUniforms.uTime, uMotion: nightUniforms.uMotion,
      uZenith: { value: new Color(NIGHT_SKY.zenith) }, uUpper: { value: new Color(NIGHT_SKY.upper) },
      uHorizon: { value: new Color(NIGHT_SKY.horizon) }, uGlow: { value: new Color(NIGHT_SKY.glow) }, uFog: { value: nightFog },
      uMoon: { value: MOON_DIRECTION },
    },
    vertexShader: /* glsl */ `
      varying vec3 vWorld;
      void main() {
        vec4 world = modelMatrix * vec4(position, 1.0);
        vWorld = world.xyz;
        gl_Position = projectionMatrix * viewMatrix * world;
      }`,
    fragmentShader: /* glsl */ `
      uniform float uTime; uniform float uMotion;
      uniform vec3 uZenith; uniform vec3 uUpper; uniform vec3 uHorizon; uniform vec3 uGlow; uniform vec3 uFog; uniform vec3 uMoon;
      varying vec3 vWorld;
      float hash1(float n) { return fract(sin(n * 127.1) * 43758.5453); }
      float hash3(vec3 p) { return fract(sin(dot(p, vec3(127.1, 311.7, 74.7))) * 43758.5453); }
      float noise(vec2 p) {
        vec2 i = floor(p); vec2 f = fract(p); f = f * f * (3.0 - 2.0 * f);
        float a = fract(sin(dot(i, vec2(127.1, 311.7))) * 43758.5453);
        float b = fract(sin(dot(i + vec2(1.0, 0.0), vec2(127.1, 311.7))) * 43758.5453);
        float c = fract(sin(dot(i + vec2(0.0, 1.0), vec2(127.1, 311.7))) * 43758.5453);
        float d = fract(sin(dot(i + vec2(1.0, 1.0), vec2(127.1, 311.7))) * 43758.5453);
        return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
      }
      float fbm(vec2 p) { float v = 0.0; float a = 0.5; for (int i = 0; i < 4; i++) { v += a * noise(p); p = p * 2.03 + 17.1; a *= 0.5; } return v; }
      void main() {
        vec3 dir = normalize(vWorld - cameraPosition);
        float h = dir.y;
        float t = uTime * uMotion;
        vec3 color = mix(uFog, uHorizon, smoothstep(-0.02, 0.05, h));
        color = mix(color, uUpper, smoothstep(0.04, 0.32, h));
        color = mix(color, uZenith, smoothstep(0.3, 0.95, h));
        color += uGlow * exp(-abs(h) * 16.0) * 0.55;

        // Звёзды: сетка на сфере, редкие ячейки горят и мерцают.
        vec3 sp = dir * 260.0;
        vec3 cell = floor(sp);
        float star = hash3(cell);
        if (star > 0.9955) {
          float r = length(fract(sp) - 0.5);
          float twinkle = 0.65 + 0.35 * sin(t * (1.5 + star * 4.0) + star * 90.0);
          color += vec3(0.85, 0.9, 1.0) * smoothstep(0.32, 0.0, r) * twinkle * smoothstep(0.06, 0.35, h) * (star > 0.999 ? 2.4 : 1.0);
        }

        // Луна: диск с «морями», мягкий ореол и широкое гало.
        float m = dot(dir, uMoon);
        vec3 tangent = normalize(cross(uMoon, vec3(0.0, 1.0, 0.0)));
        vec3 bitangent = cross(tangent, uMoon);
        vec2 mp = vec2(dot(dir, tangent), dot(dir, bitangent)) / 0.035;
        float disc = 0.0;
        if (m > 0.998) {
          disc = smoothstep(1.0, 0.94, length(mp));
          float seas = fbm(mp * 2.2 + 3.0);
          vec3 moon = mix(vec3(0.75, 0.8, 0.92), vec3(1.0, 0.97, 0.9), smoothstep(0.35, 0.65, seas)) * (0.9 - 0.25 * dot(mp, vec2(0.6, -0.4)));
          color = mix(color, moon * 1.6, disc);
        }
        color += vec3(0.55, 0.62, 0.95) * (pow(max(m, 0.0), 900.0) * 0.6 + pow(max(m, 0.0), 60.0) * 0.12 + pow(max(m, 0.0), 8.0) * 0.05);

        #ifdef CLOUDS
        // Облака: плоскость над городом, снизу их подсвечивают огни.
        if (h > 0.0) {
          vec2 uv = dir.xz / (h + 0.06) * 0.9 + vec2(t * 0.012, t * 0.004);
          float c = fbm(uv);
          float cover = smoothstep(0.5, 0.82, c) * smoothstep(0.015, 0.12, h) * (1.0 - smoothstep(0.55, 0.9, h));
          vec3 lit = mix(uGlow * 0.9 + vec3(0.04, 0.02, 0.05), uUpper * 1.4, smoothstep(0.02, 0.35, h));
          lit += vec3(0.4, 0.45, 0.6) * pow(max(m, 0.0), 12.0) * 0.6;
          color = mix(color, lit, cover * 0.85 * (1.0 - disc));
        }
        #endif

        // Бесконечно далёкий силуэт мегаполиса: дальний и ближний слой башен с окнами.
        float az = atan(dir.x, -dir.z);
        for (int layer = 1; layer >= 0; layer--) {
          float fl = float(layer);
          float bx = az * (55.0 + fl * 38.0) + fl * 13.0;
          float id = floor(bx);
          float fx = fract(bx);
          float top = 0.006 + hash1(id + fl * 71.0) * (0.03 - fl * 0.012) + step(0.88, hash1(id * 1.7 + fl)) * (0.035 - fl * 0.015);
          float spireH = step(0.9, hash1(id * 5.3 + fl)) * 0.024;
          if (h < top) {
            vec3 body = uFog * (0.5 + fl * 0.3);
            vec2 wcell = floor(vec2(fx * 6.0, h * 350.0));
            float lit = step(0.7, hash3(vec3(wcell, id + fl * 9.0))) * step(0.12, fx) * step(fx, 0.88) * smoothstep(-0.03, 0.0, h);
            vec3 tint = mix(vec3(1.0, 0.62, 0.32), vec3(0.45, 0.82, 1.0), step(0.6, hash1(id * 3.1 + wcell.y)));
            color = body + tint * lit * (0.4 - fl * 0.18);
          } else if (spireH > 0.0 && abs(fx - 0.5) < 0.035 && h < top + spireH) {
            color = uFog * 0.55;
            if (h > top + spireH - 0.004) color += vec3(1.8, 0.15, 0.2) * step(0.55, fract(t * 0.6 + id * 0.37));
          }
        }
        gl_FragColor = vec4(color, 1.0);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }`,
  }), [clouds]);
  useEffect(() => () => material.dispose(), [material]);
  useFrame(({ camera }) => { mesh.current?.position.copy(camera.position); });
  // Небо рисуется после всех непрозрачных: тест глубины отсекает пиксели, закрытые городом,
  // и дорогой шейдер считается только там, где небо действительно видно.
  return <mesh ref={mesh} material={material} renderOrder={1000} frustumCulled={false}>
    <sphereGeometry args={[300, 48, 24]} />
  </mesh>;
}

/** Прожекторы над городом медленно шарят по облакам. */
function Searchlights({ reducedMotion }: { reducedMotion: boolean }) {
  const groups = useRef<(Group | null)[]>([]);
  const geometry = useMemo(() => new CylinderGeometry(7, 0.5, 240, 24, 1, true).translate(0, 120, 0), []);
  const material = useMemo(() => new ShaderMaterial({
    transparent: true, depthWrite: false, blending: AdditiveBlending, fog: false, toneMapped: false,
    uniforms: { uColor: { value: new Color("#9fb8ff") } },
    vertexShader: /* glsl */ `
      varying vec2 vUv; varying float vFacing;
      void main() {
        vUv = uv;
        vec3 n = normalize(normalMatrix * normal);
        vec4 view = modelViewMatrix * vec4(position, 1.0);
        vFacing = abs(dot(n, normalize(-view.xyz)));
        gl_Position = projectionMatrix * view;
      }`,
    fragmentShader: /* glsl */ `
      uniform vec3 uColor; varying vec2 vUv; varying float vFacing;
      void main() {
        float along = pow(vUv.y, 1.6) * smoothstep(1.0, 0.92, vUv.y);
        gl_FragColor = vec4(uColor, pow(vFacing, 2.5) * (1.0 - vUv.y) * 0.11 * (1.0 - along * 0.3));
      }`,
  }), []);
  useEffect(() => () => { geometry.dispose(); material.dispose(); }, [geometry, material]);
  const beams = [[-150, -20, -210, 0.0], [135, -20, -190, 2.1], [-70, -20, -260, 4.2]] as const;
  useFrame(() => {
    const t = reducedMotion ? 0 : nightUniforms.uTime.value;
    groups.current.forEach((group, i) => {
      if (!group) return;
      const phase = beams[i][3];
      group.rotation.set(-0.35 + Math.sin(t * 0.21 + phase) * 0.25, 0, Math.sin(t * 0.17 + phase * 1.3) * 0.55 + (i === 1 ? -0.3 : 0.3));
    });
  });
  return <>{beams.map(([x, y, z], i) => <group key={i} position={[x, y, z]} ref={node => { groups.current[i] = node; }}>
    <mesh geometry={geometry} material={material} frustumCulled={false} renderOrder={-5} />
  </group>)}</>;
}

export function NightSky({ tier, reducedMotion }: { tier: "low" | "medium" | "high"; reducedMotion: boolean }) {
  return <>
    <SkyDome clouds={tier !== "low"} />
    {tier === "high" && <Searchlights reducedMotion={reducedMotion} />}
  </>;
}
