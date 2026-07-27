import { IsString, IsOptional, IsBoolean, IsIn } from 'class-validator';
import { VPN_PROTOCOLS, type TVpnProtocol } from 'src/wg/tunnel.types';

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

  /** Туннель конфига: wg (по умолчанию) или awg — AmneziaWG с обфускацией */
  @IsOptional()
  @IsIn(VPN_PROTOCOLS, { message: 'protocol должен быть wg или awg' })
  protocol?: TVpnProtocol;
}

export interface ICreatePeer {
  telegramId: string;
  username?: string;
  durationDays?: SubscriptionDuration;
  isTrial?: boolean;
  protocol?: TVpnProtocol;
}
