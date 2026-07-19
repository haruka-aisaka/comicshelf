#!/usr/bin/env -S deno run --allow-read --allow-write --allow-env=NODE_ENV
// SVG から PWA 用 PNG アイコン (192, 512, 512-maskable) を生成する。
// 実行: deno run --allow-read --allow-write scripts/generate_pwa_icons.ts

import { Resvg } from "npm:@resvg/resvg-js@2.6.2";

const SRC = "web/public/icons/icon.svg";
const OUT_DIR = "web/public/icons";

const svg = await Deno.readTextFile(SRC);

async function render(outPath: string, size: number, svgSrc: string) {
  const resvg = new Resvg(svgSrc, {
    fitTo: { mode: "width", value: size },
    background: "rgba(0,0,0,0)",
  });
  const png = resvg.render().asPng();
  await Deno.writeFile(outPath, png);
  console.log(`wrote ${outPath} (${size}x${size}, ${png.byteLength} bytes)`);
}

// any 用: 元 SVG そのまま
await render(`${OUT_DIR}/icon-192.png`, 192, svg);
await render(`${OUT_DIR}/icon-512.png`, 512, svg);

// maskable 用: セーフゾーンを確保するため元 SVG を 80% スケールで中央配置し、
// 背景をアイコンの背景色で全面塗り。 Android のアイコン形状トリミング
// (safe zone: 中央 80%) に耐えるようにする。
const maskable = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">
  <rect width="512" height="512" fill="#0f1115" />
  <g transform="translate(51.2 51.2) scale(0.8)">
    ${svg.replace(/^<\?xml[^>]*\?>\s*/, "").replace(/^<svg[^>]*>/, "").replace(/<\/svg>\s*$/, "")}
  </g>
</svg>`;
await render(`${OUT_DIR}/icon-512-maskable.png`, 512, maskable);
