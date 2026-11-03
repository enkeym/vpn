import { Injectable, Logger } from '@nestjs/common';
import { Context, InputFile } from 'grammy';
import { PeersService } from 'src/peers/peers.service';
import { BotUi } from '../ui/bot.ui';
import {
  editPromptMessage,
  safeEditMessageText,
} from '../utils/safe-edit-message';
import {
  closeMediaMessage,
  sendCreatedPeerMessage,
  sendPeerConfigFileMessage,
  sendPeerQrCodeMessage,
} from '../utils/peer-media';
import { MainHandler } from './main.handler';
import { SubscriptionService } from 'src/subscription/subscription.service';

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
    private readonly subscriptionService: SubscriptionService,
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
          this.peersService.isXrayAvailable(),
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
          this.peersService.isXrayAvailable(),
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
          reply_markup: BotUi.cancelEditOwnDescriptionKeyboard(peerName),
        },
      );
      this.setAwaitingDescriptionEdit(userId, {
        peerName,
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
          reply_markup: BotUi.backToOwnPeerKeyboard(peerName),
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
          reply_markup: BotUi.backToOwnPeerKeyboard(peerName),
        },
      );
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
    if (!ctx.from || !this.mainHandler.isAdmin(String(ctx.from.id))) {
      return this.showVlessQrCode(ctx, peerName);
    }
    await sendPeerQrCodeMessage(ctx, this.peersService, peerName, this.logger);
  }

  // === Получить файл конфига ===

  async sendConfigFile(ctx: Context, peerName: string) {
    if (!ctx.from || !this.mainHandler.isAdmin(String(ctx.from.id))) {
      return this.showVlessMenu(ctx, peerName);
    }
    await sendPeerConfigFileMessage(
      ctx,
      this.peersService,
      peerName,
      this.logger,
    );
  }

  // === Второй канал: VLESS (Xray) ===

  /**
   * Ссылка-подписка и прямые ссылки отдельным сообщением поверх карточки
   * конфига — как QR и .conf. Одна и та же кнопка работает из всех веток меню
   * (свои конфиги, «Семья», карточка клиента у админа), потому что ничего
   * не редактирует и не знает про контекст вызова.
   */
  async showVlessMenu(ctx: Context, peerName: string) {
    if (!ctx.chat) return;

    if (!this.peersService.isXrayAvailable()) {
      await ctx.reply(BotUi.vlessUnavailable, {
        parse_mode: 'Markdown',
        reply_markup: BotUi.closeMediaKeyboard(),
      });
      return;
    }

    try {
      const body = await this.peersService.getPeerVlessText(peerName);

      await ctx.reply(BotUi.vlessMenuText(peerName, body), {
        parse_mode: 'Markdown',
        link_preview_options: { is_disabled: true },
        reply_markup: BotUi.vlessMenuKeyboard(
          peerName,
          this.peersService.isSubscriptionAvailable(),
        ),
      });
    } catch (error) {
      this.logger.error(`Ошибка выдачи VLESS: ${error}`);
      await ctx
        .answerCallbackQuery({
          text: 'Не удалось собрать ссылки VLESS',
          show_alert: true,
        })
        .catch(() => {});
    }
  }

  /** QR со ссылкой-подпиской — для Hiddify, NekoBox, v2rayNG, Streisand. */
  async showVlessQrCode(ctx: Context, peerName: string) {
    await this.sendVlessQr(
      ctx,
      peerName,
      () => this.peersService.generatePeerVlessQrCode(peerName),
      `${peerName}_vless_qr.png`,
      `📷 *QR — VLESS* \`${peerName}\`\n\n` +
        '_Отсканируйте в Hiddify / NekoBox / v2rayNG / Streisand_',
    );
  }

  /**
   * QR для официального sing-box (SFA/SFI/SFM): его сканер не принимает
   * обычную https-ссылку за профиль — нужен deep-link его схемы.
   */
  async showVlessSingBoxQrCode(ctx: Context, peerName: string) {
    await this.sendVlessQr(
      ctx,
      peerName,
      () => this.peersService.generatePeerSingBoxQrCode(peerName),
      `${peerName}_singbox_qr.png`,
      `📷 *QR для sing-box* \`${peerName}\`\n\n` +
        '_Только для официального приложения sing-box (SFA/SFI/SFM) — оно уже должно ' +
        'быть установлено. В остальных клиентах берите обычный «📷 QR-код»._',
    );
  }

  /** Общая отправка QR: разница между двумя кнопками — только в содержимом. */
  private async sendVlessQr(
    ctx: Context,
    peerName: string,
    generate: () => Promise<Buffer>,
    fileName: string,
    caption: string,
  ) {
    if (!ctx.chat) return;

    try {
      const qrBuffer = await generate();

      await ctx.replyWithPhoto(new InputFile(qrBuffer, fileName), {
        caption,
        parse_mode: 'Markdown',
        reply_markup: BotUi.closeMediaKeyboard(),
      });
    } catch (error) {
      this.logger.error(`Ошибка генерации QR VLESS для ${peerName}: ${error}`);
      await ctx
        .answerCallbackQuery({
          text: 'Ошибка генерации QR-кода',
          show_alert: true,
        })
        .catch(() => {});
    }
  }

  /**
   * Готовый sing-box конфиг файлом (.json). Нужен, когда домен подписки
   * травят по DNS и «Удалённый» профиль в клиенте не скачивается — файл
   * добавляется как «Локальный», в обход резолвинга по URL.
   */
  async sendVlessJsonFile(ctx: Context, peerName: string) {
    if (!ctx.chat) return;

    try {
      const peer = await this.peersService.findPeer(peerName);
      const config = this.subscriptionService.buildFullSingBoxConfig(peer);
      const fileBuffer = Buffer.from(JSON.stringify(config, null, 2), 'utf-8');

      await ctx.replyWithDocument(
        new InputFile(fileBuffer, `${peer.name}.json`),
        {
          caption:
            `📥 *Файл конфига sing-box* \`${peer.name}\`\n\n` +
            'Для официального *sing-box*: создайте профиль с типом ' +
            '*«Локальный»* и импортируйте этот файл. Помогает, когда ' +
            '«Удалённый» профиль виснет на обновлении.',
          parse_mode: 'Markdown',
          reply_markup: BotUi.closeMediaKeyboard(),
        },
      );
    } catch (error) {
      this.logger.error(`Ошибка отправки sing-box конфига: ${error}`);
      await ctx
        .answerCallbackQuery({
          text: 'Ошибка формирования файла конфига',
          show_alert: true,
        })
        .catch(() => {});
    }
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
      await sendCreatedPeerMessage(
        ctx.api,
        ctx.chat.id,
        this.peersService,
        newPeer,
        config,
        BotUi.configReplaced(newPeer.name, newPeer.ip, newPeer.expiresAt),
        !!ctx.from && this.mainHandler.isAdmin(String(ctx.from.id)),
        BotUi.backToOwnPeerKeyboardReplyAfterReplace(peerName),
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
