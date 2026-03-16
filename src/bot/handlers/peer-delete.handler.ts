import { Injectable, Logger, ForbiddenException } from '@nestjs/common';
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

  async deletePeer(ctx: Context, peerName: string, isAdmin = false) {
    try {
      const peer = await this.peersService.findPeer(peerName);

      if (!isAdmin && ctx.from && String(ctx.from.id) !== peer.telegramId) {
        throw new ForbiddenException('Нет доступа к удалению чужого конфига');
      }

      const chatId = peer.telegramId;
      for (const messageId of [
        peer.configMessageId,
        peer.qrMessageId,
        peer.fileMessageId,
      ]) {
        if (messageId != null) {
          try {
            await ctx.api.deleteMessage(chatId, messageId);
          } catch (error) {
            this.logger.warn(
              `Не удалось удалить связанное сообщение (${messageId}): ${error}`,
            );
          }
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
