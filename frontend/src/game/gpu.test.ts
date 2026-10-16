import assert from "node:assert/strict";
import test from "node:test";
import { classifyGpu, gpuName } from "./gpu";

test("встроенная, дискретная и программная графика по строке ANGLE", () => {
  const cases: [string, string, string][] = [
    ["ANGLE (Intel, Intel(R) UHD Graphics (0x0000A78B) Direct3D11 vs_5_0 ps_5_0, D3D11)", "integrated", "Intel UHD Graphics"],
    ["ANGLE (NVIDIA, NVIDIA GeForce RTX 5060 Laptop GPU (0x00002D59) Direct3D11 vs_5_0 ps_5_0, D3D11)", "discrete", "NVIDIA GeForce RTX 5060 Laptop GPU"],
    ["ANGLE (AMD, AMD Radeon(TM) Graphics (0x00001681) Direct3D11 vs_5_0 ps_5_0, D3D11)", "integrated", "AMD Radeon Graphics"],
    ["ANGLE (AMD, AMD Radeon RX 7600 (0x00007480) Direct3D11 vs_5_0 ps_5_0, D3D11)", "discrete", "AMD Radeon RX 7600"],
    ["ANGLE (Intel, Intel(R) Arc(TM) A770 Graphics (0x000056A0) Direct3D11 vs_5_0 ps_5_0, D3D11)", "discrete", "Intel Arc A770 Graphics"],
    ["ANGLE (Intel, Intel(R) Arc(TM) Graphics (0x00007D55) Direct3D11 vs_5_0 ps_5_0, D3D11)", "integrated", "Intel Arc Graphics"],
    ["ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero) (0x0000C0DE)), SwiftShader driver)", "software", "Vulkan 1.3.0 (SwiftShader Device (Subzero))"],
    ["ANGLE (Apple, ANGLE Metal Renderer: Apple M2, Unspecified Version)", "unknown", "Apple M2"],
    ["", "unknown", ""],
  ];
  for (const [renderer, kind, name] of cases) {
    assert.equal(classifyGpu(renderer), kind, renderer);
    assert.equal(gpuName(renderer), name, renderer);
  }
});
