import { Injectable, Logger } from '@nestjs/common';
import { Context } from 'grammy';
import { PeersService } from 'src/peers/peers.service';
import { PeerManageHandler } from './peer-manage.handler';

@Injectable()
export class PeerDeleteHandler {
  private readonly logger = new Logger(PeerDeleteHandler.name);

  constructor(
    private readonly peersService: PeersService,
    private readonly peerManageHandler: PeerManageHandler,
  ) {}

  async deletePeer(ctx: Context, peerName: string) {
    try {
      const peer = await this.peersService.findPeer(peerName);

      if (peer.configMessageId) {
        try {
          await ctx.api.deleteMessage(peer.telegramId, peer.configMessageId);
        } catch (error) {
          this.logger.warn(`Не удалось удалить сообщение с конфигом: ${error}`);
        }
      }

      await this.peersService.deletePeer(peerName);
      await this.peerManageHandler.showConfigsList(ctx);
    } catch (error) {
      this.logger.error(`Ошибка удаления: ${error}`);
      try {
        await ctx.answerCallbackQuery({
          text: 'Ошибка удаления',
          show_alert: true,
        });
      } catch {
        // Игнорируем если callback уже был отвечен
      }
    }
  }
}
