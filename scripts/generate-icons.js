/**
 * Generate app icons for Career Future.
 * Creates minimal PNG icons without any external dependencies.
 * Run: node scripts/generate-icons.js
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import zlib from 'zlib';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const iconsDir = path.join(__dirname, '..', 'assets', 'icons');

// Ensure directory exists
fs.mkdirSync(iconsDir, { recursive: true });

/**
 * Create a minimal valid PNG file from raw RGBA pixel data
 */
function createPNG(width, height, rgbaPixels) {
  // PNG signature
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

  // IHDR chunk
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 6;  // color type: RGBA
  ihdr[10] = 0; // compression
  ihdr[11] = 0; // filter
  ihdr[12] = 0; // interlace
  const ihdrChunk = makeChunk('IHDR', ihdr);

  // IDAT chunk - raw pixel data with filter bytes
  const rawData = Buffer.alloc(height * (1 + width * 4));
  for (let y = 0; y < height; y++) {
    rawData[y * (1 + width * 4)] = 0; // filter: none
    for (let x = 0; x < width; x++) {
      const srcIdx = (y * width + x) * 4;
      const dstIdx = y * (1 + width * 4) + 1 + x * 4;
      rawData[dstIdx] = rgbaPixels[srcIdx];
      rawData[dstIdx + 1] = rgbaPixels[srcIdx + 1];
      rawData[dstIdx + 2] = rgbaPixels[srcIdx + 2];
      rawData[dstIdx + 3] = rgbaPixels[srcIdx + 3];
    }
  }
  const compressed = zlib.deflateSync(rawData);
  const idatChunk = makeChunk('IDAT', compressed);

  // IEND chunk
  const iendChunk = makeChunk('IEND', Buffer.alloc(0));

  return Buffer.concat([signature, ihdrChunk, idatChunk, iendChunk]);
}

function makeChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeB = Buffer.from(type, 'ascii');
  const crcData = Buffer.concat([typeB, data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(crcData) >>> 0, 0);
  return Buffer.concat([len, typeB, data, crc]);
}

function crc32(buf) {
  let crc = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) {
    crc ^= buf[i];
    for (let j = 0; j < 8; j++) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xEDB88320 : 0);
    }
  }
  return crc ^ 0xFFFFFFFF;
}

/**
 * Draw the "CF" logo icon
 * A rounded blue square with white "CF" text
 */
function drawIcon(size) {
  const pixels = Buffer.alloc(size * size * 4);

  const bgR = 0x43, bgG = 0x61, bgB = 0xEE; // #4361ee (blue)
  const fgR = 0xFF, fgG = 0xFF, fgB = 0xFF; // white

  const radius = Math.floor(size * 0.15);

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const idx = (y * size + x) * 4;

      // Check if inside rounded rect
      if (isInsideRoundedRect(x, y, 0, 0, size, size, radius)) {
        pixels[idx] = bgR;
        pixels[idx + 1] = bgG;
        pixels[idx + 2] = bgB;
        pixels[idx + 3] = 255;
      } else {
        pixels[idx + 3] = 0; // transparent
      }
    }
  }

  // Draw "C" and "F" letters using simple bitmap approach
  drawLetterC(pixels, size, fgR, fgG, fgB);
  drawLetterF(pixels, size, fgR, fgG, fgB);

  return pixels;
}

function isInsideRoundedRect(x, y, rx, ry, rw, rh, radius) {
  if (x < rx || x >= rx + rw || y < ry || y >= ry + rh) return false;

  // Check corners
  const corners = [
    [rx + radius, ry + radius],                 // top-left
    [rx + rw - radius - 1, ry + radius],        // top-right
    [rx + radius, ry + rh - radius - 1],        // bottom-left
    [rx + rw - radius - 1, ry + rh - radius - 1] // bottom-right
  ];

  for (const [cx, cy] of corners) {
    const inCornerX = (x < rx + radius && x < cx) || (x >= rx + rw - radius && x > cx);
    const inCornerY = (y < ry + radius && y < cy) || (y >= ry + rh - radius && y > cy);
    if (inCornerX && inCornerY) {
      const dx = x - cx;
      const dy = y - cy;
      if (dx * dx + dy * dy > radius * radius) return false;
    }
  }
  return true;
}

