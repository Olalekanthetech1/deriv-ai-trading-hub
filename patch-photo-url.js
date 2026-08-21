const fs = require('fs');
let code = fs.readFileSync('lib/telegram-trade-controller.ts', 'utf8');

// Replace the photoUrl logic to use the Cloudinary URL directly to bypass the preview proxy
const target = "const photoUrl = appUrl ? `${appUrl}/telegram-assets/main-menu.png` : null;";
const replacement = "const photoUrl = 'https://res.cloudinary.com/yuiqsyna/image/upload/v1787275716/1787274491917.png';";

if (code.includes(target)) {
  code = code.replace(target, replacement);
  fs.writeFileSync('lib/telegram-trade-controller.ts', code);
  console.log("Patched photoUrl successfully.");
} else {
  console.log("Could not find the target line.");
}
