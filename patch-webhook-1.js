const fs = require('fs');
let code = fs.readFileSync('app/api/telegram/webhook/route.ts', 'utf8');

const anchor = "} else if (data.startsWith('stake_') || data.startsWith('exec_')) {";
const replacement = `} else if (data.startsWith('manual_stake_')) {
        await bot.handleManualStakePrompt(chatId, messageId, data.replace('manual_stake_', ''));
      } else if (data.startsWith('stake_') || data.startsWith('exec_')) {`;

if (code.includes(anchor)) {
  code = code.replace(anchor, replacement);
  fs.writeFileSync('app/api/telegram/webhook/route.ts', code);
  console.log("Successfully patched webhook callbacks");
} else {
  console.log("Could not find anchor");
}
