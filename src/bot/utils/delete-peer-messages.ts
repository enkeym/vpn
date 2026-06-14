import type { Api } from 'grammy';

/**
 * Параллельно удаляет связанные с пиром сообщения (config/qr/file).
 * Ошибки намеренно игнорируются: сообщение могло быть уже удалено или
 * быть старше 48 ч (Telegram не позволяет боту удалять такие сообщения).
 */
export async function deletePeerRelatedMessages(
  api: Api,
  chatId: string | number,
  messageIds: Array<number | null | undefined>,
): Promise<void> {
  const ids = messageIds.filter((id): id is number => id != null);
  if (ids.length === 0) return;
  await Promise.all(
    ids.map((id) => api.deleteMessage(Number(chatId), id).catch(() => {})),
  );
}
