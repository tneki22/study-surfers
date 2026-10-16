import { AdditiveBlending, Color, ShaderMaterial } from "three";

/**
 * Оболочка усиления байка: светится по краю (френель), внутри почти прозрачна,
 * поэтому пилот и трасса за ней читаются. Щит — соты, фаза — бегущие полосы.
 * Вспышка — короткий всплеск яркости на импульсе щита.
 */
export function energyShellMaterial() {
  return new ShaderMaterial({
    transparent: true,
    depthWrite: false,
    blending: AdditiveBlending,
    toneMapped: false,
    uniforms: {
      uColor: { value: new Color() },
      uTime: { value: 0 },
      uOpacity: { value: 0 },
      uFlash: { value: 0 },
      uMode: { value: 0 },
    },
    vertexShader: /* glsl */ `
      varying vec3 vNormal;
      varying vec3 vView;
      varying vec2 vUv;
      varying float vY;
      void main() {
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        vNormal = normalize(normalMatrix * normal);
        vView = normalize(-mv.xyz);
        vUv = uv;
        vY = position.y;
        gl_Position = projectionMatrix * mv;
      }
    `,
    fragmentShader: /* glsl */ `
      uniform vec3 uColor;
      uniform float uTime;
      uniform float uOpacity;
      uniform float uFlash;
      uniform float uMode;
      varying vec3 vNormal;
      varying vec3 vView;
      varying vec2 vUv;
      varying float vY;
      float hexEdge(vec2 p) {
        p.x *= 1.1547;
        p.y += mod(floor(p.x), 2.0) * 0.5;
        p = abs(fract(p) - 0.5);
        return abs(max(p.x * 1.5 + p.y, p.y * 2.0) - 1.0);
      }
      void main() {
        float rim = pow(1.0 - abs(dot(normalize(vNormal), normalize(vView))), 2.4);
        float pattern;
        if (uMode < 0.5) {
          pattern = 1.0 - smoothstep(0.02, 0.09, hexEdge(vUv * vec2(26.0, 13.0)));
          pattern *= 0.55 + 0.45 * sin(vUv.y * 18.0 - uTime * 4.0);
        } else {
          pattern = smoothstep(0.6, 1.0, sin(vY * 34.0 - uTime * 9.0));
        }
        float a = (rim * 0.9 + pattern * (0.18 + rim * 0.5) + 0.03) * uOpacity + uFlash * (0.35 + rim);
        gl_FragColor = vec4(uColor * a, a);
      }
    `,
  });
}
