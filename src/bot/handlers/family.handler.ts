import { Injectable, Logger } from '@nestjs/common';
import { Context, InputFile } from 'grammy';
import { FamilyService } from 'src/family/family.service';
import { PeersService } from 'src/peers/peers.service';
import { BotUi } from '../ui/bot.ui';
import type { SubscriptionDuration } from 'src/peers/dto/create-peer.dto';
import { deletePeerRelatedMessages } from '../utils/delete-peer-messages';

// Состояние ожидания ввода для добавления члена группы
// userId -> { promptMessageId: number, chatId: number }
const awaitingFamilyInput = new Map<
  string,
  { promptMessageId: number; chatId: number }
>();
// Состояние ожидания ввода для редактирования имени
// userId -> { memberId: string, promptMessageId: number, chatId: number }
const awaitingNameEdit = new Map<
  string,
  { memberId: string; promptMessageId: number; chatId: number }
>();
// Состояние ожидания ввода для редактирования описания конфига
// userId -> { peerName: string, memberId: string, promptMessageId: number, chatId: number }
const awaitingDescriptionEdit = new Map<
  string,
  {
    peerName: string;
    memberId: string;
    promptMessageId: number;
    chatId: number;
  }
>();

@Injectable()
export class FamilyHandler {
  private readonly logger = new Logger(FamilyHandler.name);

  constructor(
    private readonly familyService: FamilyService,
    private readonly peersService: PeersService,
  ) {}

  isAwaitingInput(userId: string): boolean {
    return awaitingFamilyInput.has(userId);
  }

  getAwaitingInputState(userId: string) {
    return awaitingFamilyInput.get(userId);
  }

  setAwaitingInput(
    userId: string,
    state: { promptMessageId: number; chatId: number } | null,
  ) {
    if (state) {
      awaitingFamilyInput.set(userId, state);
    } else {
      awaitingFamilyInput.delete(userId);
    }
  }

  isAwaitingNameEdit(userId: string): boolean {
    return awaitingNameEdit.has(userId);
  }

  getAwaitingNameEditState(userId: string) {
    return awaitingNameEdit.get(userId);
  }

  setAwaitingNameEdit(
    userId: string,
    state: { memberId: string; promptMessageId: number; chatId: number } | null,
  ) {
    if (state) {
      awaitingNameEdit.set(userId, state);
    } else {
      awaitingNameEdit.delete(userId);
    }
  }

  isAwaitingDescriptionEdit(userId: string): boolean {
    return awaitingDescriptionEdit.has(userId);
  }

  getAwaitingDescriptionEditState(userId: string) {
    return awaitingDescriptionEdit.get(userId);
  }

  setAwaitingDescriptionEdit(
    userId: string,
    state: {
      peerName: string;
      memberId: string;
      promptMessageId: number;
      chatId: number;
    } | null,
  ) {
    if (state) {
      awaitingDescriptionEdit.set(userId, state);
    } else {
      awaitingDescriptionEdit.delete(userId);
    }
  }

  async showAddMemberPrompt(ctx: Context) {
    if (!ctx.from || !ctx.chat) return;

    const result = await ctx.editMessageText(BotUi.addMemberPrompt, {
      parse_mode: 'Markdown',
      reply_markup: BotUi.cancelKeyboard(),
    });

    if (result && typeof result === 'object' && 'message_id' in result) {
      this.setAwaitingInput(String(ctx.from.id), {
        promptMessageId: result.message_id,
        chatId: ctx.chat.id,
      });
    }
  }

  /**
   * Пересланное сообщение от пользователя (не канал/чат), с учётом скрытого профиля и совпадения с админом.
   */
  private resolveForwardedMemberTelegramId(
    message: NonNullable<Context['message']>,
    adminId: string,
  ):
    | { kind: 'id'; telegramId: string }
    | { kind: 'admin_self' }
    | { kind: 'hidden' }
    | { kind: 'not_from_user' }
    | { kind: 'none' } {
    const origin = message.forward_origin;
    if (origin) {
      if (origin.type === 'user') {
        const id = String(origin.sender_user.id);
        if (id === adminId) return { kind: 'admin_self' };
        return { kind: 'id', telegramId: id };
      }
      if (origin.type === 'hidden_user') {
        return { kind: 'hidden' };
      }
      return { kind: 'not_from_user' };
    }
    const legacyFrom = (message as { forward_from?: { id: number } })
      .forward_from;
    if (legacyFrom) {
      const id = String(legacyFrom.id);
      if (id === adminId) return { kind: 'admin_self' };
      return { kind: 'id', telegramId: id };
    }
    return { kind: 'none' };
  }

