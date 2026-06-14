import type { Context } from 'grammy';

/**
 * Проверка прав администратора для callback-кнопок.
 * При отсутствии прав сразу отвечает на callback алертом и возвращает `false`.
 * Так из обработчиков убирается повторяющийся блок проверки.
 */
export async function ensureAdmin(
  ctx: Context,
  isAdmin: (userId: string) => boolean,
): Promise<boolean> {
  if (!ctx.from || !isAdmin(String(ctx.from.id))) {
    await ctx.answerCallbackQuery({
      text: 'Нет доступа',
      show_alert: true,
    });
    return false;
  }
  return true;
}
