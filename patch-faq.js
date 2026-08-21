const fs = require('fs');
let code = fs.readFileSync('lib/telegram-trade-controller.ts', 'utf8');

const target = `  async renderFaqScreen(chatId: number, messageId?: number) {
    const payload = {
      chat_id: chatId,
      text:
        \`📖 *DERIV TRADING TERMINAL — FAQ*\\n\\n\` +
        \`🧠 *1️⃣ How does this bot work?*\\n\` +
        \`The bot obtains live predictions from our production market microstructure pipeline, verifies the authoritative horizon alignment, and executes trade proposals when pre-trade criteria are fully met.\\n\\n\` +
        \`🔒 *2️⃣ How are my credentials stored?*\\n\` +
        \`Your Deriv credentials are encrypted at rest with industry-standard cryptographic protection and are never displayed in plain text in your Telegram interface.\\n\\n\` +
        \`🔄 *3️⃣ Can I switch between Demo and Real accounts?*\\n\` +
        \`Yes. Switch account modes using the \\\`🎮 Demo / Real\\\` toggle. The bot dynamically re-resolves and connects to your respective Demo or Real account with the broker.\\n\\n\` +
        \`🤖 *4️⃣ Auto vs. Manual Expiration: What's the difference?*\\n\` +
        \`• \\\`Auto (AI Optimal)\\\`: The system evaluates the currently eligible, validated trading horizons and selects the horizon that best fits current market conditions and available model evidence.\\n\` +
        \`• \\\`Manual Select\\\`: Overrides the AI selection and strictly locks your trade execution to your chosen duration (e.g., 5 Ticks or 60 Seconds).\\n\\n\` +
        \`💬 *5️⃣ How does the Live Support system work?*\\n\` +
        \`When you click **Live Support** below and type your message, your inquiry is securely routed to our administrator support channel, allowing our team to reply to your ticket directly in this chat.\`,
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [
          [{ text: '💬 Live Support', callback_data: 'nav_support_contact' }],
          [{ text: '🏠 Back to Main Menu', callback_data: 'nav_main_menu' }],
        ],
      },
    };

    if (messageId) {
      await this.safeSendApi('editMessageText', { ...payload, message_id: messageId });
    } else {
      await this.safeSendApi('sendMessage', payload);
    }
  }`;

const replacement = `  async renderFaqScreen(chatId: number, messageId?: number) {
    const text = 
        \`📖 *DERIV TRADING TERMINAL — FAQ*\\n\\n\` +
        \`🧠 *1️⃣ How does this bot work?*\\n\` +
        \`The bot obtains live predictions from our production market microstructure pipeline, verifies the authoritative horizon alignment, and executes trade proposals when pre-trade criteria are fully met.\\n\\n\` +
        \`🔒 *2️⃣ How are my credentials stored?*\\n\` +
        \`Your Deriv credentials are encrypted at rest with industry-standard cryptographic protection and are never displayed in plain text in your Telegram interface.\\n\\n\` +
        \`🔄 *3️⃣ Can I switch between Demo and Real accounts?*\\n\` +
        \`Yes. Switch account modes using the \\\`🎮 Demo / Real\\\` toggle. The bot dynamically re-resolves and connects to your respective Demo or Real account with the broker.\\n\\n\` +
        \`🤖 *4️⃣ Auto vs. Manual Expiration: What's the difference?*\\n\` +
        \`• \\\`Auto (AI Optimal)\\\`: The system evaluates the currently eligible, validated trading horizons and selects the horizon that best fits current market conditions and available model evidence.\\n\` +
        \`• \\\`Manual Select\\\`: Overrides the AI selection and strictly locks your trade execution to your chosen duration (e.g., 5 Ticks or 60 Seconds).\\n\\n\` +
        \`💬 *5️⃣ How does the Live Support system work?*\\n\` +
        \`When you click **Live Support** below and type your message, your inquiry is securely routed to our administrator support channel, allowing our team to reply to your ticket directly in this chat.\`;
    const keyboard = {
        inline_keyboard: [
          [{ text: '💬 Live Support', callback_data: 'nav_support_contact' }],
          [{ text: '🏠 Back to Main Menu', callback_data: 'nav_main_menu' }],
        ],
      };
    
    await this.sendRichMessage(chatId, messageId, TelegramAssets.faq, text, keyboard);
  }`;

if (code.includes('`📖 *DERIV TRADING TERMINAL — FAQ*\\n\\n`')) {
  code = code.replace(target, replacement);
  fs.writeFileSync('lib/telegram-trade-controller.ts', code);
  console.log("Patched FAQ screen.");
} else {
  console.log("Not found.");
}
