/** Геометрия трассы и камеры. Мир едет на бегуна: бегун всегда в z = 0, вперёд — это −z. */

export const LANE_WIDTH = 2.6;

/** Центр трека `lane` (0 — левый) при `lanes` треках. */
export function laneX(lane: number, lanes: number): number {
  return (lane - (lanes - 1) / 2) * LANE_WIDTH;
}

export const CAMERA = {
  fov: 55,
  position: [0, 4.8, 7.6] as const,
  lookAt: [0, 0.9, -14] as const,
  near: 0.1,
  far: 320,
};

/** Видимая даль: туман сгущается к ней, за ней объекты не рисуются. */
export const FOG = { near: 70, far: 205 };

/** Длина сегмента окружения и сколько сегментов живёт одновременно (2 позади камеры — для облёта на старте). */
export const SEGMENT_LENGTH = 36;
export const SEGMENT_COUNT = 8;
export const SEGMENTS_BEHIND = 2;

/** Высота верха шпал: на ней стоит бегун, ворота и препятствия. */
export const GROUND_Y = 0.23;

/** Путь тянется от камеры (и за неё — для облёта) до горизонта. */
export const TRACK_NEAR = 70;
export const TRACK_FAR = -240;

/** Цвета треков: те же, что --lane-1…4 в tokens.css. */
export const LANE_COLORS = ["#2b9bf0", "#f5a623", "#8b5cf6", "#ec4899"] as const;
export const LANE_LETTERS = ["A", "B", "C", "D"] as const;

export const FEEDBACK = {
  correct: "#22c55e",
  wrong: "#ef4444",
};
