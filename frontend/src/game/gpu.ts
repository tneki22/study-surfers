/**
 * Видеокарта, на которой браузер рисует WebGL. На ноутбуках с двумя GPU
 * Windows по умолчанию отдаёт браузеру встроенную (Intel UHD, Radeon Graphics),
 * даже если рядом стоит RTX: тогда игра упирается в слабую графику.
 */
export type GpuKind = "discrete" | "integrated" | "software" | "unknown";

export interface GpuInfo {
  /** Строка драйвера как есть: «ANGLE (Intel, Intel(R) UHD Graphics …, D3D11)». */
  renderer: string;
  /** Короткое имя для интерфейса: «Intel UHD Graphics». */
  name: string;
  kind: GpuKind;
}

const SOFTWARE = /swiftshader|llvmpipe|softpipe|basic render|software/i;
// Сначала дискретные: у встроенных Arc и Radeon в имени нет номера модели серии A/RX.
const DISCRETE = /nvidia|geforce|quadro|rtx|radeon\s*(rx|pro)\b|arc\(tm\)\s*a\d|arc\s+a\d/i;
const INTEGRATED = /intel|uhd|iris|radeon\(tm\) graphics|radeon\s+graphics|radeon\s+\d{3}m|vega\s*\d*\s*graphics|adreno|mali|powervr/i;

export function classifyGpu(renderer: string): GpuKind {
  if (!renderer) return "unknown";
  if (SOFTWARE.test(renderer)) return "software";
  if (DISCRETE.test(renderer)) return "discrete";
  if (INTEGRATED.test(renderer)) return "integrated";
  return "unknown";
}

/** «ANGLE (NVIDIA, NVIDIA GeForce RTX 5060 Laptop GPU (0x00002D59) Direct3D11 …)» → «NVIDIA GeForce RTX 5060 Laptop GPU». */
export function gpuName(renderer: string): string {
  const angle = /^ANGLE \(([^,]*),\s*(.*?)(?:,\s*[^,]*\))?$/.exec(renderer);
  const raw = angle ? angle[2] : renderer;
  return raw
    .replace(/^ANGLE Metal Renderer:\s*/i, "")
    .replace(/\s*\(0x[0-9a-f]+\)/gi, "")
    .replace(/\s+(Direct3D|OpenGL|Vulkan|Metal).*$/i, "")
    .replace(/\((R|TM)\)/gi, "")
    .replace(/\s{2,}/g, " ")
    .trim() || renderer;
}

let cached: GpuInfo | null = null;

export function gpuInfo(): GpuInfo {
  if (cached) return cached;
  let renderer = "";
  try {
    const canvas = document.createElement("canvas");
    const gl = canvas.getContext("webgl2") ?? canvas.getContext("webgl");
    if (gl) {
      const debug = gl.getExtension("WEBGL_debug_renderer_info");
      renderer = String(gl.getParameter(debug ? debug.UNMASKED_RENDERER_WEBGL : gl.RENDERER) ?? "");
      gl.getExtension("WEBGL_lose_context")?.loseContext();
    }
  } catch {
    renderer = "";
  }
  cached = { renderer, name: gpuName(renderer), kind: classifyGpu(renderer) };
  return cached;
}

/** Встроенная или программная графика: тяжёлые эффекты и полное разрешение ей не по силам. */
export const weakGpu = (gpu: GpuInfo) => gpu.kind === "integrated" || gpu.kind === "software";
