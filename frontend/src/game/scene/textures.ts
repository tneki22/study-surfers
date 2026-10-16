import { CanvasTexture, RepeatWrapping, SRGBColorSpace } from "three";
import { createRng } from "../engine/random";

/*
 * Все текстуры рисуются на canvas при запуске: игра работает локально и без
 * скачанных картинок. Надписи — тоже canvas, а не шрифт troika: тот по
 * умолчанию тянет шрифт из CDN.
 */

const cache = new Map<string, CanvasTexture>();

function texture(
  key: string,
  width: number,
  height: number,
  draw: (ctx: CanvasRenderingContext2D) => void,
  repeat = false,
): CanvasTexture {
  const cached = cache.get(key);
  if (cached) return cached;
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d")!;
  draw(ctx);
  const result = new CanvasTexture(canvas);
  result.colorSpace = SRGBColorSpace;
  result.anisotropy = 8;
  if (repeat) {
    result.wrapS = RepeatWrapping;
    result.wrapT = RepeatWrapping;
  }
  cache.set(key, result);
  return result;
}

const DISPLAY_FONT = '700 {size}px "Unbounded Variable", "Onest Variable", system-ui, sans-serif';
const font = (size: number) => DISPLAY_FONT.replace("{size}", String(size));

export function letterTexture(letter: string, color: string): CanvasTexture {
  return texture(`letter:${letter}:${color}`, 256, 256, (ctx) => {
    const glow = ctx.createRadialGradient(128, 128, 60, 128, 128, 128);
    glow.addColorStop(0, color);
    glow.addColorStop(1, "rgba(255,255,255,0)");
    ctx.fillStyle = glow;
    ctx.fillRect(0, 0, 256, 256);
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.roundRect(28, 28, 200, 200, 50);
    ctx.fill();
    ctx.lineWidth = 10;
    ctx.strokeStyle = "rgba(255,255,255,0.95)";
    ctx.stroke();
    ctx.fillStyle = "#ffffff";
    ctx.font = font(128);
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(letter, 128, 136);
  });
}

export function bannerTexture(text: string, kind: "start" | "finish"): CanvasTexture {
  return texture(`banner:${kind}:${text}`, 1024, 192, (ctx) => {
    if (kind === "finish") {
      const cell = 32;
      for (let y = 0; y < 192; y += cell) {
        for (let x = 0; x < 1024; x += cell) {
          ctx.fillStyle = (x / cell + y / cell) % 2 === 0 ? "#111827" : "#ffffff";
          ctx.fillRect(x, y, cell, cell);
        }
      }
      ctx.fillStyle = "rgba(214,63,34,0.94)";
      ctx.beginPath();
      ctx.roundRect(150, 26, 724, 140, 30);
      ctx.fill();
    } else {
      const gradient = ctx.createLinearGradient(0, 0, 1024, 0);
      gradient.addColorStop(0, "#1f8ff0");
      gradient.addColorStop(0.5, "#6d5cf6");
      gradient.addColorStop(1, "#d946ef");
      ctx.fillStyle = gradient;
      ctx.fillRect(0, 0, 1024, 192);
      ctx.fillStyle = "rgba(255,255,255,0.18)";
      for (let x = -192; x < 1024; x += 64) {
        ctx.beginPath();
        ctx.moveTo(x, 192);
        ctx.lineTo(x + 32, 192);
        ctx.lineTo(x + 224, 0);
        ctx.lineTo(x + 192, 0);
        ctx.fill();
      }
    }
    ctx.fillStyle = "#ffffff";
    ctx.shadowColor = "rgba(0,0,0,0.35)";
    ctx.shadowBlur = 12;
    ctx.font = font(104);
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(text, 512, 102);
  });
}

/** Растяжка «СЕССИЯ» над путями: красное полотнище с белой надписью. */
export function sessionBannerTexture(): CanvasTexture {
  return texture("banner:session", 512, 128, (ctx) => {
    ctx.fillStyle = "#d62f3a";
    ctx.fillRect(0, 0, 512, 128);
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 8, 512, 6);
    ctx.fillRect(0, 114, 512, 6);
    ctx.font = font(72);
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText("СЕССИЯ", 256, 68);
  });
}

