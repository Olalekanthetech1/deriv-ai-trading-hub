const fs = require('fs');
let code = fs.readFileSync('lib/telegram-trade-controller.ts', 'utf8');

const target = `    const appUrl = process.env.APP_URL ? (process.env.APP_URL.endsWith('/') ? process.env.APP_URL.slice(0, -1) : process.env.APP_URL) : null;
    const photoUrl = 'https://res.cloudinary.com/yuiqsyna/image/upload/v1787275716/1787274491917.png';`;

const replacement = `    const photoUrl = TelegramAssets.mainMenu;`;

if (code.includes(target)) {
  code = code.replace(target, replacement);
  fs.writeFileSync('lib/telegram-trade-controller.ts', code);
  console.log("Patched mainMenu successfully.");
} else {
  console.log("Could not find the target line. Checking what's there...");
  console.log(code.substring(code.indexOf('const appUrl'), code.indexOf('const appUrl') + 200));
}
