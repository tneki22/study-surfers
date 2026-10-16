import { PerspectiveCamera, Vector3 } from "three";
import { CAMERA, GROUND_Y, LANE_WIDTH, laneX } from "./constants";
import type { ScreenLayout } from "./store";

export interface CameraPose {
  fov: number;
  position: Vector3;
  lookAt: Vector3;
}

const poses = new Map<string, CameraPose>();

/**
 * Поза камеры в забеге под форму экрана. На широком экране — обычная поза.
 * На узком (телефон стоя) все треки не влезают по ширине, поэтому камера
 * шире смотрит и отъезжает назад от бегуна, пока крайние треки не
 * окажутся в кадре. Цель взгляда та же — горизонт остаётся на месте.
 */
export function cameraPose(aspect: number, lanes: number): CameraPose {
  const key = `${aspect.toFixed(3)}:${lanes}`;
  const cached = poses.get(key);
  if (cached) return cached;
  const fov = aspect < 1 ? 68 : CAMERA.fov;
  const base = new Vector3(...CAMERA.position);
  const lookAt = new Vector3(...CAMERA.lookAt);
  const edge = new Vector3(laneX(lanes - 1, lanes) + LANE_WIDTH * 0.35, GROUND_Y, 0);
  const camera = new PerspectiveCamera(fov, aspect, CAMERA.near, CAMERA.far);
  for (let scale = 1; scale <= 3; scale += 0.05) {
    // Только назад, не вверх: выше 5,3 камера окажется над контактными проводами.
    camera.position.set(base.x, base.y, base.z * scale);
    camera.lookAt(lookAt);
    camera.updateMatrixWorld(true);
    camera.updateProjectionMatrix();
    if (edge.clone().project(camera).x <= 0.96) break;
  }
  const pose = { fov, position: camera.position.clone(), lookAt };
  if (poses.size > 64) poses.clear();
  poses.set(key, pose);
  return pose;
}

/** Камера в позе забега — по ней считаются места табло и карточек, независимо от анимаций камеры. */
export function runningCamera(aspect: number, lanes: number): PerspectiveCamera {
  const pose = cameraPose(aspect, lanes);
  const camera = new PerspectiveCamera(pose.fov, aspect, CAMERA.near, CAMERA.far);
  camera.position.copy(pose.position);
  camera.lookAt(pose.lookAt);
  camera.updateMatrixWorld(true);
  camera.updateProjectionMatrix();
  return camera;
}

/**
 * Раскладка HUD. Табло задаётся в экранных координатах (сверху по центру),
 * 3D-рамка потом подстраивается под него. Карточки ответов — столбцы над
 * треками там, где бежит бегун (z = 0): по горизонтали каждая стоит над
 * центром своего трека у ног бегуна, а по вертикали висит на линии `cardsY`.
 * Дальше по трассе треки сходятся в перспективе — привязка к ним сделала бы
 * карточки слишком узкими.
 *
 * Телефон: стоя табло во всю ширину и пониже, карточки узкие и прижаты
 * к табло — середина экрана остаётся под трассу и препятствия; лёжа (низкий экран)
 * табло ниже и прижато к верху, чтобы карточкам осталось место.
 */
export function computeLayout(width: number, height: number, lanes: number): ScreenLayout {
  const camera = runningCamera(width / height, lanes);
  const narrow = width < 560;
  const short = height < 520;
  const billboardWidth = narrow ? width - 24 : Math.min(900, width * (short ? 0.6 : 0.68));
  const billboardHeight = short
    ? Math.max(96, height * 0.3)
    : narrow
      ? Math.max(120, Math.min(170, height * 0.18))
      : Math.max(140, Math.min(250, height * 0.25));
  const billboard = {
    left: (width - billboardWidth) / 2,
    top: short ? 12 : narrow ? 64 : Math.max(76, height * 0.1),
    width: billboardWidth,
    height: billboardHeight,
  };

  const below = billboard.top + billboard.height;
  const cardsY = short
    ? Math.max(below + 50, height * 0.48)
    : narrow
      ? below + 56
      : Math.max(below + 80, height * 0.58);
  const centers = Array.from({ length: lanes }, (_, lane) => {
    const point = new Vector3(laneX(lane, lanes), 0, 0).project(camera);
    return ((point.x + 1) / 2) * width;
  });
  const spacing = lanes > 1 ? centers[1] - centers[0] : width / 3;
  const cardWidth = narrow || short ? Math.max(64, Math.min(380, spacing - 6)) : Math.max(140, Math.min(380, spacing - 16));

  return {
    width,
    height,
    billboard,
    cards: centers.map((centerX) => ({ centerX, width: cardWidth })),
    cardsY,
  };
}
