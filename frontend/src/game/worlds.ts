import { LANE_COLORS } from "./constants";
import type { World } from "./engine/settings";

export const NIGHT_LANE_COLORS = ["#55d6cc", "#e6ae62", "#8fb6e8", "#c9d9bc"] as const;
export const worldLaneColors = (world: World) => world === "night-maglev" ? NIGHT_LANE_COLORS : LANE_COLORS;
