import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { ConfigService } from '@nestjs/config';
import * as path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { existsSync } from 'fs';
import { readFile, writeFile } from 'fs/promises';
import { Mutex } from 'async-mutex';
import {
  assertValidObfuscation,
  applyAdvancedFromEnv,
  generateHeaderProtectionKey,
  generateObfuscation,
  obfuscationLines,
  parseAwgConfig,
  readAdvancedFromEnv,
  readAwg3FromEnv,
  readObfuscationFromEnv,
  serializeAwgConfig,
  type IAwgServerConfig,
} from './awg.utils';
import {
  deriveClientIpv6,
  derivePublicKey,
  generateKeys,
  generatePrivateKey,
  getIpv4Address,
  getNextFreeIp,
  getSubnetPrefix,
  readAllowedIps,
  readClientDns,
} from './tunnel.utils';
import {
  bringInterfaceDown,
  bringInterfaceUp,
  isBinaryAvailable,
  isInterfaceUp,
  isIpv6Available,
  readRuntimeStats,
  syncInterface,
  type ITunnelBinaries,
} from './tunnel.runtime';
import { HostNetworkService } from '../network/host-network.service';
import {
  HEALTH_CHECK_TIMEOUT_MS,
  HEALTH_FAILURE_THRESHOLD,
} from '../network/health-check';
import { resolveWanInterface } from '../network/wan-interface';
import type {
  IClientConfigInput,
  IDbPeer,
  IPeerRuntimeStats,
  ITunnelCredentials,
} from './tunnel.types';

/** RFC 8200: на интерфейсе с MTU ниже этого Linux выключает IPv6 */
const IPV6_MIN_MTU = 1280;
const TCP_MIN_MSS = 536;
const TCP_MAX_MSS = 65535;
const IPV6_TCP_HEADER_BYTES = 60;
const execFileAsync = promisify(execFile);

/**
 * AmneziaWG 3 — единственный туннель сервиса: форк WireGuard, маскирующий трафик
 * мусорными пакетами, пакетами-имитациями чужих протоколов и шифрованием
 * заголовков. Интерфейс с включённой обфускацией несовместим с обычными
 * WireGuard-клиентами — конфиги открываются только в AmneziaVPN.
 *
 * Работает поверх userspace-реализации amneziawg-go (через /dev/net/tun) —
 * модуль ядра на хосте не нужен. Если бинарей нет, туннель остаётся выключенным,
 * приложение при этом стартует штатно, но выдавать конфиги не может.
 *
 * Клиенты: AmneziaVPN ≥ 5.0.0.5 или AmneziaWG ≥ 3.0.1 — более старые не понимают
 * диапазоны заголовков и header protection.
 */
/**
 * Правило фаервола интерфейса. Хранится разобранным, а не строкой, чтобы PostUp
 * и PostDown гарантированно оставались зеркальными: разошедшиеся `-A` и `-D`
 * оставляют мусор в iptables после каждого перезапуска.
 */
interface IFirewallRule {
  bin: 'iptables' | 'ip6tables';
  table?: 'nat' | 'mangle';
  chain: string;
  rule: string;
  /**
   * Правило, отсутствие которого не должно ронять подъём интерфейса: awg-quick
   * выполняет PostUp с `set -e`, а NAT66 и ip6tables-mangle собраны не в каждом ядре.
   */
  optional?: boolean;
  /**
   * Перед `-A` проверяем `-C`: правило могли уже поставить руками на хосте
   * (README, iptables-persistent), и второй экземпляр пережил бы PostDown.
   */
  checkFirst?: boolean;
}

@Injectable()
export class AwgService implements OnModuleInit {
  private readonly logger = new Logger(AwgService.name);

  private readonly filePath = path.join(process.cwd(), '/configs/awg0.conf');
  private readonly interfaceAddress = process.env.AWG_ADDRESS || '10.9.0.1/16';
  /**
   * IPv6-подсеть туннеля. Клиенту всегда выдаётся «AllowedIPs = 0.0.0.0/0, ::/0»,
   * но без собственного v6-адреса он заворачивает весь IPv6-трафик в туннель,
   * где тот молча пропадает: ICMPv6 «unreachable» вернуться неоткуда, и дуалстек-
   * сайты висят до таймаута Happy Eyeballs. ULA-подсети достаточно: с v6-аплинком
   * трафик уходит через NAT66, без него ядро сразу отвечает unreachable и клиент
   * мгновенно откатывается на IPv4. Пустое значение выключает IPv6 совсем.
   */
  private readonly interfaceAddress6 = (
    process.env.AWG_ADDRESS6 ?? 'fd42:9::1/64'
  ).trim();

