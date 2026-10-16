import { createContext, useContext } from "react";
import type { GameRuntime } from "../runtime";

export const RuntimeContext = createContext<GameRuntime | null>(null);

export function useRuntime(): GameRuntime {
  const runtime = useContext(RuntimeContext);
  if (!runtime) throw new Error("Сцена забега вне RuntimeContext");
  return runtime;
}
