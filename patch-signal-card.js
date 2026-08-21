const fs = require('fs');
let code = fs.readFileSync('lib/telegram-trade-controller.ts', 'utf8');

const target = `      await this.safeSendApi('editMessageText', {
        chat_id: chatId,
        message_id: messageId,
        text,
        parse_mode: 'Markdown',
        reply_markup: keyboard,
      });`;

const replacement = `      const photoUrl = signal.prediction.signal === 'CALL' ? TelegramAssets.bullish : TelegramAssets.bearish;
      let success = false;
      if (photoUrl) {
        if (messageId) {
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
  console.log("Patched renderSignalCard successfully.");
} else {
  console.log("Could not find the target block for renderSignalCard.");
}