  /** Ставится на старте: v6 может быть отключён в ядре — тогда awg-quick упал бы */
  private ipv6Enabled = false;

  /**
   * Здесь нужно ровно «0.0.0.0/0, ::/0» — иначе AmneziaVPN блокирует
   * раздельное туннелирование (см. AWG_DEFAULT_ALLOWED_IPS).
   */
  private readonly allowedIps = readAllowedIps(process.env.AWG_ALLOWED_IPS);
  private readonly clientDns = readClientDns(process.env.AWG_DNS);
  /**
   * MTU клиентского конфига. 1200, а не 1280: на мобильных сетях (464XLAT,
   * DPI оператора) снаружи не проходят пакеты крупнее ~1300 байт, а 1280 +
   * заголовок WG + S4 + UDP/IP туда не влезает — телефон подключался только
   * после ручного занижения MTU в .conf.
   */
  private readonly clientMtu = Number(process.env.AWG_MTU || 1200);
  private readonly tcpMss = Number(process.env.AWG_TCP_MSS || 0);

  /**
   * Единственный параметр AWG 3, который обязан совпасть с клиентом. По
   * умолчанию выключен: AmneziaVPN при импорте .conf-файла отбрасывает
   * HeaderProtectionKey (importController переносит только Jc/S1..S4/H1..H4/
   * I1..I5), клиент шлёт хендшейк без шифрования заголовков и виснет.
   * Включать только если все клиенты — приложение AmneziaWG >= 3.0.1,
   * передающее .conf в туннель как есть.
   */
  private readonly headerProtection =
    process.env.AWG_HEADER_PROTECTION === 'true';

  /** AWG 3 принимает и диапазон `22-30`: ровный интервал keepalive — тоже сигнатура */
  private readonly persistentKeepalive =
    process.env.AWG_PERSISTENT_KEEPALIVE || '25';

  private readonly binaries: ITunnelBinaries = {
    cli: 'awg',
    quick: 'awg-quick',
    interfaceName: 'awg0',
    env: { WG_QUICK_USERSPACE_IMPLEMENTATION: 'amneziawg-go' },
  };

  /** Порт, на котором awg0 слушает внутри контейнера */
  public readonly port = Number(process.env.AWG_PORT || 51821);

  public readonly host = process.env.WG_HOST || '';

  private enabled = false;
  private monitoring = false;
  private healthFailures = 0;
  private _serverPublicKeyCache: string | null = null;
  private readonly configMutex = new Mutex();

  /**
   * Кеш распарсенного awg0.conf. Единственный туннель сервиса — каждое создание
   * конфига без кеша читало и парсило файл с диска трижды (generateClientCredentials,
   * createClientConfig, buildClientConfig), а показ QR/файла — ещё раз. TTL как
   * подстраховка на случай ручной правки файла в обход приложения; при записи
   * через writeConfig кеш обновляется сразу, без повторного чтения.
   */
  private configCache: { config: IAwgServerConfig; timestamp: number } | null =
    null;
  private readonly CONFIG_CACHE_TTL = 30 * 1000;

  constructor(
    private readonly hostNetwork: HostNetworkService,
    private readonly config: ConfigService,
  ) {}

