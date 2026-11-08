export function canManagePeerConfig(
  peerTelegramId: string,
  actorTelegramId: string | undefined,
  actorIsAdmin: boolean,
  isAdmin: (telegramId: string) => boolean,
): boolean {
  if (!actorTelegramId) return false;
  if (peerTelegramId === actorTelegramId) return true;
  return actorIsAdmin && !isAdmin(peerTelegramId);
}
