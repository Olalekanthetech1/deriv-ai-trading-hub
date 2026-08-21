const fs = require('fs');
let code = fs.readFileSync('app/api/telegram/webhook/route.ts', 'utf8');

const oldStartTrade = "} else if (data === 'menu_start_trade') {\n" +
"        await bot.renderAssetSelection(chatId, messageId);\n" +
"      } else if (data.startsWith('asset_')) {";

const newStartTrade = "} else if (data === 'menu_start_trade') {\n" +
"        await bot.renderTradeModeSelection(chatId, messageId);\n" +
"      } else if (data === 'mode_single_trade') {\n" +
"        await bot.updateUser(chatId, { is_autotrading: false });\n" +
"        await bot.renderAssetSelection(chatId, messageId);\n" +
"      } else if (data === 'mode_auto_strategy') {\n" +
"        await bot.updateUser(chatId, { is_autotrading: true });\n" +
"        await bot.renderAssetSelection(chatId, messageId);\n" +
"      } else if (data.startsWith('asset_')) {";

if (code.includes(oldStartTrade)) {
  code = code.replace(oldStartTrade, newStartTrade);
  fs.writeFileSync('app/api/telegram/webhook/route.ts', code);
  console.log('Successfully patched webhook');
} else {
  console.log('Error: Could not find oldStartTrade block');
}
