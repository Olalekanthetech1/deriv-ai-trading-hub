const fs = require('fs');
let code = fs.readFileSync('app/api/telegram/webhook/route.ts', 'utf8');

const anchor = `      if (user && user.support_state === 'awaiting_message') {`;
const newBlock = `      if (user && user.support_state?.startsWith('awaiting_stake_')) {
        const symbol = user.support_state.replace('awaiting_stake_', '');
        const amount = Number(text.replace(/[^0-9.]/g, ''));
        
        if (Number.isFinite(amount) && amount > 0) {
          await bot.updateUser(chatId, { support_state: 'idle', active_stake: amount });
          const response = await bot.sendMessage(chatId, \`⚙️ Initializing trade execution for \${symbol}...\`);
          const botMessageId = response?.result?.message_id;
          if (botMessageId) {
             await bot.executeTrade(chatId, botMessageId, symbol, amount, msg.message_id.toString());
          }
        } else {
          await bot.sendMessage(chatId, \`❌ Invalid amount.\\n\\nPlease enter a valid numerical amount for *\${symbol}* (e.g. \\\`15.50\\\`), or type /start to cancel.\`);
        }
        return NextResponse.json({ ok: true });
      }

`;

if (code.includes(anchor)) {
  code = code.replace(anchor, newBlock + anchor);
  fs.writeFileSync('app/api/telegram/webhook/route.ts', code);
  console.log("Successfully patched webhook text handler");
} else {
  console.log("Could not find anchor");
}
