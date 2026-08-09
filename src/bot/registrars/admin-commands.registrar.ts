import { Injectable } from '@nestjs/common';
import { Bot } from 'grammy';
import { AdminHandler } from '../handlers/admin.handler';
import { ensureAdmin } from './admin-guard';

/**
 * Регистрация callback-кнопок административной панели (только для админов).
 */
@Injectable()
export class AdminCommandsRegistrar {
  constructor(private readonly adminHandler: AdminHandler) {}

  register(bot: Bot, isAdmin: (userId: string) => boolean): void {
    // Панель администратора
    bot.callbackQuery('admin_panel', async (ctx) => {
      if (!(await ensureAdmin(ctx, isAdmin))) return;
      await ctx.answerCallbackQuery();
      await this.adminHandler.showAdminPanel(ctx);
    });

    // Параметры (оплата / тестовая оплата)
    bot.callbackQuery('admin_settings', async (ctx) => {
      if (!(await ensureAdmin(ctx, isAdmin))) return;
      await ctx.answerCallbackQuery();
      await this.adminHandler.showSettings(ctx);
    });

    bot.callbackQuery('admin_toggle_payment', async (ctx) => {
      if (!(await ensureAdmin(ctx, isAdmin))) return;
      await ctx.answerCallbackQuery();
      await this.adminHandler.togglePayment(ctx);
    });

    bot.callbackQuery('admin_toggle_test_payment', async (ctx) => {
      if (!(await ensureAdmin(ctx, isAdmin))) return;
      await ctx.answerCallbackQuery();
      await this.adminHandler.toggleTestPayment(ctx);
    });

    // Рупор (рассылка всем пользователям)
    bot.callbackQuery('admin_broadcast', async (ctx) => {
      if (!(await ensureAdmin(ctx, isAdmin))) return;
      await ctx.answerCallbackQuery();
      await this.adminHandler.showBroadcastPrompt(ctx);
    });

    bot.callbackQuery('admin_confirm_broadcast', async (ctx) => {
      if (!(await ensureAdmin(ctx, isAdmin))) return;
      // Сразу отвечаем, т.к. рассылка может занять время
      await ctx.answerCallbackQuery();
      await this.adminHandler.confirmBroadcast(ctx);
    });

    bot.callbackQuery('admin_cancel_broadcast', async (ctx) => {
      if (!(await ensureAdmin(ctx, isAdmin))) return;
      await ctx.answerCallbackQuery();
      await this.adminHandler.cancelBroadcast(ctx);
    });

    // Бан-лист
    bot.callbackQuery('admin_blocked_list', async (ctx) => {
      if (!(await ensureAdmin(ctx, isAdmin))) return;
      await ctx.answerCallbackQuery();
      await this.adminHandler.showBlockedList(ctx);
    });

    // Сброс скидки на первую покупку
    bot.callbackQuery(/^admin_reset_discount:(.+)$/, async (ctx) => {
      if (!(await ensureAdmin(ctx, isAdmin))) return;
      await ctx.answerCallbackQuery();
      await this.adminHandler.resetClientDiscount(ctx, ctx.match[1]);
    });

    // Удаление всех конфигов клиента
    bot.callbackQuery(/^admin_delete_all_peers:(.+)$/, async (ctx) => {
      if (!(await ensureAdmin(ctx, isAdmin))) return;
      // Сразу отвечаем, т.к. операция может занять время
      await ctx.answerCallbackQuery();
      await this.adminHandler.deleteAllClientPeers(ctx, ctx.match[1]);
    });

    // Поиск клиента
    bot.callbackQuery('admin_search', async (ctx) => {
      if (!(await ensureAdmin(ctx, isAdmin))) return;
      await ctx.answerCallbackQuery();
      await this.adminHandler.showSearchPrompt(ctx);
    });

    // Отмена поиска
    bot.callbackQuery('admin_cancel_search', async (ctx) => {
      if (!(await ensureAdmin(ctx, isAdmin))) return;
      await ctx.answerCallbackQuery();
      await this.adminHandler.cancelSearch(ctx);
    });

    // Статистика (конфиги и пользователи)
    bot.callbackQuery('admin_stats', async (ctx) => {
      if (!(await ensureAdmin(ctx, isAdmin))) return;
      await ctx.answerCallbackQuery();
      await this.adminHandler.showStats(ctx);
    });

    // Аналитика конфигов (меню)
    bot.callbackQuery('admin_analytics', async (ctx) => {
      if (!(await ensureAdmin(ctx, isAdmin))) return;
      await ctx.answerCallbackQuery();
      await this.adminHandler.showAnalytics(ctx);
    });

    // Аналитика: сводка
    bot.callbackQuery('admin_analytics_overview', async (ctx) => {
      if (!(await ensureAdmin(ctx, isAdmin))) return;
      await ctx.answerCallbackQuery();
      await this.adminHandler.showAnalyticsOverview(ctx);
    });

    // Аналитика: по срокам
    bot.callbackQuery('admin_analytics_duration', async (ctx) => {
      if (!(await ensureAdmin(ctx, isAdmin))) return;
      await ctx.answerCallbackQuery();
      await this.adminHandler.showAnalyticsDuration(ctx);
    });

    // Аналитика: пробные конфиги
    bot.callbackQuery('admin_analytics_trial', async (ctx) => {
      if (!(await ensureAdmin(ctx, isAdmin))) return;
      await ctx.answerCallbackQuery();
      await this.adminHandler.showAnalyticsTrial(ctx);
    });

    // Аналитика: последние созданные
    bot.callbackQuery('admin_analytics_recent', async (ctx) => {
      if (!(await ensureAdmin(ctx, isAdmin))) return;
      await ctx.answerCallbackQuery();
      await this.adminHandler.showAnalyticsRecent(ctx);
    });

    // Аналитика: истекают скоро
    bot.callbackQuery('admin_analytics_expiring', async (ctx) => {
      if (!(await ensureAdmin(ctx, isAdmin))) return;
      await ctx.answerCallbackQuery();
      await this.adminHandler.showAnalyticsExpiring(ctx);
    });

    // Просмотр клиента
    bot.callbackQuery(/^admin_client:(.+)$/, async (ctx) => {
      if (!(await ensureAdmin(ctx, isAdmin))) return;
      await ctx.answerCallbackQuery();
      await this.adminHandler.showClientDetails(ctx, ctx.match[1]);
    });

    // Список конфигов клиента
    bot.callbackQuery(/^admin_client_configs:(.+)$/, async (ctx) => {
      if (!(await ensureAdmin(ctx, isAdmin))) return;
      await ctx.answerCallbackQuery();
      await this.adminHandler.showClientConfigs(ctx, ctx.match[1]);
    });

    // Просмотр конфига клиента
    bot.callbackQuery(/^admin_peer:(.+):(.+)$/, async (ctx) => {
      if (!(await ensureAdmin(ctx, isAdmin))) return;
      await ctx.answerCallbackQuery();
      await this.adminHandler.showClientPeerDetails(
        ctx,
        ctx.match[1],
        ctx.match[2],
      );
    });

    // Переключение статуса конфига клиента
    bot.callbackQuery(/^admin_toggle_peer:(.+):(.+)$/, async (ctx) => {
      if (!(await ensureAdmin(ctx, isAdmin))) return;
      // Сразу отвечаем, т.к. операция может занять время
      await ctx.answerCallbackQuery();
      await this.adminHandler.toggleClientPeer(ctx, ctx.match[1], ctx.match[2]);
    });

    // Удаление конфига клиента
    bot.callbackQuery(/^admin_delete_peer:(.+):(.+)$/, async (ctx) => {
      if (!(await ensureAdmin(ctx, isAdmin))) return;
      // Сразу отвечаем, т.к. операция может занять время
      await ctx.answerCallbackQuery();
      await this.adminHandler.deleteClientPeer(ctx, ctx.match[1], ctx.match[2]);
    });

    // Изменение срока действия конфига
    bot.callbackQuery(/^admin_change_duration:(.+):(.+)$/, async (ctx) => {
      if (!(await ensureAdmin(ctx, isAdmin))) return;
      await ctx.answerCallbackQuery();
      await this.adminHandler.showChangeDuration(
        ctx,
        ctx.match[1],
        ctx.match[2],
      );
    });

    // Установка нового срока действия
    bot.callbackQuery(/^admin_set_duration:(.+):(.+):(.+)$/, async (ctx) => {
      if (!(await ensureAdmin(ctx, isAdmin))) return;
      // Сразу отвечаем, т.к. операция может занять время
      await ctx.answerCallbackQuery();
      await this.adminHandler.changePeerDuration(
        ctx,
        ctx.match[1],
        ctx.match[2],
        ctx.match[3],
      );
    });

    // Редактирование описания конфига клиента
    bot.callbackQuery(/^admin_edit_description:(.+):(.+)$/, async (ctx) => {
      if (!(await ensureAdmin(ctx, isAdmin))) return;
      await ctx.answerCallbackQuery();
      await this.adminHandler.showEditDescriptionPrompt(
        ctx,
        ctx.match[1],
        ctx.match[2],
      );
    });

    // Отмена редактирования описания
    bot.callbackQuery(
      /^admin_cancel_edit_description:(.+):(.+)$/,
      async (ctx) => {
        if (!(await ensureAdmin(ctx, isAdmin))) return;
        await ctx.answerCallbackQuery();
        await this.adminHandler.cancelEditDescription(
          ctx,
          ctx.match[1],
          ctx.match[2],
        );
      },
    );

    // Меню создания конфига для клиента (admin_cc = admin_create_config)
    bot.callbackQuery(/^admin_cc:(.+)$/, async (ctx) => {
      if (!(await ensureAdmin(ctx, isAdmin))) return;
      await ctx.answerCallbackQuery();
      await this.adminHandler.showCreateConfigOptions(ctx, ctx.match[1]);
    });

    // Создать конфиг для клиента (admin_dc = admin_do_create, u = unlimited)
    bot.callbackQuery(/^admin_dc:([^:]+):(u|30|60|90)$/, async (ctx) => {
      if (!(await ensureAdmin(ctx, isAdmin))) return;
      // Сразу отвечаем, т.к. создание конфига может занять время
      await ctx.answerCallbackQuery();

      const telegramId = ctx.match[1];
      const rawDuration = ctx.match[2];
      const duration = rawDuration === 'u' ? 'unlimited' : rawDuration;

      await this.adminHandler.createClientConfig(ctx, telegramId, duration);
    });

    // Блокировка клиента
    bot.callbackQuery(/^admin_block:(.+)$/, async (ctx) => {
      if (!(await ensureAdmin(ctx, isAdmin))) return;
      await ctx.answerCallbackQuery();
      await this.adminHandler.blockClient(ctx, ctx.match[1]);
    });

    // Разблокировка клиента
    bot.callbackQuery(/^admin_unblock:(.+)$/, async (ctx) => {
      if (!(await ensureAdmin(ctx, isAdmin))) return;
      await ctx.answerCallbackQuery();
      await this.adminHandler.unblockClient(ctx, ctx.match[1]);
    });
  }
}
