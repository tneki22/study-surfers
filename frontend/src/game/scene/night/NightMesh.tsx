import type { Material } from "three";
import type { NightChannel } from "../kit/batch";
import type { NightGeometry } from "./kit";

/** Каналы с объёмом: они отбрасывают и принимают тени, светящиеся — нет. */
export const SOLID_CHANNELS: ReadonlySet<NightChannel> = new Set(["solid", "metal", "glass", "facade"]);

export function NightMesh({ geometry, materials, shadows = false, receiveShadow = shadows }: {
  geometry: NightGeometry;
  materials: Partial<Record<NightChannel, Material>>;
  shadows?: boolean;
  receiveShadow?: boolean;
}) {
  return <>{[...geometry].map(([channel, part]) => materials[channel] && (
    <mesh key={channel} geometry={part} material={materials[channel]} castShadow={shadows && SOLID_CHANNELS.has(channel)} receiveShadow={receiveShadow && SOLID_CHANNELS.has(channel)} dispose={null} />
  ))}</>;
}
