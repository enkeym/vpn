import { Injectable, Logger } from '@nestjs/common';
import { PeersService } from 'src/peers/peers.service';
import { MainHandler } from './main.handler';
import { Context, InputFile } from 'grammy';
import { BotUi } from '../ui/bot.ui';
import type { SubscriptionDuration } from 'src/peers/dto/create-peer.dto';

@Injectable()
export class PeerCreateHandler {
  private readonly logger = new Logger(PeerCreateHandler.name);

  constructor(
    private readonly peersService: PeersService,
    private readonly mainHandler: MainHandler,
  ) {}

  async showCreateOptions(ctx: Context) {
    await ctx.editMessageText(BotUi.selectDurationTitle, {
      parse_mode: 'Markdown',
      reply_markup: BotUi.createConfigKeyboard(),
    });
  }

  /** Меню тарифов для обычных пользователей (оплата 30/60/90 дней) */
  async showPaymentPlans(ctx: Context) {
    if (!ctx.from) return;
    const hasDiscount = !(await this.peersService.hasUsedFirstPurchaseDiscount(
      String(ctx.from.id),
    ));
    await ctx.editMessageText(BotUi.paymentPlansTitle(hasDiscount), {
      parse_mode: 'Markdown',
      reply_markup: BotUi.paymentPlansKeyboard(hasDiscount),
    });
  }

  /** Подтверждение оплаты (мок) перед созданием конфига */
  async showPaymentConfirm(ctx: Context, durationDays: 30 | 60 | 90) {
    if (!ctx.from) return;
    const hasDiscount = !(await this.peersService.hasUsedFirstPurchaseDiscount(
      String(ctx.from.id),
    ));
    const isDiscounted =
      hasDiscount && (durationDays === 60 || durationDays === 90);
    const price = isDiscounted
      ? BotUi.paymentPlanDiscountedPrices[durationDays]
      : BotUi.paymentPlanPrices[durationDays];
    await ctx.editMessageText(
      BotUi.paymentConfirmTitle(durationDays, price, isDiscounted),
      {
        parse_mode: 'Markdown',
        reply_markup: BotUi.paymentConfirmKeyboard(durationDays),
      },
    );
  }

  /** Пробный период: конфиг на 3 дня, доступен только один раз */
  async handleCreateTrialConfig(ctx: Context) {
    if (!ctx.from) return;
    await this.handleCreateConfig(ctx, 3 as SubscriptionDuration, true);
  }

  async handleCreateConfig(
    ctx: Context,
    durationDays?: SubscriptionDuration,
    isTrial = false,
    usedPromoDiscount?: 60 | 90,
  ) {
    if (!ctx.from) return;

    try {
      await ctx.editMessageText(BotUi.creatingConfig, {
        parse_mode: 'Markdown',
      });

      const { config, peer } = await this.peersService.createPeer({
        telegramId: String(ctx.from.id),
        username: ctx.from.username,
        durationDays,
        isTrial,
      });

      if (usedPromoDiscount) {
        await this.peersService.recordPromoUsage(
          String(ctx.from.id),
          usedPromoDiscount,
        );
      }

      // Удаляем сообщение «Создаю конфигурацию» — конфиг будет главным, без меню сверху
      try {
        const msg = ctx.callbackQuery?.message;
        if (msg && 'message_id' in msg && ctx.chat) {
          await ctx.api.deleteMessage(ctx.chat.id, msg.message_id);
        }
      } catch {
        // Игнорируем
      }

      const message = await ctx.replyWithDocument(
        new InputFile(Buffer.from(config), `${peer.name}.conf`),
        {
          caption: BotUi.configCreated(peer.name, peer.ip, peer.expiresAt),
          parse_mode: 'Markdown',
          reply_markup: BotUi.backToMenuKeyboard(),
        },
      );

      await this.peersService.setConfigMessageId(peer.name, message.message_id);
    } catch (error) {
      this.logger.error(error);
      const errorMsg = error instanceof Error ? error.message : String(error);
      await ctx.editMessageText(BotUi.configError(errorMsg), {
        parse_mode: 'Markdown',
        reply_markup: BotUi.backToMenuKeyboard(),
      });
    }
  }
}