  async onModuleInit(): Promise<void> {
    if (process.env.AWG_ENABLED === 'false') {
      this.logger.log('AmneziaWG отключён (AWG_ENABLED=false)');
      return;
    }

    // PostUp ниже собирается с учётом PUBLIC_IPV4: адрес и SNAT должны быть готовы
    await this.hostNetwork.ensureApplied();

    if (!this.host) {
      this.logger.warn('AmneziaWG не поднят: WG_HOST в .env не задан');
      return;
    }

    const missing: string[] = [];
    for (const binary of [
      this.binaries.cli,
      this.binaries.quick,
      'amneziawg-go',
    ]) {
      if (!(await isBinaryAvailable(binary))) missing.push(binary);
    }

    if (missing.length > 0) {
      this.logger.warn(
        `AmneziaWG недоступен — нет бинарей: ${missing.join(', ')}. ` +
          'Пересоберите образ (docker compose build) — без них выдавать конфиги нечем.',
      );
      return;
    }

    this.ipv6Enabled =
      this.interfaceAddress6 !== '' && (await isIpv6Available());

    if (this.interfaceAddress6 !== '' && !this.ipv6Enabled) {
      this.logger.warn(
        'IPv6 недоступен в сетевом пространстве контейнера — туннель поднимается ' +
          'без него. Проверьте sysctls net.ipv6.conf.all.disable_ipv6=0 в docker-compose.yml.',
      );
    }

    this.monitoring = true;
    try {
      await this.configMutex.runExclusive(async () => {
        const restartRequired = await this.generateServerConfig();
        await this.getServerPublicKey();
        await this.startInterfaceUp(restartRequired);
        // На старте сбой syncconf не критичен: awg-quick уже применил весь конфиг
        await this.syncSystem(false);
      });

      this.enabled = true;
      const { obfuscation, awg3 } = await this.getConfig();
      this.logger.log(
        `AmneziaWG 3 активен: ${this.binaries.interfaceName} слушает :${this.port}, ` +
          `клиентам выдаётся Endpoint ${this.host}:${this.port}, ` +
          `IPv6: ${this.ipv6Enabled ? this.interfaceAddress6 : 'выключён'}, ` +
          `Jc=${obfuscation.jc} S1=${obfuscation.s1} S2=${obfuscation.s2} ` +
          `S3=${obfuscation.s3} S4=${obfuscation.s4}, header protection: ` +
          (awg3.headerProtectionKey ? 'включена' : 'выключена'),
      );
    } catch (error) {
      // Падение awg0 не должно ронять бота: меню, оплаты и админка
      // остаются доступными, а причина видна в логах
      this.logger.error(
        `AmneziaWG не запущен: ${error instanceof Error ? error.message : error}`,
      );
    }
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  async isHealthy(): Promise<boolean> {
    if (this.config.get<string>('AWG_ENABLED') === 'false') return true;
    return this.enabled && (await this.runtimeHealthy());
  }

  private async runtimeHealthy(): Promise<boolean> {
    try {
      const { stdout } = await execFileAsync(
        'sudo',
        [this.binaries.cli, 'show', this.binaries.interfaceName, 'listen-port'],
        { timeout: HEALTH_CHECK_TIMEOUT_MS },
      );
      return Number(stdout.trim()) === this.port;
    } catch {
      return false;
    }
  }

  @Cron(CronExpression.EVERY_30_SECONDS, { waitForCompletion: true })
  async restoreInterface(): Promise<void> {
    if (!this.monitoring) return;

    try {
      await this.configMutex.runExclusive(async () => {
        if (await this.runtimeHealthy()) {
          if (!this.enabled) await this.syncSystem(true);
          this.enabled = true;
          this.healthFailures = 0;
          return;
        }

        this.enabled = false;
        this.healthFailures += 1;
        if (this.healthFailures < HEALTH_FAILURE_THRESHOLD) return;

        this.logger.warn('AmneziaWG не отвечает — восстанавливаю интерфейс');
        if (!existsSync(this.filePath)) {
          throw new Error('Сохранённый конфиг AmneziaWG отсутствует');
        }
        await this.startInterfaceUp(true);
        await this.syncSystem(true);
        if (!(await this.runtimeHealthy())) {
          throw new Error(
            'Интерфейс AmneziaWG не отвечает после восстановления',
          );
        }
        this.enabled = true;
        this.healthFailures = 0;
        this.logger.log('AmneziaWG восстановлен');
      });
    } catch (error) {
      this.enabled = false;
      this.logger.error(
        `Не удалось восстановить AmneziaWG: ${error instanceof Error ? error.message : error}`,
        error instanceof Error ? error.stack : undefined,
      );
    }
  }

  /** Возвращает true, если применение изменений требует перезапуска интерфейса */
  private async generateServerConfig(): Promise<boolean> {
    if (existsSync(this.filePath)) {
      this.logger.log(`Конфиг AmneziaWG найден: ${this.filePath}`);
      return await this.reconcileConfig();
    }

    const privateKey = await generatePrivateKey();

    if (!privateKey) {
      throw new Error('Не удалось сгенерировать приватный ключ для AmneziaWG');
    }

    // Параметры из .env, иначе — уникальные для этого сервера (одинаковые
    // у всех значения сами по себе становятся сигнатурой для DPI)
    const obfuscation = readObfuscationFromEnv() ?? generateObfuscation();
    const awg3 = readAwg3FromEnv();
    if (this.headerProtection) {
      awg3.headerProtectionKey ??= generateHeaderProtectionKey();
    } else {
      // Флаг — выключатель: заданный в .env ключ его не переопределяет
      delete awg3.headerProtectionKey;
    }
    // В .env могли приехать короткие S1..S4 — с header protection они не работают
    assertValidObfuscation(obfuscation, awg3);

    const { postUp, postDown } = await this.buildFirewallRules();

    await this.writeConfig({
      privateKey,
      address: this.serverAddress(),
      listenPort: this.port,
      mtu: this.serverMtu(),
      obfuscation,
      advanced: readAdvancedFromEnv(),
      awg3,
      postUp,
      postDown,
      peers: [],
    });

    this.logger.log(`Конфигурация AmneziaWG создана: ${this.filePath}`);
    return false;
  }

  /**
   * MTU awg0 совпадает с клиентским — без строки MTU awg-quick ставил 1420, и
   * сервер заворачивал клиенту пакеты, которые тот не мог принять. Исключение —
   * включённый IPv6: ядро снимает v6-адреса с интерфейса с MTU < 1280, и
   * дуалстек-сайты повисли бы у всех. TCP это расхождение не задевает: размер
   * сегментов задаёт MSS из SYN клиента.
   */
  private serverMtu(): number {
    return this.ipv6Enabled
      ? Math.max(this.clientMtu, IPV6_MIN_MTU)
      : this.clientMtu;
  }

  /** Address интерфейса: IPv4 всегда, IPv6 — если он доступен и не выключен */
  private serverAddress(): string {
    return this.ipv6Enabled
      ? `${this.interfaceAddress}, ${this.interfaceAddress6}`
      : this.interfaceAddress;
  }

  /**
   * AllowedIPs пира в серверном конфиге. Без v6-адреса в этом списке ответный
   * IPv6-трафик к клиенту не маршрутизируется вообще.
   */
  private peerAllowedIps(ip: string): string[] {
    const ipv4 = ip.split('/')[0];
    const allowed = [`${ipv4}/32`];

    if (!this.ipv6Enabled) return allowed;

    return [
      ...allowed,
      `${deriveClientIpv6(this.interfaceAddress6, ipv4)}/128`,
    ];
  }

  /**
   * Правила фаервола интерфейса — единый источник и для нового конфига, и для
   * миграции уже существующего: разойдись они, на давно работающих серверах
   * правила навсегда остались бы в первой редакции.
   */
  private async firewallRules(): Promise<IFirewallRule[]> {
    const iface = this.binaries.interfaceName;
    const wanIface = await resolveWanInterface();
    if (
      this.tcpMss !== 0 &&
      (!Number.isInteger(this.tcpMss) ||
        this.tcpMss < TCP_MIN_MSS ||
        this.tcpMss > this.serverMtu() - IPV6_TCP_HEADER_BYTES)
    ) {
      throw new Error('AWG_TCP_MSS должен помещаться в MTU туннеля');
    }
    // MASQUERADE берёт первый адрес интерфейса, поэтому при PUBLIC_IPV4 NAT
    // делается явным SNAT; без подтверждённого адреса остаётся MASQUERADE
    const snatIp = this.hostNetwork.snatSourceIp;
    const natTarget = snatIp ? `SNAT --to-source ${snatIp}` : 'MASQUERADE';

    // Без клэмпинга MSS хендшейк и мелкие пакеты (DNS, keepalive) проходят, а
    // крупные TCP-сегменты настоящих сайтов не помещаются в инкапсуляцию и тихо
    // теряются — PMTUD внутри туннеля не работает. Фильтра по интерфейсу здесь нет
    // намеренно: с `-o awg0` правило чинит только SYN, летящие к клиенту, и не
    // спасает, когда завышенный MSS называет сам клиент (свой MTU он мог поменять).
    const clamp =
      '-p tcp --tcp-flags SYN,RST SYN -j TCPMSS --clamp-mss-to-pmtu';

    const rules: IFirewallRule[] = [
      {
        bin: 'iptables',
        chain: 'FORWARD',
        rule: `-i ${iface} -j ACCEPT`,
        checkFirst: true,
      },
      {
        bin: 'iptables',
        table: 'nat',
        chain: 'POSTROUTING',
        rule: `-o ${wanIface} -j ${natTarget}`,
        checkFirst: true,
      },
      {
        bin: 'iptables',
        table: 'mangle',
        chain: 'FORWARD',
        rule: clamp,
        checkFirst: true,
      },
    ];

    if (this.tcpMss !== 0) {
      const binaries: IFirewallRule['bin'][] = this.ipv6Enabled
        ? ['iptables', 'ip6tables']
        : ['iptables'];
      for (const bin of binaries) {
        for (const direction of ['-i', '-o']) {
          rules.push({
            bin,
            table: 'mangle',
            chain: 'FORWARD',
            rule: `${direction} ${iface} -p tcp --tcp-flags SYN,RST SYN -m tcpmss --mss ${this.tcpMss + 1}:${TCP_MAX_MSS} -j TCPMSS --set-mss ${this.tcpMss}`,
            checkFirst: true,
            optional: bin === 'ip6tables',
          });
        }
      }
    }

    if (!this.ipv6Enabled) return rules;

    return [
      ...rules,
      {
        bin: 'ip6tables',
        chain: 'FORWARD',
        rule: `-i ${iface} -j ACCEPT`,
        optional: true,
        checkFirst: true,
      },
      {
        bin: 'ip6tables',
        table: 'nat',
        chain: 'POSTROUTING',
        rule: `-o ${wanIface} -j MASQUERADE`,
        optional: true,
        checkFirst: true,
      },
      {
        bin: 'ip6tables',
        table: 'mangle',
        chain: 'FORWARD',
        rule: clamp,
        optional: true,
        checkFirst: true,
      },
    ];
  }

  private async buildFirewallRules(): Promise<{
    postUp: string[];
    postDown: string[];
  }> {
    const rules = await this.firewallRules();

    const render = (rule: IFirewallRule, op: '-A' | '-D'): string => {
      const table = rule.table ? `-t ${rule.table} ` : '';
      const line = `${rule.bin} ${table}${op} ${rule.chain} ${rule.rule}`;
      if (op === '-A' && rule.checkFirst) {
        const check = `${rule.bin} ${table}-C ${rule.chain} ${rule.rule}`;
        return `${check} 2>/dev/null || ${line}`;
      }
      // Удаление терпимо к ошибкам всегда: awg-quick выполняет PostDown с
      // `set -e`, и правило, оставшееся от прошлой редакции набора, иначе
      // оборвало бы опускание интерфейса на полпути
      return rule.optional || op === '-D' ? `${line} || true` : line;
    };

    return {
      postUp: rules.map((rule) => render(rule, '-A')),
      // Снимаем в обратном порядке — в том же, в каком добавляли
      postDown: [...rules].reverse().map((rule) => render(rule, '-D')),
    };
  }

  private async reconcileConfig(): Promise<boolean> {
    const config = await this.getConfig();
    const previousPostDown = [...config.postDown];

    // awg0.conf пишется один раз при первом старте — смена AWG_PORT в .env
    // иначе осталась бы незамеченной: интерфейс поднимался бы со старым
    // ListenPort из файла, а клиентам выдавался бы конфиг с новым Endpoint
    // (он берётся из this.port), и никто никогда бы не сходился. В отличие
    // от параметров обфускации ниже, порт применяется сразу и безусловно —
    // это явное решение администратора поменять .env, а не дрейф дефолтов.
    //
    // Address, ListenPort и правила фаервола живут только в `awg-quick up`:
    // syncconf их не видит (strip выбрасывает эти поля), поэтому любое
    // расхождение здесь означает перезапуск интерфейса.
    let restartRequired = false;

    if (config.listenPort !== this.port) {
      this.logger.warn(
        `AWG_PORT изменился: ${config.listenPort} → ${this.port}. Обновляю ${this.filePath}.`,
      );
      config.listenPort = this.port;
      restartRequired = true;
    }

    const address = this.serverAddress();
    if (config.address !== address) {
      this.logger.warn(
        `Адрес интерфейса изменился: «${config.address}» → «${address}». Обновляю ${this.filePath}.`,
      );
      config.address = address;
      restartRequired = true;
    }

    // MTU живёт только в `awg-quick up` (strip его выбрасывает), поэтому
    // расхождение — это перезапуск интерфейса. Конфиги, созданные до появления
    // этой строки, молча работали с awg-quick-дефолтом 1420.
    const mtu = this.serverMtu();
    if (config.mtu !== mtu) {
      this.logger.warn(
        `MTU интерфейса изменился: ${config.mtu || 'авто'} → ${mtu}. Обновляю ${this.filePath}.`,
      );
      config.mtu = mtu;
      restartRequired = true;
    }

    // Конфиги, созданные до появления MSS-клэмпинга и правил для IPv6, сами по
    // себе их не получат: PostUp/PostDown пишутся только при создании файла.
    // Набор не дополняется, а заменяется целиком — файл под управлением сервиса
    // (0600), и только так его состояние гарантированно сходится с кодом.
    const { postUp, postDown } = await this.buildFirewallRules();
    if (
      config.postUp.join('\n') !== postUp.join('\n') ||
      config.postDown.join('\n') !== postDown.join('\n')
    ) {
      this.logger.warn(
        `Правила фаервола в ${this.filePath} отличаются от текущих — заменяю.`,
      );
      config.postUp = postUp;
      config.postDown = postDown;
      restartRequired = true;
    }

    const advancedChanged = applyAdvancedFromEnv(config, readAdvancedFromEnv());
    if (advancedChanged.length > 0) {
      this.logger.warn(
        `В ${this.filePath} обновлены пакеты-имитации из .env (${advancedChanged.join(', ')}). ` +
          'Чтобы они появились у клиентов, конфиг нужно заново скачать из бота.',
      );
      restartRequired = true;
    }

    // У пиров, записанных до появления IPv6, в AllowedIPs нет v6-адреса —
    // обратный трафик к ним не маршрутизируется. Это применяется через
    // syncconf, перезапуск интерфейса для них не нужен.
    let peersChanged = false;
    for (const peer of config.peers) {
      const ipv4 = peer.allowedIps.find((entry) => entry.includes('.'));
      if (!ipv4) continue;

      const allowedIps = this.peerAllowedIps(ipv4);
      if (allowedIps.join(',') !== peer.allowedIps.join(',')) {
        peer.allowedIps = allowedIps;
        peersChanged = true;
      }
    }

    if (peersChanged) {
      this.logger.warn(
        `AllowedIPs пиров в ${this.filePath} приведены к текущим настройкам IPv6.`,
      );
    }

    if (restartRequired || peersChanged) {
      if (restartRequired) {
        if (await isInterfaceUp(this.binaries.interfaceName)) {
          await bringInterfaceDown(this.binaries, this.filePath);
        } else {
          await this.removeObsoleteFirewallRules(
            previousPostDown,
            config.postDown,
          );
        }
      }
      await this.writeConfig(config);
    }

    return restartRequired;
  }

  private async removeObsoleteFirewallRules(
    previous: string[],
    next: string[],
  ): Promise<void> {
    for (const rule of previous) {
      if (next.includes(rule)) continue;
      const mssMatch = rule.match(
        /^((?:iptables|ip6tables) -t mangle -D FORWARD -[io] ([\w-]+) -p tcp --tcp-flags SYN,RST SYN -m tcpmss --mss \d+:\d+ -j TCPMSS --set-mss \d+) \|\| true$/,
      );
      const portMatch = rule.match(
        /^(iptables -t nat -D PREROUTING (?:-i [\w.-]+ )?-p udp --dport \d+ -j (?:DNAT --to-destination :|REDIRECT --to-ports )\d+) \|\| true$/,
      );
      const command =
        mssMatch?.[2] === this.binaries.interfaceName
          ? mssMatch[1]
          : portMatch?.[1];
      if (!command) continue;
      try {
        await execFileAsync('sudo', command.split(' '));
      } catch (error) {
        if (!(error instanceof Error && 'code' in error && error.code === 1)) {
          throw error;
        }
      }
    }
  }

  private async getConfig(): Promise<IAwgServerConfig> {
    const cached = this.configCache;
    if (cached && Date.now() - cached.timestamp < this.CONFIG_CACHE_TTL) {
      return cached.config;
    }

    const config = parseAwgConfig(await readFile(this.filePath, 'utf8'));
    this.configCache = { config, timestamp: Date.now() };
    return config;
  }

  private async writeConfig(config: IAwgServerConfig): Promise<void> {
    await writeFile(this.filePath, serializeAwgConfig(config), { mode: 0o600 });
    // Файл только что записан нами же — обновляем кеш вместо инвалидации,
    // чтобы следующий getConfig() в этом же запросе (buildClientConfig после
    // createClientConfig) не перечитывал файл с диска.
    this.configCache = { config, timestamp: Date.now() };
  }

  async getServerPublicKey(): Promise<string> {
    if (this._serverPublicKeyCache) {
      return this._serverPublicKeyCache;
    }

    const { privateKey } = await this.getConfig();
    this._serverPublicKeyCache = await derivePublicKey(privateKey);

    return this._serverPublicKeyCache;
  }

  private async startInterfaceUp(restartRequired: boolean): Promise<void> {
    const iface = this.binaries.interfaceName;

    if (await isInterfaceUp(iface)) {
      if (!restartRequired) {
        this.logger.log(`Интерфейс ${iface} уже активен`);
        return;
      }

      // Интерфейс пережил перезапуск процесса внутри того же контейнера и
      // остался со старыми Address/ListenPort — syncconf их не перенесёт
      this.logger.warn(
        `Интерфейс ${iface} поднят со старыми параметрами — перезапускаю`,
      );
      await bringInterfaceDown(this.binaries, this.filePath);
    }

    await bringInterfaceUp(this.binaries, this.filePath);
    this.logger.log(`Интерфейс ${iface} успешно поднят`);
  }

  /**
   * Применяет конфиг к живому интерфейсу.
   *
   * `critical` — это путь выдачи конфига пользователю: проглоченная там ошибка
   * означает выданный .conf, который никогда не подключится, — такую нужно
   * поднимать наверх. На старте и в фоновых чистках интерфейс уже поднят
   * целиком, и разовый сбой не повод ронять операцию.
   */
  private async syncSystem(critical: boolean): Promise<void> {
    try {
      await syncInterface(this.binaries, this.filePath);
      this.logger.log(
        `Интерфейс ${this.binaries.interfaceName} синхронизирован`,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(`Ошибка синхронизации AmneziaWG: ${message}`);

      if (critical) {
        throw new Error(
          `Не удалось применить конфиг к ${this.binaries.interfaceName}: ${message}`,
        );
      }
    }
  }

  async generateClientCredentials(
    usedIps: Set<string>,
  ): Promise<ITunnelCredentials> {
    const address = this.isEnabled()
      ? (await this.getConfig()).address
      : this.interfaceAddress;
    const prefix = getSubnetPrefix(address);

    // Адрес самого интерфейса занят сервером
    usedIps.add(getIpv4Address(address));

    return await generateKeys(getNextFreeIp(usedIps, prefix));
  }

  async createClientConfig(
    name: string,
    credentials: ITunnelCredentials,
  ): Promise<string> {
    return await this.configMutex.runExclusive(async () => {
      const config = await this.getConfig();

      config.peers.push({
        publicKey: credentials.publicKey,
        presharedKey: credentials.presharedKey,
        allowedIps: this.peerAllowedIps(credentials.ip),
      });

      await this.writeConfig(config);
      await this.syncSystem(true);
      this.logger.log(`Клиент ${name} добавлен в AmneziaWG: ${credentials.ip}`);

      return await this.buildClientConfig({
        privateKey: credentials.privateKey,
        presharedKey: credentials.presharedKey,
        ip: credentials.ip,
      });
    });
  }

  /**
   * Замена ключей пира одной записью конфига.
   *
   * Раздельные removePeer + createClientConfig давали окно, в котором старого
   * пира в туннеле уже нет, а нового ещё нет: упади второй шаг — конфиг
   * числится живым в БД, но не работает до ближайшего restoreConfigs на старте.
   * Заодно снимается ограничение на повторное использование того же IP.
   */
  async replaceClientConfig(
    name: string,
    oldPublicKey: string,
    credentials: ITunnelCredentials,
  ): Promise<string> {
    return await this.configMutex.runExclusive(async () => {
      const config = await this.getConfig();

      config.peers = config.peers.filter(
        (peer) => peer.publicKey !== oldPublicKey,
      );
      config.peers.push({
        publicKey: credentials.publicKey,
        presharedKey: credentials.presharedKey,
        allowedIps: this.peerAllowedIps(credentials.ip),
      });

      await this.writeConfig(config);
      await this.syncSystem(true);
      this.logger.log(`Ключи клиента ${name} заменены: ${credentials.ip}`);

      return await this.buildClientConfig({
        privateKey: credentials.privateKey,
        presharedKey: credentials.presharedKey,
        ip: credentials.ip,
      });
    });
  }

  async buildClientConfig(peer: IClientConfigInput): Promise<string> {
    const serverPublicKey = await this.getServerPublicKey();
    const { obfuscation, advanced, awg3 } = await this.getConfig();

    // Пустая строка PresharedKey отвергается парсером как ключ неверной длины
    const presharedKey = peer.presharedKey
      ? `PresharedKey = ${peer.presharedKey}\n`
      : '';

    const address = this.ipv6Enabled
      ? `${peer.ip}/32, ${deriveClientIpv6(this.interfaceAddress6, peer.ip)}/128`
      : `${peer.ip}/32`;

    return `[Interface]
PrivateKey = ${peer.privateKey}
Address = ${address}
DNS = ${this.clientDns}
MTU = ${this.serverMtu()}
${obfuscationLines(obfuscation, advanced, awg3)}

[Peer]
PublicKey = ${serverPublicKey}
${presharedKey}Endpoint = ${this.host}:${this.port}
AllowedIPs = ${this.allowedIps}
PersistentKeepalive = ${this.persistentKeepalive}
`;
  }

  async removePeer(publicKey: string): Promise<void> {
    return this.removePeers([publicKey]);
  }

  async removePeers(publicKeys: string[]): Promise<void> {
    if (publicKeys.length === 0) return;

    return await this.configMutex.runExclusive(async () => {
      const config = await this.getConfig();
      const keysSet = new Set(publicKeys);

      if (!config.peers.some((peer) => keysSet.has(peer.publicKey))) return;

      config.peers = config.peers.filter(
        (peer) => !keysSet.has(peer.publicKey),
      );

      await this.writeConfig(config);
      await this.syncSystem(false);
      this.logger.log(`Удалено пиров из AmneziaWG: ${publicKeys.length}`);
    });
  }

  async restoreConfigs(dbPeers: IDbPeer[]): Promise<void> {
    if (!this.enabled) return;

    return await this.configMutex.runExclusive(async () => {
      const config = await this.getConfig();
      const fileKeys = new Set(config.peers.map((peer) => peer.publicKey));

      const isSyncRequired =
        config.peers.length !== dbPeers.length ||
        dbPeers.some((peer) => !fileKeys.has(peer.publicKey));

      if (!isSyncRequired) {
        this.logger.log('Конфигурация AmneziaWG синхронизирована с БД.');
        return;
      }

      this.logger.warn(
        `Рассинхрон AmneziaWG (файл: ${config.peers.length}, БД: ${dbPeers.length}). Восстановление...`,
      );

      config.peers = dbPeers.map((peer) => ({
        publicKey: peer.publicKey,
        presharedKey: peer.presharedKey || undefined,
        allowedIps: this.peerAllowedIps(peer.ip),
      }));

      await this.writeConfig(config);
      await this.syncSystem(false);
      this.logger.log(
        `Конфигурация AmneziaWG восстановлена. Активных пиров: ${dbPeers.length}`,
      );
    });
  }

  async getPeerRuntimeStats(): Promise<Map<string, IPeerRuntimeStats>> {
    if (!this.enabled) return new Map();

    try {
      return await readRuntimeStats(this.binaries);
    } catch (error) {
      this.logger.error(
        `Ошибка получения статистики AmneziaWG: ${error instanceof Error ? error.message : error}`,
      );
      return new Map();
    }
  }
}
