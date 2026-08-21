const fs = require('fs');
let code = fs.readFileSync('lib/telegram-trade-controller.ts', 'utf8');

const target = `  async sendRichMessage(chatId: number, messageId: number | undefined, photoUrl: string | null, text: string, keyboard: any) {
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
  }`;

const replacement = `  async sendRichMessage(chatId: number, messageId: number | undefined, photoUrl: string | null, text: string, keyboard: any) {
    let success = false;
    
    // We will bypass safeSendApi for the optimistic edits so we don't spam the logs with expected errors
    const silentSend = async (method: string, payload: any) => {
      try { return await this.sendApi(method, payload); } catch { return null; }
    };

    if (photoUrl) {
      if (messageId) {
        // Attempt to edit existing media
        const editRes = await silentSend('editMessageMedia', {
          chat_id: chatId,
          message_id: messageId,
          media: {
            type: 'photo',
            media: photoUrl,
            caption: text,
            parse_mode: 'Markdown'
          },
          reply_markup: keyboard,
        });
        
        if (editRes && editRes.ok) {
          success = true;
        } else {
          // If it was a text message, editing media fails. Delete and send new photo.
          await silentSend('deleteMessage', { chat_id: chatId, message_id: messageId });
          const sendRes = await silentSend('sendPhoto', {
            chat_id: chatId,
            photo: photoUrl,
            caption: text,
            parse_mode: 'Markdown',
            reply_markup: keyboard,
          });
          if (sendRes && sendRes.ok) success = true;
        }
      } else {
        const sendRes = await silentSend('sendPhoto', {
          chat_id: chatId,
          photo: photoUrl,
          caption: text,
          parse_mode: 'Markdown',
          reply_markup: keyboard,
        });
        if (sendRes && sendRes.ok) success = true;
      }
    } else {
      // No photo URL - sending text only
      if (messageId) {
        const editRes = await silentSend('editMessageText', {
          chat_id: chatId,
          message_id: messageId,
          text,
          parse_mode: 'Markdown',
          reply_markup: keyboard,
        });
        if (editRes && editRes.ok) {
          success = true;
        } else {
          // If it was a photo message, editing text fails. Delete and send new text.
          await silentSend('deleteMessage', { chat_id: chatId, message_id: messageId });
          const sendRes = await silentSend('sendMessage', {
            chat_id: chatId,
            text,
            parse_mode: 'Markdown',
            reply_markup: keyboard,
          });
          if (sendRes && sendRes.ok) success = true;
        }
      } else {
        const sendRes = await silentSend('sendMessage', {
          chat_id: chatId,
          text,
          parse_mode: 'Markdown',
          reply_markup: keyboard,
        });
        if (sendRes && sendRes.ok) success = true;
      }
    }
  }`;

if (code.includes('async sendRichMessage')) {
  code = code.replace(target, replacement);
  fs.writeFileSync('lib/telegram-trade-controller.ts', code);
  console.log("Patched sendRichMessage successfully.");
} else {
  console.log("Target not found.");
}
