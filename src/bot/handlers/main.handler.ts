import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Context } from 'grammy';
import { FamilyService } from 'src/family/family.service';
import { BotUi } from '../ui/bot.ui';

export type UserType = 'admin' | 'family' | 'user';

@Injectable()
export class MainHandler {
  private adminIds: string[] = [];

  constructor(
    private readonly configService: ConfigService,
    private readonly familyService: FamilyService,
  ) {
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

  async getUserType(userId: string): Promise<UserType> {
    if (this.isAdmin(userId)) return 'admin';
    const isFamilyMember = await this.familyService.isMember(userId);
    if (isFamilyMember) return 'family';
    return 'user';
  }

  private getWelcomeMessage(userType: UserType): string {
    switch (userType) {
      case 'admin':
        return BotUi.welcomeMessageAdmin;
      case 'family':
        return BotUi.welcomeMessageFamily;
      default:
        return BotUi.welcomeMessageUser;
    }
  }

  private getMenuKeyboard(userType: UserType) {
    switch (userType) {
      case 'admin':
        return BotUi.adminMenuKeyboard();
      case 'family':
        return BotUi.familyMemberMenuKeyboard();
      default:
        return BotUi.mainMenuKeyboard();
    }
  }

  async showMainMenu(ctx: Context) {
    if (!ctx.from) return;

    const userId = String(ctx.from.id);
    const userType = await this.getUserType(userId);
    const keyboard = this.getMenuKeyboard(userType);
    const welcomeMessage = this.getWelcomeMessage(userType);

    try {
      await ctx.editMessageText(welcomeMessage, {
        reply_markup: keyboard,
        parse_mode: 'MarkdownV2',
      });
    } catch {
      await ctx.reply(welcomeMessage, {
        reply_markup: keyboard,
        parse_mode: 'MarkdownV2',
      });
    }
  }

  // === Инструкции ===

  async showInstructions(ctx: Context) {
    try {
      await ctx.editMessageText(BotUi.instructionsMenuTitle, {
        reply_markup: BotUi.instructionsMenuKeyboard(),
        parse_mode: 'Markdown',
      });
    } catch {
      await ctx.reply(BotUi.instructionsMenuTitle, {
        reply_markup: BotUi.instructionsMenuKeyboard(),
        parse_mode: 'Markdown',
      });
    }
  }

  async showInstruction(ctx: Context, platform: string) {
    const instructions: Record<string, string> = {
      android: BotUi.instructionAndroid,
      ios: BotUi.instructionIos,
      windows: BotUi.instructionWindows,
      macos: BotUi.instructionMacos,
      linux: BotUi.instructionLinux,
    };

    const text = instructions[platform] || 'Инструкция не найдена';

    try {
      await ctx.editMessageText(text, {
        reply_markup: BotUi.backToInstructionsKeyboard(),
        parse_mode: 'MarkdownV2',
        link_preview_options: { is_disabled: true },
      });
    } catch {
      await ctx.reply(text, {
        reply_markup: BotUi.backToInstructionsKeyboard(),
        parse_mode: 'MarkdownV2',
        link_preview_options: { is_disabled: true },
      });
    }
  }
}
