import { IsString, IsOptional, IsBoolean, IsIn } from 'class-validator';

export type SubscriptionDuration = 3 | 30 | 60 | 90;

export class CreatePeerDto {
  @IsString()
  telegramId!: string;

  @IsOptional()
  @IsString()
  username?: string;

  @IsOptional()
  @IsIn([3, 30, 60, 90], {
    message: 'durationDays должно быть 3, 30, 60 или 90',
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