/** Трава: пятна оттенков и короткие штрихи травинок. Тайл бесшовный — рисуем с заворотом краёв. */
export function grassTexture(): CanvasTexture {
  return texture("grass", 256, 256, (ctx) => {
    const rng = createRng(11);
    ctx.fillStyle = "#68b04f";
    ctx.fillRect(0, 0, 256, 256);
    const blot = (x: number, y: number, r: number, color: string) => {
      for (const dx of [-256, 0, 256]) {
        for (const dy of [-256, 0, 256]) {
          const g = ctx.createRadialGradient(x + dx, y + dy, 0, x + dx, y + dy, r);
          g.addColorStop(0, color);
          g.addColorStop(1, "rgba(0,0,0,0)");
          ctx.fillStyle = g;
          ctx.fillRect(x + dx - r, y + dy - r, r * 2, r * 2);
        }
      }
    };
    for (let i = 0; i < 26; i += 1) {
      blot(rng() * 256, rng() * 256, 20 + rng() * 50, rng() < 0.5 ? "rgba(88,158,68,0.45)" : "rgba(140,192,96,0.35)");
    }
    for (let i = 0; i < 1400; i += 1) {
      const x = rng() * 256;
      const y = rng() * 256;
      ctx.strokeStyle = rng() < 0.5 ? "rgba(70,140,55,0.55)" : "rgba(170,220,120,0.5)";
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(x, y);
      ctx.lineTo(x + (rng() - 0.5) * 3, y - 2 - rng() * 4);
      ctx.stroke();
    }
  }, true);
}

/** Щебень насыпи: мелкие камешки разных оттенков с бликом сверху. */
export function gravelTexture(): CanvasTexture {
  return texture("gravel", 256, 256, (ctx) => {
    const rng = createRng(23);
    ctx.fillStyle = "#7d776f";
    ctx.fillRect(0, 0, 256, 256);
    const tones = ["#8e877d", "#6e6861", "#a39b8f", "#5e5953", "#958a7a", "#857c70"];
    for (let i = 0; i < 2600; i += 1) {
      const x = rng() * 256;
      const y = rng() * 256;
      const r = 1.2 + rng() * 2.6;
      for (const dx of [-256, 0, 256]) {
        for (const dy of [-256, 0, 256]) {
          if (x + dx < -r || x + dx > 256 + r || y + dy < -r || y + dy > 256 + r) continue;
          ctx.fillStyle = tones[Math.floor(rng() * tones.length)];
          ctx.beginPath();
          ctx.ellipse(x + dx, y + dy, r, r * (0.6 + rng() * 0.4), rng() * Math.PI, 0, Math.PI * 2);
          ctx.fill();
          ctx.fillStyle = "rgba(255,255,255,0.12)";
          ctx.beginPath();
          ctx.ellipse(x + dx - r * 0.25, y + dy - r * 0.3, r * 0.45, r * 0.3, 0, 0, Math.PI * 2);
          ctx.fill();
        }
      }
    }
  }, true);
}

/** Тротуарная плитка 4×4 со швами и разнотоном. */
export function pavingTexture(): CanvasTexture {
  return texture("paving", 256, 256, (ctx) => {
    const rng = createRng(5);
    ctx.fillStyle = "#9c9893";
    ctx.fillRect(0, 0, 256, 256);
    const size = 64;
    for (let y = 0; y < 256; y += size) {
      for (let x = 0; x < 256; x += size) {
        const tone = 196 + Math.floor(rng() * 22);
        ctx.fillStyle = `rgb(${tone},${tone - 4},${tone - 10})`;
        ctx.fillRect(x + 2, y + 2, size - 4, size - 4);
        ctx.fillStyle = "rgba(0,0,0,0.04)";
        for (let i = 0; i < 30; i += 1) ctx.fillRect(x + 2 + rng() * (size - 6), y + 2 + rng() * (size - 6), 2, 2);
      }
    }
  }, true);
}

/** Мягкое пятно: тень под бегуном, пыль, искры. */
export function softDotTexture(): CanvasTexture {
  return texture("dot", 64, 64, (ctx) => {
    const g = ctx.createRadialGradient(32, 32, 0, 32, 32, 32);
    g.addColorStop(0, "rgba(255,255,255,1)");
    g.addColorStop(0.45, "rgba(255,255,255,0.55)");
    g.addColorStop(1, "rgba(255,255,255,0)");
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, 64, 64);
  });
}

