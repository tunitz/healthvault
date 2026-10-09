// Generates the Health Vault logo mark and all icon rasters from one geometry.
// Run: bun scripts/make-icons.ts
// Uses `sharp` (present in node_modules via Next's optional deps; not a declared dependency).
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import sharp from "sharp";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const TEAL = "#007c59"; // oklch(0.52 0.11 165), --primary (light)
const WHITE = "#ffffff";

// Pulse geometry in a 64-unit box; bbox approx x 10..54, y 22..44.
const PULSE = "M10 34h11l5-12 6 22 6-16 3 6h13";
const STROKE = 6;

// Pulse group scaled about the centre (32,32).
function pulse(scale: number): string {
  return `<path transform="translate(32 32) scale(${scale}) translate(-32 -32)" d="${PULSE}" fill="none" stroke="${WHITE}" stroke-width="${STROKE}" stroke-linecap="round" stroke-linejoin="round"/>`;
}

function svg(body: string): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">${body}</svg>\n`;
}

// Rounded tile with pulse: logo, favicon, 'any' icons.
const markSvg = svg(`<rect width="64" height="64" rx="14" fill="${TEAL}"/>${pulse(1)}`);
// Full-bleed square, pulse at 80%: apple-touch and maskable (maskable pulse kept inside safe zone).
const fullBleedSvg = (scale: number) => svg(`<rect width="64" height="64" fill="${TEAL}"/>${pulse(scale)}`);

async function raster(source: string, size: number, out: string) {
  await sharp(Buffer.from(source), { density: 1200 })
    .resize(size, size)
    .png()
    .toFile(join(ROOT, out));
  console.log(`wrote ${out} (${size}x${size})`);
}

async function main() {
  writeFileSync(join(ROOT, "public/logo-mark.svg"), markSvg);
  writeFileSync(join(ROOT, "src/app/icon.svg"), markSvg);
  console.log("wrote public/logo-mark.svg, src/app/icon.svg");

  await raster(markSvg, 192, "public/icon-192.png");
  await raster(markSvg, 512, "public/icon-512.png");
  // Apple: solid, no transparency; flatten onto teal.
  await sharp(Buffer.from(fullBleedSvg(0.8)), { density: 1200 })
    .resize(180, 180)
    .flatten({ background: TEAL })
    .png()
    .toFile(join(ROOT, "src/app/apple-icon.png"));
  console.log("wrote src/app/apple-icon.png (180x180)");
  // Maskable: full-bleed; pulse scaled to 0.6 so it sits well inside the 80% safe circle.
  await raster(fullBleedSvg(0.6), 512, "public/icon-maskable-512.png");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
