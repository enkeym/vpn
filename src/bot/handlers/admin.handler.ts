import { Injectable, Logger } from '@nestjs/common';
import { Context, InputFile } from 'grammy';
import { PeersService } from 'src/peers/peers.service';
import { BotUi } from '../ui/bot.ui';
import type { SubscriptionDuration } from 'src/peers/dto/create-peer.dto';

// Состояние ожидания ввода telegramId для поиска клиента
// adminId -> { promptMessageId: number, chatId: number }
const awaitingClientSearch = new Map<
  string,
  { promptMessageId: number; chatId: number }
>();

// Состояние ожидания ввода для редактирования описания конфига клиента
// adminId -> { peerName: string, clientTelegramId: string, promptMessageId: number, chatId: number }
const awaitingClientDescriptionEdit = new Map<
  string,
  {
    peerName: string;
    clientTelegramId: string;
    promptMessageId: number;
    chatId: number;
  }
>();

@Injectable()
export class AdminHandler {
  private readonly logger = new Logger(AdminHandler.name);

  constructor(private readonly peersService: PeersService) {}

  // === Поиск клиента ===

  isAwaitingClientSearch(userId: string): boolean {
    return awaitingClientSearch.has(userId);
  }

  getAwaitingClientSearchState(userId: string) {
    return awaitingClientSearch.get(userId);
  }

  setAwaitingClientSearch(
    userId: string,
    state: { promptMessageId: number; chatId: number } | null,
  ) {
    if (state) {
      awaitingClientSearch.set(userId, state);
    } else {
      awaitingClientSearch.delete(userId);
    }
  }

  async showSearchPrompt(ctx: Context) {
    if (!ctx.from || !ctx.chat) return;

    const result = await ctx.editMessageText(BotUi.clientSearchPrompt, {
      parse_mode: 'Markdown',
      reply_markup: BotUi.cancelClientSearchKeyboard(),
    });

    if (result && typeof result === 'object' && 'message_id' in result) {
      this.setAwaitingClientSearch(String(ctx.from.id), {
        promptMessageId: result.message_id,
        chatId: ctx.chat.id,
      });
    }
  }

  async handleSearchInput(ctx: Context) {
    if (!ctx.from || !ctx.message?.text || !ctx.chat) return;

    const adminId = String(ctx.from.id);
    const state = this.getAwaitingClientSearchState(adminId);
    this.setAwaitingClientSearch(adminId, null);

    const input = ctx.message.text.trim();

    // Удаляем сообщение пользователя
    try {
      await ctx.api.deleteMessage(ctx.chat.id, ctx.message.message_id);
    } catch {
      // Игнорируем ошибку удаления
    }

    // Удаляем prompt-сообщение
    if (state) {
      try {
        await ctx.api.deleteMessage(state.chatId, state.promptMessageId);
      } catch {
        // Игнорируем ошибку удаления
      }
    }

    // Проверяем что введен числовой ID
    if (!/^\d+$/.test(input)) {
      const errorMsg = await ctx.reply(BotUi.invalidClientIdInput, {
        parse_mode: 'Markdown',
        reply_markup: BotUi.cancelClientSearchKeyboard(),
      });
      this.setAwaitingClientSearch(adminId, {
        promptMessageId: errorMsg.message_id,
        chatId: ctx.chat.id,
      });
      return;
    }

    const telegramId = input;

    // Ищем конфиги клиента (может быть 0)
    const peers = await this.peersService.getPeersByTelegramId(telegramId);

    // Показываем сообщение "Клиент найден" с кнопкой открыть меню
    // Клиент создаётся как "оболочка" даже если конфигов нет
    await ctx.reply(BotUi.clientFoundText(telegramId, peers.length), {
      parse_mode: 'Markdown',
      reply_markup: BotUi.clientFoundKeyboard(telegramId),
    });
  }

  async cancelSearch(ctx: Context) {
    if (!ctx.from) return;
    this.setAwaitingClientSearch(String(ctx.from.id), null);
    // Возвращаемся в главное меню
    try {
      await ctx.editMessageText(BotUi.welcomeMessage, {
        reply_markup: BotUi.adminMenuKeyboard(),
        parse_mode: 'Markdown',
      });
    } catch {
      await ctx.reply(BotUi.welcomeMessage, {
        reply_markup: BotUi.adminMenuKeyboard(),
        parse_mode: 'Markdown',
      });
    }
  }

