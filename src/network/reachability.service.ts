import { Injectable, Logger } from '@nestjs/common';
import { setTimeout as sleep } from 'node:timers/promises';
import { NotificationService } from '../notification/notification.service';
import { HostNetworkService } from './host-network.service';

const CHECK_HOST_API = 'https://check-host.net';
// Москва: если IP в бане у российских операторов, клиенты из РФ не дойдут
const CHECK_NODES = ['ru1.node.check-host.net', 'ru2.node.check-host.net'];
const REQUEST_TIMEOUT_MS = 10_000;
const POLL_INTERVAL_MS = 3_000;
const POLL_ATTEMPTS = 6;
const DEFAULT_PORT = 443;

type TReachability = 'ok' | 'blocked';

interface ICheckStartResponse {
  ok?: number;
  request_id?: string;
}

/** Результат узла: null — ещё не готов; [{ time }] — подключились; [{ error }] — нет */
type TCheckResult = Record<string, unknown>;

/**
 * Раз в час проверяет TCP-доступность PUBLIC_IPV4:XRAY_REALITY_PORT с российских узлов
 * check-host.net и пишет админу только при смене состояния. Так бан IP виден
 * сразу, а не по жалобам клиентов; после смены PUBLIC_IPV4 состояние
 * пересчитывается с нуля при перезапуске.
 *
 * Сбой самого check-host.net или неполный ответ состояние не меняют: «не знаю»
 * не должно превращаться ни в ложную тревогу, ни в ложный отбой.
 */
@Injectable()
export class ReachabilityService {
  private readonly logger = new Logger(ReachabilityService.name);

  private readonly port = Number(process.env.XRAY_REALITY_PORT) || DEFAULT_PORT;

  private state: TReachability | null = null;

  constructor(
    private readonly hostNetwork: HostNetworkService,
    private readonly notification: NotificationService,
  ) {}

  async check(): Promise<void> {
    const ip = this.hostNetwork.snatSourceIp;
    // Без PUBLIC_IPV4 проверять нечего: адрес хоста сервис не знает
    if (!ip) return;

    const current = await this.probe(ip);
    if (!current) return;

    const previous = this.state;
    this.state = current;

    // Первый «ок» после старта — не событие: стартовый отчёт уже был
    if (previous === current || (previous === null && current === 'ok')) return;

    const message =
      current === 'blocked'
        ? `🚫 \`${ip}:${this.port}\` недоступен из Москвы (check-host.net). Вероятен бан IP: смените PUBLIC\\_IPV4 и перезапустите контейнер.`
        : `✅ \`${ip}:${this.port}\` снова доступен из Москвы.`;
    await this.notification.notifyAdmins(message);
  }

  /** null — результата нет (сбой API, узлы не успели ответить) */
  private async probe(ip: string): Promise<TReachability | null> {
    try {
      const nodes = CHECK_NODES.map((node) => `node=${node}`).join('&');
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
        if (verdict) return verdict;
      }
      return null;
    } catch (error) {
      this.logger.warn(
        `Проверка доступности не выполнена: ${error instanceof Error ? error.message : error}`,
      );
      return null;
    }
  }

  /** ok — хоть один узел подключился; blocked — все ответили и никто не подключился */
  private judge(results: TCheckResult): TReachability | null {
    const answers = CHECK_NODES.map((node) => results[node]);
    // Подключившийся узел уже даёт ответ — ждать остальных незачем
    if (answers.some((answer) => this.connected(answer))) return 'ok';
    return answers.every((answer) => answer != null) ? 'blocked' : null;
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
