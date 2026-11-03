/** Формат ответа подписки. */
export type TSubscriptionFormat = 'base64' | 'singbox';

/**
 * Клиенты на движке sing-box — им нужен JSON, остальным base64. Список
 * намеренно узкий: всё, что не опознано, получает base64 как самый
 * совместимый формат.
 */
const SINGBOX_CLIENT_MARKERS = [
  'hiddify',
  'sing-box',
  'singbox',
  'nekoray',
  'karing',
] as const;

/**
 * Определяет формат по User-Agent клиента. Явный ?format= имеет приоритет —
 * им можно точечно починить подписку конкретному пользователю без деплоя.
 */
export function resolveSubscriptionFormat(
  userAgent: string | undefined,
  explicit: string | undefined,
): TSubscriptionFormat {
  if (explicit === 'base64' || explicit === 'singbox') return explicit;

  const ua = (userAgent ?? '').toLowerCase();
  return SINGBOX_CLIENT_MARKERS.some((marker) => ua.includes(marker))
    ? 'singbox'
    : 'base64';
}