  // === Управление клиентом ===

  async showClientDetails(ctx: Context, telegramId: string) {
    const peers = await this.peersService.getPeersByTelegramId(telegramId);

    await ctx.editMessageText(BotUi.clientDetailsText(telegramId, peers.length), {
      parse_mode: 'Markdown',
      reply_markup: BotUi.clientDetailsKeyboard(telegramId, peers),
    });
  }

  async showClientConfigs(ctx: Context, telegramId: string) {
    const peers = await this.peersService.getPeersByTelegramId(telegramId);

    await ctx.editMessageText(
      BotUi.clientConfigsListTitle(telegramId, peers.length),
      {
        parse_mode: 'Markdown',
        reply_markup: BotUi.clientConfigsListKeyboard(peers, telegramId),
      },
    );
  }

  async showClientPeerDetails(ctx: Context, peerName: string, telegramId: string) {
    try {
      const peer = await this.peersService.findPeer(peerName);

      await ctx.editMessageText(BotUi.clientPeerDetailsText(peer), {
        reply_markup: BotUi.clientPeerDetailsKeyboard(peer, telegramId),
        parse_mode: 'Markdown',
      });
    } catch {
      await ctx.answerCallbackQuery({
        text: 'Конфиг не найден',
        show_alert: true,
      });
      await this.showClientDetails(ctx, telegramId);
    }
  }

  async toggleClientPeer(ctx: Context, peerName: string, telegramId: string) {
    try {
      await this.peersService.updatedPeer(peerName);
      await this.showClientPeerDetails(ctx, peerName, telegramId);
      await ctx.answerCallbackQuery('Статус изменен');
    } catch (error) {
      this.logger.error(`Ошибка переключения: ${error}`);
      await ctx.answerCallbackQuery({
        text: 'Ошибка изменения статуса',
        show_alert: true,
      });
    }
  }

