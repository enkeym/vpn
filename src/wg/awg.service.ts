import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import * as path from 'path';
import { existsSync } from 'fs';
import { readFile, writeFile } from 'fs/promises';
import { Mutex } from 'async-mutex';
import {
  assertValidObfuscation,
  generateHeaderProtectionKey,
  generateObfuscation,
  obfuscationLines,
  parseAwgConfig,
  readAdvancedFromEnv,
  readAwg3FromEnv,
  readObfuscationFromEnv,
  serializeAwgConfig,
  upgradeToAwg3,
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
import type {
  IClientConfigInput,
  IDbPeer,
  IPeerRuntimeStats,
  ITunnelCredentials,
} from './tunnel.types';

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
  /** 1420 — проверено на живых клиентах: junk-пакеты объём добавляют, запас держит */
  private readonly clientMtu = Number(process.env.AWG_MTU || 1420);

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

  /**
   * Апгрейд существующего awg0.conf до AWG 3 перевыпускает параметры обфускации
   * и разом отключает всех, кому конфиг уже выдан. Поэтому только по явному
   * запросу: молча ломать рабочий сервер при обновлении образа нельзя.
   */
  private readonly allowConfigUpgrade =
    process.env.AWG_ALLOW_CONFIG_UPGRADE === 'true';

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

  /**
   * Порт в Endpoint клиентского конфига. Отделён от ListenPort намеренно:
   * мобильные операторы режут нестандартные UDP-порты, поэтому наружу сервис
   * публикуется на 4500/udp (порт IPsec NAT-T, который пропускают везде), а внутрь
   * контейнера его прокидывает docker. Без AWG_PUBLIC_PORT совпадает с ListenPort.
   */
  public readonly publicPort = Number(
    process.env.AWG_PUBLIC_PORT || process.env.AWG_PORT || 51821,
  );

  public readonly host = process.env.WG_HOST || '';

  private enabled = false;
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

  async onModuleInit(): Promise<void> {
    if (process.env.AWG_ENABLED === 'false') {
      this.logger.log('AmneziaWG отключён (AWG_ENABLED=false)');
      return;
    }

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
          `клиентам выдаётся Endpoint ${this.host}:${this.publicPort}, ` +
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

  /** Возвращает true, если применение изменений требует перезапуска интерфейса */
  private async generateServerConfig(): Promise<boolean> {
    if (existsSync(this.filePath)) {
      this.logger.log(`Конфиг AmneziaWG найден: ${this.filePath}`);
      return await this.upgradeExistingConfig();
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

    const { postUp, postDown } = this.buildFirewallRules();

    await this.writeConfig({
      privateKey,
      address: this.serverAddress(),
      listenPort: this.port,
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
  private firewallRules(): IFirewallRule[] {
    const iface = this.binaries.interfaceName;

    // Без клэмпинга MSS хендшейк и мелкие пакеты (DNS, keepalive) проходят, а
    // крупные TCP-сегменты настоящих сайтов не помещаются в инкапсуляцию и тихо
    // теряются — PMTUD внутри туннеля не работает. Фильтра по интерфейсу здесь нет
    // намеренно: с `-o awg0` правило чинит только SYN, летящие к клиенту, и не
    // спасает, когда завышенный MSS называет сам клиент (свой MTU он мог поменять).
    const clamp =
      '-p tcp --tcp-flags SYN,RST SYN -j TCPMSS --clamp-mss-to-pmtu';

    const rules: IFirewallRule[] = [
      { bin: 'iptables', chain: 'FORWARD', rule: `-i ${iface} -j ACCEPT` },
      {
        bin: 'iptables',
        table: 'nat',
        chain: 'POSTROUTING',
        rule: '-o eth0 -j MASQUERADE',
      },
      { bin: 'iptables', table: 'mangle', chain: 'FORWARD', rule: clamp },
    ];

    if (!this.ipv6Enabled) return rules;

    return [
      ...rules,
      {
        bin: 'ip6tables',
        chain: 'FORWARD',
        rule: `-i ${iface} -j ACCEPT`,
        optional: true,
      },
      {
        bin: 'ip6tables',
        table: 'nat',
        chain: 'POSTROUTING',
        rule: '-o eth0 -j MASQUERADE',
        optional: true,
      },
      {
        bin: 'ip6tables',
        table: 'mangle',
        chain: 'FORWARD',
        rule: clamp,
        optional: true,
      },
    ];
  }

  private buildFirewallRules(): { postUp: string[]; postDown: string[] } {
    const rules = this.firewallRules();

    const render = (rule: IFirewallRule, op: '-A' | '-D'): string => {
      const table = rule.table ? `-t ${rule.table} ` : '';
      const line = `${rule.bin} ${table}${op} ${rule.chain} ${rule.rule}`;
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

  /**
   * Конфиг, созданный до AWG 3, поднимется и так, но обфускация останется на
   * уровне первой версии — дозаполняем недостающие поля на месте.
   *
   * Любая такая правка меняет параметры обфускации, а значит разом отключает
   * всех, кому конфиг уже выдан, поэтому по умолчанию только пишем
   * предупреждение: применяется она лишь при AWG_ALLOW_CONFIG_UPGRADE=true.
   */
  private async upgradeExistingConfig(): Promise<boolean> {
    const config = await this.getConfig();

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

    // Конфиги, созданные до появления MSS-клэмпинга и правил для IPv6, сами по
    // себе их не получат: PostUp/PostDown пишутся только при создании файла.
    // Набор не дополняется, а заменяется целиком — файл под управлением сервиса
    // (0600), и только так его состояние гарантированно сходится с кодом.
    const { postUp, postDown } = this.buildFirewallRules();
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
      await this.writeConfig(config);
    }

    // upgradeToAwg3 правит config на месте, но пока файл не перезаписан, правки
    // живут только в этом локальном объекте — getConfig читает файл заново
    const changes = upgradeToAwg3(
      config,
      this.headerProtection,
      readAwg3FromEnv(),
    );

    // Header protection выключили в .env, а ключ в файле остался: с ним клиенты,
    // ради которых его и выключают, всё равно не подключатся
    if (!this.headerProtection && config.awg3.headerProtectionKey) {
      delete config.awg3.headerProtectionKey;
      changes.push('HeaderProtectionKey');
    }

    if (changes.length === 0) return restartRequired;

    if (!this.allowConfigUpgrade) {
      this.logger.warn(
        `Конфиг AmneziaWG расходится с текущими настройками AWG 3 (${changes.join(', ')}). ` +
          'Обновление отключило бы всех, кому конфиг уже выдан, поэтому пропущено: ' +
          'задайте AWG_ALLOW_CONFIG_UPGRADE=true, чтобы применить.',
      );
      return restartRequired;
    }

    await this.writeConfig(config);
    this.logger.warn(
      `Конфиг AmneziaWG обновлён до AWG 3 (${changes.join(', ')}). ` +
        'Старые выданные файлы больше не подключатся: клиентам нужно заново скачать конфиг из бота.',
    );

    // Параметры обфускации задаются при создании интерфейса — как и Address
    return true;
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
    const config = await this.getConfig();
    const prefix = getSubnetPrefix(config.address);

    // Адрес самого интерфейса занят сервером
    usedIps.add(getIpv4Address(config.address));

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

    // Адреса клиента в туннеле: без v6-адреса клиент всё равно забирает ::/0
    // из AllowedIPs, а выпустить IPv6-пакеты ему некуда
    const address = this.ipv6Enabled
      ? `${peer.ip}/32, ${deriveClientIpv6(this.interfaceAddress6, peer.ip)}/128`
      : `${peer.ip}/32`;

    return `[Interface]
PrivateKey = ${peer.privateKey}
Address = ${address}
DNS = ${this.clientDns}
MTU = ${this.clientMtu}
${obfuscationLines(obfuscation, advanced, awg3)}

[Peer]
PublicKey = ${serverPublicKey}
${presharedKey}Endpoint = ${this.host}:${this.publicPort}
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
