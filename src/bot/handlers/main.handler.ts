import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { type Api, type Context } from 'grammy';
import { FamilyService } from 'src/family/family.service';
import { PeersService } from 'src/peers/peers.service';
import { BotUi } from '../ui/bot.ui';
import {
  isMessageNotModifiedError,
  safeEditMessageText,
} from '../utils/safe-edit-message';

export type UserType = 'admin' | 'family' | 'user';

@Injectable()
export class MainHandler {
  private adminIds: string[] = [];

  constructor(
    private readonly configService: ConfigService,
    private readonly familyService: FamilyService,
    private readonly peersService: PeersService,
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

  private getMenuKeyboard(userType: UserType, showTrial: boolean) {
    switch (userType) {
      case 'admin':
        return BotUi.adminMenuKeyboard(showTrial);
      case 'family':
        return BotUi.familyMemberMenuKeyboard(showTrial);
      default:
        return BotUi.mainMenuKeyboard(showTrial);
    }
  }

  private async sendWelcomeForClientUser(
    ctx: Context,
    userType: 'family' | 'user',
    showTrial: boolean,
  ): Promise<number | undefined> {
    const keyboard = this.getMenuKeyboard(userType, showTrial);
    const welcomeMessage = this.getWelcomeMessage(userType);

    return safeEditMessageText(ctx, welcomeMessage, {
      reply_markup: keyboard,
      parse_mode: 'Markdown',
    });
  }

  /**
   * Обновить уже существующее сообщение главным меню (если пользователь удалил чат — вернёт false).
   */
  async tryRefreshMainMenuMessage(
    api: Api,
    chatId: number,
    messageId: number,
    userId: string,
  ): Promise<boolean> {
    try {
      const [userType, hasUsedTrial] = await Promise.all([
        this.getUserType(userId),
        this.peersService.hasUsedTrial(userId),
      ]);
      const showTrial = !hasUsedTrial;
      const keyboard = this.getMenuKeyboard(userType, showTrial);
      const welcomeMessage = this.getWelcomeMessage(userType);
      await api.editMessageText(chatId, messageId, welcomeMessage, {
        reply_markup: keyboard,
        parse_mode: 'Markdown',
        link_preview_options: { is_disabled: true },
      });
      return true;
    } catch (e) {
      if (isMessageNotModifiedError(e)) return true;
      return false;
    }
  }

  /** @returns message_id сообщения с меню (если удалось определить) */
  async showMainMenu(ctx: Context): Promise<number | undefined> {
    if (!ctx.from || !ctx.chat) return undefined;

    const userId = String(ctx.from.id);
    const [userType, hasUsedTrial] = await Promise.all([
      this.getUserType(userId),
      this.peersService.hasUsedTrial(userId),
    ]);
    const showTrial = !hasUsedTrial;
    const keyboard = this.getMenuKeyboard(userType, showTrial);
    const welcomeMessage = this.getWelcomeMessage(userType);

    if (userType === 'family' || userType === 'user') {
      return this.sendWelcomeForClientUser(ctx, userType, showTrial);
    }

    return safeEditMessageText(ctx, welcomeMessage, {
      reply_markup: keyboard,
      parse_mode: 'Markdown',
    });
  }

  async showInstructions(ctx: Context) {
    await safeEditMessageText(ctx, BotUi.instructionsMenuTitle, {
      reply_markup: BotUi.instructionsMenuKeyboard(),
      parse_mode: 'Markdown',
    });
  }

  async showInstruction(ctx: Context, platform: string) {
    const instructions: Record<string, string> = {
      android: BotUi.instructionAndroid,
      ios: BotUi.instructionIos,
      windows: BotUi.instructionWindows,
      macos: BotUi.instructionMacos,
      linux: BotUi.instructionLinux,
      video: BotUi.instructionVideo,
    };

    const text = instructions[platform] || 'Инструкция не найдена';

    await safeEditMessageText(ctx, text, {
      reply_markup: BotUi.backToInstructionsKeyboard(),
      parse_mode: 'Markdown',
      link_preview_options: { is_disabled: true },
    });
  }
}
