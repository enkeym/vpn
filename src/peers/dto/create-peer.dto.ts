import { IsString, IsOptional, IsBoolean, IsIn } from 'class-validator';
import { PAID_DURATIONS, type PaidDuration } from 'src/payment/pricing';

/** Пробный период (3 дня) + все платные тарифы */
export type SubscriptionDuration = 3 | PaidDuration;

export const SUBSCRIPTION_DURATIONS: readonly SubscriptionDuration[] = [
  3,
  ...PAID_DURATIONS,
];

export class CreatePeerDto {
  @IsString()
  telegramId!: string;

  @IsOptional()
  @IsString()
  username?: string;

  @IsOptional()
  @IsIn(SUBSCRIPTION_DURATIONS, {
    message: `durationDays должно быть одним из: ${SUBSCRIPTION_DURATIONS.join(', ')}`,
  })
  durationDays?: SubscriptionDuration;

  /** Пробный конфиг на 3 дня (доступен только один раз на пользователя) */
  @IsOptional()
  @IsBoolean()
  isTrial?: boolean;
}

export interface ICreatePeer {
  telegramId: string;
  username?: string;
  durationDays?: SubscriptionDuration;
  isTrial?: boolean;
}
