export type SubscriptionDuration = 30 | 60 | 90;

export interface ICreatePeer {
  telegramId: string;
  username?: string;
  durationDays?: SubscriptionDuration;
}
