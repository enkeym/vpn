import { Injectable } from '@nestjs/common';
import { Bot, type Context } from 'grammy';
import { MainHandler } from '../handlers/main.handler';
import { MainMenuAnchorStore } from './main-menu-anchor.store';

/**
 * Презентация главного меню: по возможности редактируем одно и то же
 * сообщение-«якорь», чтобы /start и переходы «В меню» не плодили дубли.
 */
@Injectable()
export class MainMenuService {
  private bot!: Bot;

  constructor(
    private readonly mainHandler: MainHandler,
    private readonly anchorStore: MainMenuAnchorStore,
  ) {}

  attach(bot: Bot): void {
    this.bot = bot;
  }

  /**
   * Снимает клавиатуру с якорного сообщения, если это ещё не сообщение со счётом/успехом.
   */
  async dismissStaleMainMenuAnchor(
    telegramId: string,
    invoiceMessageId?: number,
  ): Promise<void> {
    const anchor = this.anchorStore.get(telegramId);
    if (!anchor) return;
    if (invoiceMessageId != null && anchor.messageId === invoiceMessageId) {
      return;
    }
    await this.bot.api
      .editMessageReplyMarkup(anchor.chatId, anchor.messageId, {
        reply_markup: { inline_keyboard: [] },
      })
      .catch(() => {});
    this.anchorStore.delete(telegramId);
  }

  /**
   * Коллбэк висит на сообщении без обычного `text` (документ, фото, видео и т.п.).
   * Для таких сообщений нельзя редактировать «как текст» — caption fallback в
   * `safeEditMessageText` приклеит текст меню к caption-у медиа.
   */
  isCallbackOnNonTextMessage(ctx: Context): boolean {
    const m = ctx.callbackQuery?.message;
    if (!m) return false;
    if ('text' in m && typeof m.text === 'string') return false;
    return (
      ('document' in m && !!m.document) ||
      ('photo' in m && !!m.photo) ||
      ('video' in m && !!m.video) ||
      ('animation' in m && !!m.animation) ||
      ('audio' in m && !!m.audio) ||
      ('voice' in m && !!m.voice) ||
      ('sticker' in m && !!m.sticker)
    );
  }

  /**
   * Главное меню: по возможности обновляем одно и то же сообщение (меньше дублей от /start).
   * «В меню» с файла .conf — снова рисуем меню в том же сообщении, что счёт/успех (якорь), без нового reply.
   */
  async presentMainMenuAnchored(ctx: Context): Promise<void> {
    if (!ctx.from || !ctx.chat) {
      await this.mainHandler.showMainMenu(ctx);
      return;
    }
    const userId = String(ctx.from.id);
    const chatId = ctx.chat.id;
    const anchor = this.anchorStore.get(userId);

    const cbMsg = ctx.callbackQuery?.message;
    const cbMid = cbMsg && 'message_id' in cbMsg ? cbMsg.message_id : undefined;

    // «В меню» с документа .conf / QR: файл удаляем, меню — в якорном текстовом сообщении
    // или новым reply (нельзя превратить документ в текстовое меню через edit).
    if (this.isCallbackOnNonTextMessage(ctx)) {
      const deleteCurrentMessage =
        cbMid != null
          ? ctx.api.deleteMessage(chatId, cbMid).catch(() => {})
          : Promise.resolve();
      void deleteCurrentMessage;

      if (anchor && anchor.chatId === chatId && anchor.messageId !== cbMid) {
        const ok = await this.mainHandler.tryRefreshMainMenuMessage(
          this.bot.api,
          anchor.chatId,
          anchor.messageId,
          userId,
        );
        if (ok) {
          return;
        }
        this.anchorStore.delete(userId);
      }

      const newId = await this.mainHandler.sendFreshMainMenu(ctx);
      if (newId != null) {
        this.anchorStore.set(userId, { chatId, messageId: newId });
      }
      return;
    }

    const canRefreshAnchoredMenu =
      anchor?.chatId === chatId &&
      (cbMid == null || cbMid === anchor.messageId);

    if (
      cbMid != null &&
      anchor &&
      anchor.messageId !== cbMid &&
      !this.isCallbackOnNonTextMessage(ctx)
    ) {
      this.anchorStore.delete(userId);
    }

    if (canRefreshAnchoredMenu) {
      const ok = await this.mainHandler.tryRefreshMainMenuMessage(
        this.bot.api,
        anchor.chatId,
        anchor.messageId,
        userId,
      );
      if (ok) {
        return;
      }
      this.anchorStore.delete(userId);
    }

    const messageId = await this.mainHandler.showMainMenu(ctx);
    if (messageId != null) {
      this.anchorStore.set(userId, { chatId, messageId });
    }
  }

  async presentMainMenuFresh(ctx: Context): Promise<void> {
    if (!ctx.from || !ctx.chat) {
      await this.mainHandler.sendFreshMainMenu(ctx);
      return;
    }
    const userId = String(ctx.from.id);
    const chatId = ctx.chat.id;

    const anchor = this.anchorStore.get(userId);
    if (anchor && anchor.chatId === chatId) {
      await this.bot.api
        .editMessageReplyMarkup(anchor.chatId, anchor.messageId, {
          reply_markup: { inline_keyboard: [] },
        })
        .catch(() => {
          // Сообщение могло быть удалено пользователем — игнорируем
        });
      this.anchorStore.delete(userId);
    }

    const messageId = await this.mainHandler.sendFreshMainMenu(ctx);
    if (messageId != null) {
      this.anchorStore.set(userId, { chatId, messageId });
    }
  }
}
