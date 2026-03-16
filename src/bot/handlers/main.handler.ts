import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Context, InputFile } from 'grammy';
import * as path from 'path';
import { existsSync, readFileSync, statSync } from 'fs';
import { FamilyService } from 'src/family/family.service';
import { PeersService } from 'src/peers/peers.service';
import { BotUi } from '../ui/bot.ui';

const VPN_GIF_MAX_SIZE = 50 * 1024 * 1024; // 50 MB — лимит Telegram

function getVpnGifPath(): string | null {
  const candidates = [
    path.join(process.cwd(), 'vpn.gif'),
    path.join(process.cwd(), 'src', 'assets', 'vpn.gif'),
    // dist/src/bot/handlers -> dist/src/assets (Docker / production)
    path.join(__dirname, '..', '..', 'assets', 'vpn.gif'),
    // src/bot/handlers -> src/assets (dev)
    path.join(__dirname, '..', '..', 'src', 'assets', 'vpn.gif'),
    path.join(__dirname, '..', '..', '..', 'vpn.gif'),
  ];
  for (const p of candidates) {
    if (existsSync(p)) return p;
  }
  return null;
}

export type UserType = 'admin' | 'family' | 'user';

@Injectable()
export class MainHandler {
  private readonly logger = new Logger(MainHandler.name);
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

  private async sendWelcomeWithGif(
    ctx: Context,
    userType: 'family' | 'user',
    showTrial: boolean,
  ) {
    const keyboard = this.getMenuKeyboard(userType, showTrial);
    const welcomeMessage = this.getWelcomeMessage(userType);

    const isStartCommand = !ctx.callbackQuery;

    const trySendGif = async () => {
      if (!isStartCommand) return;
      const gifPath = getVpnGifPath();
      if (!gifPath) {
        this.logger.warn(`vpn.gif не найден. cwd=${process.cwd()}`);
        return;
      }
      try {
        const size = statSync(gifPath).size;
        if (size > VPN_GIF_MAX_SIZE) {
          this.logger.warn(`vpn.gif слишком большой: ${size} bytes`);
          return;
        }
        const file = new InputFile(readFileSync(gifPath), 'vpn.gif');
        await ctx.replyWithAnimation(file);
      } catch (err) {
        this.logger.error(
          `Ошибка отправки GIF: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    };

    const sendTextAndGif = async () => {
      await ctx.reply(welcomeMessage, {
        reply_markup: keyboard,
        parse_mode: 'Markdown',
      });
      await trySendGif();
    };

    try {
      await ctx.editMessageText(welcomeMessage, {
        reply_markup: keyboard,
        parse_mode: 'Markdown',
      });
      await trySendGif();
    } catch (err) {
      const msg = String(err instanceof Error ? err.message : err);
      if (msg.includes('not modified')) return;
      const cbMsg = ctx.callbackQuery?.message;
      if (cbMsg && ctx.chat && 'message_id' in cbMsg) {
        await ctx.api
          .editMessageReplyMarkup(ctx.chat.id, cbMsg.message_id, {
            reply_markup: { inline_keyboard: [] },
          })
          .catch(() => {});
      }
      await sendTextAndGif();
    }
  }

  async showMainMenu(ctx: Context) {
    if (!ctx.from) return;

    const userId = String(ctx.from.id);
    const [userType, hasUsedTrial] = await Promise.all([
      this.getUserType(userId),
      this.peersService.hasUsedTrial(userId),
    ]);
    const showTrial = !hasUsedTrial;
    const keyboard = this.getMenuKeyboard(userType, showTrial);
    const welcomeMessage = this.getWelcomeMessage(userType);

    if (userType === 'family' || userType === 'user') {
      await this.sendWelcomeWithGif(ctx, userType, showTrial);
      return;
    }

    try {
      await ctx.editMessageText(welcomeMessage, {
        reply_markup: keyboard,
        parse_mode: 'Markdown',
      });
    } catch (err) {
      const msg = String(err instanceof Error ? err.message : err);
      if (msg.includes('not modified')) return;
      const cbMsg = ctx.callbackQuery?.message;
      if (cbMsg && ctx.chat && 'message_id' in cbMsg) {
        await ctx.api
          .editMessageReplyMarkup(ctx.chat.id, cbMsg.message_id, {
            reply_markup: { inline_keyboard: [] },
          })
          .catch(() => {});
      }
      await ctx.reply(welcomeMessage, {
        reply_markup: keyboard,
        parse_mode: 'Markdown',
      });
    }
  }

  async showInstructions(ctx: Context) {
    try {
      await ctx.editMessageText(BotUi.instructionsMenuTitle, {
        reply_markup: BotUi.instructionsMenuKeyboard(),
        parse_mode: 'Markdown',
      });
    } catch (err) {
      const msg = String(err instanceof Error ? err.message : err);
      if (
        msg.includes('not modified') ||
        msg.includes('message to edit not found')
      )
        return;
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
      video: BotUi.instructionVideo,
    };

    const text = instructions[platform] || 'Инструкция не найдена';

    try {
      await ctx.editMessageText(text, {
        reply_markup: BotUi.backToInstructionsKeyboard(),
        parse_mode: 'Markdown',
        link_preview_options: { is_disabled: true },
      });
    } catch {
      await ctx.reply(text, {
        reply_markup: BotUi.backToInstructionsKeyboard(),
        parse_mode: 'Markdown',
        link_preview_options: { is_disabled: true },
      });
    }
  }
}
