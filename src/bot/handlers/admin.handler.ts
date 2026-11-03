import { forwardRef, Inject, Injectable, Logger } from '@nestjs/common';
import { Context } from 'grammy';
import { resolveTelegramIdInput } from '../utils/resolve-telegram-id';
import { PeersService } from 'src/peers/peers.service';
import { BlockedUsersService } from 'src/blocked/blocked.service';
import { PaymentService } from 'src/payment/payment.service';
import { MainHandler } from './main.handler';
import { BotUi } from '../ui/bot.ui';
import type { SubscriptionDuration } from 'src/peers/dto/create-peer.dto';
import { deletePeerRelatedMessages } from '../utils/delete-peer-messages';
import {
  sendCreatedPeerMessage,
  sendPeerConfigFileMessage,
  sendPeerQrCodeMessage,
} from '../utils/peer-media';
import {
  editPromptMessage,
  safeEditMessageText,
} from '../utils/safe-edit-message';

// Состояние ожидания ввода текста рассылки («Рупор»)
// adminId -> { promptMessageId: number, chatId: number }
const awaitingBroadcastMessage = new Map<
  string,
  { promptMessageId: number; chatId: number }
>();

// Текст рассылки, ожидающий подтверждения
// adminId -> текст сообщения
const pendingBroadcastText = new Map<string, string>();

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

  constructor(
    private readonly peersService: PeersService,
    private readonly blockedUsersService: BlockedUsersService,
    private readonly mainHandler: MainHandler,
    @Inject(forwardRef(() => PaymentService))
    private readonly paymentService: PaymentService,
  ) {}

  // === Панель администратора ===

  async showAdminPanel(ctx: Context) {
    await safeEditMessageText(ctx, BotUi.adminPanelTitle, {
      parse_mode: 'Markdown',
      reply_markup: BotUi.adminPanelKeyboard(),
    });
  }

  // === Параметры (оплата / тестовая оплата) ===

  async showSettings(ctx: Context) {
    const [paymentEnabled, testPayment] = await Promise.all([
      this.paymentService.isPaymentEnabled(),
      this.paymentService.isTestPayment(),
    ]);
    await safeEditMessageText(
      ctx,
      BotUi.adminSettingsTitle(paymentEnabled, testPayment),
      {
        parse_mode: 'Markdown',
        reply_markup: BotUi.adminSettingsKeyboard(paymentEnabled, testPayment),
      },
    );
  }

  async togglePayment(ctx: Context) {
    const current = await this.paymentService.isPaymentEnabled();
    await this.paymentService.setPaymentEnabled(!current);
    this.mainHandler.invalidateAllMainMenuCaches();
    this.logger.log(
      `Приём оплаты переключён админом ${ctx.from ? String(ctx.from.id) : '?'}: ${!current ? 'включён' : 'выключен'}`,
    );
    await this.showSettings(ctx);
  }

  async toggleTestPayment(ctx: Context) {
    if (!(await this.paymentService.isPaymentEnabled())) {
      await ctx.answerCallbackQuery({
        text: BotUi.testPaymentRequiresPaymentAlert,
        show_alert: true,
      });
      await this.showSettings(ctx);
      return;
    }

    const current = await this.paymentService.isTestPayment();
    await this.paymentService.setTestPayment(!current);
    this.logger.log(
      `Тестовая оплата переключена админом ${ctx.from ? String(ctx.from.id) : '?'}: ${!current ? 'включена' : 'выключена'}`,
    );
    await this.showSettings(ctx);
  }

  // === Рупор (рассылка всем пользователям) ===

  isAwaitingBroadcastMessage(userId: string): boolean {
    return awaitingBroadcastMessage.has(userId);
  }

  private setAwaitingBroadcastMessage(
    userId: string,
    state: { promptMessageId: number; chatId: number } | null,
  ) {
    if (state) {
      awaitingBroadcastMessage.set(userId, state);
    } else {
      awaitingBroadcastMessage.delete(userId);
    }
  }

  async showBroadcastPrompt(ctx: Context) {
    if (!ctx.from || !ctx.chat) return;

    const promptMessageId = await safeEditMessageText(
      ctx,
      BotUi.broadcastPrompt,
      {
        parse_mode: 'Markdown',
        reply_markup: BotUi.cancelBroadcastKeyboard(),
      },
    );

    if (promptMessageId != null) {
      this.setAwaitingBroadcastMessage(String(ctx.from.id), {
        promptMessageId,
        chatId: ctx.chat.id,
      });
    }
  }

  async handleBroadcastInput(ctx: Context) {
    if (!ctx.from || !ctx.message?.text || !ctx.chat) return;

    const adminId = String(ctx.from.id);
    const state = awaitingBroadcastMessage.get(adminId);
    this.setAwaitingBroadcastMessage(adminId, null);

    const text = ctx.message.text.trim();

    try {
      await ctx.api.deleteMessage(ctx.chat.id, ctx.message.message_id);
    } catch {
      // Игнорируем ошибку удаления
    }

    const userIds = await this.peersService.getBroadcastUserIds();
    if (userIds.length === 0) {
      await editPromptMessage(ctx, state, BotUi.broadcastEmptyText, {
        parse_mode: 'Markdown',
        reply_markup: BotUi.backToAdminPanelKeyboard(),
      });
      return;
    }

    pendingBroadcastText.set(adminId, text);
    await editPromptMessage(
      ctx,
      state,
      BotUi.broadcastConfirmText(text, userIds.length),
      {
        parse_mode: 'Markdown',
        reply_markup: BotUi.broadcastConfirmKeyboard(),
      },
    );
  }

  async confirmBroadcast(ctx: Context) {
    if (!ctx.from) return;

    const adminId = String(ctx.from.id);
    const text = pendingBroadcastText.get(adminId);
    pendingBroadcastText.delete(adminId);

    if (!text) {
      await safeEditMessageText(
        ctx,
        '❌ Текст рассылки не найден, начните заново',
        { reply_markup: BotUi.backToAdminPanelKeyboard() },
      );
      return;
    }

    await safeEditMessageText(ctx, BotUi.broadcastSendingText, {
      parse_mode: 'Markdown',
    });

    const userIds = await this.peersService.getBroadcastUserIds();
    let sent = 0;
    let failed = 0;
    for (const userId of userIds) {
      try {
        await ctx.api.sendMessage(userId, text);
        sent++;
      } catch (error) {
        failed++;
        this.logger.warn(`Рассылка не доставлена ${userId}: ${error}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }

    this.logger.log(`Рассылка завершена: отправлено ${sent}, ошибок ${failed}`);

    const resultText = BotUi.broadcastResultText(sent, failed);
    await safeEditMessageText(ctx, resultText, {
      parse_mode: 'Markdown',
      reply_markup: BotUi.backToAdminPanelKeyboard(),
    });
  }

  async cancelBroadcast(ctx: Context) {
    if (!ctx.from) return;
    this.setAwaitingBroadcastMessage(String(ctx.from.id), null);
    await this.showAdminPanel(ctx);
  }

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

    const promptMessageId = await safeEditMessageText(
      ctx,
      BotUi.clientSearchPrompt,
      {
        parse_mode: 'Markdown',
        reply_markup: BotUi.cancelClientSearchKeyboard(),
      },
    );

    if (promptMessageId != null) {
      this.setAwaitingClientSearch(String(ctx.from.id), {
        promptMessageId,
        chatId: ctx.chat.id,
      });
    }
  }

  async handleSearchInput(ctx: Context) {
    if (!ctx.from || !ctx.message || !ctx.chat) return;

    const adminId = String(ctx.from.id);
    const state = this.getAwaitingClientSearchState(adminId);
    this.setAwaitingClientSearch(adminId, null);

    const resolved = resolveTelegramIdInput(ctx.message);

    // Удаляем сообщение пользователя
    try {
      await ctx.api.deleteMessage(ctx.chat.id, ctx.message.message_id);
    } catch {
      // Игнорируем ошибку удаления
    }

    if (resolved.kind !== 'id') {
      const text =
        resolved.kind === 'hidden'
          ? BotUi.forwardHiddenUser
          : resolved.kind === 'not_from_user'
            ? BotUi.forwardNotFromUser
            : BotUi.invalidClientIdInput;
      const promptMessageId = await editPromptMessage(ctx, state, text, {
        parse_mode: 'Markdown',
        reply_markup: BotUi.cancelClientSearchKeyboard(),
      });
      this.setAwaitingClientSearch(adminId, {
        promptMessageId,
        chatId: ctx.chat.id,
      });
      return;
    }

    const { telegramId } = resolved;
    // Ищем конфиги клиента (может быть 0)
    const peers = await this.peersService.getPeersByTelegramId(telegramId);
    const isBlocked = await this.blockedUsersService.isBlocked(telegramId);

    // Показываем сообщение "Клиент найден" с кнопкой открыть меню
    // Клиент создаётся как "оболочка" даже если конфигов нет
    await editPromptMessage(
      ctx,
      state,
      BotUi.clientFoundText(telegramId, peers.length, isBlocked),
      {
        parse_mode: 'Markdown',
        reply_markup: BotUi.clientFoundKeyboard(telegramId),
      },
    );
  }

  async cancelSearch(ctx: Context) {
    if (!ctx.from) return;
    this.setAwaitingClientSearch(String(ctx.from.id), null);
    await this.showAdminPanel(ctx);
  }

  // === Статистика ===

  async showStats(ctx: Context) {
    const stats = await this.peersService.getStats();
    await safeEditMessageText(ctx, BotUi.adminStatsText(stats), {
      parse_mode: 'Markdown',
      reply_markup: BotUi.adminStatsKeyboard(),
    });
  }

  // === Аналитика конфигов ===

  async showAnalytics(ctx: Context) {
    await safeEditMessageText(ctx, BotUi.analyticsMenuTitle, {
      parse_mode: 'Markdown',
      reply_markup: BotUi.analyticsMenuKeyboard(),
    });
  }

  async showAnalyticsOverview(ctx: Context) {
    try {
      const analytics = await this.peersService.getAnalytics();
      await safeEditMessageText(
        ctx,
        BotUi.analyticsOverviewText(analytics.stats),
        {
          parse_mode: 'Markdown',
          reply_markup: BotUi.backToAnalyticsKeyboard(),
        },
      );
    } catch (error) {
      this.logger.error(`Ошибка показа сводки аналитики: ${error}`);
      await ctx.answerCallbackQuery({
        text: 'Ошибка загрузки',
        show_alert: true,
      });
    }
  }

  async showAnalyticsDuration(ctx: Context) {
    try {
      const analytics = await this.peersService.getAnalytics();
      await safeEditMessageText(
        ctx,
        BotUi.analyticsByDurationText(analytics.byDuration),
        {
          parse_mode: 'Markdown',
          reply_markup: BotUi.backToAnalyticsKeyboard(),
        },
      );
    } catch (error) {
      this.logger.error(`Ошибка показа аналитики по срокам: ${error}`);
      await ctx.answerCallbackQuery({
        text: 'Ошибка загрузки',
        show_alert: true,
      });
    }
  }

  async showAnalyticsTrial(ctx: Context) {
    try {
      const analytics = await this.peersService.getAnalytics();
      await safeEditMessageText(
        ctx,
        BotUi.analyticsTrialText(analytics.stats.trialConfigs),
        {
          parse_mode: 'Markdown',
          reply_markup: BotUi.backToAnalyticsKeyboard(),
        },
      );
    } catch (error) {
      this.logger.error(`Ошибка показа пробных конфигов: ${error}`);
      await ctx.answerCallbackQuery({
        text: 'Ошибка загрузки',
        show_alert: true,
      });
    }
  }

  async showAnalyticsRecent(ctx: Context) {
    try {
      const analytics = await this.peersService.getAnalytics();
      await safeEditMessageText(
        ctx,
        BotUi.analyticsRecentText(analytics.recentConfigs),
        {
          parse_mode: 'Markdown',
          reply_markup: BotUi.backToAnalyticsKeyboard(),
        },
      );
    } catch (error) {
      this.logger.error(`Ошибка показа последних конфигов: ${error}`);
      await ctx.answerCallbackQuery({
        text: 'Ошибка загрузки',
        show_alert: true,
      });
    }
  }

  async showAnalyticsExpiring(ctx: Context) {
    try {
      const analytics = await this.peersService.getAnalytics();
      await safeEditMessageText(
        ctx,
        BotUi.analyticsExpiringText(analytics.expiringSoon),
        {
          parse_mode: 'Markdown',
          reply_markup: BotUi.backToAnalyticsKeyboard(),
        },
      );
    } catch (error) {
      this.logger.error(`Ошибка показа истекающих конфигов: ${error}`);
      await ctx.answerCallbackQuery({
        text: 'Ошибка загрузки',
        show_alert: true,
      });
    }
  }

  // === Управление клиентом ===

  async showClientDetails(ctx: Context, telegramId: string) {
    const [peers, isBlocked, hasUsedDiscount] = await Promise.all([
      this.peersService.getPeersByTelegramId(telegramId),
      this.blockedUsersService.isBlocked(telegramId),
      this.peersService.hasUsedFirstPurchaseDiscount(telegramId),
    ]);

    await safeEditMessageText(
      ctx,
      BotUi.clientDetailsText(
        telegramId,
        peers.length,
        isBlocked,
        hasUsedDiscount,
      ),
      {
        parse_mode: 'Markdown',
        reply_markup: BotUi.clientDetailsKeyboard(
          telegramId,
          peers,
          isBlocked,
          hasUsedDiscount,
        ),
      },
    );
  }

  // === Сброс скидки на первую покупку ===

  async resetClientDiscount(ctx: Context, telegramId: string) {
    try {
      await this.peersService.resetPromoUsage(telegramId);
      this.logger.log(
        `Скидка на первую покупку сброшена для ${telegramId} админом ${ctx.from ? String(ctx.from.id) : '?'}`,
      );
      await this.showClientDetails(ctx, telegramId);
    } catch (error) {
      this.logger.error(`Ошибка сброса скидки: ${error}`);
      try {
        await ctx.answerCallbackQuery({
          text: 'Ошибка сброса скидки',
          show_alert: true,
        });
      } catch {
        // Игнорируем если callback уже был отвечен
      }
    }
  }

  // === Удаление всех конфигов клиента ===

  async deleteAllClientPeers(ctx: Context, telegramId: string) {
    try {
      const peers = await this.peersService.getPeersByTelegramId(telegramId);
      if (peers.length === 0) {
        await this.showClientDetails(ctx, telegramId);
        return;
      }

      // Связанные сообщения удаляем в фоне (не блокируя отрисовку меню):
      // часть из них может быть старше 48 ч и боту недоступна для удаления.
      for (const peer of peers) {
        void deletePeerRelatedMessages(ctx.api, peer.telegramId, [
          peer.configMessageId,
          peer.qrMessageId,
          peer.fileMessageId,
        ]);
      }

      await this.peersService.deletePeersByNames(peers.map((p) => p.name));
      this.logger.log(
        `Удалены все конфиги клиента ${telegramId} (${peers.length}) админом ${ctx.from ? String(ctx.from.id) : '?'}`,
      );
      await this.showClientDetails(ctx, telegramId);
    } catch (error) {
      this.logger.error(`Ошибка удаления всех конфигов клиента: ${error}`);
      try {
        await ctx.answerCallbackQuery({
          text: 'Ошибка удаления конфигов',
          show_alert: true,
        });
      } catch {
        // Игнорируем если callback уже был отвечен
      }
    }
  }

  // === Бан-лист ===

  async showBlockedList(ctx: Context) {
    const blocked = await this.blockedUsersService.getAllBlocked();
    await safeEditMessageText(ctx, BotUi.blockedListTitle(blocked.length), {
      parse_mode: 'Markdown',
      reply_markup: BotUi.blockedListKeyboard(blocked),
    });
  }

  // === Блокировка/Разблокировка ===

  async blockClient(ctx: Context, telegramId: string) {
    if (!ctx.from) return;

    try {
      await this.blockedUsersService.blockUser(telegramId, String(ctx.from.id));
      this.logger.log(
        `Клиент ${telegramId} заблокирован админом ${ctx.from.id}`,
      );

      const peers = await this.peersService.getPeersByTelegramId(telegramId);
      for (const peer of peers) {
        try {
          const chatId = peer.telegramId;
          for (const messageId of [
            peer.configMessageId,
            peer.qrMessageId,
            peer.fileMessageId,
          ]) {
            if (messageId != null) {
              try {
                await ctx.api.deleteMessage(chatId, messageId);
              } catch {
                // Игнорируем ошибки удаления сообщений (чат мог быть удалён и т.д.)
              }
            }
          }
          await this.peersService.deletePeer(peer.name);
        } catch (error) {
          this.logger.warn(
            `Ошибка удаления конфига ${peer.name} при блокировке: ${error}`,
          );
        }
      }

      await this.showClientDetails(ctx, telegramId);
    } catch (error) {
      this.logger.error(`Ошибка блокировки: ${error}`);
      try {
        await ctx.answerCallbackQuery({
          text: error instanceof Error ? error.message : 'Ошибка блокировки',
          show_alert: true,
        });
      } catch {
        // Игнорируем если callback уже был отвечен
      }
    }
  }

  async unblockClient(ctx: Context, telegramId: string) {
    try {
      await this.blockedUsersService.unblockUser(telegramId);
      this.logger.log(`Клиент ${telegramId} разблокирован`);
      await this.showClientDetails(ctx, telegramId);
    } catch (error) {
      this.logger.error(`Ошибка разблокировки: ${error}`);
      try {
        await ctx.answerCallbackQuery({
          text: 'Ошибка разблокировки',
          show_alert: true,
        });
      } catch {
        // Игнорируем если callback уже был отвечен
      }
    }
  }

  async showClientConfigs(ctx: Context, telegramId: string) {
    const peers = await this.peersService.getPeersByTelegramId(telegramId);

    await safeEditMessageText(
      ctx,
      BotUi.clientConfigsListTitle(telegramId, peers.length),
      {
        parse_mode: 'Markdown',
        reply_markup: BotUi.clientConfigsListKeyboard(peers, telegramId),
      },
    );
  }

  async showClientPeerDetails(
    ctx: Context,
    peerName: string,
    telegramId: string,
  ) {
    // Ошибку поиска конфига отделяем от ошибки отрисовки: раньше общий catch
    // на «not modified» показывал ложное «Конфиг не найден» и выбрасывал
    // администратора из карточки.
    let peer;
    try {
      peer = await this.peersService.findPeer(peerName);
    } catch {
      try {
        await ctx.answerCallbackQuery({
          text: 'Конфиг не найден',
          show_alert: true,
        });
      } catch {
        // Игнорируем если callback уже был отвечен
      }
      await this.showClientDetails(ctx, telegramId);
      return;
    }

    await safeEditMessageText(ctx, BotUi.clientPeerDetailsText(peer), {
      reply_markup: BotUi.clientPeerDetailsKeyboard(peer, telegramId),
      parse_mode: 'Markdown',
    });
  }

  // === QR-код и файл конфига клиента ===

  async showClientQrCode(ctx: Context, peerName: string) {
    await sendPeerQrCodeMessage(ctx, this.peersService, peerName, this.logger);
  }

  async sendClientConfigFile(ctx: Context, peerName: string) {
    await sendPeerConfigFileMessage(
      ctx,
      this.peersService,
      peerName,
      this.logger,
    );
  }

  async toggleClientPeer(ctx: Context, peerName: string, telegramId: string) {
    try {
      await this.peersService.updatedPeer(peerName);
      await this.showClientPeerDetails(ctx, peerName, telegramId);
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

  async deleteClientPeer(ctx: Context, peerName: string, telegramId: string) {
    try {
      const peer = await this.peersService.findPeer(peerName);

      // Связанные сообщения удаляем в фоне (не блокируя отрисовку меню):
      // часть из них может быть старше 48 ч и боту недоступна для удаления.
      void deletePeerRelatedMessages(ctx.api, peer.telegramId, [
        peer.configMessageId,
        peer.qrMessageId,
        peer.fileMessageId,
      ]);

      await this.peersService.deletePeer(peerName);
      await this.showClientDetails(ctx, telegramId);
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

  // === Изменение срока действия ===

  async showChangeDuration(ctx: Context, peerName: string, telegramId: string) {
    await safeEditMessageText(ctx, BotUi.changeDurationTitle, {
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
      await this.showClientPeerDetails(ctx, peerName, telegramId);
    } catch (error) {
      this.logger.error(`Ошибка изменения срока: ${error}`);
      try {
        await ctx.answerCallbackQuery({
          text: 'Ошибка изменения срока',
          show_alert: true,
        });
      } catch {
        // Игнорируем если callback уже был отвечен
      }
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
      const promptMessageId = await safeEditMessageText(
        ctx,
        BotUi.editDescriptionPrompt(peer),
        {
          parse_mode: 'Markdown',
          reply_markup: BotUi.cancelClientEditDescriptionKeyboard(
            peerName,
            telegramId,
          ),
        },
      );

      if (promptMessageId != null) {
        this.setAwaitingClientDescriptionEdit(String(ctx.from!.id), {
          peerName,
          clientTelegramId: telegramId,
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

    // Проверка на удаление описания
    const newDescription = input === '-' ? null : input;

    // Валидация длины
    if (newDescription && newDescription.length > 200) {
      const promptMessageId = await editPromptMessage(
        ctx,
        state,
        BotUi.invalidDescriptionInput,
        {
          parse_mode: 'Markdown',
          reply_markup: BotUi.cancelClientEditDescriptionKeyboard(
            peerName,
            clientTelegramId,
          ),
        },
      );
      this.setAwaitingClientDescriptionEdit(userId, {
        peerName,
        clientTelegramId,
        promptMessageId,
        chatId: ctx.chat.id,
      });
      return;
    }

    try {
      await this.peersService.updatePeerDescription(peerName, newDescription);
      await editPromptMessage(
        ctx,
        state,
        BotUi.descriptionUpdated(newDescription),
        {
          parse_mode: 'Markdown',
          reply_markup: BotUi.backToClientPeerKeyboard(
            peerName,
            clientTelegramId,
          ),
        },
      );
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      await editPromptMessage(
        ctx,
        state,
        BotUi.editDescriptionError(errorMsg),
        {
          parse_mode: 'Markdown',
          reply_markup: BotUi.backToClientPeerKeyboard(
            peerName,
            clientTelegramId,
          ),
        },
      );
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
    await safeEditMessageText(ctx, BotUi.clientCreateConfigTitle(telegramId), {
      parse_mode: 'Markdown',
      reply_markup: BotUi.clientCreateConfigKeyboard(telegramId),
    });
  }

  async createClientConfig(ctx: Context, telegramId: string, duration: string) {
    try {
      // Показываем сообщение о создании
      await safeEditMessageText(ctx, '⏳ *Создаю конфигурацию...*', {
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
        const message = await sendCreatedPeerMessage(
          ctx.api,
          telegramId,
          this.peersService,
          peer,
          config,
          BotUi.memberConfigCreated(peer.name, peer.ip, peer.expiresAt),
          this.mainHandler.isAdmin(telegramId),
        );
        await this.peersService.setConfigMessageId(
          peer.name,
          message.message_id,
        );
      } catch (error) {
        this.logger.warn(
          `Не удалось отправить конфиг клиенту ${telegramId}: ${error}`,
        );
      }

      // Уведомляем админа
      await safeEditMessageText(
        ctx,
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
    } catch (error) {
      this.logger.error(`Ошибка создания конфига: ${error}`);
      const errorMsg = error instanceof Error ? error.message : String(error);
      await safeEditMessageText(ctx, `❌ *Ошибка:* ${errorMsg}`, {
        parse_mode: 'Markdown',
        reply_markup: BotUi.backToClientDetailsKeyboard(telegramId),
      });
    }
  }
}
