const fs = require('fs');
let code = fs.readFileSync('lib/telegram-trade-controller.ts', 'utf8');

const target = `    await this.safeSendApi('editMessageText', {
      chat_id: chatId,
      message_id: messageId,
      text:
        \`👤 *MY ACCOUNT*\\n\\n\` +
        \`🎮 *Trading Mode:* \\\`\${user.account_type.toUpperCase()}\\\`\\n\` +
        \`📧 *Login ID:* \\\`\${user.account_id}\\\`\\n\` +
        \`📬 *Email:* \\\`\${emailStr}\\\`\\n\` +
        \`💵 *Active Balance:* *\${balanceStr}*\\n\` +
        \`⚙️ *Risk Scaling:* \\\`\${user.scaling_factor}x (Max \${user.max_steps} Steps)\\\`\`,
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [
          [{ text: '💰 Deposit', callback_data: 'menu_deposit' }],
          [
            { text: '💵 Withdraw', callback_data: 'menu_withdrawal' },
            { text: '⚙️ Settings', callback_data: 'menu_settings' },
          ],
          [
            { text: '↪️ Logout', callback_data: 'action_logout' },
            { text: '📘 F.A.Q.', callback_data: 'nav_faq' },
          ],
          [{ text: '⬅️ Main menu', callback_data: 'nav_main_menu' }],
        ],
      },
    });`;

const replacement = `    const text = 
        \`👤 *MY ACCOUNT*\\n\\n\` +
        \`🎮 *Trading Mode:* \\\`\${user.account_type.toUpperCase()}\\\`\\n\` +
        \`📧 *Login ID:* \\\`\${user.account_id}\\\`\\n\` +
        \`📬 *Email:* \\\`\${emailStr}\\\`\\n\` +
        \`💵 *Active Balance:* *\${balanceStr}*\\n\` +
        \`⚙️ *Risk Scaling:* \\\`\${user.scaling_factor}x (Max \${user.max_steps} Steps)\\\`\`;
    const keyboard = {
        inline_keyboard: [
          [{ text: '💰 Deposit', callback_data: 'menu_deposit' }],
          [
            { text: '💵 Withdraw', callback_data: 'menu_withdrawal' },
            { text: '⚙️ Settings', callback_data: 'menu_settings' },
          ],
          [
            { text: '↪️ Logout', callback_data: 'action_logout' },
            { text: '📘 F.A.Q.', callback_data: 'nav_faq' },
          ],
          [{ text: '⬅️ Main menu', callback_data: 'nav_main_menu' }],
        ],
      };
    await this.sendRichMessage(chatId, messageId, TelegramAssets.myAccount, text, keyboard);`;

if (code.includes('`👤 *MY ACCOUNT*\\n\\n`')) {
  code = code.replace(target, replacement);
  fs.writeFileSync('lib/telegram-trade-controller.ts', code);
  console.log("Patched account screen.");
} else {
  console.log("Not found.");
}
