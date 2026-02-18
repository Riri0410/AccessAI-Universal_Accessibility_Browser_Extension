#!/usr/bin/env node
/**
 * generate-icons.js
 *
 * Generates PNG icon files for the AccessAI browser extension.
 * Uses only built-in Node.js modules (no external dependencies).
 *
 * Produces:
 *   extension/icons/icon16.png   (16x16)
 *   extension/icons/icon48.png   (48x48)
 *   extension/icons/icon128.png  (128x128)
 *
 * Each icon is a blue (#60a5fa) circle with a white "A" in the center.
 */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

// ── Color helpers ──────────────────────────────────────────────────────────

function hexToRgb(hex) {
  const n = parseInt(hex.replace('#', ''), 16);
  return [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];
}

function lerpColor(a, b, t) {
  return [
    Math.round(a[0] + (b[0] - a[0]) * t),
    Math.round(a[1] + (b[1] - a[1]) * t),
    Math.round(a[2] + (b[2] - a[2]) * t),
  ];
}

// ── Pixel drawing ──────────────────────────────────────────────────────────

/**
 * Returns an RGBA pixel buffer (size x size x 4 bytes) representing the icon.
 */
function renderIcon(size) {
  const pixels = Buffer.alloc(size * size * 4, 0);
  const cx = size / 2;
  const cy = size / 2;
  const r = size / 2;

  // Gradient colours
  const colorLight = hexToRgb('#93c5fd');
  const colorDark = hexToRgb('#3b82f6');

  // Pre-render a bitmap "A" glyph. We define it on a 7x9 grid and scale it.
  const glyphRows = [
    '..XXX..',
    '.XX.XX.',
    'XX...XX',
    'XX...XX',
    'XXXXXXX',
    'XX...XX',
    'XX...XX',
    'XX...XX',
    'XX...XX',
  ];
  const glyphW = 7;
  const glyphH = 9;

  // Determine the glyph placement: scale factor and offset
  const glyphScale = Math.max(1, Math.floor(size * 0.065));
  const scaledW = glyphW * glyphScale;
  const scaledH = glyphH * glyphScale;
  const glyphX0 = Math.round(cx - scaledW / 2);
  const glyphY0 = Math.round(cy - scaledH / 2);

  // Build a lookup set of glyph pixels for fast access
  const glyphSet = new Set();
  for (let gy = 0; gy < glyphH; gy++) {
    for (let gx = 0; gx < glyphW; gx++) {
      if (glyphRows[gy][gx] === 'X') {
        // Fill the scaled block
        for (let sy = 0; sy < glyphScale; sy++) {
          for (let sx = 0; sx < glyphScale; sx++) {
            const px = glyphX0 + gx * glyphScale + sx;
            const py = glyphY0 + gy * glyphScale + sy;
            if (px >= 0 && px < size && py >= 0 && py < size) {
              glyphSet.add(py * size + px);
            }
          }
        }
      }
    }
  }

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = x - cx + 0.5;
      const dy = y - cy + 0.5;
      const dist = Math.sqrt(dx * dx + dy * dy);
      const idx = (y * size + x) * 4;

      if (dist <= r) {
        // Anti-aliasing at the edge
        let alpha = 255;
        if (dist > r - 1.0) {
          alpha = Math.round(255 * Math.max(0, r - dist));
        }

        // Radial gradient
        const t = Math.min(1, dist / r);
        const bg = lerpColor(colorLight, colorDark, t);

        // Check if this pixel is part of the "A" glyph
        const key = y * size + x;
        if (glyphSet.has(key)) {
          // White letter with slight blending at circle edge
          pixels[idx] = 255;
          pixels[idx + 1] = 255;
          pixels[idx + 2] = 255;
          pixels[idx + 3] = alpha;
        } else {
          pixels[idx] = bg[0];
          pixels[idx + 1] = bg[1];
          pixels[idx + 2] = bg[2];
          pixels[idx + 3] = alpha;
        }
      }
      // else: transparent (already zeroed)
    }
  }

  return pixels;
}

// ── PNG encoder (minimal, spec-compliant) ──────────────────────────────────

function crc32(buf) {
  // Standard CRC-32 used by PNG
  let table = crc32.table;
  if (!table) {
    table = crc32.table = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) {
        c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      }
      table[n] = c;
    }
  }
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    crc = table[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const typeBytes = Buffer.from(type, 'ascii');
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);

  const crcInput = Buffer.concat([typeBytes, data]);
  const crcVal = Buffer.alloc(4);
  crcVal.writeUInt32BE(crc32(crcInput), 0);

  return Buffer.concat([length, typeBytes, data, crcVal]);
}

function encodePng(width, height, rgbaPixels) {
  // PNG signature
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

  // IHDR
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 6;  // color type: RGBA
  ihdr[10] = 0; // compression
  ihdr[11] = 0; // filter
  ihdr[12] = 0; // interlace

  // IDAT: filter each row with filter type 0 (None), then deflate
  const rawData = Buffer.alloc(height * (1 + width * 4));
  for (let y = 0; y < height; y++) {
    const rowOffset = y * (1 + width * 4);
    rawData[rowOffset] = 0; // filter byte: None
    rgbaPixels.copy(rawData, rowOffset + 1, y * width * 4, (y + 1) * width * 4);
  }
  const compressed = zlib.deflateSync(rawData, { level: 9 });

  // IEND
  const iend = Buffer.alloc(0);

  return Buffer.concat([
    signature,
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', compressed),
    pngChunk('IEND', iend),
  ]);
}

// ── Main ───────────────────────────────────────────────────────────────────

const outDir = path.join(__dirname, 'extension', 'icons');
fs.mkdirSync(outDir, { recursive: true });

const sizes = [16, 48, 128];

for (const size of sizes) {
  const pixels = renderIcon(size);
  const png = encodePng(size, size, pixels);
  const filePath = path.join(outDir, `icon${size}.png`);
  fs.writeFileSync(filePath, png);
  console.log(`Created ${filePath} (${png.length} bytes)`);
}

console.log('\nDone! Icons are ready in extension/icons/');
