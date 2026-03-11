// Run once with: node make-icons.js
// Generates icons/icon-48.png and icons/icon-128.png
// Requires: npm install canvas  (or just use the SVG manually in a browser)

const { createCanvas } = require('canvas');
const fs = require('fs');
const path = require('path');

function drawIcon(size) {
  const canvas = createCanvas(size, size);
  const ctx = canvas.getContext('2d');

  // Background circle
  ctx.fillStyle = '#1a1a2e';
  ctx.beginPath();
  ctx.arc(size / 2, size / 2, size / 2, 0, Math.PI * 2);
  ctx.fill();

  // Speaker icon (▶ play triangle)
  const scale = size / 48;
  ctx.fillStyle = '#ffffff';
  ctx.beginPath();
  ctx.moveTo(17 * scale, 12 * scale);
  ctx.lineTo(17 * scale, 36 * scale);
  ctx.lineTo(36 * scale, 24 * scale);
  ctx.closePath();
  ctx.fill();

  // Small clock lines (reading time indicator)
  ctx.strokeStyle = 'rgba(255,255,255,0.5)';
  ctx.lineWidth = 1.5 * scale;
  ctx.beginPath();
  ctx.moveTo(12 * scale, 38 * scale);
  ctx.lineTo(20 * scale, 38 * scale);
  ctx.moveTo(12 * scale, 41 * scale);
  ctx.lineTo(24 * scale, 41 * scale);
  ctx.moveTo(12 * scale, 44 * scale);
  ctx.lineTo(18 * scale, 44 * scale);
  ctx.stroke();

  return canvas.toBuffer('image/png');
}

const sizes = [48, 128];
for (const size of sizes) {
  const buf = drawIcon(size);
  const outPath = path.join(__dirname, 'icons', `icon-${size}.png`);
  fs.writeFileSync(outPath, buf);
  console.log(`Created: ${outPath}`);
}
