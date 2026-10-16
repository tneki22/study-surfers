import { CanvasTexture, SRGBColorSpace } from "three";

/*
 * Атласы ночного мира рисуются на canvas при входе в мир: неоновые трубки
 * на чёрном (материал складывает их со сценой, чёрное исчезает) и экраны —
 * непрозрачные панели. Части атласа раздаются деталям через uvRect.
 */

type Rect = [number, number, number, number];
const HEAD = '800 {size}px "Unbounded Variable", "Onest Variable", system-ui, sans-serif';
const BODY = '600 {size}px "Onest Variable", system-ui, sans-serif';
const font = (template: string, size: number) => template.replace("{size}", String(Math.round(size)));

function rect(x: number, y: number, w: number, h: number, W: number, H: number): Rect {
  return [x / W, 1 - (y + h) / H, (x + w) / W, 1 - y / H];
}

function canvas(width: number, height: number) {
  const element = document.createElement("canvas");
  element.width = width;
  element.height = height;
  return { element, ctx: element.getContext("2d")! };
}

function finish(element: HTMLCanvasElement) {
  const texture = new CanvasTexture(element);
  texture.colorSpace = SRGBColorSpace;
  texture.anisotropy = 8;
  return texture;
}

/** Неоновая трубка: широкое свечение, цветная трубка и почти белая сердцевина. */
function tube(ctx: CanvasRenderingContext2D, color: string, draw: (mode: "stroke" | "fill") => void, width: number) {
  ctx.save();
  ctx.lineJoin = "round";
  ctx.lineCap = "round";
  ctx.shadowColor = color;
  ctx.strokeStyle = color;
  ctx.globalAlpha = 0.55;
  ctx.shadowBlur = width * 5;
  ctx.lineWidth = width * 1.8;
  draw("stroke");
  ctx.globalAlpha = 1;
  ctx.shadowBlur = width * 2;
  ctx.lineWidth = width;
  draw("stroke");
  ctx.shadowBlur = 0;
  ctx.strokeStyle = "rgba(255,255,255,0.85)";
  ctx.lineWidth = Math.max(1, width * 0.35);
  draw("stroke");
  ctx.restore();
}

function neonText(ctx: CanvasRenderingContext2D, text: string, x: number, y: number, size: number, color: string, maxWidth: number) {
  ctx.font = font(HEAD, size);
  let scale = 1;
  const measured = ctx.measureText(text).width;
  if (measured > maxWidth) scale = maxWidth / measured;
  ctx.save();
  ctx.translate(x, y);
  ctx.scale(scale, 1);
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  tube(ctx, color, () => ctx.strokeText(text, 0, 0), size * 0.07);
  ctx.restore();
}

function neonFrame(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, color: string, radius: number) {
  tube(ctx, color, () => { ctx.beginPath(); ctx.roundRect(x, y, w, h, radius); ctx.stroke(); }, 5);
}

const NEON_W = 1024;
const NEON_H = 1024;
const VERTICAL = [
  { text: "КОФЕ", color: "#ffb35c" },
  { text: "НОЧЬ", color: "#ff4fb4" },
  { text: "ЗАЧЁТ", color: "#55d6cc" },
  { text: "ОТЕЛЬ", color: "#8f6bff" },
  { text: "РАМЕН", color: "#ff5a5a" },
  { text: "ЛЕКЦИИ", color: "#5ab8ff" },
  { text: "СЕССИЯ", color: "#ff4fb4" },
  { text: "24/7", color: "#ffd35c" },
];
const HORIZONTAL = [
  { text: "СЕССИЯ 24/7", color: "#ff4fb4" },
  { text: "∫ f(x) dx", color: "#55d6cc" },
  { text: "НЕ СПИ", color: "#ff5a6e" },
  { text: "ДЕДЛАЙН", color: "#ffb35c" },
  { text: "БИБЛИОТЕКА", color: "#7fd0ff" },
  { text: "e^iπ + 1 = 0", color: "#b18cff" },
  { text: "СЕКТОР 07 →", color: "#ffd35c" },
  { text: "ПОВТОРИ", color: "#55d6cc" },
];

