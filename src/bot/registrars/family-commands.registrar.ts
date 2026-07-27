import { Injectable } from '@nestjs/common';
import { Bot } from 'grammy';
import { FamilyHandler } from '../handlers/family.handler';
import { ensureAdmin } from './admin-guard';
import type { TVpnProtocol } from 'src/wg/tunnel.types';

/**
 * Регистрация callback-кнопок меню группы «Семья» (только для админов).
 */
@Injectable()
export class FamilyCommandsRegistrar {
  constructor(private readonly familyHandler: FamilyHandler) {}

  register(bot: Bot, isAdmin: (userId: string) => boolean): void {
    // Меню группы "Семья"
    bot.callbackQuery('family_menu', async (ctx) => {
      if (!(await ensureAdmin(ctx, isAdmin))) return;
      await ctx.answerCallbackQuery();
      await this.familyHandler.showFamilyMenu(ctx);
    });

    // Добавить в группу
    bot.callbackQuery('family_add', async (ctx) => {
      if (!(await ensureAdmin(ctx, isAdmin))) return;
      await ctx.answerCallbackQuery();
      await this.familyHandler.showAddMemberPrompt(ctx);
    });

    // Отмена добавления
    bot.callbackQuery('family_cancel_add', async (ctx) => {
      await ctx.answerCallbackQuery();
      await this.familyHandler.cancelAddMember(ctx);
    });

    // Просмотр члена группы (f_m = family_member)
    bot.callbackQuery(/^f_m:(.+)$/, async (ctx) => {
      if (!(await ensureAdmin(ctx, isAdmin))) return;
      await ctx.answerCallbackQuery();
      await this.familyHandler.showMemberDetails(ctx, ctx.match[1]);
    });

    // Список конфигов члена группы (f_mc = family_member_configs)
    bot.callbackQuery(/^f_mc:(.+)$/, async (ctx) => {
      if (!(await ensureAdmin(ctx, isAdmin))) return;
      await ctx.answerCallbackQuery();
      await this.familyHandler.showMemberConfigs(ctx, ctx.match[1]);
    });

    // Просмотр конфига члена группы (f_p = family_peer)
    bot.callbackQuery(/^f_p:(.+):(.+)$/, async (ctx) => {
      if (!(await ensureAdmin(ctx, isAdmin))) return;
      await ctx.answerCallbackQuery();
      await this.familyHandler.showMemberPeerDetails(
        ctx,
        ctx.match[1],
        ctx.match[2],
      );
    });

    // Переключение статуса конфига (f_tp = family_toggle_peer)
    bot.callbackQuery(/^f_tp:(.+):(.+)$/, async (ctx) => {
      if (!(await ensureAdmin(ctx, isAdmin))) return;
      // Сразу отвечаем, т.к. операция может занять время
      await ctx.answerCallbackQuery();
      await this.familyHandler.toggleMemberPeer(
        ctx,
        ctx.match[1],
        ctx.match[2],
      );
    });

    // Удаление конфига члена группы (f_dp = family_delete_peer)
    bot.callbackQuery(/^f_dp:(.+):(.+)$/, async (ctx) => {
      if (!(await ensureAdmin(ctx, isAdmin))) return;
      // Сразу отвечаем, т.к. операция может занять время
      await ctx.answerCallbackQuery();
      await this.familyHandler.deleteMemberPeer(
        ctx,
        ctx.match[1],
        ctx.match[2],
      );
    });

    // Изменение срока действия (f_cd = family_change_duration)
    bot.callbackQuery(/^f_cd:(.+):(.+)$/, async (ctx) => {
      if (!(await ensureAdmin(ctx, isAdmin))) return;
      await ctx.answerCallbackQuery();
      await this.familyHandler.showChangeDuration(
        ctx,
        ctx.match[1],
        ctx.match[2],
      );
    });

    // Установка срока (f_sd = family_set_duration, u = unlimited)
    bot.callbackQuery(/^f_sd:(.+):(.+):(.+)$/, async (ctx) => {
      if (!(await ensureAdmin(ctx, isAdmin))) return;
      // Сразу отвечаем, т.к. операция может занять время
      await ctx.answerCallbackQuery();
      const duration = ctx.match[3] === 'u' ? 'unlimited' : ctx.match[3];
      await this.familyHandler.changePeerDuration(
        ctx,
        ctx.match[1],
        ctx.match[2],
        duration,
      );
    });

    // Удаление члена из группы (f_rm = family_remove)
    bot.callbackQuery(/^f_rm:(.+)$/, async (ctx) => {
      if (!(await ensureAdmin(ctx, isAdmin))) return;
      // Сразу отвечаем, т.к. удаление может занять время
      await ctx.answerCallbackQuery();
      await this.familyHandler.removeMember(ctx, ctx.match[1]);
    });

    // Редактирование имени (f_en = family_edit_name)
    bot.callbackQuery(/^f_en:(.+)$/, async (ctx) => {
      if (!(await ensureAdmin(ctx, isAdmin))) return;
      await ctx.answerCallbackQuery();
      await this.familyHandler.showEditNamePrompt(ctx, ctx.match[1]);
    });

    // Отмена редактирования имени (f_cen = family_cancel_edit_name)
    bot.callbackQuery(/^f_cen:(.+)$/, async (ctx) => {
      if (!(await ensureAdmin(ctx, isAdmin))) return;
      await ctx.answerCallbackQuery();
      await this.familyHandler.cancelEditName(ctx, ctx.match[1]);
    });

    // Редактирование описания (f_ed = family_edit_description)
    bot.callbackQuery(/^f_ed:(.+):(.+)$/, async (ctx) => {
      if (!(await ensureAdmin(ctx, isAdmin))) return;
      await ctx.answerCallbackQuery();
      await this.familyHandler.showEditDescriptionPrompt(
        ctx,
        ctx.match[1],
        ctx.match[2],
      );
    });

    // Отмена редактирования описания (f_ced = family_cancel_edit_description)
    bot.callbackQuery(/^f_ced:(.+):(.+)$/, async (ctx) => {
      if (!(await ensureAdmin(ctx, isAdmin))) return;
      await ctx.answerCallbackQuery();
      await this.familyHandler.cancelEditDescription(
        ctx,
        ctx.match[1],
        ctx.match[2],
      );
    });

    // Меню создания конфига (f_cc = family_create_config)
    bot.callbackQuery(/^f_cc:(.+)$/, async (ctx) => {
      if (!(await ensureAdmin(ctx, isAdmin))) return;
      await ctx.answerCallbackQuery();
      await this.familyHandler.showCreateConfigOptions(ctx, ctx.match[1]);
    });

    // Создать конфиг (f_dc = family_do_create, u = unlimited)
    bot.callbackQuery(
      /^f_dc:([^:]+):(u|30|60|90)(?::(wg|awg))?$/,
      async (ctx) => {
        if (!(await ensureAdmin(ctx, isAdmin))) return;
        // Сразу отвечаем, чтобы кнопка не зависала во время создания конфига
        await ctx.answerCallbackQuery();

        const memberId = ctx.match[1];
        const rawDuration = ctx.match[2];
        const protocol = ctx.match[3] as TVpnProtocol | undefined;

        if (!protocol) {
          const asked = await this.familyHandler.showMemberProtocolOptions(
            ctx,
            memberId,
            rawDuration,
          );
          if (asked) return;
        }

        const duration = rawDuration === 'u' ? 'unlimited' : rawDuration;
        await this.familyHandler.createMemberConfig(
          ctx,
          memberId,
          duration,
          protocol ?? 'wg',
        );
      },
    );
  }
}
