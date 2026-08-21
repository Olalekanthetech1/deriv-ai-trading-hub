const fs = require('fs');
let code = fs.readFileSync('lib/telegram-trade-controller.ts', 'utf8');

const newMethod = `  async renderTradeModeSelection(chatId: number, messageId: number) {
    const user = await this.getUser(chatId);
    if (!user) return this.renderUnlinkedScreen(chatId);

    const text = 
      \`⚙️ *SELECT TRADING MODE*\\n\\n\` +
      \`How would you like to execute this trade?\\n\\n\` +
      \`🎯 *Manual Single Trade*\\n\` +
      \`Executes exactly one trade with your selected stake. No recovery steps.\\n\\n\` +
      \`🤖 *Automated Strategy Session*\\n\` +
      \`Uses your preset configuration (Max Steps: \\\`\${user.max_steps || 1}\\\`, Scaling: \\\`\${Number(user.scaling_factor || 1.0).toFixed(2)}x\\\`). Automatically recovers losses via Martingale.\\n\`;

    await this.safeSendApi('editMessageText', {
      chat_id: chatId,
      message_id: messageId,
      text,
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [
          [{ text: '🎯 Manual Single Trade', callback_data: 'mode_single_trade' }],
          [{ text: '🤖 Automated Strategy Session', callback_data: 'mode_auto_strategy' }],
          [{ text: '🔙 Main Menu', callback_data: 'nav_main_menu' }],
        ],
      },
    });
  }

  async renderAssetSelection`;

if (code.includes('  async renderAssetSelection')) {
  code = code.replace('  async renderAssetSelection', newMethod);
  fs.writeFileSync('lib/telegram-trade-controller.ts', code);
  console.log('Successfully inserted renderTradeModeSelection');
} else {
  console.log('Error: Could not find renderAssetSelection');
}
