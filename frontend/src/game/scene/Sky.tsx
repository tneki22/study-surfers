import { useFrame } from "@react-three/fiber";
import { useEffect, useMemo, useRef } from "react";
import {
  BackSide,
  BoxGeometry,
  BufferGeometry,
  Color,
  ConeGeometry,
  type Group,
  type Mesh,
  MeshBasicMaterial,
  ShaderMaterial,
  Sprite,
  SpriteMaterial,
} from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import { createRng } from "../engine/random";
import { daylight } from "./daylight";
import { cloudTexture } from "./textures";

/** Небо — сфера вокруг камеры: градиент по высоте взгляда, диск солнца с ореолом, дымка у горизонта. */
function SkyDome() {
  const mesh = useRef<Mesh>(null);
  const material = useMemo(() => new ShaderMaterial({
    side: BackSide,
    depthWrite: false,
    fog: false,
    uniforms: {
      top: { value: new Color() },
      horizon: { value: new Color() },
      ground: { value: new Color() },
      sunColor: { value: new Color() },
      sunDirection: { value: daylight.sunDirection },
    },
    vertexShader: /* glsl */ `
      varying vec3 vWorld;
      void main() {
        vec4 world = modelMatrix * vec4(position, 1.0);
        vWorld = world.xyz;
        gl_Position = projectionMatrix * viewMatrix * world;
      }
    `,
    fragmentShader: /* glsl */ `
      uniform vec3 top;
      uniform vec3 horizon;
      uniform vec3 ground;
      uniform vec3 sunColor;
      uniform vec3 sunDirection;
      varying vec3 vWorld;
      void main() {
        vec3 dir = normalize(vWorld - cameraPosition);
        float h = dir.y;
        vec3 color = h > 0.0
          ? mix(horizon, top, pow(smoothstep(0.0, 1.0, h), 0.55))
          : mix(horizon, ground, pow(smoothstep(0.0, 1.0, -h), 0.45));
        float d = max(dot(dir, normalize(sunDirection)), 0.0);
        color += sunColor * (pow(d, 1400.0) * 9.0 + pow(d, 60.0) * 0.4 + pow(d, 6.0) * 0.16);
        color = mix(color, horizon * 1.04, exp(-abs(h) * 22.0) * 0.4);
        gl_FragColor = vec4(color, 1.0);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }
    `,
  }), []);
  useEffect(() => () => material.dispose(), [material]);

  useFrame(({ camera, scene }) => {
    mesh.current?.position.copy(camera.position);
    (material.uniforms.top.value as Color).copy(daylight.top);
    (material.uniforms.horizon.value as Color).copy(daylight.horizon);
    (material.uniforms.ground.value as Color).copy(daylight.ground);
    (material.uniforms.sunColor.value as Color).copy(daylight.sun);
    // Туман в цвет горизонта — дальние дома растворяются в небе, а не в сером.
    if (scene.fog && "color" in scene.fog) (scene.fog.color as Color).copy(daylight.horizon);
  });

  return (
    <mesh ref={mesh} material={material} renderOrder={-10} frustumCulled={false}>
      <sphereGeometry args={[290, 40, 20]} />
    </mesh>
  );
}

/** Облака-спрайты далеко впереди: медленно плывут и окрашиваются закатом. */
function Clouds() {
  const group = useRef<Group>(null);
  const sprites = useMemo(() => {
    const rng = createRng(99);
    const materials = [0, 1, 2].map((variant) => new SpriteMaterial({
      map: cloudTexture(variant),
      fog: false,
      depthWrite: false,
      transparent: true,
      opacity: 0.96,
    }));
    return Array.from({ length: 18 }, (_, i) => {
      const sprite = new Sprite(materials[i % 3]);
      const width = 45 + rng() * 70;
      sprite.scale.set(width, width / 2, 1);
      sprite.position.set((rng() - 0.5) * 460, 34 + rng() * 52, -110 - rng() * 150);
      sprite.renderOrder = -9;
      return { sprite, speed: 0.6 + rng() * 0.8 };
    });
  }, []);

  useEffect(() => {
    const parent = group.current;
    sprites.forEach(({ sprite }) => parent?.add(sprite));
    return () => {
      sprites.forEach(({ sprite }) => parent?.remove(sprite));
      new Set(sprites.map(({ sprite }) => sprite.material)).forEach((material) => material.dispose());
    };
  }, [sprites]);

  useFrame((_, delta) => {
    for (const { sprite, speed } of sprites) {
      sprite.position.x += delta * speed;
      if (sprite.position.x > 240) sprite.position.x -= 480;
      sprite.material.color.copy(daylight.clouds);
    }
  });

  return <group ref={group} />;
}

/** Силуэты города и гор у горизонта: стоят на месте (бесконечно далеко) и тонут в дымке. */
function Skyline() {
  const { city, hills } = useMemo(() => {
    const rng = createRng(42);
    const towers: BufferGeometry[] = [];
    for (let i = 0; i < 46; i += 1) {
      const x = -250 + i * 11 + rng() * 6;
      if (Math.abs(x) < 14) continue;
      const width = 7 + rng() * 12;
      const height = 14 + rng() * 48 * (1 - Math.abs(x) / 320);
      const box = new BoxGeometry(width, height, 8);
      box.translate(x, height / 2, -232 - rng() * 22);
      towers.push(box);
    }
    const peaks: BufferGeometry[] = [];
    for (let i = 0; i < 9; i += 1) {
      const radius = 50 + rng() * 60;
      const cone = new ConeGeometry(radius, 26 + rng() * 34, 7);
      cone.translate(-240 + i * 60 + rng() * 20, (26 + rng() * 34) / 2 - 4, -262);
      peaks.push(cone);
    }
    const city = mergeGeometries(towers);
    const hills = mergeGeometries(peaks);
    towers.forEach((g) => g.dispose());
    peaks.forEach((g) => g.dispose());
    return { city, hills };
  }, []);
  const materials = useMemo(() => ({
    city: new MeshBasicMaterial({ fog: false }),
    hills: new MeshBasicMaterial({ fog: false }),
    cityBase: new Color("#7f93b3"),
    hillsBase: new Color("#6f8fa8"),
  }), []);
  useEffect(() => () => {
    city.dispose();
    hills.dispose();
    materials.city.dispose();
    materials.hills.dispose();
  }, [city, hills, materials]);

  useFrame(() => {
    materials.city.color.lerpColors(materials.cityBase, daylight.horizon, 0.42);
    materials.hills.color.lerpColors(materials.hillsBase, daylight.horizon, 0.62);
  });

  return (
    <group renderOrder={-8}>
      <mesh geometry={hills} material={materials.hills} renderOrder={-8} />
      <mesh geometry={city} material={materials.city} renderOrder={-7} />
    </group>
  );
}

export function Sky() {
  return (
    <>
      <SkyDome />
      <Skyline />
      <Clouds />
    </>
  );
}
