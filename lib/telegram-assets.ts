export const TelegramAssets = {
  get mainMenu() {
    return process.env.TELEGRAM_MAIN_MENU_IMAGE_URL || null;
  },
  get bullish() {
    return process.env.TELEGRAM_BULLISH_IMAGE_URL || null;
  },
  get bearish() {
    return process.env.TELEGRAM_BEARISH_IMAGE_URL || null;
  },
  get profit() {
    return process.env.TELEGRAM_PROFIT_IMAGE_URL || null;
  },
  get lost() {
    return process.env.TELEGRAM_LOST_IMAGE_URL || null;
  },
  get settings() {
    return process.env.TELEGRAM_SETTINGS_IMAGE_URL || null;
  },
  get myAccount() {
    return process.env.TELEGRAM_MY_ACCOUNT_IMAGE_URL || null;
  },
  get balanceExpired() {
    return process.env.TELEGRAM_BALANCE_EXPIRED_IMAGE_URL || null;
  },
  get faq() {
    return process.env.TELEGRAM_FAQ_IMAGE_URL || null;
  }
};
