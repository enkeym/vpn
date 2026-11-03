import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { HostNetworkService } from './host-network.service';

const CF_API = 'https://api.cloudflare.com/client/v4';
const REQUEST_TIMEOUT_MS = 10_000;

function normalizeDnsName(name: string): string {
  return name.trim().toLowerCase().replace(/\.$/, '');
}

/** Итог синхронизации для отчёта на старте */
export interface IDnsSyncStatus {
  enabled: boolean;
  ip: string | null;
  ok: string[];
  /** «имя: причина» */
  failed: string[];
}

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

  private readonly token: string;
  private readonly zoneId: string;
  private readonly records: string[];
  private readonly cdnName: string;
  private readonly directNames: Set<string>;

  private synced: Promise<IDnsSyncStatus> | null = null;

  constructor(
    private readonly hostNetwork: HostNetworkService,
    config: ConfigService,
  ) {
    this.token = config.get<string>('CF_API_TOKEN', '').trim();
    this.zoneId = config.get<string>('CF_ZONE_ID', '').trim();
    this.records = config
      .get<string>('CF_DNS_RECORDS', '')
      .split(',')
      .map(normalizeDnsName)
      .filter(Boolean);
    this.cdnName = normalizeDnsName(config.get<string>('XRAY_DOMAIN', ''));
    this.directNames = new Set(
      [
        config.get<string>('WG_HOST', ''),
        config.get<string>('XRAY_REALITY_SNI', ''),
      ]
        .map(normalizeDnsName)
        .filter(Boolean),
    );
  }

  async onApplicationBootstrap(): Promise<void> {
    await this.ensureSynced();
  }

  /** Идемпотентно: отчёт на старте ждёт тот же промис, порядок хуков не важен */
  ensureSynced(): Promise<IDnsSyncStatus> {
    this.synced ??= this.sync();
    return this.synced;
  }

  private async sync(): Promise<IDnsSyncStatus> {
    const status: IDnsSyncStatus = {
      enabled: false,
      ip: null,
      ok: [],
      failed: [],
    };
    if (!this.token) return status;

    if (!this.zoneId || this.records.length === 0) {
      this.logger.warn(
        'CF_API_TOKEN задан, но нет CF_ZONE_ID или CF_DNS_RECORDS — DNS не синхронизируется',
      );
      return status;
    }
    status.enabled = true;

    await this.hostNetwork.ensureApplied();
    const ip = this.hostNetwork.snatSourceIp;
    if (!ip) {
      this.logger.warn(
        'PUBLIC_IPV4 не применён — A-записи в Cloudflare не трогаем',
      );
      return status;
    }
    status.ip = ip;

    // Падение одной записи не должно оставлять остальные на старом адресе
    for (const name of this.records) {
      try {
        await this.upsert(name, ip);
        status.ok.push(name);
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        this.logger.error(`DNS ${name}: ${reason}`);
        status.failed.push(`${name}: ${reason.slice(0, 120)}`);
      }
    }

    // Ошибки попадут в одно стартовое сообщение StartupReportService — без отдельного
    // алерта здесь, чтобы админ не получал два сообщения на один запуск
    return status;
  }

  private async upsert(name: string, ip: string): Promise<void> {
    const isCdn = name === this.cdnName;
    const isDirect = this.directNames.has(name);
    if (isCdn && isDirect) {
      throw new Error(
        'Один домен задан для CDN и прямого VPN: разделите XRAY_DOMAIN и прямые адреса',
      );
    }
    const existing = await this.cf<ICfDnsRecord[]>(
      'GET',
      `/dns_records?type=A&name=${encodeURIComponent(name)}`,
    );

    const current = existing[0];
    const proxied = isCdn
      ? true
      : isDirect
        ? false
        : (current?.proxied ?? false);
    if (current && current.content === ip && current.proxied === proxied) {
      return;
    }

    const body = {
      type: 'A',
      name,
      content: ip,
      ttl: 1,
      proxied,
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
