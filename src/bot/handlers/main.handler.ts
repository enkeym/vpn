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

type MainMenuView = {
  userType: UserType;
  welcomeMessage: string;
  keyboard: ReturnType<typeof BotUi.mainMenuKeyboard>;
};

@Injectable()
export class MainHandler {
  private adminIds: string[] = [];
  private readonly mainMenuCache = new Map<
    string,
    MainMenuView & { expiresAt: number }
  >();
  private static readonly MAIN_MENU_CACHE_TTL_MS = 15_000;

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

  invalidateMainMenuCache(userId: string): void {
    this.mainMenuCache.delete(userId);
  }

  private async getMainMenuView(userId: string): Promise<MainMenuView> {
    const cached = this.mainMenuCache.get(userId);
    if (cached && cached.expiresAt > Date.now()) {
      return cached;
    }

    const [userType, hasUsedTrial] = await Promise.all([
      this.getUserType(userId),
      this.peersService.hasUsedTrial(userId),
    ]);
    const showTrial = !hasUsedTrial;
    const view = {
      userType,
      keyboard: this.getMenuKeyboard(userType, showTrial),
      welcomeMessage: this.getWelcomeMessage(userType),
    };

    this.mainMenuCache.set(userId, {
      ...view,
      expiresAt: Date.now() + MainHandler.MAIN_MENU_CACHE_TTL_MS,
    });
    return view;
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
      const { keyboard, welcomeMessage } = await this.getMainMenuView(userId);
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
    const { userType, keyboard, welcomeMessage } =
      await this.getMainMenuView(userId);

    if (userType === 'family' || userType === 'user') {
      return safeEditMessageText(ctx, welcomeMessage, {
        reply_markup: keyboard,
        parse_mode: 'Markdown',
      });
    }

    return safeEditMessageText(ctx, welcomeMessage, {
      reply_markup: keyboard,
      parse_mode: 'Markdown',
    });
  }

  /**
   * Отправить НОВОЕ сообщение с главным меню (без попыток отредактировать существующее).
   * Нужно для /start: после «Очистить историю» Bot API всё ещё видит старые сообщения и
   * успешно их «правит», но пользователь у себя в чате ничего не видит — поэтому при
   * /start всегда шлём свежее сообщение.
   */
  async sendFreshMainMenu(ctx: Context): Promise<number | undefined> {
    if (!ctx.from || !ctx.chat) return undefined;

    const userId = String(ctx.from.id);
    const { keyboard, welcomeMessage } = await this.getMainMenuView(userId);

    const sent = await ctx.reply(welcomeMessage, {
      reply_markup: keyboard,
      parse_mode: 'Markdown',
      link_preview_options: { is_disabled: true },
    });
    return sent.message_id;
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
