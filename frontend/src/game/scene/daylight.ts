import { Color, Vector3 } from "three";

/*
 * Время суток по прогрессу забега: ясное утро → тёплый день → закат к финишу.
 * Одно общее состояние: его обновляет игровой цикл, читают небо, свет и материалы.
 */

interface Key {
  at: number;
  top: string;
  horizon: string;
  ground: string;
  sun: string;
  sunIntensity: number;
  /** Высота солнца над горизонтом, рад. */
  elevation: number;
  hemiSky: string;
  hemiGround: string;
  hemiIntensity: number;
  clouds: string;
}

const KEYS: Key[] = [
  {
    at: 0, top: "#2b7be4", horizon: "#cfe9ff", ground: "#cfe4c4", sun: "#fff3dd", sunIntensity: 3.1, elevation: 0.95,
    hemiSky: "#cfe6ff", hemiGround: "#86b46a", hemiIntensity: 0.9, clouds: "#ffffff",
  },
  {
    at: 0.55, top: "#2f6fd0", horizon: "#ffe6c2", ground: "#e6dcc0", sun: "#ffe2b5", sunIntensity: 2.9, elevation: 0.62,
    hemiSky: "#dfe6ff", hemiGround: "#94b06a", hemiIntensity: 0.85, clouds: "#fff4e6",
  },
  {
    at: 1, top: "#34408f", horizon: "#ffa86e", ground: "#d9a98a", sun: "#ff9c55", sunIntensity: 2.3, elevation: 0.24,
    hemiSky: "#c4b8f0", hemiGround: "#8a7a5a", hemiIntensity: 0.75, clouds: "#ffc8b0",
  },
];

const parsed = KEYS.map((key) => ({
  ...key,
  colors: Object.fromEntries(
    (["top", "horizon", "ground", "sun", "hemiSky", "hemiGround", "clouds"] as const).map((name) => [name, new Color(key[name])]),
  ) as Record<"top" | "horizon" | "ground" | "sun" | "hemiSky" | "hemiGround" | "clouds", Color>,
}));

export const daylight = {
  /** Прогресс забега 0…1 (сглаженный). */
  progress: 0,
  /** 0 — день, 1 — сумерки: окна и фонари загораются. */
  dusk: 0,
  top: new Color(),
  horizon: new Color(),
  ground: new Color(),
  sun: new Color(),
  sunIntensity: 3,
  sunDirection: new Vector3(),
  hemiSky: new Color(),
  hemiGround: new Color(),
  hemiIntensity: 0.9,
  clouds: new Color(),
};

/** Солнце светит справа-спереди: тени ложатся к камере и влево — объём читается лучше. */
const AZIMUTH = new Vector3(0.62, 0, -0.78).normalize();

export function updateDaylight(progress: number) {
  const t = Math.min(1, Math.max(0, progress));
  daylight.progress = t;
  let index = 0;
  while (index < parsed.length - 2 && t > parsed[index + 1].at) index += 1;
  const a = parsed[index];
  const b = parsed[index + 1];
  const k = (t - a.at) / (b.at - a.at);
  for (const name of ["top", "horizon", "ground", "sun", "hemiSky", "hemiGround", "clouds"] as const) {
    daylight[name].lerpColors(a.colors[name], b.colors[name], k);
  }
  daylight.sunIntensity = a.sunIntensity + (b.sunIntensity - a.sunIntensity) * k;
  daylight.hemiIntensity = a.hemiIntensity + (b.hemiIntensity - a.hemiIntensity) * k;
  const elevation = a.elevation + (b.elevation - a.elevation) * k;
  daylight.sunDirection.copy(AZIMUTH).multiplyScalar(Math.cos(elevation)).setY(Math.sin(elevation)).normalize();
  daylight.dusk = Math.min(1, Math.max(0, (t - 0.55) / 0.4));
}

updateDaylight(0);
