import { Message } from 'grammy/types';

export type ResolvedTelegramId =
  | { kind: 'id'; telegramId: string }
  | { kind: 'admin_self' }
  | { kind: 'hidden' }
  | { kind: 'not_from_user' }
  | { kind: 'none' };

/**
 * Извлекает Telegram ID из пересланного сообщения или числового текста.
 * adminId — опционально: если передан, возвращает { kind: 'admin_self' } при совпадении.
 */
export function resolveTelegramIdInput(
  message: Message,
  adminId?: string,
): ResolvedTelegramId {
  const origin = message.forward_origin;
  if (origin) {
    if (origin.type === 'user') {
      const id = String(origin.sender_user.id);
      if (adminId && id === adminId) return { kind: 'admin_self' };
      return { kind: 'id', telegramId: id };
    }
    if (origin.type === 'hidden_user') {
      return { kind: 'hidden' };
    }
    return { kind: 'not_from_user' };
  }

  const legacyFrom = (message as { forward_from?: { id: number } }).forward_from;
  if (legacyFrom) {
    const id = String(legacyFrom.id);
    if (adminId && id === adminId) return { kind: 'admin_self' };
    return { kind: 'id', telegramId: id };
  }

  const text = message.text?.trim();
  if (text && /^\d+$/.test(text)) {
    return { kind: 'id', telegramId: text };
  }

  return { kind: 'none' };
}
