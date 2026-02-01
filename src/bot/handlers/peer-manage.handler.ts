import { Injectable, Logger } from '@nestjs/common';
import { Context } from 'grammy';
import { PeersService } from 'src/peers/peers.service';
import { BotUi } from '../ui/bot.ui';

@Injectable()
export class PeerManageHandler {
  private readonly logger = new Logger(PeerManageHandler.name);

  constructor(private readonly peersService: PeersService) {}

  async showConfigsList(ctx: Context) {
    if (!ctx.from) return;

    const peers = await this.peersService.getPeersByTelegramId(
      String(ctx.from.id),
    );

    if (peers.length === 0) {
      return ctx.editMessageText(BotUi.noConfigs, {
        parse_mode: 'Markdown',
        reply_markup: BotUi.emptyConfigsKeyboard(),
      });
    }

    await ctx.editMessageText(BotUi.configsListTitle(peers.length), {
      reply_markup: BotUi.configsListKeyboard(peers),
      parse_mode: 'Markdown',
    });
  }

  async showPeerDetails(ctx: Context, peerName: string) {
    try {
      const peer = await this.peersService.findPeer(peerName);

      await ctx.editMessageText(BotUi.peerDetailsText(peer), {
        reply_markup: BotUi.peerDetailsKeyboard(peer),
        parse_mode: 'Markdown',
      });
    } catch {
      await ctx.answerCallbackQuery({
        text: 'Конфиг не найден',
        show_alert: true,
      });
      await this.showConfigsList(ctx);
    }
  }

  async togglePeer(ctx: Context, peerName: string) {
    try {
      await this.peersService.updatedPeer(peerName);
      await this.showPeerDetails(ctx, peerName);
      await ctx.answerCallbackQuery('Статус изменен');
    } catch (error) {
      this.logger.error(`Ошибка переключения: ${error}`);
      await ctx.answerCallbackQuery({
        text: 'Ошибка изменения статуса',
        show_alert: true,
      });
    }
  }
}
