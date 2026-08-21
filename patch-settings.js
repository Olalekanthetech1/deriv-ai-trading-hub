const fs = require('fs');
let code = fs.readFileSync('lib/telegram-trade-controller.ts', 'utf8');

const target = `    await this.safeSendApi('editMessageText', {
      chat_id: chatId,
      message_id: messageId,
      text:
        \`⚙️ *SETTINGS*\\n\` +
        \`_Configure your preferences and options_\\n\\n\` +
        \`⚙️ *Trading Options*\\n\\n\` +
        \`🎯 *Autotrade Settings*\\n\` +
        \`Fine-tune the bot to match your style — full control at your fingertips.\\n\\n\` +
        \`⏳ *Expiration Time*\\n\` +
        \`Decide when your trades close (Current: \\\`\${durationLabel}\\\`).\\n\\n\` +
        \`🛠️ *Mode Selection*\\n\` +
        \`Switch between Manual and Autotrade anytime (Current: \\\`\${modeText}\\\`).\\n\\n\` +
        \`🌐 *Language*\\n\` +
        \`Select your preferred interface language (Current: \\\`\${langLabel}\\\`).\`,
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [
          [{ text: '🎯 Autotrade Settings', callback_data: 'set_autotrade_settings_menu' }],
          [{ text: '⏳ Expiration Time', callback_data: 'set_duration_menu' }],
          [{ text: \`🛠️ Mode: \${user.is_autotrading ? 'Autotrade 🟢' : 'Manual 🔴'}\`, callback_data: 'toggle_autotrade' }],
          [{ text: '🌐 Language', callback_data: 'set_language_menu' }],
          [{ text: '🔙 Back', callback_data: 'nav_main_menu' }],
        ],
      },
    });`;

const replacement = `    const text = 
        \`⚙️ *SETTINGS*\\n\` +
        \`_Configure your preferences and options_\\n\\n\` +
        \`⚙️ *Trading Options*\\n\\n\` +
        \`🎯 *Autotrade Settings*\\n\` +
        \`Fine-tune the bot to match your style — full control at your fingertips.\\n\\n\` +
        \`⏳ *Expiration Time*\\n\` +
        \`Decide when your trades close (Current: \\\`\${durationLabel}\\\`).\\n\\n\` +
        \`🛠️ *Mode Selection*\\n\` +
        \`Switch between Manual and Autotrade anytime (Current: \\\`\${modeText}\\\`).\\n\\n\` +
        \`🌐 *Language*\\n\` +
        \`Select your preferred interface language (Current: \\\`\${langLabel}\\\`).\`;
    const keyboard = {
        inline_keyboard: [
          [{ text: '🎯 Autotrade Settings', callback_data: 'set_autotrade_settings_menu' }],
          [{ text: '⏳ Expiration Time', callback_data: 'set_duration_menu' }],
          [{ text: \`🛠️ Mode: \${user.is_autotrading ? 'Autotrade 🟢' : 'Manual 🔴'}\`, callback_data: 'toggle_autotrade' }],
          [{ text: '🌐 Language', callback_data: 'set_language_menu' }],
          [{ text: '🔙 Back', callback_data: 'nav_main_menu' }],
        ],
      };
    await this.sendRichMessage(chatId, messageId, TelegramAssets.settings, text, keyboard);`;

if (code.includes('`⚙️ *SETTINGS*\\n` +')) {
  code = code.replace(target, replacement);
  fs.writeFileSync('lib/telegram-trade-controller.ts', code);
  console.log("Patched settings screen.");
} else {
  console.log("Not found.");
}
