import { Injectable, Logger } from '@nestjs/common';
import { PeersService } from 'src/peers/peers.service';
import { MainHandler } from './main.handler';
import { Context, InputFile } from 'grammy';
import { BotUi } from '../ui/bot.ui';
import { safeEditMessageText } from '../utils/safe-edit-message';
import type { SubscriptionDuration } from 'src/peers/dto/create-peer.dto';
import { PaymentService } from 'src/payment/payment.service';
import type { TVpnProtocol } from 'src/wg/tunnel.types';

@Injectable()
export class PeerCreateHandler {
  private readonly logger = new Logger(PeerCreateHandler.name);

  constructor(
    private readonly peersService: PeersService,
    private readonly mainHandler: MainHandler,
    private readonly paymentService: PaymentService,
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
    const hasDiscount =
      hasUsedDiscount !== undefined
        ? !hasUsedDiscount
        : !(await this.peersService.hasUsedFirstPurchaseDiscount(
            String(ctx.from.id),
          ));
    const testPayment = this.paymentService.isTestPayment();
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
        this.paymentService.isTestPayment(),
      ),
    });
  }

  /**
   * Экран выбора протокола. Если AmneziaWG на сервере не поднят, выбирать не из
   * чего — возвращаем false, и вызывающая сторона идёт по обычному пути с WireGuard.
   */
  async showProtocolOptions(
    ctx: Context,
    actionPrefix: string,
    backCallback = 'main_menu',
  ): Promise<boolean> {
    if (!this.peersService.isProtocolAvailable('awg')) return false;

    await safeEditMessageText(ctx, BotUi.selectProtocolTitle, {
      parse_mode: 'Markdown',
      reply_markup: BotUi.selectProtocolKeyboard(actionPrefix, backCallback),
    });
    return true;
  }

  /** Пробный период: конфиг на 3 дня, доступен только один раз */
  async handleCreateTrialConfig(ctx: Context, protocol: TVpnProtocol = 'wg') {
    if (!ctx.from) return;
    await this.handleCreateConfig(
      ctx,
      3 as SubscriptionDuration,
      true,
      undefined,
      protocol,
    );
  }

  async handleCreateConfig(
    ctx: Context,
    durationDays?: SubscriptionDuration,
    isTrial = false,
    usedPromoDiscount?: 60 | 90,
    protocol: TVpnProtocol = 'wg',
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
        protocol,
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

      const message = await ctx.replyWithDocument(
        new InputFile(Buffer.from(config), `${peer.name}.conf`),
        {
          caption: BotUi.configCreated(
            peer.name,
            peer.ip,
            peer.expiresAt,
            peer.protocol,
          ),
          parse_mode: 'Markdown',
          reply_markup: BotUi.configDeliveredKeyboard(peer.name),
        },
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
