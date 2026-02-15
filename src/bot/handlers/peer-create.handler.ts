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
    await ctx.editMessageText(BotUi.paymentPlansTitle, {
      parse_mode: 'Markdown',
      reply_markup: BotUi.paymentPlansKeyboard(),
    });
  }

  /** Подтверждение оплаты (мок) перед созданием конфига */
  async showPaymentConfirm(ctx: Context, durationDays: 30 | 60 | 90) {
    const price = BotUi.paymentPlanPrices[durationDays];
    await ctx.editMessageText(
      BotUi.paymentConfirmTitle(durationDays, price),
      {
        parse_mode: 'Markdown',
        reply_markup: BotUi.paymentConfirmKeyboard(durationDays),
      },
    );
  }

  async handleCreateConfig(ctx: Context, durationDays?: SubscriptionDuration) {
    if (!ctx.from) return;

    try {
      await ctx.editMessageText(BotUi.creatingConfig, {
        parse_mode: 'Markdown',
      });

      const { config, peer } = await this.peersService.createPeer({
        telegramId: String(ctx.from.id),
        username: ctx.from.username,
        durationDays,
      });

      const message = await ctx.replyWithDocument(
        new InputFile(Buffer.from(config), `${peer.name}.conf`),
        {
          caption: BotUi.configCreated(peer.name, peer.ip, peer.expiresAt),
          parse_mode: 'Markdown',
        },
      );

      await this.peersService.setConfigMessageId(peer.name, message.message_id);

      await this.mainHandler.showMainMenu(ctx);
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
