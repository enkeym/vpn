import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Context } from 'grammy';
import { BotUi } from '../ui/bot.ui';

@Injectable()
export class MainHandler {
  private adminIds: string[] = [];

  constructor(private readonly configService: ConfigService) {
    const whiteList = this.configService.get<string>(
      'TELEGRAM_ALLOWED_IDS',
      '',
    );
    this.adminIds = whiteList
      .split(',')
      .map((id) => id.trim())
      .filter((id) => id.length > 0);
  }

  isAdmin(userId: string): boolean {
    return this.adminIds.includes(userId);
  }

  async showMainMenu(ctx: Context) {
    if (!ctx.from) return;

    const userId = String(ctx.from.id);
    const keyboard = this.isAdmin(userId)
      ? BotUi.adminMenuKeyboard()
      : BotUi.mainMenuKeyboard();

    try {
      await ctx.editMessageText(BotUi.welcomeMessage, {
        reply_markup: keyboard,
        parse_mode: 'Markdown',
      });
    } catch {
      await ctx.reply(BotUi.welcomeMessage, {
        reply_markup: keyboard,
        parse_mode: 'Markdown',
      });
    }
  }
}
