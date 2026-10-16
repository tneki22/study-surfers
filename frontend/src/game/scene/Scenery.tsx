import { useFrame } from "@react-three/fiber";
import { useEffect, useMemo, useRef } from "react";
import { BufferGeometry, Group, Mesh } from "three";
import { LANE_WIDTH, SEGMENT_COUNT, SEGMENT_LENGTH, SEGMENTS_BEHIND } from "../constants";
import { useRuntime } from "./context";
import { GraffitiTrail } from "./Graffiti";
import type { Channel } from "./kit/batch";
import { buildSegment } from "./kit/city";
import { CHANNEL_MATERIALS, prepareSceneMaterials } from "./materials";

const CHANNELS: Channel[] = ["solid", "facade", "glass", "glow", "leaf", "metal", "ads"];
const CASTS: ReadonlySet<Channel> = new Set(["solid", "facade", "leaf", "metal"]);
const EMPTY = new BufferGeometry();

type Built = Map<Channel, BufferGeometry>;

const idle: (callback: () => void) => void =
  typeof requestIdleCallback === "function" ? (callback) => requestIdleCallback(callback, { timeout: 400 }) : (callback) => setTimeout(callback, 0);

/** Готовые геометрии сегментов: следующий строится заранее в простое, старые освобождаются. */
class SegmentCache {
  private built = new Map<number, Built>();
  private pending = new Set<number>();
  private disposed = false;
  private readonly build: (index: number) => Built;

  constructor(build: (index: number) => Built) {
    this.build = build;
  }

  get(index: number): Built {
    let segment = this.built.get(index);
    if (!segment) {
      segment = this.build(index);
      this.built.set(index, segment);
    }
    return segment;
  }

  prefetch(index: number) {
    if (this.built.has(index) || this.pending.has(index)) return;
    this.pending.add(index);
    idle(() => {
      this.pending.delete(index);
      if (!this.disposed && !this.built.has(index)) this.built.set(index, this.build(index));
    });
  }

  releaseBelow(index: number) {
    for (const [key, segment] of this.built) {
      if (key >= index) continue;
      segment.forEach((geometry) => geometry.dispose());
      this.built.delete(key);
    }
  }

  dispose() {
    this.disposed = true;
    this.releaseBelow(Number.POSITIVE_INFINITY);
  }
}

interface Slot {
  index: number;
  group: Group;
  meshes: Map<Channel, Mesh>;
}

/**
 * Город вдоль трассы. Сегменты живут в пуле слотов: когда сегмент уезжает за
 * камеру, его слот получает геометрию следующего — без перерисовки React и
 * без пересоздания мешей.
 */
export function Scenery({ shadows }: { shadows: boolean }) {
  const runtime = useRuntime();
  const root = useRef<Group>(null);
  const trackHalf = (runtime.lanes * LANE_WIDTH) / 2;

  const cache = useMemo(() => {
    prepareSceneMaterials();
    return new SegmentCache((index) => buildSegment(index, trackHalf, runtime.lanes, LANE_WIDTH));
  }, [trackHalf, runtime.lanes]);

  const slots = useMemo<Slot[]>(() => Array.from({ length: SEGMENT_COUNT }, () => {
    const group = new Group();
    const meshes = new Map<Channel, Mesh>();
    for (const channel of CHANNELS) {
      const mesh = new Mesh(EMPTY, CHANNEL_MATERIALS[channel]);
      mesh.castShadow = shadows && CASTS.has(channel);
      mesh.receiveShadow = shadows && channel !== "glow";
      mesh.matrixAutoUpdate = false;
      group.add(mesh);
      meshes.set(channel, mesh);
    }
    return { index: Number.NaN, group, meshes };
  }), [shadows]);

  useEffect(() => {
    const parent = root.current;
    if (!parent) return;
    slots.forEach((slot) => parent.add(slot.group));
    return () => slots.forEach((slot) => parent.remove(slot.group));
  }, [slots]);

  useEffect(() => () => cache.dispose(), [cache]);

  useFrame(() => {
    const base = Math.floor(runtime.distance / SEGMENT_LENGTH) - SEGMENTS_BEHIND;
    for (let i = 0; i < SEGMENT_COUNT; i += 1) {
      const index = base + i;
      const slot = slots[((index % SEGMENT_COUNT) + SEGMENT_COUNT) % SEGMENT_COUNT];
      if (slot.index !== index) {
        const segment = cache.get(index);
        for (const [channel, mesh] of slot.meshes) {
          const geometry = segment.get(channel);
          mesh.geometry = geometry ?? EMPTY;
          mesh.visible = Boolean(geometry);
        }
        slot.index = index;
      }
      slot.group.position.z = -(index * SEGMENT_LENGTH - runtime.distance);
    }
    cache.prefetch(base + SEGMENT_COUNT);
    cache.releaseBelow(base - 1);
  });

  return <><group ref={root} /><GraffitiTrail /></>;
}
