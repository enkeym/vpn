import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { NotificationService } from '../notification/notification.service';
import { HostNetworkService } from './host-network.service';

const CF_API = 'https://api.cloudflare.com/client/v4';
const REQUEST_TIMEOUT_MS = 10_000;

interface ICfDnsRecord {
  id: string;
  content: string;
  proxied: boolean;
}

interface ICfResponse<T> {
  success: boolean;
  result: T;
  errors?: { message: string }[];
}

/**
 * После смены PUBLIC_IPV4 A-записи в Cloudflare переписываются на новый адрес,
 * чтобы выданные ссылки (по домену) продолжили работать без правок руками.
 * Без CF_API_TOKEN сервис выключен.
 *
 * Адрес берётся из HostNetworkService.snatSourceIp, а не из .env напрямую:
 * записать в DNS адрес, который не удалось повесить на интерфейс, значит
 * увести клиентов на сервер, где их никто не ждёт.
 */
@Injectable()
export class DnsSyncService implements OnApplicationBootstrap {
  private readonly logger = new Logger(DnsSyncService.name);

  private readonly token = (process.env.CF_API_TOKEN ?? '').trim();
  private readonly zoneId = (process.env.CF_ZONE_ID ?? '').trim();
  private readonly records = (process.env.CF_DNS_RECORDS ?? '')
    .split(',')
    .map((name) => name.trim().toLowerCase())
    .filter(Boolean);
  // Серое облако по умолчанию: за прокси Cloudflare Reality и AWG не работают
  private readonly proxied = process.env.CF_DNS_PROXIED === 'true';

  constructor(
    private readonly hostNetwork: HostNetworkService,
    private readonly notification: NotificationService,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    if (!this.token) return;

    if (!this.zoneId || this.records.length === 0) {
      this.logger.warn(
        'CF_API_TOKEN задан, но нет CF_ZONE_ID или CF_DNS_RECORDS — DNS не синхронизируется',
      );
      return;
    }

    await this.hostNetwork.ensureApplied();
    const ip = this.hostNetwork.snatSourceIp;
    if (!ip) {
      this.logger.warn(
        'PUBLIC_IPV4 не применён — A-записи в Cloudflare не трогаем',
      );
      return;
    }

    // Падение одной записи не должно оставлять остальные на старом адресе
    const failed: string[] = [];
    for (const name of this.records) {
      try {
        await this.upsert(name, ip);
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        this.logger.error(`DNS ${name}: ${reason}`);
        failed.push(`${name}: ${reason.slice(0, 120)}`);
      }
    }

    if (failed.length > 0) {
      await this.notification.notifyAdmins(
        `⚠️ *DNS не обновлён* (${ip})\n\`${failed.join('\n')}\``,
      );
    }
  }

  private async upsert(name: string, ip: string): Promise<void> {
    const existing = await this.cf<ICfDnsRecord[]>(
      'GET',
      `/dns_records?type=A&name=${encodeURIComponent(name)}`,
    );

    const current = existing[0];
    if (current && current.content === ip && current.proxied === this.proxied) {
      return;
    }

    const body = {
      type: 'A',
      name,
      content: ip,
      ttl: 1,
      proxied: this.proxied,
    };

    if (current) {
      await this.cf('PUT', `/dns_records/${current.id}`, body);
    } else {
      await this.cf('POST', '/dns_records', body);
    }
    this.logger.log(`DNS ${name} → ${ip}`);
  }

  private async cf<T>(
    method: 'GET' | 'POST' | 'PUT',
    path: string,
    body?: unknown,
  ): Promise<T> {
    const res = await fetch(`${CF_API}/zones/${this.zoneId}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${this.token}`,
        'Content-Type': 'application/json',
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });

    const json = (await res.json()) as ICfResponse<T>;
    if (!res.ok || !json.success) {
      // Токен в сообщение не попадает: только то, что вернул Cloudflare
      const detail = json.errors?.map((e) => e.message).join('; ');
      throw new Error(`Cloudflare ${res.status}: ${detail || 'без деталей'}`);
    }
    return json.result;
  }
}
