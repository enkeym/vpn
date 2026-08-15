import { Injectable, Logger } from '@nestjs/common';
import { Context, InputFile } from 'grammy';
import { PeersService } from 'src/peers/peers.service';
import { BotUi } from '../ui/bot.ui';
import { safeEditMessageText } from '../utils/safe-edit-message';
import {
  closeMediaMessage,
  sendPeerConfigFileMessage,
  sendPeerQrCodeMessage,
} from '../utils/peer-media';
import { MainHandler } from './main.handler';
import { MtprotoService } from 'src/mtproto/mtproto.service';

// Состояние ожидания ввода описания для своих конфигов
// userId -> { peerName: string, promptMessageId: number, chatId: number }
const awaitingDescriptionEdit = new Map<
  string,
  { peerName: string; promptMessageId: number; chatId: number }
>();

@Injectable()
export class PeerManageHandler {
  private readonly logger = new Logger(PeerManageHandler.name);

  constructor(
    private readonly peersService: PeersService,
    private readonly mainHandler: MainHandler,
    private readonly mtprotoService: MtprotoService,
  ) {}

  isAwaitingDescriptionEdit(userId: string): boolean {
    return awaitingDescriptionEdit.has(userId);
  }

  getAwaitingDescriptionEditState(userId: string) {
    return awaitingDescriptionEdit.get(userId);
  }

  setAwaitingDescriptionEdit(
    userId: string,
    state: { peerName: string; promptMessageId: number; chatId: number } | null,
  ) {
    if (state) {
      awaitingDescriptionEdit.set(userId, state);
    } else {
      awaitingDescriptionEdit.delete(userId);
    }
  }

  async showConfigsList(ctx: Context) {
    if (!ctx.from) return;

    const peers = await this.peersService.getPeersByTelegramId(
      String(ctx.from.id),
    );

    if (peers.length === 0) {
      const userType = await this.mainHandler.getUserType(String(ctx.from.id));
      const showGetVpn =
        userType !== 'user' ||
        !(await this.mainHandler.isUserPaymentMenuHidden());
      return safeEditMessageText(ctx, BotUi.noConfigs, {
        parse_mode: 'Markdown',
        reply_markup: BotUi.emptyConfigsKeyboard(showGetVpn),
      });
    }

    await safeEditMessageText(ctx, BotUi.configsListTitle(peers.length), {
      reply_markup: BotUi.configsListKeyboard(peers),
      parse_mode: 'Markdown',
    });
  }