  private async rearmAddMemberPrompt(
    ctx: Context,
    adminId: string,
    text: string,
  ) {
    const errorMsg = await ctx.reply(text, {
      parse_mode: 'Markdown',
      reply_markup: BotUi.cancelKeyboard(),
    });
    this.setAwaitingInput(adminId, {
      promptMessageId: errorMsg.message_id,
      chatId: ctx.chat!.id,
    });
  }

  async handleAddMemberInput(ctx: Context) {
    if (!ctx.from || !ctx.message || !ctx.chat) return;

    const adminId = String(ctx.from.id);
    const state = this.getAwaitingInputState(adminId);
    this.setAwaitingInput(adminId, null);
    const message = ctx.message;

    // Удаляем сообщение пользователя
    try {
      await ctx.api.deleteMessage(ctx.chat.id, message.message_id);
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

    const forwarded = this.resolveForwardedMemberTelegramId(message, adminId);

    if (forwarded.kind === 'admin_self') {
      await this.rearmAddMemberPrompt(ctx, adminId, BotUi.cannotAddAdminSelf);
      return;
    }
    if (forwarded.kind === 'hidden') {
      await this.rearmAddMemberPrompt(ctx, adminId, BotUi.forwardHiddenUser);
      return;
    }
    if (forwarded.kind === 'not_from_user') {
      await this.rearmAddMemberPrompt(ctx, adminId, BotUi.forwardNotFromUser);
      return;
    }

    let telegramId: string | undefined;
    if (forwarded.kind === 'id') {
      telegramId = forwarded.telegramId;
    } else {
      const input = message.text?.trim();
      if (!input || !/^\d+$/.test(input)) {
        await this.rearmAddMemberPrompt(ctx, adminId, BotUi.invalidInput);
        return;
      }
      telegramId = input;
    }

    try {
      const member = await this.familyService.addMember(adminId, telegramId);
      await ctx.reply(BotUi.memberAdded(member), {
        parse_mode: 'Markdown',
        reply_markup: BotUi.backToFamilyKeyboard(),
      });
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      await ctx.reply(BotUi.addMemberError(errorMsg), {
        parse_mode: 'Markdown',
        reply_markup: BotUi.backToFamilyKeyboard(),
      });
    }
  }

  async cancelAddMember(ctx: Context) {
    if (!ctx.from) return;
    this.setAwaitingInput(String(ctx.from.id), null);
    await this.showFamilyMenu(ctx);
  }

  async showFamilyMenu(ctx: Context) {
    if (!ctx.from) return;

    const adminId = String(ctx.from.id);
    const members = await this.familyService.getMembersByAdmin(adminId);

    try {
      await ctx.editMessageText(BotUi.familyMenuTitle(members.length), {
        parse_mode: 'Markdown',
        reply_markup: BotUi.familyMenuKeyboard(members),
      });
    } catch {
      await ctx.reply(BotUi.familyMenuTitle(members.length), {
        parse_mode: 'Markdown',
        reply_markup: BotUi.familyMenuKeyboard(members),
      });
    }
  }

  async showMemberDetails(ctx: Context, memberId: string) {
    if (!(await this.checkOwnership(ctx, memberId))) return;

    try {
      const member = await this.familyService.findMemberById(memberId);
      const peers = await this.peersService.getPeersByTelegramId(
        member.telegramId,
      );

      await ctx.editMessageText(BotUi.memberDetailsText(member, peers.length), {
        parse_mode: 'Markdown',
        reply_markup: BotUi.memberDetailsKeyboard(member, peers),
      });
    } catch {
      await ctx.answerCallbackQuery({
        text: 'Член группы не найден',
        show_alert: true,
      });
      await this.showFamilyMenu(ctx);
    }
  }

  async showMemberConfigs(ctx: Context, memberId: string) {
    if (!(await this.checkOwnership(ctx, memberId))) return;

    try {
      const member = await this.familyService.findMemberById(memberId);

      const peers = await this.peersService.getPeersByTelegramId(
        member.telegramId,
      );

      const displayName = this.familyService.getDisplayName(member);

      await ctx.editMessageText(BotUi.memberConfigsListTitle(displayName), {
        parse_mode: 'Markdown',
        reply_markup: BotUi.memberConfigsListKeyboard(peers, member.id),
      });
    } catch {
      await ctx.answerCallbackQuery({
        text: 'Ошибка загрузки конфигов',
        show_alert: true,
      });
    }
  }

  private async checkOwnership(
    ctx: Context,
    memberId: string,
  ): Promise<boolean> {
    if (!ctx.from) return false;

    const adminId = String(ctx.from.id);
    const isOwner = await this.familyService.isMemberOwnedByAdmin(
      memberId,
      adminId,
    );

    if (!isOwner) {
      try {
        await ctx.answerCallbackQuery({
          text: 'Нет доступа к этому участнику',
          show_alert: true,
        });
      } catch {
        // Игнорируем если callback уже был отвечен
      }
    }

    return isOwner;
  }

  async showMemberPeerDetails(
    ctx: Context,
    peerName: string,
    memberId: string,
  ) {
    if (!(await this.checkOwnership(ctx, memberId))) return;

    let peer;
    let member;
    try {
      peer = await this.peersService.findPeer(peerName);
      member = await this.familyService.findMemberById(memberId);
    } catch (error) {
      this.logger.error(`Конфиг/член не найден: ${peerName}, ошибка: ${error}`);
      await ctx.answerCallbackQuery({
        text: 'Конфиг не найден',
        show_alert: true,
      });
      await this.showMemberDetails(ctx, memberId);
      return;
    }

    try {
      await ctx.editMessageText(BotUi.memberPeerDetailsText(peer), {
        reply_markup: BotUi.memberPeerDetailsKeyboard(peer, member.id),
        parse_mode: 'Markdown',
      });
    } catch (error) {
      this.logger.error(`Ошибка editMessageText для ${peerName}: ${error}`);
      // Попробуем отправить новое сообщение вместо редактирования
      try {
        await ctx.reply(BotUi.memberPeerDetailsText(peer), {
          reply_markup: BotUi.memberPeerDetailsKeyboard(peer, member.id),
          parse_mode: 'Markdown',
        });
      } catch (replyError) {
        this.logger.error(`Ошибка reply для ${peerName}: ${replyError}`);
        await ctx.answerCallbackQuery({
          text: 'Ошибка отображения конфига',
          show_alert: true,
        });
      }
    }
  }

  async toggleMemberPeer(ctx: Context, peerName: string, memberId: string) {
    if (!(await this.checkOwnership(ctx, memberId))) return;

    try {
      await this.peersService.updatedPeer(peerName);
      await this.showMemberPeerDetails(ctx, peerName, memberId);
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

  async deleteMemberPeer(ctx: Context, peerName: string, memberId: string) {
    if (!(await this.checkOwnership(ctx, memberId))) return;

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
      await this.showMemberDetails(ctx, memberId);
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

  async removeMember(ctx: Context, memberId: string) {
    if (!(await this.checkOwnership(ctx, memberId))) return;

    try {
      const member = await this.familyService.findMemberById(memberId);

      // Удаляем все конфиги члена группы
      const peers = await this.peersService.getPeersByTelegramId(
        member.telegramId,
      );

      // Связанные сообщения удаляем в фоне (часть может быть старше 48 ч).
      for (const peer of peers) {
        void deletePeerRelatedMessages(ctx.api, peer.telegramId, [
          peer.configMessageId,
          peer.qrMessageId,
          peer.fileMessageId,
        ]);
      }

      // Батч-удаление: один DELETE в БД и один `wg syncconf` на все конфиги.
      if (peers.length > 0) {
        await this.peersService.deletePeersByNames(peers.map((p) => p.name));
      }

      await this.familyService.removeMemberById(memberId);
      await this.showFamilyMenu(ctx);
    } catch (error) {
      this.logger.error(`Ошибка удаления члена группы: ${error}`);
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

  async showChangeDuration(ctx: Context, peerName: string, memberId: string) {
    if (!(await this.checkOwnership(ctx, memberId))) return;

    try {
      const member = await this.familyService.findMemberById(memberId);
      await ctx.editMessageText(BotUi.changeDurationTitle, {
        parse_mode: 'Markdown',
        reply_markup: BotUi.changeDurationKeyboard(peerName, member.id),
      });
    } catch {
      await ctx.answerCallbackQuery({
        text: 'Член группы не найден',
        show_alert: true,
      });
    }
  }

  async changePeerDuration(
    ctx: Context,
    peerName: string,
    memberId: string,
    duration: string,
  ) {
    if (!(await this.checkOwnership(ctx, memberId))) return;

    try {
      // Проверяем что пир существует
      await this.peersService.findPeer(peerName);

      let newExpiresAt: Date | null = null;
      if (duration !== 'unlimited') {
        const days = parseInt(duration, 10);
        newExpiresAt = new Date(Date.now() + days * 24 * 60 * 60 * 1000);
      }

      await this.peersService.updatePeerExpiration(peerName, newExpiresAt);
      await this.showMemberPeerDetails(ctx, peerName, memberId);
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

  // === Редактирование имени участника ===

  async showEditNamePrompt(ctx: Context, memberId: string) {
    if (!(await this.checkOwnership(ctx, memberId))) return;
    if (!ctx.chat) return;

    try {
      const member = await this.familyService.findMemberById(memberId);
      const result = await ctx.editMessageText(BotUi.editNamePrompt(member), {
        parse_mode: 'Markdown',
        reply_markup: BotUi.cancelEditNameKeyboard(member.id),
      });

      // Сохраняем ID prompt-сообщения для последующего удаления
      if (result && typeof result === 'object' && 'message_id' in result) {
        this.setAwaitingNameEdit(String(ctx.from!.id), {
          memberId: member.id,
          promptMessageId: result.message_id,
          chatId: ctx.chat.id,
        });
      }
    } catch {
      await ctx.answerCallbackQuery({
        text: 'Член группы не найден',
        show_alert: true,
      });
    }
  }

  async handleEditNameInput(ctx: Context) {
    if (!ctx.from || !ctx.message?.text || !ctx.chat) return;

    const userId = String(ctx.from.id);
    const state = this.getAwaitingNameEditState(userId);

    if (!state) return;

    const { memberId } = state;
    this.setAwaitingNameEdit(userId, null);

    const newName = ctx.message.text.trim();

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

    if (newName.length < 1 || newName.length > 50) {
      const errorMsg = await ctx.reply(BotUi.invalidNameInput, {
        parse_mode: 'Markdown',
        reply_markup: BotUi.cancelEditNameKeyboard(memberId),
      });
      // Сохраняем новое prompt-сообщение для повторной попытки
      this.setAwaitingNameEdit(userId, {
        memberId,
        promptMessageId: errorMsg.message_id,
        chatId: ctx.chat.id,
      });
      return;
    }

    try {
      await this.familyService.updateDisplayName(memberId, newName);
      await ctx.reply(BotUi.nameUpdated(newName), {
        parse_mode: 'Markdown',
        reply_markup: BotUi.backToMemberKeyboard(memberId),
      });
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      await ctx.reply(BotUi.editNameError(errorMsg), {
        parse_mode: 'Markdown',
        reply_markup: BotUi.backToMemberKeyboard(memberId),
      });
    }
  }

  async cancelEditName(ctx: Context, memberId: string) {
    if (!ctx.from) return;
    this.setAwaitingNameEdit(String(ctx.from.id), null);
    await this.showMemberDetails(ctx, memberId);
  }

  // === Редактирование описания конфига ===

  async showEditDescriptionPrompt(
    ctx: Context,
    peerName: string,
    memberId: string,
  ) {
    if (!(await this.checkOwnership(ctx, memberId))) return;
    if (!ctx.chat) return;

    try {
      const peer = await this.peersService.findPeer(peerName);
      const member = await this.familyService.findMemberById(memberId);
      const result = await ctx.editMessageText(
        BotUi.editDescriptionPrompt(peer),
        {
          parse_mode: 'Markdown',
          reply_markup: BotUi.cancelEditDescriptionKeyboard(
            peerName,
            member.id,
          ),
        },
      );

      // Сохраняем ID prompt-сообщения для последующего удаления
      if (result && typeof result === 'object' && 'message_id' in result) {
        this.setAwaitingDescriptionEdit(String(ctx.from!.id), {
          peerName,
          memberId: member.id,
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

    const { peerName, memberId } = state;
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
        reply_markup: BotUi.cancelEditDescriptionKeyboard(peerName, memberId),
      });
      // Сохраняем новое prompt-сообщение для повторной попытки
      this.setAwaitingDescriptionEdit(userId, {
        peerName,
        memberId,
        promptMessageId: errorMsg.message_id,
        chatId: ctx.chat.id,
      });
      return;
    }

    try {
      await this.peersService.updatePeerDescription(peerName, newDescription);
      await ctx.reply(BotUi.descriptionUpdated(newDescription), {
        parse_mode: 'Markdown',
        reply_markup: BotUi.backToPeerKeyboard(peerName, memberId),
      });
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      await ctx.reply(BotUi.editDescriptionError(errorMsg), {
        parse_mode: 'Markdown',
        reply_markup: BotUi.backToPeerKeyboard(peerName, memberId),
      });
    }
  }

  async cancelEditDescription(
    ctx: Context,
    peerName: string,
    memberId: string,
  ) {
    if (!ctx.from) return;
    this.setAwaitingDescriptionEdit(String(ctx.from.id), null);
    await this.showMemberPeerDetails(ctx, peerName, memberId);
  }

  // Вспомогательный метод для безопасного удаления сообщения
  private async safeDeleteMessage(
    ctx: Context,
    chatId: number,
    messageId: number,
  ): Promise<void> {
    try {
      await ctx.api.deleteMessage(chatId, messageId);
    } catch {
      // Игнорируем ошибку удаления (сообщение уже удалено или нет прав)
    }
  }

  // === Создание конфига для члена группы ===

  async showCreateConfigOptions(ctx: Context, memberId: string) {
    if (!(await this.checkOwnership(ctx, memberId))) return;

    try {
      const member = await this.familyService.findMemberById(memberId);
      const displayName = this.familyService.getDisplayName(member);

      await ctx.editMessageText(BotUi.memberCreateConfigTitle(displayName), {
        parse_mode: 'Markdown',
        reply_markup: BotUi.memberCreateConfigKeyboard(member.id),
      });
    } catch {
      await ctx.answerCallbackQuery({
        text: 'Член группы не найден',
        show_alert: true,
      });
    }
  }

  async createMemberConfig(ctx: Context, memberId: string, duration: string) {
    if (!(await this.checkOwnership(ctx, memberId))) return;

    let member;
    try {
      member = await this.familyService.findMemberById(memberId);
    } catch {
      await ctx.answerCallbackQuery({
        text: 'Член группы не найден',
        show_alert: true,
      });
      return;
    }

    try {
      const displayName = this.familyService.getDisplayName(member);

      // Показываем сообщение о создании
      await ctx.editMessageText('⏳ *Создаю конфигурацию...*', {
        parse_mode: 'Markdown',
      });

      // Определяем срок действия
      const durationDays: SubscriptionDuration | undefined =
        duration === 'unlimited'
          ? undefined
          : (Number(duration) as SubscriptionDuration);

      // Создаем конфиг для члена группы
      const { config, peer } = await this.peersService.createPeer({
        telegramId: member.telegramId,
        durationDays,
      });

      // Отправляем конфиг клиенту
      try {
        const message = await ctx.api.sendDocument(
          member.telegramId,
          new InputFile(Buffer.from(config), `${peer.name}.conf`),
          {
            caption: BotUi.memberConfigCreated(
              peer.name,
              peer.ip,
              peer.expiresAt,
            ),
            parse_mode: 'Markdown',
          },
        );
        await this.peersService.setConfigMessageId(
          peer.name,
          message.message_id,
        );
      } catch (error) {
        this.logger.warn(
          `Не удалось отправить конфиг клиенту ${member.telegramId}: ${error}`,
        );
      }

      // Уведомляем админа
      const escapedName = displayName.replace(
        /([_*[\]()~`>#+\-=|{}.!\\])/g,
        '\\$1',
      );
      await ctx.editMessageText(
        `✅ *Конфиг создан для ${escapedName}*\n\n` +
          `🏷 Имя: \`${peer.name}\`\n` +
          `🌐 IP: \`${peer.ip}\`\n` +
          (peer.expiresAt
            ? `📅 Действует до: ${peer.expiresAt.toLocaleDateString('ru-RU')}`
            : '⏳ Срок: ♾️ Бессрочно'),
        {
          parse_mode: 'Markdown',
          reply_markup: BotUi.backToMemberDetailsKeyboard(member.id),
        },
      );
    } catch (error) {
      this.logger.error(`Ошибка создания конфига: ${error}`);
      const errorMsg = error instanceof Error ? error.message : String(error);
      await ctx.editMessageText(`❌ *Ошибка:* ${errorMsg}`, {
        parse_mode: 'Markdown',
        reply_markup: BotUi.backToMemberDetailsKeyboard(member.id),
      });
    }
  }
}
