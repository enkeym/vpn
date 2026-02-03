import { Injectable, Logger } from '@nestjs/common';
import { Context } from 'grammy';
import { FamilyService } from 'src/family/family.service';
import { PeersService } from 'src/peers/peers.service';
import { BotUi } from '../ui/bot.ui';

// Состояние ожидания ввода для добавления члена группы
const awaitingFamilyInput = new Map<string, boolean>();

@Injectable()
export class FamilyHandler {
  private readonly logger = new Logger(FamilyHandler.name);

  constructor(
    private readonly familyService: FamilyService,
    private readonly peersService: PeersService,
  ) {}

  isAwaitingInput(userId: string): boolean {
    return awaitingFamilyInput.get(userId) === true;
  }

  setAwaitingInput(userId: string, value: boolean) {
    if (value) {
      awaitingFamilyInput.set(userId, true);
    } else {
      awaitingFamilyInput.delete(userId);
    }
  }

  async showAddMemberPrompt(ctx: Context) {
    if (!ctx.from) return;

    this.setAwaitingInput(String(ctx.from.id), true);

    await ctx.editMessageText(BotUi.addMemberPrompt, {
      parse_mode: 'Markdown',
      reply_markup: BotUi.cancelKeyboard(),
    });
  }

  async handleAddMemberInput(ctx: Context) {
    if (!ctx.from || !ctx.message?.text) return;

    const adminId = String(ctx.from.id);
    this.setAwaitingInput(adminId, false);

    const input = ctx.message.text.trim();

    let telegramId: string | undefined;
    let username: string | undefined;

    if (input.startsWith('@')) {
      // Добавление по username
      username = input.slice(1);
      if (!username || username.length < 3) {
        await ctx.reply(BotUi.invalidInput, {
          parse_mode: 'Markdown',
          reply_markup: BotUi.cancelKeyboard(),
        });
        this.setAwaitingInput(adminId, true);
        return;
      }
    } else if (/^\d+$/.test(input)) {
      // Добавление по telegram ID
      telegramId = input;
    } else {
      await ctx.reply(BotUi.invalidInput, {
        parse_mode: 'Markdown',
        reply_markup: BotUi.cancelKeyboard(),
      });
      this.setAwaitingInput(adminId, true);
      return;
    }

    try {
      const member = await this.familyService.addMember(adminId, {
        username,
        telegramId,
      });
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
    this.setAwaitingInput(String(ctx.from.id), false);
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
      // Конфиги есть только если привязан telegramId
      const peers = member.telegramId
        ? await this.peersService.getPeersByTelegramId(member.telegramId)
        : [];

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

      if (!member.telegramId) {
        await ctx.answerCallbackQuery({
          text: 'У пользователя нет конфигов (ID не привязан)',
          show_alert: true,
        });
        return;
      }

      const peers = await this.peersService.getPeersByTelegramId(
        member.telegramId,
      );

      await ctx.editMessageText(BotUi.memberConfigsListTitle(member.username), {
        parse_mode: 'Markdown',
        reply_markup: BotUi.memberConfigsListKeyboard(peers, memberId),
      });
    } catch {
      await ctx.answerCallbackQuery({
        text: 'Ошибка загрузки конфигов',
        show_alert: true,
      });
    }
  }

  private async checkOwnership(ctx: Context, memberId: string): Promise<boolean> {
    if (!ctx.from) return false;

    const adminId = String(ctx.from.id);
    const isOwner = await this.familyService.isMemberOwnedByAdmin(
      memberId,
      adminId,
    );

    if (!isOwner) {
      await ctx.answerCallbackQuery({
        text: 'Нет доступа к этому участнику',
        show_alert: true,
      });
    }

    return isOwner;
  }

  async showMemberPeerDetails(
    ctx: Context,
    peerName: string,
    memberId: string,
  ) {
    if (!(await this.checkOwnership(ctx, memberId))) return;

    try {
      const peer = await this.peersService.findPeer(peerName);

      await ctx.editMessageText(BotUi.memberPeerDetailsText(peer), {
        reply_markup: BotUi.memberPeerDetailsKeyboard(peer, memberId),
        parse_mode: 'Markdown',
      });
    } catch {
      await ctx.answerCallbackQuery({
        text: 'Конфиг не найден',
        show_alert: true,
      });
      await this.showMemberDetails(ctx, memberId);
    }
  }

  async toggleMemberPeer(ctx: Context, peerName: string, memberId: string) {
    if (!(await this.checkOwnership(ctx, memberId))) return;

    try {
      await this.peersService.updatedPeer(peerName);
      await this.showMemberPeerDetails(ctx, peerName, memberId);
      await ctx.answerCallbackQuery('Статус изменен');
    } catch (error) {
      this.logger.error(`Ошибка переключения: ${error}`);
      await ctx.answerCallbackQuery({
        text: 'Ошибка изменения статуса',
        show_alert: true,
      });
    }
  }

  async deleteMemberPeer(ctx: Context, peerName: string, memberId: string) {
    if (!(await this.checkOwnership(ctx, memberId))) return;

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
      await this.showMemberDetails(ctx, memberId);
    } catch (error) {
      this.logger.error(`Ошибка удаления: ${error}`);
      await ctx.answerCallbackQuery({
        text: 'Ошибка удаления',
        show_alert: true,
      });
    }
  }

  async removeMember(ctx: Context, memberId: string) {
    if (!(await this.checkOwnership(ctx, memberId))) return;

    try {
      const member = await this.familyService.findMemberById(memberId);

      // Удаляем все конфиги члена группы (если есть telegramId)
      if (member.telegramId) {
        const peers = await this.peersService.getPeersByTelegramId(
          member.telegramId,
        );
        for (const peer of peers) {
          try {
            if (peer.configMessageId) {
              await ctx.api.deleteMessage(
                peer.telegramId,
                peer.configMessageId,
              );
            }
            await this.peersService.deletePeer(peer.name);
          } catch (error) {
            this.logger.warn(`Ошибка удаления конфига ${peer.name}: ${error}`);
          }
        }
      }

      await this.familyService.removeMemberById(memberId);
      await ctx.answerCallbackQuery({ text: 'Член группы удален' });
      await this.showFamilyMenu(ctx);
    } catch (error) {
      this.logger.error(`Ошибка удаления члена группы: ${error}`);
      await ctx.answerCallbackQuery({
        text: 'Ошибка удаления',
        show_alert: true,
      });
    }
  }

  async showChangeDuration(ctx: Context, peerName: string, memberId: string) {
    if (!(await this.checkOwnership(ctx, memberId))) return;

    await ctx.editMessageText(BotUi.changeDurationTitle, {
      parse_mode: 'Markdown',
      reply_markup: BotUi.changeDurationKeyboard(peerName, memberId),
    });
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
      await ctx.answerCallbackQuery({ text: 'Срок действия изменен' });
      await this.showMemberPeerDetails(ctx, peerName, memberId);
    } catch (error) {
      this.logger.error(`Ошибка изменения срока: ${error}`);
      await ctx.answerCallbackQuery({
        text: 'Ошибка изменения срока',
        show_alert: true,
      });
    }
  }
}
