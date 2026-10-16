// Готовит персонажей KayKit для игры: `npm run assets`.
// Вход — скачанные GLB в assets-src/kaykit-adventurers (см. docs/ASSETS.md),
// выход — frontend/public/models:
//   kaykit-anims.glb      — скелет и только нужные игре клипы (общие для всех героев);
//   kaykit-<герой>.glb    — меши со скином, без анимаций и без оружия.
// У всех героев набора один и тот же скелет (41 кость, одинаковые имена),
// поэтому клипы из одного файла подходят к любому.
import { NodeIO } from "@gltf-transform/core";
import { ALL_EXTENSIONS } from "@gltf-transform/extensions";
import { dedup, meshopt, prune, resample } from "@gltf-transform/functions";
import { MeshoptEncoder } from "meshoptimizer";
import { mkdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const source = join(root, "assets-src", "kaykit-adventurers");
const target = join(root, "frontend", "public", "models");
mkdirSync(target, { recursive: true });

const HEROES = {
  "rogue-hooded": "Rogue_Hooded.glb",
  rogue: "Rogue.glb",
  knight: "Knight.glb",
  mage: "Mage.glb",
  barbarian: "Barbarian.glb",
};

/** Оружие, щиты и прочее, что висит на костях рук: бегуну с ними не по пути. */
const GEAR = /^(1H_|2H_|Knife|Throwable|Mug|Spellbook|.*Shield)/;

/** Клипы, которые использует игра (CLIPS в src/game/scene/runner/ModelRunner.tsx). */
const CLIPS = [
  "Unarmed_Idle",
  "Idle",
  "Running_A",
  "Running_Strafe_Left",
  "Running_Strafe_Right",
  "Jump_Start",
  "Jump_Idle",
  "Jump_Land",
  "Lie_Pose",
  "Hit_A",
  "Hit_B",
  "Cheer",
  "Death_A",
];

await MeshoptEncoder.ready;
const io = new NodeIO()
  .registerExtensions(ALL_EXTENSIONS)
  .registerDependencies({ "meshopt.encoder": MeshoptEncoder });

const finish = async (document, file) => {
  await document.transform(prune(), dedup(), meshopt({ encoder: MeshoptEncoder, level: "medium" }));
  const path = join(target, file);
  await io.write(path, document);
  console.log(`${file.padEnd(26)} ${(statSync(path).size / 1024).toFixed(0).padStart(6)} КБ`);
};

/** Удалить клип целиком: сэмплеры держат аксессоры, и prune без этого их не уберёт. */
const dropAnimation = (animation) => {
  for (const channel of animation.listChannels()) channel.dispose();
  for (const sampler of animation.listSamplers()) sampler.dispose();
  animation.dispose();
};

/** Имена узлов-костей: каналы на IK-контроллеры three.js не нужны. */
const jointNames = (document) => new Set(
  document.getRoot().listSkins().flatMap((skin) => skin.listJoints().map((joint) => joint.getName())),
);

// Анимации: берём из героя в капюшоне, меши выкидываем.
{
  const document = await io.read(join(source, HEROES["rogue-hooded"]));
  const joints = jointNames(document);
  const rootNode = document.getRoot();
  for (const animation of rootNode.listAnimations()) {
    if (!CLIPS.includes(animation.getName())) {
      dropAnimation(animation);
      continue;
    }
    for (const channel of animation.listChannels()) {
      const node = channel.getTargetNode();
      if (!node || !joints.has(node.getName()) || channel.getTargetPath() === "scale") {
        const sampler = channel.getSampler();
        channel.dispose();
        if (sampler && !sampler.listParents().some((parent) => parent.propertyType === "AnimationChannel")) sampler.dispose();
      }
    }
  }
  for (const node of rootNode.listNodes()) node.setMesh(null).setSkin(null);
  for (const mesh of rootNode.listMeshes()) mesh.dispose();
  for (const skin of rootNode.listSkins()) skin.dispose();
  const missing = CLIPS.filter((name) => !rootNode.listAnimations().some((a) => a.getName() === name));
  if (missing.length) throw new Error(`нет клипов: ${missing.join(", ")}`);
  await document.transform(resample({ tolerance: 1e-4 }));
  // Канал, который всё время держит кость в позе покоя, ничего не меняет: без него
  // AnimationMixer и так вернёт кость в исходное положение. Таких каналов больше половины.
  let dropped = 0;
  for (const animation of rootNode.listAnimations()) {
    for (const channel of animation.listChannels()) {
      const node = channel.getTargetNode();
      const path = channel.getTargetPath();
      const output = channel.getSampler()?.getOutput();
      if (!node || !output || (path !== "rotation" && path !== "translation")) continue;
      const rest = path === "rotation" ? node.getRotation() : node.getTranslation();
      const value = [];
      let still = true;
      for (let i = 0; i < output.getCount() && still; i += 1) {
        output.getElement(i, value);
        const sign = path === "rotation" && value.reduce((sum, v, k) => sum + v * rest[k], 0) < 0 ? -1 : 1;
        still = value.every((v, k) => Math.abs(sign * v - rest[k]) < 1e-4);
      }
      if (still) {
        const sampler = channel.getSampler();
        channel.dispose();
        sampler.dispose();
        dropped += 1;
      }
    }
  }
  console.log(`каналов в покое убрано: ${dropped}`);
  await finish(document, "kaykit-anims.glb");
}

// Герои: только меши со скином.
for (const [name, file] of Object.entries(HEROES)) {
  const document = await io.read(join(source, file));
  const rootNode = document.getRoot();
  for (const animation of rootNode.listAnimations()) dropAnimation(animation);
  for (const node of rootNode.listNodes()) {
    if (GEAR.test(node.getName())) {
      for (const child of node.listChildren()) child.dispose();
      node.dispose();
    }
  }
  await finish(document, `kaykit-${name}.glb`);
}
