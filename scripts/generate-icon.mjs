#!/usr/bin/env node
/**
 * Renders the Nox mark to a 1024×1024 PNG for `tauri icon` to slice up.
 *
 * Written by hand with zlib rather than pulling in a rasteriser: the mark is
 * two circles and a rounded square, and a build-time image dependency for that
 * would be exactly the kind of bloat the project is trying to avoid.
 *
 *   node scripts/generate-icon.mjs [output.png]
 */

import { deflateSync } from 'node:zlib';
import { writeFileSync } from 'node:fs';

const SIZE = 1024;
const SAMPLES = 4; // Supersampling factor per axis.

const BACKGROUND = [0x0a, 0x0c, 0x11];
const FOREGROUND = [0x7d, 0xd3, 0xe0];

const CORNER_RADIUS = SIZE * 0.22;
const DISC = { x: 0.5, y: 0.5, r: 0.375 };
const BITE = { x: 0.7125, y: 0.375, r: 0.325 };

/** Coverage of the rounded-square canvas at a sample point. */
function inCanvas(x, y) {
  const r = CORNER_RADIUS;
  const cx = Math.min(Math.max(x, r), SIZE - r);
  const cy = Math.min(Math.max(y, r), SIZE - r);
  const dx = x - cx;
  const dy = y - cy;
  return dx * dx + dy * dy <= r * r;
}

function inCircle(x, y, circle) {
  const cx = circle.x * SIZE;
  const cy = circle.y * SIZE;
  const r = circle.r * SIZE;
  const dx = x - cx;
  const dy = y - cy;
  return dx * dx + dy * dy <= r * r;
}

function render() {
  // One filter byte per row, then RGBA per pixel.
  const raw = Buffer.alloc(SIZE * (1 + SIZE * 4));
  const step = 1 / SAMPLES;
  const total = SAMPLES * SAMPLES;

  for (let y = 0; y < SIZE; y++) {
    const rowStart = y * (1 + SIZE * 4);
    raw[rowStart] = 0; // filter: none

    for (let x = 0; x < SIZE; x++) {
      let canvasHits = 0;
      let markHits = 0;

      for (let sy = 0; sy < SAMPLES; sy++) {
        for (let sx = 0; sx < SAMPLES; sx++) {
          const px = x + (sx + 0.5) * step;
          const py = y + (sy + 0.5) * step;
          if (inCanvas(px, py)) canvasHits++;
          if (inCircle(px, py, DISC) && !inCircle(px, py, BITE)) markHits++;
        }
      }

      const canvasAlpha = canvasHits / total;
      const markAlpha = (markHits / total) * canvasAlpha;

      // Composite the crescent over the plate, then the plate over transparency.
      const offset = rowStart + 1 + x * 4;
      for (let channel = 0; channel < 3; channel++) {
        const plate = BACKGROUND[channel] * canvasAlpha;
        const mark = FOREGROUND[channel] * markAlpha;
        raw[offset + channel] = Math.round(mark + plate * (1 - markAlpha));
      }
      raw[offset + 3] = Math.round(canvasAlpha * 255);
    }
  }

  return raw;
}

// --- Minimal PNG writer ----------------------------------------------------

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buffer) {
  let c = -1;
  for (const byte of buffer) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

function png(raw) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(SIZE, 0);
  header.writeUInt32BE(SIZE, 4);
  header[8] = 8; // bit depth
  header[9] = 6; // colour type: RGBA
  header[10] = 0; // deflate
  header[11] = 0; // adaptive filtering
  header[12] = 0; // no interlace

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const output = process.argv[2] ?? 'src-tauri/icons/source.png';
writeFileSync(output, png(render()));
console.log(`Wrote ${output} (${SIZE}×${SIZE})`);
