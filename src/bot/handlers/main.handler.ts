import { Injectable } from '@nestjs/common';
import { Context } from 'grammy';
import { BotUi } from '../ui/bot.ui';

@Injectable()
export class MainHandler {
  async showMainMenu(ctx: Context) {
    try {
      await ctx.editMessageText(BotUi.welcomeMessage, {
        reply_markup: BotUi.mainMenuKeyboard(),
        parse_mode: 'Markdown',
      });
    } catch {
      await ctx.reply(BotUi.welcomeMessage, {
        reply_markup: BotUi.mainMenuKeyboard(),
        parse_mode: 'Markdown',
      });
    }
  }
}
