import { forwardRef, Inject, Injectable, Logger } from '@nestjs/common';
import { Context } from 'grammy';
import { AutopayService } from 'src/payment/autopay.service';
import { isPaidDuration, type PaidDuration } from 'src/payment/pricing';
import { BotUi } from '../ui/bot.ui';
import { safeEditMessageText } from '../utils/safe-edit-message';

/** Экран и переключатели автопродления подписки для пользователя */
@Injectable()
export class AutopayHandler {
  private readonly logger = new Logger(AutopayHandler.name);

  constructor(
    @Inject(forwardRef(() => AutopayService))
    private readonly autopayService: AutopayService,
  ) {}

  private resolveDuration(value: number | undefined | null): PaidDuration {
    return value != null && isPaidDuration(value) ? value : 30;
  }

  async showAutopayMenu(ctx: Context, peerName: string): Promise<void> {
    if (!ctx.from) return;
    const state = await this.autopayService.getState(String(ctx.from.id));
    const durationDays = this.resolveDuration(state?.durationDays);

    await safeEditMessageText(
      ctx,
      BotUi.autopayMenuText({
        enabled: state?.enabled ?? false,
        durationDays,
        hasPaymentMethod: !!state?.paymentMethodId,
        methodTitle: state?.paymentMethodTitle ?? null,
        nextChargeAt: state?.nextChargeAt ?? null,
      }),
      {
        parse_mode: 'Markdown',
        reply_markup: BotUi.autopayMenuKeyboard(
          peerName,
          state?.enabled ?? false,
          durationDays,
          !!state?.paymentMethodId,
        ),
      },
    );
  }

  async enableAutopay(
    ctx: Context,
    peerName: string,
    durationDays: PaidDuration,
  ): Promise<void> {
    if (!ctx.from) return;
    const result = await this.autopayService.enable(String(ctx.from.id), {
      durationDays,
      peerName,
    });

    const alert: Record<typeof result, string> = {
      enabled: BotUi.autopayEnabledAlert,
      no_payment_method: BotUi.autopayNoMethodAlert,
      no_peer: BotUi.autopayNoPeerAlert,
      unlimited_peer: BotUi.autopayNoPeerAlert,
    };

    await ctx
      .answerCallbackQuery({
        text: alert[result],
        show_alert: result !== 'enabled',
      })
      .catch(() => {});

    if (result === 'enabled') {
      await this.showAutopayMenu(ctx, peerName);
    }
  }

  async disableAutopay(ctx: Context): Promise<void> {
    if (!ctx.from) return;
    const telegramId = String(ctx.from.id);
    await this.autopayService.disable(telegramId);
    await ctx
      .answerCallbackQuery({ text: BotUi.autopayDisabledAlert })
      .catch(() => {});

    const state = await this.autopayService.getState(telegramId);
    if (state?.peerName) {
      await this.showAutopayMenu(ctx, state.peerName);
    }
  }
}