/** Пушистое облако из перекрывающихся «шаров» с подсвеченным верхом и тенью снизу. */
export function cloudTexture(variant: number): CanvasTexture {
  return texture(`cloud:${variant}`, 512, 256, (ctx) => {
    const rng = createRng(100 + variant * 31);
    const puffs = Array.from({ length: 11 + variant * 2 }, () => {
      const x = 110 + rng() * 290;
      const y = 150 - Math.sin(((x - 110) / 290) * Math.PI) * (40 + rng() * 40) + rng() * 20;
      return { x, y, r: 38 + rng() * 42 };
    });
    for (const pass of [0, 1]) {
      for (const { x, y, r } of puffs) {
        const g = ctx.createRadialGradient(x - r * 0.2, y - r * 0.35, r * 0.1, x, y, r);
        if (pass === 0) {
          g.addColorStop(0, "rgba(206,214,232,0.9)");
          g.addColorStop(1, "rgba(206,214,232,0)");
          ctx.fillStyle = g;
          ctx.beginPath();
          ctx.arc(x, y + r * 0.18, r, 0, Math.PI * 2);
        } else {
          g.addColorStop(0, "rgba(255,255,255,1)");
          g.addColorStop(0.6, "rgba(255,255,255,0.85)");
          g.addColorStop(1, "rgba(255,255,255,0)");
          ctx.fillStyle = g;
          ctx.beginPath();
          ctx.arc(x, y - r * 0.05, r * 0.92, 0, Math.PI * 2);
        }
        ctx.fill();
      }
    }
  });
}

/** Диагональные полосы для барьеров и балок. */
export function stripeTexture(a: string, b: string): CanvasTexture {
  return texture(`stripes:${a}:${b}`, 256, 64, (ctx) => {
    ctx.fillStyle = a;
    ctx.fillRect(0, 0, 256, 64);
    ctx.fillStyle = b;
    for (let x = -64; x < 256 + 64; x += 64) {
      ctx.beginPath();
      ctx.moveTo(x, 64);
      ctx.lineTo(x + 32, 64);
      ctx.lineTo(x + 64, 0);
      ctx.lineTo(x + 32, 0);
      ctx.fill();
    }
    ctx.fillStyle = "rgba(255,255,255,0.25)";
    ctx.fillRect(0, 0, 256, 6);
    ctx.fillStyle = "rgba(0,0,0,0.18)";
    ctx.fillRect(0, 58, 256, 6);
  });
}

const ADS: { bg: [string, string]; title: string; sub: string; ink: string }[] = [
  { bg: ["#ff6b4a", "#ffb03b"], title: "∫ всё получится", sub: "учи на бегу", ink: "#ffffff" },
  { bg: ["#2b9bf0", "#6d5cf6"], title: "Σ = 5", sub: "сумма усилий", ink: "#ffffff" },
  { bg: ["#16c79a", "#0f8f8f"], title: "lim сессия → 5", sub: "x → подготовка", ink: "#ffffff" },
  { bg: ["#ffe066", "#ffc93c"], title: "E = mc²", sub: "энергия знаний", ink: "#1d2645" },
];

/** Атлас рекламных щитов 2×2: учебные шутки вместо брендов. */
export function adsTexture(): CanvasTexture {
  return texture("ads", 1024, 512, (ctx) => {
    ADS.forEach((ad, index) => {
      const x = (index % 2) * 512;
      const y = Math.floor(index / 2) * 256;
      const g = ctx.createLinearGradient(x, y, x + 512, y + 256);
      g.addColorStop(0, ad.bg[0]);
      g.addColorStop(1, ad.bg[1]);
      ctx.fillStyle = g;
      ctx.fillRect(x, y, 512, 256);
      ctx.fillStyle = "rgba(255,255,255,0.14)";
      ctx.beginPath();
      ctx.arc(x + 430, y + 40, 120, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = ad.ink;
      ctx.textAlign = "left";
      ctx.textBaseline = "alphabetic";
      ctx.font = font(58);
      ctx.fillText(ad.title, x + 36, y + 132, 440);
      ctx.font = '600 30px "Onest Variable", system-ui, sans-serif';
      ctx.globalAlpha = 0.85;
      ctx.fillText(ad.sub, x + 38, y + 190, 440);
      ctx.globalAlpha = 1;
      ctx.strokeStyle = "rgba(255,255,255,0.9)";
      ctx.lineWidth = 10;
      ctx.strokeRect(x + 5, y + 5, 502, 246);
    });
  });
}

/** Прямоугольник атласа рекламы с номером `index` в координатах UV (низ — v=0). */
export function adRect(index: number): [number, number, number, number] {
  const col = index % 2;
  const row = Math.floor(index / 2) % 2;
  return [col * 0.5, 1 - (row + 1) * 0.5, (col + 1) * 0.5, 1 - row * 0.5];
}
