import { forwardRef, Inject, Injectable, Logger } from '@nestjs/common';
import { Bot } from 'grammy';
import { PeersService } from 'src/peers/peers.service';
import { MainHandler } from '../handlers/main.handler';
import { PeerCreateHandler } from '../handlers/peer-create.handler';
import { PeerManageHandler } from '../handlers/peer-manage.handler';
import { PeerDeleteHandler } from '../handlers/peer-delete.handler';
import { InvoiceService } from '../invoice/invoice.service';
import { MainMenuService } from '../menu/main-menu.service';
import { PaymentService } from 'src/payment/payment.service';
import type { PaidDuration } from 'src/payment/pricing';
import { AutopayHandler } from '../handlers/autopay.handler';
import { closeMediaMessage } from '../utils/peer-media';

/**
 * Регистрация пользовательских команд и callback-кнопок:
 * главное меню, создание/оплата/продление конфигов, действия с пирами, инструкции.
 */
@Injectable()
export class UserCommandsRegistrar {
  private readonly logger = new Logger(UserCommandsRegistrar.name);

  constructor(
    private readonly mainHandler: MainHandler,
    private readonly peerCreateHandler: PeerCreateHandler,
    private readonly peerManageHandler: PeerManageHandler,
    private readonly peerDeleteHandler: PeerDeleteHandler,
    private readonly peersService: PeersService,
    private readonly invoiceService: InvoiceService,
    private readonly mainMenuService: MainMenuService,
    @Inject(forwardRef(() => PaymentService))
    private readonly paymentService: PaymentService,
    private readonly autopayHandler: AutopayHandler,
  ) {}