function setPixel(pixels, size, x, y, r, g, b) {
  if (x < 0 || x >= size || y < 0 || y >= size) return;
  const idx = (y * size + x) * 4;
  if (pixels[idx + 3] > 0) { // only draw on non-transparent
    pixels[idx] = r;
    pixels[idx + 1] = g;
    pixels[idx + 2] = b;
  }
}

function fillRect(pixels, size, x0, y0, w, h, r, g, b) {
  for (let y = y0; y < y0 + h; y++) {
    for (let x = x0; x < x0 + w; x++) {
      setPixel(pixels, size, x, y, r, g, b);
    }
  }
}

function drawLetterC(pixels, size, r, g, b) {
  // "C" positioned on the left side
  const s = Math.floor(size / 16); // scale unit
  const x0 = Math.floor(size * 0.15);
  const y0 = Math.floor(size * 0.25);
  const w = Math.floor(size * 0.30);
  const h = Math.floor(size * 0.50);
  const thick = Math.max(2, Math.floor(size * 0.08));

  // Top bar
  fillRect(pixels, size, x0, y0, w, thick, r, g, b);
  // Bottom bar
  fillRect(pixels, size, x0, y0 + h - thick, w, thick, r, g, b);
  // Left bar
  fillRect(pixels, size, x0, y0, thick, h, r, g, b);
}

function drawLetterF(pixels, size, r, g, b) {
  // "F" positioned on the right side
  const x0 = Math.floor(size * 0.52);
  const y0 = Math.floor(size * 0.25);
  const w = Math.floor(size * 0.30);
  const h = Math.floor(size * 0.50);
  const thick = Math.max(2, Math.floor(size * 0.08));

  // Top bar
  fillRect(pixels, size, x0, y0, w, thick, r, g, b);
  // Middle bar
  fillRect(pixels, size, x0, y0 + Math.floor(h / 2) - Math.floor(thick / 2), Math.floor(w * 0.75), thick, r, g, b);
  // Left bar
  fillRect(pixels, size, x0, y0, thick, h, r, g, b);
}

/**
 * Create ICO file from PNG data
 * Single-image ICO wrapping a PNG
 */
function createICO(pngData) {
  // ICO header: 6 bytes
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);     // reserved
  header.writeUInt16LE(1, 2);     // type: icon
  header.writeUInt16LE(1, 4);     // count: 1 image

  // ICO directory entry: 16 bytes
  const entry = Buffer.alloc(16);
  entry[0] = 0;   // width (0 = 256)
  entry[1] = 0;   // height (0 = 256)
  entry[2] = 0;   // color palette
  entry[3] = 0;   // reserved
  entry.writeUInt16LE(1, 4);   // color planes
  entry.writeUInt16LE(32, 6);  // bits per pixel
  entry.writeUInt32LE(pngData.length, 8);  // size of image data
  entry.writeUInt32LE(22, 12); // offset to image data (6 + 16)

  return Buffer.concat([header, entry, pngData]);
}

// Generate icons at various sizes
console.log('Generating Career Future icons...');

const sizes = [16, 32, 48, 64, 128, 256];

for (const size of sizes) {
  const pixels = drawIcon(size);
  const png = createPNG(size, size, pixels);
  const filename = size === 256 ? 'icon.png' : `icon-${size}.png`;
  fs.writeFileSync(path.join(iconsDir, filename), png);
  console.log(`  Created ${filename} (${size}x${size})`);
}

// Main icon is 256x256
const mainPixels = drawIcon(256);
const mainPng = createPNG(256, 256, mainPixels);

// Tray icons
const tray16 = drawIcon(16);
const tray32 = drawIcon(32);
fs.writeFileSync(path.join(iconsDir, 'tray-icon.png'), createPNG(16, 16, tray16));
console.log('  Created tray-icon.png (16x16)');

// Windows ICO (wraps the 256px PNG)
fs.writeFileSync(path.join(iconsDir, 'tray-icon.ico'), createICO(mainPng));
console.log('  Created tray-icon.ico');

// macOS template (same as tray icon)
fs.writeFileSync(path.join(iconsDir, 'tray-iconTemplate.png'), createPNG(16, 16, tray16));
console.log('  Created tray-iconTemplate.png (16x16)');

// Remove placeholder
const readmePath = path.join(iconsDir, 'README.txt');
if (fs.existsSync(readmePath)) {
  fs.unlinkSync(readmePath);
}

console.log('\nAll icons generated successfully!');
