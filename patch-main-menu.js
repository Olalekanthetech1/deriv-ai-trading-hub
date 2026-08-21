const fs = require('fs');
let code = fs.readFileSync('lib/telegram-trade-controller.ts', 'utf8');

const target = `    await this.safeSendApi(messageId ? 'editMessageText' : 'sendMessage', {
      chat_id: chatId,
      ...(messageId ? { message_id: messageId } : {}),
      text,
      reply_markup: keyboard,
    });`;

const replacement = `    const appUrl = process.env.APP_URL ? (process.env.APP_URL.endsWith('/') ? process.env.APP_URL.slice(0, -1) : process.env.APP_URL) : null;
    const photoUrl = appUrl ? \`\${appUrl}/telegram-assets/main-menu.jpg\` : null;
    let success = false;

    if (photoUrl) {
      if (messageId) {
        // Attempt to edit caption first (assuming it's already a photo)
        const editRes = await this.safeSendApi('editMessageCaption', {
          chat_id: chatId,
          message_id: messageId,
          caption: text,
          parse_mode: 'Markdown',
          reply_markup: keyboard,
        });
        if (editRes && editRes.ok) {
          success = true;
        } else {
          // If editing caption failed (likely because it was a text message originally),
          // delete it and send a fresh photo message.
          await this.safeSendApi('deleteMessage', { chat_id: chatId, message_id: messageId });
          const sendRes = await this.safeSendApi('sendPhoto', {
            chat_id: chatId,
            photo: photoUrl,
            caption: text,
            parse_mode: 'Markdown',
            reply_markup: keyboard,
          });
          if (sendRes && sendRes.ok) success = true;
        }
      } else {
        // No messageId, just send a fresh photo
        const sendRes = await this.safeSendApi('sendPhoto', {
          chat_id: chatId,
          photo: photoUrl,
          caption: text,
          parse_mode: 'Markdown',
          reply_markup: keyboard,
        });
        if (sendRes && sendRes.ok) success = true;
      }
    }

    if (!success) {
      // Fallback: If image sending completely failed (e.g., image not uploaded yet)
      // or no APP_URL configured, we must use standard text messaging.
      // If we already deleted the message in the photo flow attempt, we can't edit it, so we fallback to sendMessage.
      const method = (messageId && !photoUrl) ? 'editMessageText' : 'sendMessage';
      await this.safeSendApi(method, {
        chat_id: chatId,
        ...(method === 'editMessageText' ? { message_id: messageId } : {}),
        text,
        parse_mode: 'Markdown',
        reply_markup: keyboard,
      });
    }`;

if (code.includes(target)) {
  code = code.replace(target, replacement);
  fs.writeFileSync('lib/telegram-trade-controller.ts', code);
  console.log("Patched renderMainTerminal");
} else {
  console.log("Could not find target block");
}