/** Куски неонового атласа: 8 вертикальных вывесок и 8 горизонтальных. */
export const NEON = {
  vertical: VERTICAL.map((_, i) => rect(i * 128, 0, 128, 512, NEON_W, NEON_H)),
  horizontal: HORIZONTAL.map((_, i) => rect((i % 2) * 512, 512 + Math.floor(i / 2) * 128, 512, 128, NEON_W, NEON_H)),
};

export function neonAtlas() {
  const { element, ctx } = canvas(NEON_W, NEON_H);
  ctx.fillStyle = "#000";
  ctx.fillRect(0, 0, NEON_W, NEON_H);
  VERTICAL.forEach(({ text, color }, i) => {
    const x = i * 128;
    neonFrame(ctx, x + 14, 14, 100, 484, color, 22);
    const letters = [...text];
    const step = Math.min(96, 440 / letters.length);
    letters.forEach((letter, j) => neonText(ctx, letter, x + 64, 256 + (j - (letters.length - 1) / 2) * step, step * 0.78, color, 80));
  });
  HORIZONTAL.forEach(({ text, color }, i) => {
    const x = (i % 2) * 512;
    const y = 512 + Math.floor(i / 2) * 128;
    neonText(ctx, text, x + 256, y + 66, 70, color, 460);
    if (i % 3 === 0) tube(ctx, color, () => { ctx.beginPath(); ctx.moveTo(x + 40, y + 114); ctx.lineTo(x + 472, y + 114); ctx.stroke(); }, 4);
  });
  return finish(element);
}

const SCREEN_W = 1024;
const SCREEN_H = 2048;
const wide = (i: number) => rect((i % 2) * 512, Math.floor(i / 2) * 256, 512, 256, SCREEN_W, SCREEN_H);
const square = (i: number) => rect((i % 4) * 256, 1536 + Math.floor(i / 4) * 256, 256, 256, SCREEN_W, SCREEN_H);

/** Куски атласа экранов. */
export const SCREENS = {
  station: wide(0), timetable: wide(1), surfers: wide(2), graph: wide(3), coffee: wide(4), canyon: wide(5),
  tunnel: wide(6), viaduct: wide(7), line: wide(8), exam: wide(9), formula: wide(10), arrows: wide(11),
  squares: Array.from({ length: 8 }, (_, i) => square(i)),
};

function panel(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, top: string, bottom: string) {
  const gradient = ctx.createLinearGradient(x, y, x, y + h);
  gradient.addColorStop(0, top);
  gradient.addColorStop(1, bottom);
  ctx.fillStyle = gradient;
  ctx.fillRect(x, y, w, h);
}

function label(ctx: CanvasRenderingContext2D, text: string, x: number, y: number, size: number, color: string, template = HEAD, align: CanvasTextAlign = "left", maxWidth = 460) {
  ctx.font = font(template, size);
  ctx.fillStyle = color;
  ctx.textAlign = align;
  ctx.textBaseline = "middle";
  ctx.fillText(text, x, y, maxWidth);
}

