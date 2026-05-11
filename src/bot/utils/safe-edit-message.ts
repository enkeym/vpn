import { Context } from 'grammy';

type EditExtra = NonNullable<Parameters<Context['editMessageText']>[1]>;

function errorText(err: unknown): string {
  if (err && typeof err === 'object' && 'description' in err) {
    return String((err as { description: string }).description);
  }
  if (err instanceof Error) return err.message;
  return String(err);
}

export function isMessageNotModifiedError(err: unknown): boolean {
  const t = errorText(err);
  return t.includes('not modified') || t.includes('message is not modified');
}

function shouldRecoverEditTextFailure(err: unknown): boolean {
  const t = errorText(err).toLowerCase();
  return (
    t.includes('there is no text in the message to edit') ||
    t.includes('message to edit not found') ||
    t.includes("message can't be edited")
  );
}

function callbackMessageId(ctx: Context): number | undefined {
  const msg = ctx.callbackQuery?.message;
  return msg && 'message_id' in msg ? msg.message_id : undefined;
}

export async function safeEditMessageText(
  ctx: Context,
  text: string,
  extra?: EditExtra,
): Promise<number | undefined> {
  try {
    await ctx.editMessageText(text, extra);
    return callbackMessageId(ctx);
  } catch (err) {
    if (isMessageNotModifiedError(err)) return callbackMessageId(ctx);
    if (!shouldRecoverEditTextFailure(err)) throw err;
  }

  try {
    await ctx.editMessageCaption({
      caption: text,
      ...(extra?.parse_mode !== undefined && { parse_mode: extra.parse_mode }),
      ...(extra?.reply_markup !== undefined && {
        reply_markup: extra.reply_markup,
      }),
    });
    return callbackMessageId(ctx);
  } catch (err) {
    if (isMessageNotModifiedError(err)) return callbackMessageId(ctx);
  }

  const cbMsg = ctx.callbackQuery?.message;
  if (cbMsg && ctx.chat && 'message_id' in cbMsg) {
    await ctx.api
      .editMessageReplyMarkup(ctx.chat.id, cbMsg.message_id, {
        reply_markup: { inline_keyboard: [] },
      })
      .catch(() => {});
  }

  const sent = await ctx.reply(text, {
    parse_mode: extra?.parse_mode,
    reply_markup: extra?.reply_markup,
    link_preview_options: extra?.link_preview_options,
  });
  return sent.message_id;
}