  async deleteClientPeer(ctx: Context, peerName: string, telegramId: string) {
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
      await ctx.answerCallbackQuery({ text: 'Конфиг удален' });
      await this.showClientDetails(ctx, telegramId);
    } catch (error) {
      this.logger.error(`Ошибка удаления: ${error}`);
      await ctx.answerCallbackQuery({
        text: 'Ошибка удаления',
        show_alert: true,
      });
    }
  }

  // === Изменение срока действия ===

  async showChangeDuration(ctx: Context, peerName: string, telegramId: string) {
    await ctx.editMessageText(BotUi.changeDurationTitle, {
      parse_mode: 'Markdown',
      reply_markup: BotUi.clientChangeDurationKeyboard(peerName, telegramId),
    });
  }

  async changePeerDuration(
    ctx: Context,
    peerName: string,
    telegramId: string,
    duration: string,
  ) {
    try {
      await this.peersService.findPeer(peerName);

      let newExpiresAt: Date | null = null;
      if (duration !== 'unlimited') {
        const days = parseInt(duration, 10);
        newExpiresAt = new Date(Date.now() + days * 24 * 60 * 60 * 1000);
      }

      await this.peersService.updatePeerExpiration(peerName, newExpiresAt);
      await ctx.answerCallbackQuery({ text: 'Срок действия изменен' });
      await this.showClientPeerDetails(ctx, peerName, telegramId);
    } catch (error) {
      this.logger.error(`Ошибка изменения срока: ${error}`);
      await ctx.answerCallbackQuery({
        text: 'Ошибка изменения срока',
        show_alert: true,
      });
    }
  }

  // === Редактирование описания ===

  isAwaitingClientDescriptionEdit(userId: string): boolean {
    return awaitingClientDescriptionEdit.has(userId);
  }

  getAwaitingClientDescriptionEditState(userId: string) {
    return awaitingClientDescriptionEdit.get(userId);
  }

  setAwaitingClientDescriptionEdit(
    userId: string,
    state: {
      peerName: string;
      clientTelegramId: string;
      promptMessageId: number;
      chatId: number;
    } | null,
  ) {
    if (state) {
      awaitingClientDescriptionEdit.set(userId, state);
    } else {
      awaitingClientDescriptionEdit.delete(userId);
    }
  }

  async showEditDescriptionPrompt(
    ctx: Context,
    peerName: string,
    telegramId: string,
  ) {
    if (!ctx.chat) return;

    try {
      const peer = await this.peersService.findPeer(peerName);
      const result = await ctx.editMessageText(
        BotUi.editDescriptionPrompt(peer),
        {
          parse_mode: 'Markdown',
          reply_markup: BotUi.cancelClientEditDescriptionKeyboard(
            peerName,
            telegramId,
          ),
        },
      );

      if (result && typeof result === 'object' && 'message_id' in result) {
        this.setAwaitingClientDescriptionEdit(String(ctx.from!.id), {
          peerName,
          clientTelegramId: telegramId,
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
    const state = this.getAwaitingClientDescriptionEditState(userId);

    if (!state) return;

    const { peerName, clientTelegramId } = state;
    this.setAwaitingClientDescriptionEdit(userId, null);

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
        reply_markup: BotUi.cancelClientEditDescriptionKeyboard(
          peerName,
          clientTelegramId,
        ),
      });
      this.setAwaitingClientDescriptionEdit(userId, {
        peerName,
        clientTelegramId,
        promptMessageId: errorMsg.message_id,
        chatId: ctx.chat.id,
      });
      return;
    }

    try {
      await this.peersService.updatePeerDescription(peerName, newDescription);
      await ctx.reply(BotUi.descriptionUpdated(newDescription), {
        parse_mode: 'Markdown',
        reply_markup: BotUi.backToClientPeerKeyboard(peerName, clientTelegramId),
      });
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      await ctx.reply(BotUi.editDescriptionError(errorMsg), {
        parse_mode: 'Markdown',
        reply_markup: BotUi.backToClientPeerKeyboard(peerName, clientTelegramId),
      });
    }
  }

  async cancelEditDescription(
    ctx: Context,
    peerName: string,
    telegramId: string,
  ) {
    if (!ctx.from) return;
    this.setAwaitingClientDescriptionEdit(String(ctx.from.id), null);
    await this.showClientPeerDetails(ctx, peerName, telegramId);
  }

  // === Создание конфига для клиента ===

  async showCreateConfigOptions(ctx: Context, telegramId: string) {
    await ctx.editMessageText(BotUi.clientCreateConfigTitle(telegramId), {
      parse_mode: 'Markdown',
      reply_markup: BotUi.clientCreateConfigKeyboard(telegramId),
    });
  }

  async createClientConfig(ctx: Context, telegramId: string, duration: string) {
    try {
      // Показываем сообщение о создании
      await ctx.editMessageText('⏳ *Создаю конфигурацию...*', {
        parse_mode: 'Markdown',
      });

      // Определяем срок действия
      const durationDays: SubscriptionDuration | undefined =
        duration === 'unlimited'
          ? undefined
          : (Number(duration) as SubscriptionDuration);

      // Создаем конфиг для клиента
      const { config, peer } = await this.peersService.createPeer({
        telegramId,
        durationDays,
      });

      // Отправляем конфиг клиенту
      try {
        const message = await ctx.api.sendDocument(
          telegramId,
          new InputFile(Buffer.from(config), `${peer.name}.conf`),
          {
            caption: BotUi.memberConfigCreated(peer.name, peer.ip, peer.expiresAt),
            parse_mode: 'Markdown',
          },
        );
        await this.peersService.setConfigMessageId(peer.name, message.message_id);
      } catch (error) {
        this.logger.warn(
          `Не удалось отправить конфиг клиенту ${telegramId}: ${error}`,
        );
      }

      // Уведомляем админа
      await ctx.editMessageText(
        `✅ *Конфиг создан для клиента* \`${telegramId}\`\n\n` +
          `🏷 Имя: \`${peer.name}\`\n` +
          `🌐 IP: \`${peer.ip}\`\n` +
          (peer.expiresAt
            ? `📅 Действует до: ${peer.expiresAt.toLocaleDateString('ru-RU')}`
            : '⏳ Срок: ♾️ Бессрочно'),
        {
          parse_mode: 'Markdown',
          reply_markup: BotUi.backToClientDetailsKeyboard(telegramId),
        },
      );

      await ctx.answerCallbackQuery({ text: 'Конфиг создан' });
    } catch (error) {
      this.logger.error(`Ошибка создания конфига: ${error}`);
      const errorMsg = error instanceof Error ? error.message : String(error);
      await ctx.editMessageText(`❌ *Ошибка:* ${errorMsg}`, {
        parse_mode: 'Markdown',
        reply_markup: BotUi.backToClientDetailsKeyboard(telegramId),
      });
    }
  }
}
