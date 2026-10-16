// Подготовка выбранных CC0-ассетов Kenney. Архивы лежат в assets-src/night-maglev.
import { NodeIO, Document } from "@gltf-transform/core";
import { ALL_EXTENSIONS } from "@gltf-transform/extensions";
import { dedup, mergeDocuments, meshopt, prune } from "@gltf-transform/functions";
import { MeshoptEncoder } from "meshoptimizer";
import { copyFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
const root = resolve(import.meta.dirname, "../..");
const source = resolve(root, "assets-src/night-maglev");
const target = resolve(root, "frontend/public/models/night");
const soundTarget = resolve(root, "frontend/public/sounds/night");
const licenses = resolve(root, "frontend/public/licenses/night");
for (const dir of [target, soundTarget, licenses]) mkdirSync(dir, { recursive: true });
await MeshoptEncoder.ready;
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({ "meshopt.encoder": MeshoptEncoder });
const doc = new Document();
for (const name of ["container-wide", "computer-wide"]) {
  const input = await io.read(resolve(source, `station/Models/GLB format/${name}.glb`));
  // Цвета унифицирует сцена; исходную текстуру и материалы сохраняем в GLB для воспроизводимости.
  input.getRoot().listScenes().forEach(scene => scene.setName(name));
  mergeDocuments(doc, input);
}
await doc.transform(prune(), dedup(), meshopt({ encoder: MeshoptEncoder }));
const buffer = doc.getRoot().listBuffers()[0];
doc.getRoot().listAccessors().forEach(accessor => accessor.setBuffer(buffer));
doc.getRoot().listBuffers().slice(1).forEach(extra => extra.dispose());
const scene = doc.getRoot().listScenes()[0];
doc.getRoot().listScenes().slice(1).forEach(extra => { extra.listChildren().forEach(node => scene.addChild(node)); extra.dispose(); });
doc.getRoot().setDefaultScene(scene);
await io.write(resolve(target, "station-props.glb"), doc);
const sounds = ["engineCircular_000", "forceField_000", "thrusterFire_000", "computerNoise_000", "doorOpen_000", "impactMetal_000"];
for (const name of sounds) copyFileSync(resolve(source, `sounds/Audio/${name}.ogg`), resolve(soundTarget, `${name}.ogg`));
copyFileSync(resolve(source, "station/License.txt"), resolve(licenses, "Kenney-Space-Station.txt"));
copyFileSync(resolve(source, "sounds/License.txt"), resolve(licenses, "Kenney-Sci-Fi-Sounds.txt"));
console.log("Подготовлены модули станции, 6 звуков и лицензии Kenney.");
