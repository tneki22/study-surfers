import { useFrame, useThree } from "@react-three/fiber";
import { useMemo } from "react";
import { type Mesh, type Object3D, type SkinnedMesh, Vector3 } from "three";
import { GROUND_Y, laneX } from "../../constants";
import { BAR_BOTTOM, HURDLE_TOP } from "../../engine/obstacles";
import { useRuntime } from "../context";

export interface ClearanceRecord {
  id: number;
  kind: "hurdle" | "bar";
  /** Логика засчитала проход. */
  cleared: boolean | null;
  /** Нижняя точка тела над доской барьера / верхняя под балкой, м от шпал. */
  lowest: number;
  highest: number;
  /** Насколько тело залезло в препятствие (0 — не задело). */
  overlap: number;
  frames: number;
}

/** Имя корневой группы бегуна: щуп ищет по нему модель в сцене. */
export const RUNNER_BODY = "runner-body";

/**
 * Только для разработки: пока ряд барьеров или балок проходит сквозь бегуна,
 * берёт реальные вершины модели (со скиннингом) в слое толщиной с препятствие
 * и записывает, не залезло ли тело в доску или балку. Итог — window.__clearance.
 */
export function ClearanceProbe() {
  const runtime = useRuntime();
  const scene = useThree((state) => state.scene);
  const records = useMemo(() => {
    const list: ClearanceRecord[] = [];
    (window as unknown as { __clearance?: ClearanceRecord[] }).__clearance = list;
    return list;
  }, []);
  const v = useMemo(() => new Vector3(), []);

  useFrame(() => {
    const body = scene.getObjectByName(RUNNER_BODY);
    if (!body) return;
    for (const row of runtime.obstacles) {
      if (row.kind !== "hurdle" && row.kind !== "bar") continue;
      if (Math.abs(laneX(row.lane, runtime.lanes) - runtime.runnerX) > 1.3) continue;
      const z = -(row.distance - runtime.distance);
      if (Math.abs(z) > 0.7) continue;
      let record = records.find((r) => r.id === row.id);
      if (!record) {
        record = { id: row.id, kind: row.kind, cleared: null, lowest: Infinity, highest: -Infinity, overlap: 0, frames: 0 };
        records.push(record);
      }
      record.cleared = row.resolved ? !row.hit : record.cleared;
      if (row.hit && row.resolved) continue;
      body.updateMatrixWorld(true);
      const slab = row.kind === "hurdle" ? 0.06 : 0.09;
      let lowest = Infinity;
      let highest = -Infinity;
      body.traverse((object: Object3D) => {
        const mesh = object as Mesh;
        if (!mesh.isMesh || !mesh.visible) return;
        const position = mesh.geometry.attributes.position;
        for (let i = 0; i < position.count; i += 1) {
          if ((mesh as SkinnedMesh).isSkinnedMesh) (mesh as SkinnedMesh).getVertexPosition(i, v);
          else v.fromBufferAttribute(position, i);
          v.applyMatrix4(mesh.matrixWorld);
          if (Math.abs(v.z - z) > slab || Math.abs(v.x - runtime.runnerX) > 1.2) continue;
          lowest = Math.min(lowest, v.y - GROUND_Y);
          highest = Math.max(highest, v.y - GROUND_Y);
        }
      });
      if (lowest === Infinity) continue;
      record.frames += 1;
      record.lowest = Math.min(record.lowest, lowest);
      record.highest = Math.max(record.highest, highest);
      const overlap = row.kind === "hurdle" ? HURDLE_TOP - lowest : highest - BAR_BOTTOM;
      record.overlap = Math.max(record.overlap, overlap, 0);
    }
  });

  return null;
}
