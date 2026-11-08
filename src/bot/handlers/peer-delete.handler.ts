import { Injectable, Logger, ForbiddenException } from '@nestjs/common';
import { Context } from 'grammy';
import { PeersService } from 'src/peers/peers.service';
import { PeerManageHandler } from './peer-manage.handler';
import { MainHandler } from './main.handler';
import { deletePeerRelatedMessages } from '../utils/delete-peer-messages';

@Injectable()
export class PeerDeleteHandler {
  private readonly logger = new Logger(PeerDeleteHandler.name);

  constructor(
    private readonly peersService: PeersService,
    private readonly peerManageHandler: PeerManageHandler,
    private readonly mainHandler: MainHandler,
  ) {}

  async deletePeer(ctx: Context, peerName: string, isAdmin = false) {
    try {
      const peer = await this.peersService.findPeer(peerName);

      if (!isAdmin && ctx.from && String(ctx.from.id) !== peer.telegramId) {
        throw new ForbiddenException('Нет доступа к удалению чужого конфига');
      }

      if (
        isAdmin &&
        ctx.from &&
        String(ctx.from.id) !== peer.telegramId &&
        this.mainHandler.isAdmin(peer.telegramId)
      ) {
        throw new ForbiddenException(
          'Нет доступа к удалению конфига администратора',
        );
      }

      // Связанные сообщения удаляем в фоне (не блокируя отрисовку меню):
      // часть из них может быть старше 48 ч и боту недоступна для удаления.
      void deletePeerRelatedMessages(ctx.api, peer.telegramId, [
        peer.configMessageId,
        peer.qrMessageId,
        peer.fileMessageId,
      ]);

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