  async showPeerDetails(
    ctx: Context,
    peerName: string,
    isAdmin: boolean = false,
  ) {
    try {
      const peer = await this.peersService.findPeer(peerName);

      await safeEditMessageText(ctx, BotUi.peerDetailsText(peer, isAdmin), {
        reply_markup: BotUi.peerDetailsKeyboard(
          peer,
          isAdmin,
          this.mtprotoService.enabled,
        ),
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

  // Возврат с документа/QR в карточку конфига (кнопка «К конфигу» на файле)
  // Детали конфига уже выше — просто удаляем документ, без нового сообщения
  // Возврат с документа/QR в карточку конфига — оставлен для сообщений,
  // отправленных до перехода на общую кнопку `close_media`.
  async showPeerDetailsReply(ctx: Context) {
    await closeMediaMessage(ctx);
  }

  // Возврат после замены конфига — родитель удалён, удаляем документ и отправляем детали
  async showPeerDetailsReplyAfterReplace(
    ctx: Context,
    peerName: string,
    isAdmin: boolean = false,
  ) {
    try {
      const peer = await this.peersService.findPeer(peerName);

      await ctx.deleteMessage().catch(() => {});

      await ctx.reply(BotUi.peerDetailsText(peer, isAdmin), {
        reply_markup: BotUi.peerDetailsKeyboard(
          peer,
          isAdmin,
          this.mtprotoService.enabled,
        ),
        parse_mode: 'Markdown',
      });
    } catch {
      await ctx.answerCallbackQuery({
        text: 'Конфиг не найден',
        show_alert: true,
      });
    }
  }

  async togglePeer(ctx: Context, peerName: string, isAdmin: boolean = false) {
    try {
      await this.peersService.updatedPeer(peerName);
      await this.showPeerDetails(ctx, peerName, isAdmin);
    } catch (error) {
      this.logger.error(`Ошибка переключения: ${error}`);
      try {
        await ctx.answerCallbackQuery({
          text: 'Ошибка изменения статуса',
          show_alert: true,
        });
      } catch {
        // Игнорируем если callback уже был отвечен
      }
    }
  }

  // === Редактирование описания ===

  async showEditDescriptionPrompt(ctx: Context, peerName: string) {
    if (!ctx.chat || !ctx.from) return;

    try {
      const peer = await this.peersService.findPeer(peerName);
      const promptMessageId = await safeEditMessageText(
        ctx,
        BotUi.editDescriptionPrompt(peer),
        {
          parse_mode: 'Markdown',
          reply_markup: BotUi.cancelEditOwnDescriptionKeyboard(peerName),
        },
      );
      if (promptMessageId != null) {
        this.setAwaitingDescriptionEdit(String(ctx.from.id), {
          peerName,
          promptMessageId,
          chatId: ctx.chat.id,
        });
      }
    } catch {
      await ctx.answerCallbackQuery({
        text: 'Конфиг не найден',
        show_alert: true,
      });
    }
  }

  async handleEditDescriptionInput(ctx: Context) {
    if (!ctx.from || !ctx.message?.text || !ctx.chat) return;

    const userId = String(ctx.from.id);
    const state = this.getAwaitingDescriptionEditState(userId);

    if (!state) return;

    const { peerName } = state;
    this.setAwaitingDescriptionEdit(userId, null);

    const input = ctx.message.text.trim();

    // Удаляем сообщение пользователя
    try {
      await ctx.api.deleteMessage(ctx.chat.id, ctx.message.message_id);
    } catch {
      // Игнорируем ошибку удаления
    }

    // Удаляем prompt-сообщение
    try {
      await ctx.api.deleteMessage(state.chatId, state.promptMessageId);
    } catch {
      // Игнорируем ошибку удаления
    }

    // Проверка на удаление описания
    const newDescription = input === '-' ? null : input;

    // Валидация длины
    if (newDescription && newDescription.length > 200) {
      const errorMsg = await ctx.reply(BotUi.invalidDescriptionInput, {
        parse_mode: 'Markdown',
        reply_markup: BotUi.cancelEditOwnDescriptionKeyboard(peerName),
      });
      this.setAwaitingDescriptionEdit(userId, {
        peerName,
        promptMessageId: errorMsg.message_id,
        chatId: ctx.chat.id,
      });
      return;
    }

    try {
      await this.peersService.updatePeerDescription(peerName, newDescription);
      await ctx.reply(BotUi.descriptionUpdated(newDescription), {
        parse_mode: 'Markdown',
        reply_markup: BotUi.backToOwnPeerKeyboard(peerName),
      });
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      await ctx.reply(BotUi.editDescriptionError(errorMsg), {
        parse_mode: 'Markdown',
        reply_markup: BotUi.backToOwnPeerKeyboard(peerName),
      });
    }
  }

  async cancelEditDescription(
    ctx: Context,
    peerName: string,
    isAdmin: boolean = false,
  ) {
    if (!ctx.from) return;
    this.setAwaitingDescriptionEdit(String(ctx.from.id), null);
    await this.showPeerDetails(ctx, peerName, isAdmin);
  }

  // === Показать QR-код конфига ===

  async showQrCode(ctx: Context, peerName: string) {
    await sendPeerQrCodeMessage(ctx, this.peersService, peerName, this.logger);
  }

  // === Получить файл конфига ===

  async sendConfigFile(ctx: Context, peerName: string) {
    await sendPeerConfigFileMessage(
      ctx,
      this.peersService,
      peerName,
      this.logger,
    );
  }

  // === Прокси для Telegram ===

  /**
   * Ссылка общая для всех клиентов (mtg держит один секрет), поэтому право
   * на неё перепроверяется здесь, а не только скрытием кнопки: карточка конфига
   * могла остаться в чате с тех пор, когда подписка была активна.
   */
  async showTelegramProxy(ctx: Context, peerName: string) {
    const link = this.mtprotoService.getProxyLink();

    let allowed = false;
    if (link) {
      try {
        const peer = await this.peersService.findPeer(peerName);
        const expired = peer.expiresAt ? new Date() > peer.expiresAt : false;
        allowed = !peer.paused && !expired;
      } catch {
        this.logger.warn(`Прокси: конфиг ${peerName} не найден`);
      }
    }

    if (!link || !allowed) {
      const fallback = BotUi.telegramProxyUnavailable(peerName);
      await safeEditMessageText(ctx, fallback.text, {
        reply_markup: fallback.keyboard,
        parse_mode: 'Markdown',
      });
      return;
    }

    await safeEditMessageText(ctx, BotUi.telegramProxyText(link), {
      reply_markup: BotUi.telegramProxyKeyboard(link, peerName),
      parse_mode: 'Markdown',
    });
  }

  // === Замена конфига ===

  async replacePeer(ctx: Context, peerName: string) {
    if (!ctx.chat) return;

    let statusMessageDeleted = false;

    try {
      // Показываем сообщение о процессе
      await safeEditMessageText(ctx, BotUi.replacingConfig, {
        parse_mode: 'Markdown',
      });

      // Выполняем замену
      const { peer: newPeer, config } =
        await this.peersService.replacePeer(peerName);

      // Удаляем сообщение "Заменяю конфигурацию..." ПЕРЕД отправкой файла
      try {
        await ctx.deleteMessage();
        statusMessageDeleted = true;
      } catch {
        // Игнорируем ошибку удаления
      }

      // Отправляем новый конфиг файлом (родитель удалён — нужна клавиатура с goto_peer_after_replace)
      await ctx.replyWithDocument(
        new InputFile(Buffer.from(config), `${newPeer.name}.conf`),
        {
          caption: BotUi.configReplaced(
            newPeer.name,
            newPeer.ip,
            newPeer.expiresAt,
          ),
          parse_mode: 'Markdown',
          reply_markup: BotUi.backToOwnPeerKeyboardReplyAfterReplace(peerName),
        },
      );
    } catch (error) {
      this.logger.error(`Ошибка замены конфига: ${error}`);
      const errorMsg = error instanceof Error ? error.message : String(error);

      // Если сообщение уже удалено, используем reply, иначе editMessageText
      if (statusMessageDeleted) {
        await ctx.reply(BotUi.configError(errorMsg), {
          parse_mode: 'Markdown',
          reply_markup: BotUi.backToOwnPeerKeyboard(peerName),
        });
      } else {
        try {
          await safeEditMessageText(ctx, BotUi.configError(errorMsg), {
            parse_mode: 'Markdown',
            reply_markup: BotUi.backToOwnPeerKeyboard(peerName),
          });
        } catch {
          // Если не удалось отредактировать, отправляем новое сообщение
          await ctx.reply(BotUi.configError(errorMsg), {
            parse_mode: 'Markdown',
            reply_markup: BotUi.backToOwnPeerKeyboard(peerName),
          });
        }
      }
    }
  }
}
