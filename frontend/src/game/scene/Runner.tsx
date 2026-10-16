import { Suspense } from "react";
import { usePreferences } from "../../app/stores";
import { ModelRunner } from "./runner/ModelRunner";
import { ProceduralRunner } from "./runner/ProceduralRunner";

/**
 * Бегун выбранного в параметрах героя. Пока модель KayKit грузится
 * (или если выбран «Студент»), бежит процедурный бегун.
 */
export function Runner({ reducedMotion, quietEffects }: { reducedMotion: boolean; quietEffects: boolean }) {
  const character = usePreferences((s) => s.character);
  if (character === "student") return <ProceduralRunner reducedMotion={reducedMotion} quietEffects={quietEffects} />;
  return (
    <Suspense fallback={<ProceduralRunner reducedMotion={reducedMotion} quietEffects={quietEffects} />}>
      <ModelRunner key={character} hero={character} reducedMotion={reducedMotion} quietEffects={quietEffects} />
    </Suspense>
  );
}
