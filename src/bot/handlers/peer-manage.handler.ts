import { Injectable, Logger } from '@nestjs/common';
import { Context, InputFile } from 'grammy';
import { PeersService } from 'src/peers/peers.service';
import { BotUi } from '../ui/bot.ui';

// Состояние ожидания ввода описания для своих конфигов
// userId -> { peerName: string, promptMessageId: number, chatId: number }
const awaitingDescriptionEdit = new Map<
  string,
  { peerName: string; promptMessageId: number; chatId: number }
>();

@Injectable()
export class PeerManageHandler {
  private readonly logger = new Logger(PeerManageHandler.name);

  constructor(private readonly peersService: PeersService) {}

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

  async showPeerDetails(
    ctx: Context,
    peerName: string,
    isAdmin: boolean = false,
  ) {
    try {
      const peer = await this.peersService.findPeer(peerName);

      await ctx.editMessageText(BotUi.peerDetailsText(peer, isAdmin), {
        reply_markup: BotUi.peerDetailsKeyboard(peer, isAdmin),
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

  // Показать детали конфига через новое сообщение (для использования после документов)
  async showPeerDetailsReply(
    ctx: Context,
    peerName: string,
    isAdmin: boolean = false,
  ) {
    try {
      const peer = await this.peersService.findPeer(peerName);

      // Удаляем текущее сообщение (с документом)
      try {
        await ctx.deleteMessage();
      } catch {
        // Игнорируем ошибку удаления
      }

      // Отправляем новое сообщение с деталями
      await ctx.reply(BotUi.peerDetailsText(peer, isAdmin), {
        reply_markup: BotUi.peerDetailsKeyboard(peer, isAdmin),
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
      const result = await ctx.editMessageText(
        BotUi.editDescriptionPrompt(peer),
        {
          parse_mode: 'Markdown',
          reply_markup: BotUi.cancelEditOwnDescriptionKeyboard(peerName),
        },
      );

      if (result && typeof result === 'object' && 'message_id' in result) {
        this.setAwaitingDescriptionEdit(String(ctx.from.id), {
          peerName,
          promptMessageId: result.message_id,
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
    if (!ctx.chat) return;

    try {
      const qrBuffer = await this.peersService.generatePeerQrCode(peerName);
      const peer = await this.peersService.findPeer(peerName);

      await ctx.replyWithPhoto(new InputFile(qrBuffer, `${peerName}_qr.png`), {
        caption: `📷 *QR\\-код для конфига* \`${peer.name}\`\n\n_Отсканируйте в приложении WireGuard_`,
        parse_mode: 'MarkdownV2',
        reply_markup: BotUi.backToOwnPeerKeyboardReply(peerName),
      });
    } catch (error) {
      this.logger.error(`Ошибка генерации QR: ${error}`);
      await ctx.answerCallbackQuery({
        text: 'Ошибка генерации QR-кода',
        show_alert: true,
      });
    }
  }

  // === Замена конфига ===

  async replacePeer(ctx: Context, peerName: string) {
    if (!ctx.chat) return;

    let statusMessageDeleted = false;

    try {
      // Сначала проверяем, можно ли заменить
      const peer = await this.peersService.findPeer(peerName);
      const { canReplace, hoursLeft } = this.peersService.canReplacePeer(peer);

      if (!canReplace) {
        await ctx.editMessageText(BotUi.replaceNotAvailable(hoursLeft ?? 0), {
          parse_mode: 'Markdown',
          reply_markup: BotUi.backToOwnPeerKeyboard(peerName),
        });
        return;
      }

      // Показываем сообщение о процессе
      await ctx.editMessageText(BotUi.replacingConfig, {
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

      // Отправляем новый конфиг файлом (используем ReplyKeyboard для документов)
      await ctx.replyWithDocument(
        new InputFile(Buffer.from(config), `${newPeer.name}.conf`),
        {
          caption: BotUi.configReplaced(
            newPeer.name,
            newPeer.ip,
            newPeer.expiresAt,
          ),
          parse_mode: 'Markdown',
          reply_markup: BotUi.backToOwnPeerKeyboardReply(peerName),
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
          await ctx.editMessageText(BotUi.configError(errorMsg), {
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
