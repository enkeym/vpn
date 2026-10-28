import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { execFile } from 'child_process';
import { readFile } from 'fs/promises';
import { isIPv4 } from 'net';
import { promisify } from 'util';
import { NotificationService } from '../notification/notification.service';
import { resolveWanInterface } from './wan-interface';

const execFileAsync = promisify(execFile);

/** Контейнер идёт не от root: ip и iptables — через sudo, как и в awg-quick */
async function sudo(bin: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('sudo', [bin, ...args]);
  return stdout;
}

/**
 * Входящий и исходящий IPv4 сервера. Забаненный IP меняется одной строкой
 * PUBLIC_IPV4 в .env: сервис навешивает новый адрес на внешний интерфейс и
 * ставит SNAT на него. MASQUERADE так не умеет — он всегда берёт первый адрес
 * интерфейса, и трафик продолжает выходить со старого IP.
 *
 * Работает до AwgService и XrayService (они ждут `ensureApplied`): исходящий
 * трафик Xray тоже должен выйти с нового адреса, а PostUp awg0 выполняется
 * только при включённом AWG.
 */
@Injectable()
export class HostNetworkService implements OnApplicationBootstrap {
  private readonly logger = new Logger(HostNetworkService.name);

  private readonly configuredIp = (process.env.PUBLIC_IPV4 ?? '').trim();
  private applied: Promise<void> | null = null;
  private activeIp: string | null = null;

  constructor(private readonly notification: NotificationService) {}

  /**
   * Адрес для SNAT — только после того, как он подтверждённо висит на
   * интерфейсе. SNAT на чужой адрес оборвал бы весь исходящий трафик, поэтому
   * при любом сбое здесь null и фаервол остаётся на MASQUERADE.
   */
  get snatSourceIp(): string | null {
    return this.activeIp;
  }

  /** Идемпотентно: первый вызов делает работу, остальные ждут тот же промис */
  ensureApplied(): Promise<void> {
    this.applied ??= this.apply();
    return this.applied;
  }

  async onApplicationBootstrap(): Promise<void> {
    await this.ensureApplied();
    await this.checkIpForward();
  }

  private async apply(): Promise<void> {
    if (!this.configuredIp) return;

    if (!isIPv4(this.configuredIp)) {
      this.logger.error(
        `PUBLIC_IPV4=«${this.configuredIp}» — не IPv4-адрес, настройка пропущена`,
      );
      return;
    }

    try {
      const wan = await resolveWanInterface();
      await this.ensureAddress(wan, this.configuredIp);
      await this.ensureSnat(wan, this.configuredIp);
      this.activeIp = this.configuredIp;
      this.logger.log(
        `PUBLIC_IPV4 ${this.configuredIp}: адрес на ${wan}, SNAT первым в POSTROUTING`,
      );
    } catch (error) {
      // Без NET_ADMIN или в чужом netns это не лечится в рантайме — бот и
      // туннели продолжают работать на прежнем адресе
      const reason = error instanceof Error ? error.message : String(error);
      this.logger.error(`Не удалось применить PUBLIC_IPV4: ${reason}`);
      await this.notification.notifyAdmins(
        `⚠️ *PUBLIC_IPV4 не применён*\n\`${reason.slice(0, 300)}\``,
      );
    }
  }

  private async ensureAddress(wan: string, ip: string): Promise<void> {
    const out = await sudo('ip', ['-4', '-o', 'addr', 'show', 'dev', wan]);

    // Маска не важна: адрес с /24 от провайдера тоже считается присутствующим,
    // второй раз добавлять его нельзя
    if (out.includes(` inet ${ip}/`)) return;

    await sudo('ip', ['addr', 'add', `${ip}/32`, 'dev', wan]);
  }

  /**
   * SNAT должен стоять первым: MASQUERADE awg0 в PostUp добавляется в конец и
   * иначе перехватил бы пакет раньше. Правила SNAT с прежним адресом
   * снимаются — после смены PUBLIC_IPV4 именно они продолжили бы выигрывать.
   */
  private async ensureSnat(wan: string, ip: string): Promise<void> {
    const spec = ['-o', wan, '-j', 'SNAT', '--to-source', ip];
    const nat = ['-t', 'nat'];

    const list = async () =>
      (await sudo('iptables', [...nat, '-S', 'POSTROUTING'])).split('\n');

    for (const line of await list()) {
      const match = line.match(
        /^-A POSTROUTING -o (\S+) -j SNAT --to-source (\S+)$/,
      );
      if (!match || match[1] !== wan || match[2] === ip) continue;

      await sudo('iptables', [
        ...nat,
        '-D',
        'POSTROUTING',
        '-o',
        wan,
        '-j',
        'SNAT',
        '--to-source',
        match[2],
      ]);
    }

    const first = (await list()).find((l) => l.startsWith('-A POSTROUTING'));
    if (first === `-A POSTROUTING ${spec.join(' ')}`) return;

    // Правило могло остаться не первым (его дописал PostUp) — пересоздаём
    await sudo('iptables', [...nat, '-D', 'POSTROUTING', ...spec]).catch(
      () => {},
    );
    await sudo('iptables', [...nat, '-I', 'POSTROUTING', '1', ...spec]);
  }

  /**
   * В host-режиме docker не даёт контейнеру менять sysctl: /proc/sys смонтирован
   * только на чтение. Значение выставляет `make bootstrap` на хосте — здесь
   * только громко сообщаем, что без него клиенты подключатся и не выйдут в сеть.
   */
  private async checkIpForward(): Promise<void> {
    let value: string;
    try {
      value = (await readFile('/proc/sys/net/ipv4/ip_forward', 'utf8')).trim();
    } catch {
      return;
    }
    if (value === '1') return;

    this.logger.error(
      'net.ipv4.forwarding=0: клиенты VPN подключатся, но трафик не пойдёт. ' +
        'Выставьте на хосте: sysctl -w net.ipv4.ip_forward=1',
    );
    await this.notification.notifyAdmins(
      '⚠️ *ip\\_forward=0*: клиенты VPN подключатся, но трафик не пойдёт.\n' +
        'На хосте: `sysctl -w net.ipv4.ip_forward=1`',
    );
  }
}