  register(bot: Bot, isAdmin: (userId: string) => boolean): void {
    bot.command('start', async (ctx) => {
      const postPayReturn = this.invoiceService.isPostYookassaReturnStart(ctx);

      if (postPayReturn) {
        // Синхронизация и выдача конфига — в middleware; не шлём главное меню (дубль).
        await this.invoiceService.syncUnsettledPayments(ctx);
        if (ctx.chat?.id && ctx.message?.message_id) {
          await ctx.api
            .deleteMessage(ctx.chat.id, ctx.message.message_id)
            .catch(() => {});
        }
        return;
      }

      await this.invoiceService.syncUnsettledPayments(ctx);
      await this.mainMenuService.presentMainMenuFresh(ctx);
    });

    bot.callbackQuery('main_menu', async (ctx) => {
      if (ctx.from) {
        this.invoiceService.stopInvoicePaymentPollingForUser(
          String(ctx.from.id),
        );
      }
      const callbackOnNonTextMessage =
        this.mainMenuService.isCallbackOnNonTextMessage(ctx);
      try {
        await ctx.answerCallbackQuery();
      } catch {
        // Уже отвечено в middleware (для не-админов)
      }
      if (!callbackOnNonTextMessage) {
        await this.invoiceService.syncUnsettledPayments(ctx);
      }
      await this.mainMenuService.presentMainMenuAnchored(ctx);
    });

    bot.callbackQuery('create_trial_config', async (ctx) => {
      await ctx.answerCallbackQuery();
      await this.peerCreateHandler.handleCreateTrialConfig(ctx);
    });

    bot.callbackQuery('show_create_options', async (ctx) => {
      await ctx.answerCallbackQuery();
      if (!ctx.from) return;
      const userId = String(ctx.from.id);
      const [userType, hasUsedDiscount, testPayment] = await Promise.all([
        this.mainHandler.getUserType(userId),
        this.peersService.hasUsedFirstPurchaseDiscount(userId),
        this.paymentService.isTestPaymentFor(userId),
      ]);
      // При включённой тестовой оплате админ проходит клиентский путь покупки
      // (1 ₽ за любой тариф) — так проверяются все этапы счёта и выдачи.
      // «Семья» не затрагивается; бесплатное создание остаётся в админ-панели.
      const followsPaymentFlow =
        userType === 'user' || (userType === 'admin' && testPayment);
      if (followsPaymentFlow) {
        await this.peerCreateHandler.showPaymentPlans(ctx, hasUsedDiscount);
      } else {
        await this.peerCreateHandler.showCreateOptions(ctx);
      }
    });

    bot.callbackQuery(/^pay_plan:(30|60|90|180|365)$/, async (ctx) => {
      if (!ctx.from) return;
      const days = Number(ctx.match[1]) as PaidDuration;
      try {
        await ctx.answerCallbackQuery({ text: 'Готовлю счёт…' });
        await this.invoiceService.presentNewPurchaseInvoice(ctx, days);
      } catch (error) {
        this.logger.error('Error in pay_plan', error);
        await ctx
          .reply(
            '❌ Не удалось сформировать счёт. Попробуйте позже или напишите в поддержку.',
          )
          .catch(() => {});
      }
    });

    /** Старые сообщения с экраном подтверждения */
    bot.callbackQuery(/^pay_confirm:(30|60|90|180|365)$/, async (ctx) => {
      if (!ctx.from) return;
      const durationDays = Number(ctx.match[1]) as PaidDuration;
      try {
        await ctx.answerCallbackQuery({ text: 'Готовлю счёт…' });
        await this.invoiceService.presentNewPurchaseInvoice(ctx, durationDays);
      } catch (error) {
        this.logger.error('Error in pay_confirm', error);
        await ctx
          .reply(
            '❌ Не удалось сформировать счёт. Попробуйте позже или напишите в поддержку.',
          )
          .catch(() => {});
      }
    });

    bot.callbackQuery(
      /^create_config:(unlimited|30|60|90|180|365)$/,
      async (ctx) => {
        await ctx.answerCallbackQuery();
        const userId = String(ctx.from?.id);

        // КРИТИЧЕСКОЕ ИСПРАВЛЕНИЕ: Проверка прав
        if (!isAdmin(userId)) {
          const userType = await this.mainHandler.getUserType(userId);
          if (userType === 'user') {
            return ctx.reply(
              '❌ Этот метод создания доступен только администраторам. Пожалуйста, используйте меню оплаты.',
            );
          }
        }

        const duration = ctx.match[1];
        const durationDays =
          duration === 'unlimited'
            ? undefined
            : (Number(duration) as PaidDuration);
        await this.peerCreateHandler.handleCreateConfig(ctx, durationDays);
      },
    );

    // Список конфигов (подсказка «Загрузка…» — мгновенный отклик при задержке)
    bot.callbackQuery('list_configs', async (ctx) => {
      await ctx.answerCallbackQuery({ text: 'Загрузка…' });
      await this.peerManageHandler.showConfigsList(ctx);
    });

    // Действия с конкретным пиром
    bot.callbackQuery(/^manage_peer:(.+)$/, async (ctx) => {
      await ctx.answerCallbackQuery();
      const peerName = ctx.match[1];
      const admin = ctx.from ? isAdmin(String(ctx.from.id)) : false;
      await this.peerManageHandler.showPeerDetails(ctx, peerName, admin);
    });

    // Пауза/Старт
    bot.callbackQuery(/^toggle_peer:(.+)$/, async (ctx) => {
      // Сразу отвечаем, т.к. операция может занять время
      await ctx.answerCallbackQuery();
      const peerName = ctx.match[1];
      const admin = ctx.from ? isAdmin(String(ctx.from.id)) : false;
      await this.peerManageHandler.togglePeer(ctx, peerName, admin);
    });

    // Удаление пира
    bot.callbackQuery(/^delete_peer:(.+)$/, async (ctx) => {
      // Сразу отвечаем, т.к. операция может занять время
      await ctx.answerCallbackQuery();
      const peerName = ctx.match[1];
      const admin = ctx.from ? isAdmin(String(ctx.from.id)) : false;
      await this.peerDeleteHandler.deletePeer(ctx, peerName, admin);
    });

    // Продление конфига — переход в меню оплаты
    bot.callbackQuery(/^extend_peer:(.+)$/, async (ctx) => {
      await ctx.answerCallbackQuery();
      await this.peerCreateHandler.showPaymentPlansForExtend(ctx, ctx.match[1]);
    });

    // Возврат к тарифам при продлении
    bot.callbackQuery(/^extend_pay_plans:(.+)$/, async (ctx) => {
      if (ctx.from) {
        this.invoiceService.stopInvoicePaymentPollingForUser(
          String(ctx.from.id),
        );
      }
      await ctx.answerCallbackQuery();
      await this.peerCreateHandler.showPaymentPlansForExtend(ctx, ctx.match[1]);
    });

    // Выбор тарифа при продлении — сразу счёт ЮKassa
    bot.callbackQuery(
      /^extend_pay_plan:(30|60|90|180|365):(.+)$/,
      async (ctx) => {
        if (!ctx.from) return;
        const days = Number(ctx.match[1]) as PaidDuration;
        const peerName = ctx.match[2];
        try {
          await ctx.answerCallbackQuery({ text: 'Готовлю счёт…' });
          await this.invoiceService.presentExtendInvoice(ctx, days, peerName);
        } catch (error) {
          this.logger.error('Error in extend_pay_plan', error);
          await ctx
            .reply(
              '❌ Не удалось сформировать счёт. Попробуйте позже или напишите в поддержку.',
            )
            .catch(() => {});
        }
      },
    );

    /** Старые сообщения с экраном подтверждения продления */
    bot.callbackQuery(
      /^extend_pay_confirm:(30|60|90|180|365):(.+)$/,
      async (ctx) => {
        if (!ctx.from) return;
        const durationDays = Number(ctx.match[1]) as PaidDuration;
        const peerName = ctx.match[2];
        try {
          await ctx.answerCallbackQuery({ text: 'Готовлю счёт…' });
          await this.invoiceService.presentExtendInvoice(
            ctx,
            durationDays,
            peerName,
          );
        } catch (error) {
          this.logger.error('Error in extend_pay_confirm', error);
          await ctx
            .reply(
              '❌ Не удалось сформировать счёт. Попробуйте позже или напишите в поддержку.',
            )
            .catch(() => {});
        }
      },
    );

    bot.callbackQuery(/^payment_check:(.+)$/, async (ctx) => {
      await this.invoiceService.handlePaymentCheck(ctx, ctx.match[1]);
    });

    // === Автопродление ===

    bot.callbackQuery(/^autopay_menu:(.+)$/, async (ctx) => {
      await ctx.answerCallbackQuery();
      await this.autopayHandler.showAutopayMenu(ctx, ctx.match[1]);
    });

    bot.callbackQuery(
      /^autopay_on:([^:]+):(30|60|90|180|365)$/,
      async (ctx) => {
        const peerName = ctx.match[1];
        const days = Number(ctx.match[2]) as PaidDuration;
        await this.autopayHandler.enableAutopay(ctx, peerName, days);
      },
    );

    bot.callbackQuery('autopay_off', async (ctx) => {
      await this.autopayHandler.disableAutopay(ctx);
    });

    // «Не сейчас» — убираем предложение, ничего не меняя
    bot.callbackQuery('autopay_skip', async (ctx) => {
      await ctx.answerCallbackQuery().catch(() => {});
      const msg = ctx.callbackQuery?.message;
      if (ctx.chat && msg && 'message_id' in msg) {
        await ctx.api
          .deleteMessage(ctx.chat.id, msg.message_id)
          .catch(() => {});
      }
    });

    // Замена конфига (раз в день)
    bot.callbackQuery(/^replace_peer:(.+)$/, async (ctx) => {
      // Сразу отвечаем, т.к. операция может занять время
      await ctx.answerCallbackQuery();
      await this.peerManageHandler.replacePeer(ctx, ctx.match[1]);
    });

    // Возврат с сообщения QR/файла: карточка конфига осталась выше — закрываем
    // медиа-сообщение. Единая точка для всех веток меню (свои конфиги, клиенты,
    // «Семья»), поэтому регистрируется здесь, без деления по ролям.
    bot.callbackQuery('close_media', async (ctx) => {
      await ctx.answerCallbackQuery();
      await closeMediaMessage(ctx);
    });

    // Старые сообщения с документами до перехода на `close_media`
    bot.callbackQuery(/^goto_peer:(.+)$/, async (ctx) => {
      await ctx.answerCallbackQuery();
      await this.peerManageHandler.showPeerDetailsReply(ctx);
    });

    // После замены конфига — родитель удалён, нужен новый reply с деталями
    bot.callbackQuery(/^goto_peer_after_replace:(.+)$/, async (ctx) => {
      await ctx.answerCallbackQuery();
      const peerName = ctx.match[1];
      const admin = ctx.from ? isAdmin(String(ctx.from.id)) : false;
      await this.peerManageHandler.showPeerDetailsReplyAfterReplace(
        ctx,
        peerName,
        admin,
      );
    });

    // Показать QR-код конфига
    bot.callbackQuery(/^show_qr:(.+)$/, async (ctx) => {
      await ctx.answerCallbackQuery();
      await this.peerManageHandler.showQrCode(ctx, ctx.match[1]);
    });

    // Получить файл конфига
    bot.callbackQuery(/^get_config_file:(.+)$/, async (ctx) => {
      await ctx.answerCallbackQuery();
      await this.peerManageHandler.sendConfigFile(ctx, ctx.match[1]);
    });

    // Прокси для Telegram (MTProto) — отдельный от туннеля канал
    bot.callbackQuery(/^tg_proxy:(.+)$/, async (ctx) => {
      await ctx.answerCallbackQuery();
      await this.peerManageHandler.showTelegramProxy(ctx, ctx.match[1]);
    });

    // Редактирование описания своего конфига (только для админов)
    bot.callbackQuery(/^edit_description:(.+)$/, async (ctx) => {
      if (!ctx.from || !isAdmin(String(ctx.from.id))) {
        await ctx.answerCallbackQuery({
          text: 'Нет доступа',
          show_alert: true,
        });
        return;
      }
      await ctx.answerCallbackQuery();
      await this.peerManageHandler.showEditDescriptionPrompt(ctx, ctx.match[1]);
    });

    // Отмена редактирования описания своего конфига
    bot.callbackQuery(/^cancel_edit_description:(.+)$/, async (ctx) => {
      await ctx.answerCallbackQuery();
      await this.peerManageHandler.cancelEditDescription(
        ctx,
        ctx.match[1],
        true,
      );
    });

    // === Инструкции ===

    // Показать меню инструкций
    bot.callbackQuery('show_instructions', async (ctx) => {
      await ctx.answerCallbackQuery();
      await this.mainHandler.showInstructions(ctx);
    });

    // Показать инструкцию для конкретной платформы
    bot.callbackQuery(/^instruction:(.+)$/, async (ctx) => {
      await ctx.answerCallbackQuery();
      await this.mainHandler.showInstruction(ctx, ctx.match[1]);
    });
  }
}
