const fs = require('fs');
let code = fs.readFileSync('lib/telegram-trade-controller.ts', 'utf8');

const helper = `
  async sendRichMessage(chatId: number, messageId: number | undefined, photoUrl: string | null, text: string, keyboard: any) {
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
    }
  }
`;

// Insert it right after safeSendApi
if (!code.includes('async sendRichMessage')) {
  code = code.replace(
    /async safeSendApi[^{]*\{[\s\S]*?\}\n\s*}/,
    match => match + '\n' + helper
  );
  fs.writeFileSync('lib/telegram-trade-controller.ts', code);
  console.log("Helper injected.");
} else {
  console.log("Helper already exists.");
}
