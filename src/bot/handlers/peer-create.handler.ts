import { Injectable, Logger } from '@nestjs/common';
import { PeersService } from 'src/peers/peers.service';
import { MainHandler } from './main.handler';
import { Context } from 'grammy';
import { sendCreatedPeerMessage } from '../utils/peer-media';
import { BotUi } from '../ui/bot.ui';
import { safeEditMessageText } from '../utils/safe-edit-message';
import type { SubscriptionDuration } from 'src/peers/dto/create-peer.dto';
import { PaymentService } from 'src/payment/payment.service';
import { SubscriptionService } from 'src/subscription/subscription.service';
import type { DiscountEligibleDuration } from 'src/payment/pricing';

@Injectable()
export class PeerCreateHandler {
  private readonly logger = new Logger(PeerCreateHandler.name);

  constructor(
    private readonly peersService: PeersService,
    private readonly mainHandler: MainHandler,
    private readonly paymentService: PaymentService,
    private readonly subscriptionService: SubscriptionService,
  ) {}

  async showCreateOptions(ctx: Context) {
    await safeEditMessageText(ctx, BotUi.selectDurationTitle, {
      parse_mode: 'Markdown',
      reply_markup: BotUi.createConfigKeyboard(),
    });
  }

  /** Меню тарифов для обычных пользователей (оплата 30/60/90 дней) */
  async showPaymentPlans(ctx: Context, hasUsedDiscount?: boolean) {
    if (!ctx.from) return;
    if (!(await this.paymentService.isPaymentEnabled())) {
      await safeEditMessageText(ctx, BotUi.paymentMenuUnavailable, {
        parse_mode: 'Markdown',
        reply_markup: BotUi.backToMenuKeyboard(),
      });
      return;
    }
    const hasDiscount =
      hasUsedDiscount !== undefined
        ? !hasUsedDiscount
        : !(await this.peersService.hasUsedFirstPurchaseDiscount(
            String(ctx.from.id),
          ));
    // Тестовая цена 1 ₽ — только для админов; клиенты видят обычные цены
    const testPayment = await this.paymentService.isTestPaymentFor(
      String(ctx.from.id),
    );
    await safeEditMessageText(
      ctx,
      BotUi.paymentPlansTitle(hasDiscount, testPayment),
      {
        parse_mode: 'Markdown',
        reply_markup: BotUi.paymentPlansKeyboard(hasDiscount, testPayment),
      },
    );
  }

  /** Меню тарифов для продления существующего конфига */
  async showPaymentPlansForExtend(ctx: Context, peerName: string) {
    if (!ctx.from) return;
    if (!(await this.paymentService.isPaymentEnabled())) {
      await safeEditMessageText(ctx, BotUi.paymentMenuUnavailable, {
        parse_mode: 'Markdown',
        reply_markup: BotUi.backToOwnPeerKeyboard(peerName),
      });
      return;
    }
    const hasDiscount = !(await this.peersService.hasUsedFirstPurchaseDiscount(
      String(ctx.from.id),
    ));
    const title =
      '🔄 *Продление конфига*\n\n' +
      'Выберите тариф для продления подписки. После оплаты срок действия вашего конфига будет продлён.\n\n' +
      (hasDiscount
        ? '🎁 *Разовая акция:* скидка на 60 или 90 дней при первой покупке.\n\n'
        : '');
    await safeEditMessageText(ctx, title, {
      parse_mode: 'Markdown',
      reply_markup: BotUi.paymentPlansKeyboardForExtend(
        peerName,
        hasDiscount,
        await this.paymentService.isTestPaymentFor(String(ctx.from.id)),
      ),
    });
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
    usedPromoDiscount?: DiscountEligibleDuration,
  ) {
    if (!ctx.from) return;

    try {
      await safeEditMessageText(ctx, BotUi.creatingConfig, {
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

      try {
        const msg = ctx.callbackQuery?.message;
        if (msg && 'message_id' in msg && ctx.chat) {
          await ctx.api.deleteMessage(ctx.chat.id, msg.message_id);
        }
      } catch {
        // Игнорируем
      }

      const message = await sendCreatedPeerMessage(
        ctx.api,
        ctx.from.id,
        this.peersService,
        peer,
        config,
        BotUi.configCreated(
          peer.name,
          this.peersService.isTunnelAvailable() ? peer.ip : null,
          peer.expiresAt,
        ),
        this.mainHandler.isAdmin(String(ctx.from.id)),
        this.subscriptionService.buildSubscriptionUrl(peer),
      );

      await this.peersService.setConfigMessageId(peer.name, message.message_id);
    } catch (error) {
      this.logger.error(error);
      const errorMsg = error instanceof Error ? error.message : String(error);
      await safeEditMessageText(ctx, BotUi.configError(errorMsg), {
        parse_mode: 'Markdown',
        reply_markup: BotUi.configDeliveredKeyboard(),
      });
    }
  }
}
