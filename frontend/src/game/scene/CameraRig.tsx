import { useFrame, useThree } from "@react-three/fiber";
import { useMemo, useRef } from "react";
import { type PerspectiveCamera, Vector3 } from "three";
import { GROUND_Y } from "../constants";
import { cameraPose } from "../layout";
import { IMPACTS } from "../engine/impact";
import { FLIGHT_HEIGHT } from "../engine/modifiers";
import { GRAVITY } from "../engine/obstacles";
import { useRuntime } from "./context";

const INTRO_SECONDS = 2.6;
const smooth = (t: number) => t * t * t * (t * (t * 6 - 15) + 10);
const clamp01 = (t: number) => Math.min(1, Math.max(0, t));

/**
 * Камера: на старте — портрет бегуна спереди и облёт справа за спину
 * (внутри опор стартовой арки), во время забега — неподвижная поза
 * (карточки ответов привязаны к экрану, поэтому камера по X не ходит),
 * тряска при ошибке и ударе, облёт спереди на финише. На крышах вагонеток
 * камера плавно поднимается вслед за бегуном, чтобы он не уезжал вверх по экрану.
 */
export function CameraRig({ reducedMotion }: { reducedMotion: boolean }) {
  const runtime = useRuntime();
  const camera = useThree((state) => state.camera) as PerspectiveCamera;
  const aspect = useThree((state) => state.size.width / Math.max(1, state.size.height));
  const pose = cameraPose(aspect, runtime.lanes);
  const vectors = useMemo(() => ({
    position: new Vector3(),
    target: new Vector3(),
    runner: new Vector3(),
    face: new Vector3(),
  }), []);
  const lift = useRef(0);
  const back = useRef(0);

  useFrame((_, delta) => {
    if (runtime.phase === "paused") return;
    const { position, target, runner, face } = vectors;
    const { position: runPosition, lookAt: runTarget } = pose;
    if (camera.fov !== pose.fov) {
      camera.fov = pose.fov;
      camera.updateProjectionMatrix();
    }
    // Запас над шлемом самого высокого героя: полёт остаётся под карточками.
    // Камера целится в высоту, к которой герой только летит (вершина прыжка,
    // эшелон джетпака), — на быстром взлёте шлем не заходит под ответы.
    const peak = runtime.modifiers.has("jetpack") ? FLIGHT_HEIGHT : runtime.airborne && runtime.vy > 0 ? runtime.feet + (runtime.vy * runtime.vy) / (2 * GRAVITY) : runtime.feet;
    // Опережение неполное: на взлёте ступни не уходят за нижнюю кромку.
    const lead = runtime.feet + (peak - runtime.feet) * 0.2;
    const elevation = runtime.night ? runtime.support() * 0.8 : Math.max(runtime.support() * 0.8, lead * 1.18);
    // Вниз камера догоняет быстрее: на посадке ступни не уходят под нижнюю кромку.
    lift.current += (elevation - lift.current) * (1 - Math.exp(-Math.min(delta, 0.05) * (elevation < lift.current ? 13 : 7)));
    runner.set(runtime.runnerX, GROUND_Y + 1.25 + runtime.support(), 0);
    position.copy(runPosition);
    target.copy(runTarget);
    // В полёте камера немного отъезжает: наклонённый герой с ранцем и факелами
    // помещается между карточками и нижней кромкой.
    const flying = !runtime.night && runtime.modifiers.has("jetpack") ? Math.min(1, runtime.feet / FLIGHT_HEIGHT) : 0;
    back.current += (flying - back.current) * (1 - Math.exp(-Math.min(delta, 0.05) * 4));
    position.y += lift.current + back.current * 0.45;
    target.y += back.current * 1.5;
    position.z += back.current * 0.9;
    target.y += lift.current;

    switch (runtime.night && reducedMotion ? "running" : runtime.phase) {
      case "intro": {
        const t = clamp01(runtime.phaseClock / INTRO_SECONDS);
        const swing = smooth(clamp01((t - 0.18) / 0.82));
        const pull = smooth(clamp01((t - 0.45) / 0.55));
        const angle = Math.PI * (1 - swing);
        const radius = 3.3 + (runPosition.z - 3.3) * pull;
        const height = GROUND_Y + 1.55 + (runPosition.y - GROUND_Y - 1.55) * pull;
        const x = runtime.runnerX + (0 - runtime.runnerX) * pull;
        position.set(x + Math.sin(angle) * radius, height, Math.cos(angle) * radius);
        face.set(runtime.runnerX, GROUND_Y + 1.5, 0);
        target.lerpVectors(face, runTarget, pull);
        break;
      }
      case "finished": {
        const t = smooth(Math.min(1, runtime.phaseClock / 2.2));
        const angle = Math.PI * 0.85 * t;
        const radius = runPosition.z + (5.4 - runPosition.z) * t;
        position.set(runtime.runnerX + Math.sin(angle) * radius, runPosition.y + (2.3 - runPosition.y) * t, Math.cos(angle) * radius);
        target.lerpVectors(runTarget, runner, t);
        break;
      }
      case "gameover": {
        const t = smooth(Math.min(1, runtime.phaseClock / 1.6));
        position.lerpVectors(runPosition, new Vector3(runtime.runnerX + 1.6, 2.6, 4.2), t);
        target.lerpVectors(runTarget, runner, t);
        break;
      }
      default:
        break;
    }

    if (!reducedMotion) {
      const sinceHit = runtime.clock - runtime.hitClock;
      const sinceBump = runtime.clock - runtime.bumpClock;
      let strength = 0;
      if (sinceHit < 0.35) strength = (1 - sinceHit / 0.35) * 0.16;
      if (sinceBump < 0.3) strength = Math.max(strength, (1 - sinceBump / 0.3) * IMPACTS[runtime.bumpSeverity].shake);
      if (strength > 0) {
        position.x += Math.sin(runtime.clock * 71) * strength;
        position.y += Math.cos(runtime.clock * 53) * strength;
      }
    }

    camera.position.copy(position);
    camera.lookAt(target);
  });

  return null;
}
