import sharp from 'sharp';
import fs from 'fs';
import path from 'path';

// Modern SVG Logo for Deriv Rise/Fall Trading Platform
const svgLogo = `
<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 512 512" fill="none">
  <defs>
    <linearGradient id="bgGrad" x1="0" y1="0" x2="512" y2="512" gradientUnits="userSpaceOnUse">
      <stop offset="0%" stop-color="#0F172A"/>
      <stop offset="100%" stop-color="#020617"/>
    </linearGradient>
    <linearGradient id="redGrad" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="#FF525D"/>
      <stop offset="100%" stop-color="#E02B36"/>
    </linearGradient>
    <linearGradient id="cyanGrad" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="#38BDF8"/>
      <stop offset="100%" stop-color="#06B6D4"/>
    </linearGradient>
    <filter id="glow" x="-20%" y="-20%" width="140%" height="140%">
      <feGaussianBlur stdDeviation="12" result="blur" />
      <feComposite in="SourceGraphic" in2="blur" operator="over"/>
    </filter>
  </defs>

  <!-- Background Card with rounded corners -->
  <rect width="512" height="512" rx="112" fill="url(#bgGrad)"/>
  <rect x="4" y="4" width="504" height="504" rx="108" fill="none" stroke="#FF444F" stroke-width="6" stroke-opacity="0.25"/>

  <!-- Outer Stylized 'D' Shape -->
  <path d="M 128 112 H 240 C 330 112 392 176 392 256 C 392 336 330 400 240 400 H 128 V 112 Z" 
        fill="none" stroke="url(#redGrad)" stroke-width="40" stroke-linecap="round" stroke-linejoin="round"/>

  <!-- Dynamic Upward Rise Arrow & Algorithmic Pulse inside D -->
  <path d="M 160 330 L 220 260 L 270 300 L 350 180" 
        fill="none" stroke="url(#cyanGrad)" stroke-width="28" stroke-linecap="round" stroke-linejoin="round" filter="url(#glow)"/>

  <!-- Arrowhead pointing top right (Rise Signal) -->
  <path d="M 310 180 H 350 V 220" 
        fill="none" stroke="url(#cyanGrad)" stroke-width="28" stroke-linecap="round" stroke-linejoin="round"/>

  <!-- AI Signal Pulse Dot -->
  <circle cx="350" cy="180" r="16" fill="#38BDF8"/>
</svg>
`;

const svgIconHeader = `
<svg xmlns="http://www.w3.org/2000/svg" width="128" height="128" viewBox="0 0 512 512" fill="none">
  <defs>
    <linearGradient id="bgGrad" x1="0" y1="0" x2="512" y2="512" gradientUnits="userSpaceOnUse">
      <stop offset="0%" stop-color="#0F172A"/>
      <stop offset="100%" stop-color="#020617"/>
    </linearGradient>
    <linearGradient id="redGrad" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="#FF525D"/>
      <stop offset="100%" stop-color="#E02B36"/>
    </linearGradient>
    <linearGradient id="cyanGrad" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="#38BDF8"/>
      <stop offset="100%" stop-color="#06B6D4"/>
    </linearGradient>
  </defs>
  <rect width="512" height="512" rx="112" fill="url(#bgGrad)"/>
  <rect x="4" y="4" width="504" height="504" rx="108" fill="none" stroke="#FF444F" stroke-width="12" stroke-opacity="0.3"/>
  <path d="M 128 112 H 240 C 330 112 392 176 392 256 C 392 336 330 400 240 400 H 128 V 112 Z" fill="none" stroke="url(#redGrad)" stroke-width="44" stroke-linecap="round" stroke-linejoin="round"/>
  <path d="M 160 330 L 220 260 L 270 300 L 350 180" fill="none" stroke="url(#cyanGrad)" stroke-width="32" stroke-linecap="round" stroke-linejoin="round"/>
  <path d="M 310 180 H 350 V 220" fill="none" stroke="url(#cyanGrad)" stroke-width="32" stroke-linecap="round" stroke-linejoin="round"/>
  <circle cx="350" cy="180" r="18" fill="#38BDF8"/>
</svg>
`;

async function main() {
  const publicDir = path.resolve(process.cwd(), 'public');
  const iconsDir = path.resolve(publicDir, 'icons');

  if (!fs.existsSync(iconsDir)) {
    fs.mkdirSync(iconsDir, { recursive: true });
  }

  // Save SVG
  fs.writeFileSync(path.join(publicDir, 'icon.svg'), svgLogo.trim());

  const svgBuffer = Buffer.from(svgLogo);

  // Generate 512x512 PNG
  await sharp(svgBuffer)
    .resize(512, 512)
    .png()
    .toFile(path.join(iconsDir, 'icon-512x512.png'));

  // Generate 192x192 PNG
  await sharp(svgBuffer)
    .resize(192, 192)
    .png()
    .toFile(path.join(iconsDir, 'icon-192x192.png'));

  // Generate 180x180 Apple Touch Icon
  await sharp(svgBuffer)
    .resize(180, 180)
    .png()
    .toFile(path.join(iconsDir, 'apple-touch-icon.png'));

  // Generate Header logo.png (128x128 high DPI)
  await sharp(svgBuffer)
    .resize(128, 128)
    .png()
    .toFile(path.join(publicDir, 'logo.png'));

  // Also copy to icon.png in public root for fallback
  await sharp(svgBuffer)
    .resize(192, 192)
    .png()
    .toFile(path.join(publicDir, 'icon.png'));

  console.log('Successfully generated all clean PWA icons and logo.png!');
}

main().catch((err) => {
  console.error('Failed to generate PWA assets:', err);
  process.exit(1);
});
