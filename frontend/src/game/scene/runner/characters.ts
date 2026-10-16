/**
 * Кем бежать. «Студент» — бегун из примитивов, собранный кодом (ничего не грузит);
 * остальные — CC0-герои KayKit Adventurers с общими клипами (см. docs/ASSETS.md).
 */
export type CharacterId = "student" | "rogue-hooded" | "rogue" | "knight" | "mage" | "barbarian";

export interface CharacterInfo {
  id: CharacterId;
  name: string;
  hint: string;
}

export const CHARACTERS: CharacterInfo[] = [
  { id: "rogue-hooded", name: "Разбойник в капюшоне", hint: "Модель KayKit, по умолчанию" },
  { id: "rogue", name: "Разбойник", hint: "Модель KayKit" },
  { id: "knight", name: "Рыцарь", hint: "Модель KayKit" },
  { id: "mage", name: "Маг", hint: "Модель KayKit" },
  { id: "barbarian", name: "Варвар", hint: "Модель KayKit" },
  { id: "student", name: "Студент", hint: "Собран из примитивов кодом — первая версия бегуна" },
];

export const DEFAULT_CHARACTER: CharacterId = "rogue-hooded";

const base = import.meta.env.BASE_URL;
export const ANIMATIONS_URL = `${base}models/kaykit-anims.glb`;
export const heroUrl = (id: Exclude<CharacterId, "student">) => `${base}models/kaykit-${id}.glb`;