export function screenAtlas() {
  const { element, ctx } = canvas(SCREEN_W, SCREEN_H);
  ctx.fillStyle = "#05070c";
  ctx.fillRect(0, 0, SCREEN_W, SCREEN_H);
  const at = (i: number) => ({ x: (i % 2) * 512, y: Math.floor(i / 2) * 256 });

  // 0. Название станции.
  { const { x, y } = at(0); panel(ctx, x, y, 512, 256, "#0d2a4a", "#071526");
    ctx.fillStyle = "#55d6cc"; ctx.fillRect(x, y + 214, 512, 14);
    ctx.fillStyle = "#ff4fb4"; ctx.fillRect(x + 28, y + 40, 14, 120);
    label(ctx, "СТАНЦИЯ", x + 62, y + 66, 30, "#9fc6e6", BODY);
    label(ctx, "УНИВЕРСИТЕТ", x + 60, y + 126, 50, "#ffffff", HEAD, "left", 430);
    label(ctx, "Линия М7 · переход на кольцо", x + 62, y + 182, 22, "#78a6c8", BODY); }
  // 1. Табло отправлений.
  { const { x, y } = at(1); panel(ctx, x, y, 512, 256, "#0b0f16", "#06080c");
    label(ctx, "ОТПРАВЛЕНИЕ", x + 24, y + 34, 24, "#ffb35c");
    const rows = [["23:47", "СЕКТОР 07", "#55d6cc"], ["23:52", "БИБЛИОТЕКА", "#ffffff"], ["00:05", "ОБЩЕЖИТИЕ", "#ffffff"], ["00:18", "КАФЕДРА", "#ff4fb4"]] as const;
    rows.forEach(([time, name, color], j) => {
      const ry = y + 84 + j * 44;
      ctx.fillStyle = j % 2 ? "#0e141d" : "#111a26"; ctx.fillRect(x + 16, ry - 20, 480, 40);
      label(ctx, time, x + 30, ry, 26, "#ffd35c", '700 {size}px ui-monospace, Consolas, monospace');
      label(ctx, name, x + 140, ry, 26, color, BODY);
    }); }
  // 2. Реклама игры.
  { const { x, y } = at(2); const g = ctx.createLinearGradient(x, y, x + 512, y + 256);
    g.addColorStop(0, "#3a0d5e"); g.addColorStop(0.55, "#a3165f"); g.addColorStop(1, "#ff7a3d"); ctx.fillStyle = g; ctx.fillRect(x, y, 512, 256);
    ctx.globalAlpha = 0.25; for (let k = 0; k < 9; k++) { ctx.fillStyle = "#fff"; ctx.fillRect(x + 300 + k * 26, y + 30 + k * 18, 140, 3); } ctx.globalAlpha = 1;
    label(ctx, "STUDY", x + 28, y + 82, 58, "#ffffff");
    label(ctx, "SURFERS", x + 28, y + 146, 58, "#ffe2f2");
    label(ctx, "Повтори всё до рассвета", x + 30, y + 208, 24, "#ffd9ec", BODY); }
  // 3. График на сетке.
  { const { x, y } = at(3); panel(ctx, x, y, 512, 256, "#041a1c", "#020a0c");
    ctx.strokeStyle = "rgba(85,214,204,0.18)"; ctx.lineWidth = 1;
    for (let gx = 0; gx <= 512; gx += 32) { ctx.beginPath(); ctx.moveTo(x + gx, y); ctx.lineTo(x + gx, y + 256); ctx.stroke(); }
    for (let gy = 0; gy <= 256; gy += 32) { ctx.beginPath(); ctx.moveTo(x, y + gy); ctx.lineTo(x + 512, y + gy); ctx.stroke(); }
    tube(ctx, "#55d6cc", () => { ctx.beginPath(); for (let k = 0; k <= 480; k += 4) { const px = x + 16 + k; const py = y + 140 - Math.sin(k / 42) * 70 * Math.exp(-k / 600); if (k) ctx.lineTo(px, py); else ctx.moveTo(px, py); } ctx.stroke(); }, 4);
    tube(ctx, "#ff4fb4", () => { ctx.beginPath(); for (let k = 0; k <= 480; k += 4) { const px = x + 16 + k; const py = y + 140 - Math.cos(k / 42) * 46; if (k) ctx.lineTo(px, py); else ctx.moveTo(px, py); } ctx.stroke(); }, 3);
    label(ctx, "f(x) = sin x · e^(−x)", x + 24, y + 30, 24, "#c8fff6", BODY); }
  // 4. Кофе.
  { const { x, y } = at(4); panel(ctx, x, y, 512, 256, "#3b1a06", "#140802");
    tube(ctx, "#ffb35c", () => { ctx.beginPath(); ctx.roundRect(x + 40, y + 80, 100, 110, 18); ctx.moveTo(x + 140, y + 105); ctx.arc(x + 150, y + 135, 28, -Math.PI / 2, Math.PI / 2); ctx.stroke();
      for (let k = 0; k < 3; k++) { ctx.beginPath(); ctx.moveTo(x + 62 + k * 28, y + 64); ctx.bezierCurveTo(x + 50 + k * 28, y + 48, x + 76 + k * 28, y + 38, x + 64 + k * 28, y + 20); ctx.stroke(); } }, 5);
    label(ctx, "КОФЕ", x + 210, y + 100, 64, "#ffd59a");
    label(ctx, "до утра · 24/7", x + 212, y + 170, 30, "#ffb35c", BODY); }
  // 5–8. Таблички районов и линии.
  const district = (i: number, title: string, sub: string, color: string, top: string) => {
    const { x, y } = at(i); panel(ctx, x, y, 512, 256, top, "#05070c");
    ctx.fillStyle = color; ctx.fillRect(x, y, 512, 10); ctx.fillRect(x, y + 246, 512, 10);
    label(ctx, title, x + 256, y + 112, 46, "#ffffff", HEAD, "center", 470);
    label(ctx, sub, x + 256, y + 178, 26, color, BODY, "center", 470);
  };
  district(5, "НЕОНОВЫЙ КВАРТАЛ", "Сектор 07 · не сбавляйте скорость", "#ff4fb4", "#2a0a2a");
  district(6, "ТОННЕЛЬ 7", "Техзона · магнитный разгон", "#55d6cc", "#062126");
  district(7, "ВИАДУК", "Над рекой огней", "#ffb35c", "#24170a");
  district(8, "МАГНИТНАЯ ЛИНИЯ", "Ночной город", "#8f6bff", "#140f33");
  // 9. Экзамен.
  { const { x, y } = at(9); panel(ctx, x, y, 512, 256, "#300814", "#10030a");
    label(ctx, "ЭКЗАМЕН", x + 30, y + 70, 54, "#ff5a6e");
    label(ctx, "через 3 дня", x + 32, y + 132, 34, "#ffd0d6", BODY);
    ctx.fillStyle = "#ff5a6e"; for (let k = 0; k < 3; k++) ctx.fillRect(x + 32 + k * 60, y + 178, 44, 44);
    label(ctx, "03", x + 360, y + 160, 96, "#ffffff"); }
  // 10. Формулы.
  { const { x, y } = at(10); panel(ctx, x, y, 512, 256, "#10123a", "#05061a");
    label(ctx, "d/dx eˣ = eˣ", x + 30, y + 64, 40, "#b18cff", BODY);
    label(ctx, "lim (1 + 1/n)ⁿ = e", x + 30, y + 128, 36, "#ffffff", BODY);
    label(ctx, "det(AB) = det A · det B", x + 30, y + 190, 32, "#7fd0ff", BODY); }
  // 11. Стрелки «вперёд».
  { const { x, y } = at(11); panel(ctx, x, y, 512, 256, "#0a0f14", "#05070a");
    for (let k = 0; k < 4; k++) tube(ctx, "#ffd35c", () => { ctx.beginPath(); ctx.moveTo(x + 70 + k * 100, y + 70); ctx.lineTo(x + 130 + k * 100, y + 128); ctx.lineTo(x + 70 + k * 100, y + 186); ctx.stroke(); }, 9); }
  // Квадратные экраны: символы и значки.
  const glyphs = [["π", "#55d6cc"], ["∑", "#ff4fb4"], ["λ", "#ffb35c"], ["∞", "#8f6bff"], ["Δ", "#7fd0ff"], ["√", "#ff5a6e"], ["∂", "#c9ff7a"], ["Ω", "#ffd35c"]] as const;
  glyphs.forEach(([glyph, color], i) => {
    const x = (i % 4) * 256; const y = 1536 + Math.floor(i / 4) * 256;
    panel(ctx, x, y, 256, 256, "#0b0e18", "#04050a");
    neonFrame(ctx, x + 18, y + 18, 220, 220, color, 26);
    neonText(ctx, glyph, x + 128, y + 132, 150, color, 200);
  });
  return finish(element);
}
