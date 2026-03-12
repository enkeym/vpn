export type SubscriptionDuration = 3 | 30 | 60 | 90;

export interface ICreatePeer {
  telegramId: string;
  username?: string;
  durationDays?: SubscriptionDuration;
  /** Пробный конфиг на 3 дня (доступен только один раз на пользователя) */
  isTrial?: boolean;
}
