const fs = require('fs');
let code = fs.readFileSync('lib/telegram-trade-controller.ts', 'utf8');

const target = "[{ text: `⚡ Execute Default ($${Number(user.active_stake).toFixed(2)})`, callback_data: `exec_${symbol}_${Number(user.active_stake)}` }],";
const replacement = "[{ text: `🔢 Manual amount set`, callback_data: `manual_stake_${symbol}` }],";

if (code.includes(target)) {
  code = code.replace(target, replacement);
  fs.writeFileSync('lib/telegram-trade-controller.ts', code);
  console.log("Successfully replaced button");
} else {
  console.log("Could not find button code");
}
