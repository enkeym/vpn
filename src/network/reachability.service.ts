import { Injectable, Logger } from '@nestjs/common';
import { setTimeout as sleep } from 'node:timers/promises';
import { NotificationService } from '../notification/notification.service';
import { HostNetworkService } from './host-network.service';

const CHECK_HOST_API = 'https://check-host.net';
const RUSSIAN_NODES = ['ru1.node.check-host.net', 'ru2.node.check-host.net'];
const CONTROL_NODES = ['de1.node.check-host.net', 'ch1.node.check-host.net'];
const REQUEST_TIMEOUT_MS = 10_000;
const POLL_INTERVAL_MS = 3_000;
const POLL_ATTEMPTS = 6;
const DEFAULT_PORT = 443;

type TReachability = 'ok' | 'regional' | 'unreachable';

interface ICheckStartResponse {
  ok?: number;
  request_id?: string;
}

/** Результат узла: null — ещё не готов; [{ time }] — подключились; [{ error }] — нет */
type TCheckResult = Record<string, unknown>;

@Injectable()
export class ReachabilityService {
  private readonly logger = new Logger(ReachabilityService.name);

  private readonly port = Number(process.env.XRAY_REALITY_PORT) || DEFAULT_PORT;

  private state: TReachability | null = null;
  private failureStatus: Exclude<TReachability, 'ok'> | null = null;
  private failureCount = 0;

  constructor(
    private readonly hostNetwork: HostNetworkService,
    private readonly notification: NotificationService,
  ) {}

  async check(): Promise<void> {
    const ip = this.hostNetwork.snatSourceIp;
    // Без PUBLIC_IPV4 проверять нечего: адрес хоста сервис не знает
    if (!ip) return;

    const result = await this.probe(ip);
    const current = result?.status;
    if (!current) {
      this.failureStatus = null;
      this.failureCount = 0;
      return;
    }

    if (current === 'ok') {
      this.failureStatus = null;
      this.failureCount = 0;
    } else {
      this.failureCount =
        this.failureStatus === current ? this.failureCount + 1 : 1;
      this.failureStatus = current;
      if (this.failureCount < 2) return;
    }

    const previous = this.state;
    this.state = current;

    if (previous === current || (previous === null && current === 'ok')) return;

    const message =
      current === 'regional'
        ? `⚠️ TCP \`${ip}:${this.port}\`: два узла в Москве не подключились в двух последовательных проверках, но контрольный узел за пределами РФ подключился. Возможна региональная недоступность этого порта; блокировка IP не доказана. Проверка: ${result?.reportUrl ?? CHECK_HOST_API}`
        : current === 'unreachable'
          ? `🚨 TCP \`${ip}:${this.port}\`: все четыре узла check-host.net не подключились в двух последовательных проверках. Порт недоступен с проверенных узлов; причина неизвестна. Проверьте listener, firewall и сеть сервера. Проверка: ${result?.reportUrl ?? CHECK_HOST_API}`
          : `✅ TCP \`${ip}:${this.port}\` снова доступен из Москвы.`;
    await this.notification.notifyAdmins(message);
  }

  private async probe(
    ip: string,
  ): Promise<{ status: TReachability; reportUrl?: string } | null> {
    try {
      const nodes = [...RUSSIAN_NODES, ...CONTROL_NODES]
        .map((node) => `node=${node}`)
        .join('&');
      const start = await this.get<ICheckStartResponse>(
        `/check-tcp?host=${encodeURIComponent(`${ip}:${this.port}`)}&${nodes}`,
      );
      if (!start.request_id) return null;

      for (let attempt = 0; attempt < POLL_ATTEMPTS; attempt++) {
        await sleep(POLL_INTERVAL_MS);
        const results = await this.get<TCheckResult>(
          `/check-result/${encodeURIComponent(start.request_id)}`,
        );
        const verdict = this.judge(results);
        if (verdict) {
          return {
            status: verdict,
            reportUrl: `${CHECK_HOST_API}/check-report/${encodeURIComponent(start.request_id)}`,
          };
        }
      }
      return null;
    } catch (error) {
      this.logger.warn(
        `Проверка доступности не выполнена: ${error instanceof Error ? error.message : error}`,
      );
      return null;
    }
  }

  private judge(results: TCheckResult): TReachability | null {
    const russianAnswers = RUSSIAN_NODES.map((node) => results[node]);
    const controlAnswers = CONTROL_NODES.map((node) => results[node]);
    if (russianAnswers.some((answer) => this.connected(answer))) return 'ok';
    if (!russianAnswers.every((answer) => this.failed(answer))) return null;
    if (controlAnswers.some((answer) => this.connected(answer)))
      return 'regional';
    if (controlAnswers.every((answer) => this.failed(answer)))
      return 'unreachable';
    return null;
  }

  private failed(answer: unknown): boolean {
    return (
      Array.isArray(answer) &&
      answer.some(
        (entry) =>
          typeof entry === 'object' &&
          entry !== null &&
          typeof (entry as { error?: unknown }).error === 'string',
      ) &&
      !this.connected(answer)
    );
  }

  private connected(answer: unknown): boolean {
    return (
      Array.isArray(answer) &&
      answer.some(
        (entry) =>
          typeof entry === 'object' &&
          entry !== null &&
          typeof (entry as { time?: unknown }).time === 'number',
      )
    );
  }

  private async get<T>(path: string): Promise<T> {
    const res = await fetch(`${CHECK_HOST_API}${path}`, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`check-host.net ${res.status}`);
    return (await res.json()) as T;
  }
}
