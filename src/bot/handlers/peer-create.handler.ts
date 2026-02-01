import { Injectable, Logger } from '@nestjs/common';
import { PeersService } from 'src/peers/peers.service';
import { MainHandler } from './main.handler';
import { Context, InputFile } from 'grammy';
import { BotUi } from '../ui/bot.ui';

@Injectable()
export class PeerCreateHandler {
  private readonly logger = new Logger(PeerCreateHandler.name);

  constructor(
    private readonly peersService: PeersService,
    private readonly mainHandler: MainHandler,
  ) {}

  async handleCreateConfig(ctx: Context) {
    if (!ctx.from) return;

    try {
      await ctx.editMessageText(BotUi.creatingConfig, {
        parse_mode: 'Markdown',
      });

      const { config, peer } = await this.peersService.createPeer({
        telegramId: String(ctx.from.id),
        username: ctx.from.username,
      });

      const message = await ctx.replyWithDocument(
        new InputFile(Buffer.from(config), `${peer.name}.conf`),
        {
          caption: BotUi.configCreated(peer.name, peer.ip),
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
