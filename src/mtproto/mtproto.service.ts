import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

/** Готовая к выдаче пользователю ссылка на MTProto-прокси */
export interface IMtprotoProxyLink {
  /** https://t.me/proxy?… — по клику Telegram сам открывает диалог подключения */
  shareUrl: string;
  /** tg://proxy?… — та же ссылка схемой приложения, на случай ручного копирования */
  deepLink: string;
  host: string;
  port: number;
  /** Домен, под TLS-соединение с которым маскируется прокси; null — секрет без faketls */
  fakeTlsDomain: string | null;
}

/**
 * Секрет faketls: `ee` + 16 байт секрета в hex + домен маскировки в hex.
 * Ровно то, что печатает `mtg generate-secret --hex <домен>`, — значение
 * из .env скармливается и mtg, и клиенту без переработки.
 */
const FAKE_TLS_SECRET = /^ee([0-9a-f]{32})((?:[0-9a-f]{2})+)$/i;

/** Домен из секрета показывается пользователю — пропускаем только имя хоста */
function decodeFakeTlsDomain(hex: string): string | null {
  const domain = Buffer.from(hex, 'hex').toString('utf8');
  return /^[a-z0-9.-]+$/i.test(domain) ? domain : null;
}

/**
 * MTProto-прокси — отдельный от AmneziaWG канал, обслуживающий только трафик
 * Telegram. Конфиг awg0 в `tg://proxy` не превращается (L3-туннель против
 * прикладного прокси), ссылку обслуживает внешний демон mtg — сервис `mtg` в
 * docker-compose под профилем `mtproto`.
 *
 * Секрет один на весь инстанс: mtg 2.x больше одного не принимает. Отсюда два
 * следствия, на которые опирается UI:
 *  1. ссылка общая для всех клиентов, и доступ ограничен лишь тем, что кнопка
 *     показывается только по активной подписке;
 *  2. отозвать доступ у отдельного пользователя нельзя — смена MTPROTO_SECRET
 *     отключает сразу всех.
 */
@Injectable()
export class MtprotoService implements OnModuleInit {
  private readonly logger = new Logger(MtprotoService.name);

  /** Считается один раз: значения берутся из .env и в рантайме не меняются */
  private link: IMtprotoProxyLink | null = null;

  constructor(private readonly configService: ConfigService) {}

  onModuleInit(): void {
    if (this.configService.get<string>('MTPROTO_ENABLED')?.trim() !== 'true') {
      this.logger.log('MTProto-прокси выключен (MTPROTO_ENABLED != true)');
      return;
    }

    this.link = this.buildLink();

    if (this.link) {
      this.logger.log(
        `MTProto-прокси: ${this.link.host}:${this.link.port}` +
          (this.link.fakeTlsDomain
            ? `, маскировка под ${this.link.fakeTlsDomain}`
            : ''),
      );
    }
  }

  /** Прокси настроен и ссылку есть что показать — от этого зависит кнопка в меню конфига */
  get enabled(): boolean {
    return this.link !== null;
  }

  getProxyLink(): IMtprotoProxyLink | null {
    return this.link;
  }

  private buildLink(): IMtprotoProxyLink | null {
    // Хост по умолчанию тот же, что в Endpoint конфига: прокси живёт на том же VPS
    const host =
      this.configService.get<string>('MTPROTO_HOST')?.trim() ||
      this.configService.get<string>('WG_HOST')?.trim() ||
      '';
    const secret = this.configService.get<string>('MTPROTO_SECRET')?.trim();
    const rawPort = this.configService.get<string>('MTPROTO_PORT');
    const port = Number(rawPort || 8443);

    if (!host) {
      this.logger.warn(
        'MTProto-прокси не поднят: не заданы ни MTPROTO_HOST, ни WG_HOST',
      );
      return null;
    }

    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      this.logger.warn(
        `MTProto-прокси не поднят: MTPROTO_PORT="${rawPort}" — не порт`,
      );
      return null;
    }

    const match = secret ? FAKE_TLS_SECRET.exec(secret) : null;
    if (!secret || !match) {
      this.logger.warn(
        'MTProto-прокси не поднят: MTPROTO_SECRET пуст или не в формате faketls ' +
          '(ожидается вывод `mtg generate-secret --hex <домен>`)',
      );
      return null;
    }

    const query = `server=${encodeURIComponent(host)}&port=${port}&secret=${secret.toLowerCase()}`;

    return {
      shareUrl: `https://t.me/proxy?${query}`,
      deepLink: `tg://proxy?${query}`,
      host,
      port,
      fakeTlsDomain: decodeFakeTlsDomain(match[2]),
    };
  }
}
