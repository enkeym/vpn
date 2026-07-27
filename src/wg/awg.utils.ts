import { randomBytes, randomInt } from 'node:crypto';

/**
 * Параметры обфускации AmneziaWG. Должны совпадать на сервере и у клиента:
 * при расхождении хендшейк не проходит вообще.
 *
 * Jc/Jmin/Jmax — мусорные пакеты перед хендшейком, S1..S4 — добивка init/
 * response/cookie/transport пакетов, H1..H4 — подменённые типы заголовков
 * (у обычного WireGuard это 1..4).
 *
 * С AWG 3 заголовки задаются диапазоном `x-y` — тип пакета выбирается из него
 * заново на каждый пакет, поэтому строка, а не число (одиночное число тоже
 * остаётся валидным значением).
 */
export interface IAwgObfuscation {
  jc: number;
  jmin: number;
  jmax: number;
  s1: number;
  s2: number;
  s3: number;
  s4: number;
  h1: string;
  h2: string;
  h3: string;
  h4: string;
}

type TAwgSizeKey = 'jc' | 'jmin' | 'jmax' | 's1' | 's2' | 's3' | 's4';
type TAwgHeaderKey = 'h1' | 'h2' | 'h3' | 'h4';

/**
 * Пакеты-имитации других протоколов (DNS, QUIC, SIP): отправляются перед каждым
 * хендшейком в порядке I1..I5. Опциональны — без них работает базовый набор выше.
 *
 * Значения имеют собственный синтаксис из тегов (`<b 0x...>`, `<r 10>`, `<rd 5>`,
 * `<rc 5>`, `<t>`) и пробрасываются в конфиг как есть — задаются в .env целиком.
 * J1..J3 и Itime из AmneziaWG 1.5 здесь намеренно отсутствуют: amneziawg-tools
 * их больше не разбирает, их роль перешла к тегам внутри I1..I5.
 */
export type TAwgAdvanced = Partial<Record<TAwgAdvancedKey, string>>;

export type TAwgAdvancedKey = 'I1' | 'I2' | 'I3' | 'I4' | 'I5';

export const AWG_ADVANCED_KEYS: readonly TAwgAdvancedKey[] = [
  'I1',
  'I2',
  'I3',
  'I4',
  'I5',
] as const;

/**
 * Параметры AmneziaWG 3 — маскировка не только хендшейка, но и потока данных.
 *
 * HeaderProtectionKey шифрует низкоэнтропийные поля заголовка и обязан совпадать
 * на обеих сторонах (server-side). Остальные — client-side: расхождение хендшейк
 * не ломает. Тайминги и padding хранятся строками, потому что принимают диапазон
 * `x-y` — их синтаксис проверяет уже сам amneziawg-go.
 */
export interface IAwg3Options {
  headerProtectionKey?: string;
  contentPaddingAddition?: string;
  rekeyAfterTime?: string;
  rekeyTimeout?: string;
  rejectAfterTime?: string;
  keepaliveTimeout?: string;
  maxHandshakeAttempts?: string;
}

/** Поле ↔ ключ в конфиге ↔ переменная .env. Порядок задаёт порядок строк конфига */
const AWG3_FIELDS: readonly {
  field: keyof IAwg3Options;
  conf: string;
  env: string;
}[] = [
  {
    field: 'headerProtectionKey',
    conf: 'HeaderProtectionKey',
    env: 'AWG_HEADER_PROTECTION_KEY',
  },
  {
    field: 'contentPaddingAddition',
    conf: 'ContentPaddingAddition',
    env: 'AWG_CONTENT_PADDING',
  },
  {
    field: 'rekeyAfterTime',
    conf: 'RekeyAfterTime',
    env: 'AWG_REKEY_AFTER_TIME',
  },
  { field: 'rekeyTimeout', conf: 'RekeyTimeout', env: 'AWG_REKEY_TIMEOUT' },
  {
    field: 'rejectAfterTime',
    conf: 'RejectAfterTime',
    env: 'AWG_REJECT_AFTER_TIME',
  },
  {
    field: 'keepaliveTimeout',
    conf: 'KeepaliveTimeout',
    env: 'AWG_KEEPALIVE_TIMEOUT',
  },
  {
    field: 'maxHandshakeAttempts',
    conf: 'MaxHandshakeAttempts',
    env: 'AWG_MAX_HANDSHAKE_ATTEMPTS',
  },
] as const;

export interface IAwgServerPeer {
  publicKey: string;
  presharedKey?: string;
  allowedIps: string[];
}

export interface IAwgServerConfig {
  privateKey: string;
  address: string;
  listenPort: number;
  obfuscation: IAwgObfuscation;
  advanced: TAwgAdvanced;
  awg3: IAwg3Options;
  postUp: string[];
  postDown: string[];
  peers: IAwgServerPeer[];
}

/** Типы заголовков 1..4 заняты самим протоколом — подмены начинаются с 5 */
const HEADER_MIN = 5;
const HEADER_MAX = 2_147_483_647;
/** Ширина случайного окна заголовка: чем шире, тем меньше повторов для DPI */
const HEADER_RANGE_SPAN = 100_000;
/** Верхняя граница размера мусора: пакет не должен вылезать за MTU */
const JUNK_SIZE_MAX = 1280;
/** Предел добивки хендшейк-пакетов в amneziawg-go */
const SIGNATURE_SIZE_MAX = 1132;
/** Разница размеров init- и response-пакетов WireGuard */
const HANDSHAKE_SIZE_DELTA = 56;
/** Header protection берёт S1..S4 как nonce шифра — короче 8 байт он не работает */
const HEADER_PROTECTION_MIN_SIGNATURE = 8;
/** S4 добивает КАЖДЫЙ транспортный пакет, поэтому потолок куда ниже S1..S3 */
const TRANSPORT_SIGNATURE_MAX = 64;
/** HeaderProtectionKey — обычный 32-байтный ключ в base64, как PrivateKey */
const HEADER_PROTECTION_KEY_BYTES = 32;

const SIZE_ENV_KEYS: Record<TAwgSizeKey, string> = {
  jc: 'AWG_JC',
  jmin: 'AWG_JMIN',
  jmax: 'AWG_JMAX',
  s1: 'AWG_S1',
  s2: 'AWG_S2',
  s3: 'AWG_S3',
  s4: 'AWG_S4',
};

const HEADER_ENV_KEYS: Record<TAwgHeaderKey, string> = {
  h1: 'AWG_H1',
  h2: 'AWG_H2',
  h3: 'AWG_H3',
  h4: 'AWG_H4',
};

/**
 * Случайные параметры для конкретного сервера. Одинаковые у всех значения — сами
 * по себе сигнатура для DPI, поэтому набор генерируется один раз при создании
 * awg0.conf и дальше читается из файла.
 */
export function generateObfuscation(): IAwgObfuscation {
  const s1 = randomInt(15, 133);
  let s2 = randomInt(15, 133);
  while (s1 + HANDSHAKE_SIZE_DELTA === s2) {
    s2 = randomInt(15, 133);
  }

  const [h1, h2, h3, h4] = generateHeaderRanges();

  return {
    jc: randomInt(4, 13),
    jmin: 40,
    jmax: 70,
    s1,
    s2,
    s3: randomInt(15, 133),
    // Транспортных пакетов на порядки больше, чем хендшейков: добивка мелкая,
    // иначе она съедает полезный MTU на каждом пакете
    s4: randomInt(HEADER_PROTECTION_MIN_SIGNATURE, TRANSPORT_SIGNATURE_MAX + 1),
    h1,
    h2,
    h3,
    h4,
  };
}

/**
 * Четыре непересекающихся диапазона заголовков. Пересекись они — приёмник не
 * отличит хендшейк от транспорта, поэтому пространство 5..2^31 делится на
 * четыре сегмента и в каждом берётся случайное окно.
 */
function generateHeaderRanges(): [string, string, string, string] {
  const segment = Math.floor((HEADER_MAX - HEADER_MIN) / 4);

  const ranges = [0, 1, 2, 3].map((index) => {
    const from =
      HEADER_MIN + segment * index + randomInt(0, segment - HEADER_RANGE_SPAN);
    return `${from}-${from + HEADER_RANGE_SPAN}`;
  });

  return ranges as [string, string, string, string];
}

/** Ключ header protection. Один на сервер: у клиента он обязан быть тем же */
export function generateHeaderProtectionKey(): string {
  return randomBytes(HEADER_PROTECTION_KEY_BYTES).toString('base64');
}

/**
 * Дозаполняет конфиг, созданный до AWG 3: S3/S4, диапазоны заголовков и ключ
 * header protection. Ключи и пиры не трогает — перевыпускать их не нужно,
 * достаточно раздать клиентам обновлённый файл. Возвращает список добавленных
 * полей — пустой, если конфиг уже актуален.
 */
export function upgradeToAwg3(
  config: IAwgServerConfig,
  enableHeaderProtection: boolean,
  fromEnv: IAwg3Options = {},
): string[] {
  const fresh = generateObfuscation();
  const upgraded: string[] = [];

  // Значения из .env подхватываются только для полей, которых в файле ещё нет:
  // конфиг остаётся источником истины для всего, что там уже записано
  for (const { field, conf } of AWG3_FIELDS) {
    if (
      field !== 'headerProtectionKey' &&
      !config.awg3[field] &&
      fromEnv[field]
    ) {
      config.awg3[field] = fromEnv[field];
      upgraded.push(conf);
    }
  }

  if (config.obfuscation.s3 === 0) {
    config.obfuscation.s3 = fresh.s3;
    upgraded.push('S3');
  }
  if (config.obfuscation.s4 === 0) {
    config.obfuscation.s4 = fresh.s4;
    upgraded.push('S4');
  }

  // Одиночное число — формат AWG 1.x: тип пакета там один и тот же всё время,
  // а в AWG 3 он выбирается из диапазона заново на каждый пакет
  const headers = [
    config.obfuscation.h1,
    config.obfuscation.h2,
    config.obfuscation.h3,
    config.obfuscation.h4,
  ];
  if (headers.some((header) => !header.includes('-'))) {
    config.obfuscation.h1 = fresh.h1;
    config.obfuscation.h2 = fresh.h2;
    config.obfuscation.h3 = fresh.h3;
    config.obfuscation.h4 = fresh.h4;
    upgraded.push('H1..H4');
  }

  if (enableHeaderProtection && !config.awg3.headerProtectionKey) {
    // Шифр заголовков берёт S1..S4 как nonce — короткие значения его ломают
    for (const key of ['s1', 's2', 's3', 's4'] as const) {
      if (config.obfuscation[key] < HEADER_PROTECTION_MIN_SIGNATURE) {
        config.obfuscation[key] = fresh[key];
        upgraded.push(key.toUpperCase());
      }
    }

    config.awg3.headerProtectionKey =
      fromEnv.headerProtectionKey ?? generateHeaderProtectionKey();
    upgraded.push('HeaderProtectionKey');
  }

  return upgraded;
}

/** `5-100` или `5`; границы нужны, чтобы проверить пересечения диапазонов */
function parseHeaderRange(value: string): { from: number; to: number } {
  const match = /^(\d+)(?:-(\d+))?$/.exec(value.trim());
  if (!match) {
    throw new Error(
      `Заголовок AmneziaWG должен быть числом или диапазоном вида 5-100, получено: «${value}»`,
    );
  }

  const from = Number(match[1]);
  const to = match[2] === undefined ? from : Number(match[2]);

  if (from > to) {
    throw new Error(
      `В диапазоне заголовка «${value}» левая граница больше правой`,
    );
  }

  return { from, to };
}

/** Бросает с понятным текстом — параметры править вручную опасно, ошибка ломает весь awg0 */
export function assertValidObfuscation(
  o: IAwgObfuscation,
  awg3: IAwg3Options = {},
): void {
  const sizes: Record<TAwgSizeKey, number> = {
    jc: o.jc,
    jmin: o.jmin,
    jmax: o.jmax,
    s1: o.s1,
    s2: o.s2,
    s3: o.s3,
    s4: o.s4,
  };

  const ints = Object.entries(sizes).filter(
    ([, value]) => !Number.isInteger(value),
  );
  if (ints.length > 0) {
    throw new Error(
      `Параметры AmneziaWG должны быть целыми числами: ${ints.map(([k]) => k).join(', ')}`,
    );
  }

  if (o.jc < 0 || o.jc > 128) {
    throw new Error('AWG_JC должен быть в диапазоне 0..128');
  }
  if (o.jmin < 0 || o.jmax > JUNK_SIZE_MAX || o.jmin >= o.jmax) {
    throw new Error(
      `Должно выполняться 0 <= AWG_JMIN < AWG_JMAX <= ${JUNK_SIZE_MAX}`,
    );
  }

  const signatures: Record<string, number> = {
    AWG_S1: o.s1,
    AWG_S2: o.s2,
    AWG_S3: o.s3,
    AWG_S4: o.s4,
  };
  const outOfRange = Object.entries(signatures).filter(
    ([, value]) => value < 0 || value > SIGNATURE_SIZE_MAX,
  );
  if (outOfRange.length > 0) {
    throw new Error(
      `${outOfRange.map(([k]) => k).join(', ')} должны быть в 0..${SIGNATURE_SIZE_MAX}`,
    );
  }
  if (o.s4 > TRANSPORT_SIGNATURE_MAX) {
    throw new Error(
      `AWG_S4 добавляется к каждому транспортному пакету — держите его в 0..${TRANSPORT_SIGNATURE_MAX}`,
    );
  }
  if (o.s1 + HANDSHAKE_SIZE_DELTA === o.s2) {
    throw new Error(
      'AWG_S1 + 56 не должно равняться AWG_S2: init- и response-пакеты станут неразличимы по размеру',
    );
  }

  if (awg3.headerProtectionKey) {
    const tooShort = Object.entries(signatures).filter(
      ([, value]) => value < HEADER_PROTECTION_MIN_SIGNATURE,
    );
    if (tooShort.length > 0) {
      throw new Error(
        `Header protection берёт S1..S4 как nonce, поэтому ${tooShort
          .map(([k]) => k)
          .join(
            ', ',
          )} должны быть не меньше ${HEADER_PROTECTION_MIN_SIGNATURE}`,
      );
    }
  }

  const ranges = [o.h1, o.h2, o.h3, o.h4].map(parseHeaderRange);
  if (ranges.some(({ from, to }) => from < HEADER_MIN || to > HEADER_MAX)) {
    throw new Error(
      `AWG_H1..AWG_H4 должны укладываться в ${HEADER_MIN}..${HEADER_MAX}`,
    );
  }

  // Пересекающиеся диапазоны делают типы пакетов неразличимыми друг от друга
  const sorted = [...ranges].sort((a, b) => a.from - b.from);
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i].from <= sorted[i - 1].to) {
      throw new Error('Диапазоны AWG_H1..AWG_H4 не должны пересекаться');
    }
  }
}

/**
 * Параметры из .env. Либо задан весь набор, либо ни одного —
 * частичный набор молча смешивать с генерацией нельзя.
 */
export function readObfuscationFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): IAwgObfuscation | null {
  const sizeKeys = Object.keys(SIZE_ENV_KEYS) as TAwgSizeKey[];
  const headerKeys = Object.keys(HEADER_ENV_KEYS) as TAwgHeaderKey[];

  const isSet = (name: string): boolean => {
    const raw = env[name];
    return raw !== undefined && raw.trim() !== '';
  };

  const missing = [
    ...sizeKeys.map((key) => SIZE_ENV_KEYS[key]),
    ...headerKeys.map((key) => HEADER_ENV_KEYS[key]),
  ].filter((name) => !isSet(name));

  if (missing.length === sizeKeys.length + headerKeys.length) return null;
  if (missing.length > 0) {
    throw new Error(
      `В .env заданы не все параметры AmneziaWG. Не хватает: ${missing.join(', ')}`,
    );
  }

  const sizes = sizeKeys.reduce(
    (acc, key) => {
      acc[key] = Number(env[SIZE_ENV_KEYS[key]]);
      return acc;
    },
    {} as Record<TAwgSizeKey, number>,
  );

  const headers = headerKeys.reduce(
    (acc, key) => {
      acc[key] = (env[HEADER_ENV_KEYS[key]] ?? '').trim();
      return acc;
    },
    {} as Record<TAwgHeaderKey, string>,
  );

  const obfuscation: IAwgObfuscation = { ...sizes, ...headers };
  assertValidObfuscation(obfuscation, readAwg3FromEnv(env));

  return obfuscation;
}

/**
 * Параметры AWG 3 из .env. В отличие от базовой обфускации они независимы друг
 * от друга, поэтому частичный набор тут допустим.
 */
export function readAwg3FromEnv(
  env: NodeJS.ProcessEnv = process.env,
): IAwg3Options {
  const options: IAwg3Options = {};

  for (const { field, env: name } of AWG3_FIELDS) {
    const raw = env[name];
    if (raw !== undefined && raw.trim() !== '') {
      options[field] = raw.trim();
    }
  }

  return options;
}

/**
 * Необязательные параметры 1.5 из .env (AWG_I1, AWG_ITIME, ...). Значения не
 * валидируются — синтаксис задаёт сам AmneziaWG, мы лишь переносим их в конфиг.
 */
export function readAdvancedFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): TAwgAdvanced {
  const advanced: TAwgAdvanced = {};

  for (const key of AWG_ADVANCED_KEYS) {
    const raw = env[`AWG_${key.toUpperCase()}`];
    if (raw !== undefined && raw.trim() !== '') {
      advanced[key] = raw.trim();
    }
  }

  return advanced;
}

function parseSectionLines(lines: string[]): Map<string, string[]> {
  const values = new Map<string, string[]>();

  for (const line of lines) {
    const withoutComment = line.split('#')[0].trim();
    if (!withoutComment) continue;

    const separator = withoutComment.indexOf('=');
    if (separator === -1) continue;

    const key = withoutComment.slice(0, separator).trim().toLowerCase();
    const value = withoutComment.slice(separator + 1).trim();
    const existing = values.get(key);

    if (existing) existing.push(value);
    else values.set(key, [value]);
  }

  return values;
}

function requireValue(values: Map<string, string[]>, key: string): string {
  const value = values.get(key)?.[0];
  if (!value) {
    throw new Error(`В конфиге AmneziaWG отсутствует обязательное поле ${key}`);
  }
  return value;
}

function requireNumber(values: Map<string, string[]>, key: string): number {
  const value = Number(requireValue(values, key));
  if (!Number.isFinite(value)) {
    throw new Error(`Поле ${key} в конфиге AmneziaWG не является числом`);
  }
  return value;
}

/** Для полей, которых нет в конфигах, созданных до AWG 3 */
function optionalNumber(
  values: Map<string, string[]>,
  key: string,
): number | null {
  const raw = values.get(key)?.[0];
  if (raw === undefined) return null;

  const value = Number(raw);
  if (!Number.isFinite(value)) {
    throw new Error(`Поле ${key} в конфиге AmneziaWG не является числом`);
  }
  return value;
}

/**
 * Свой парсер вместо wireguard-tools: пакет не знает про Jc/S1/H1 и потерял бы
 * их при перезаписи файла, а без них интерфейс поднимется без обфускации.
 */
export function parseAwgConfig(content: string): IAwgServerConfig {
  const sections: { name: string; lines: string[] }[] = [];

  for (const rawLine of content.split('\n')) {
    const line = rawLine.trim();
    const header = /^\[(\w+)\]$/.exec(line);

    if (header) {
      sections.push({ name: header[1].toLowerCase(), lines: [] });
      continue;
    }
    if (sections.length > 0) {
      sections[sections.length - 1].lines.push(line);
    }
  }

  const interfaceSection = sections.find((s) => s.name === 'interface');
  if (!interfaceSection) {
    throw new Error('В конфиге AmneziaWG нет секции [Interface]');
  }

  const iface = parseSectionLines(interfaceSection.lines);
  const obfuscation: IAwgObfuscation = {
    jc: requireNumber(iface, 'jc'),
    jmin: requireNumber(iface, 'jmin'),
    jmax: requireNumber(iface, 'jmax'),
    s1: requireNumber(iface, 's1'),
    s2: requireNumber(iface, 's2'),
    // Конфиги, созданные до AWG 3, этих полей не содержат — их дозаполняет AwgService
    s3: optionalNumber(iface, 's3') ?? 0,
    s4: optionalNumber(iface, 's4') ?? 0,
    h1: requireValue(iface, 'h1'),
    h2: requireValue(iface, 'h2'),
    h3: requireValue(iface, 'h3'),
    h4: requireValue(iface, 'h4'),
  };

  // Пакеты-имитации и параметры AWG 3 сохраняем как есть, чтобы не потерять их
  // при перезаписи файла
  const advanced: TAwgAdvanced = {};
  for (const key of AWG_ADVANCED_KEYS) {
    const value = iface.get(key.toLowerCase())?.[0];
    if (value) advanced[key] = value;
  }

  const awg3: IAwg3Options = {};
  for (const { field, conf } of AWG3_FIELDS) {
    const value = iface.get(conf.toLowerCase())?.[0];
    if (value) awg3[field] = value;
  }

  assertValidObfuscation(obfuscation, awg3);

  const peers = sections
    .filter((s) => s.name === 'peer')
    .map((section) => {
      const values = parseSectionLines(section.lines);
      return {
        publicKey: requireValue(values, 'publickey'),
        presharedKey: values.get('presharedkey')?.[0],
        allowedIps: (values.get('allowedips')?.[0] ?? '')
          .split(',')
          .map((ip) => ip.trim())
          .filter(Boolean),
      };
    });

  return {
    privateKey: requireValue(iface, 'privatekey'),
    address: requireValue(iface, 'address'),
    listenPort: requireNumber(iface, 'listenport'),
    obfuscation,
    advanced,
    awg3,
    postUp: iface.get('postup') ?? [],
    postDown: iface.get('postdown') ?? [],
    peers,
  };
}

/**
 * Строки Jc/Jmin/.../H4 (+ I1..I5 и параметры AWG 3, если заданы) — идентичны в
 * серверном и клиентском конфиге. Часть из них формально client-side, но держать
 * обе стороны одинаковыми проще, чем помнить, где расхождение безопасно.
 */
export function obfuscationLines(
  o: IAwgObfuscation,
  advanced: TAwgAdvanced = {},
  awg3: IAwg3Options = {},
): string {
  return [
    `Jc = ${o.jc}`,
    `Jmin = ${o.jmin}`,
    `Jmax = ${o.jmax}`,
    `S1 = ${o.s1}`,
    `S2 = ${o.s2}`,
    `S3 = ${o.s3}`,
    `S4 = ${o.s4}`,
    `H1 = ${o.h1}`,
    `H2 = ${o.h2}`,
    `H3 = ${o.h3}`,
    `H4 = ${o.h4}`,
    ...AWG_ADVANCED_KEYS.filter((key) => advanced[key]).map(
      (key) => `${key} = ${advanced[key]}`,
    ),
    ...AWG3_FIELDS.filter(({ field }) => awg3[field]).map(
      ({ field, conf }) => `${conf} = ${awg3[field]}`,
    ),
  ].join('\n');
}

export function serializeAwgConfig(config: IAwgServerConfig): string {
  const blocks = [
    [
      '[Interface]',
      `PrivateKey = ${config.privateKey}`,
      `Address = ${config.address}`,
      `ListenPort = ${config.listenPort}`,
      obfuscationLines(config.obfuscation, config.advanced, config.awg3),
      ...config.postUp.map((cmd) => `PostUp = ${cmd}`),
      ...config.postDown.map((cmd) => `PostDown = ${cmd}`),
    ].join('\n'),
  ];

  for (const peer of config.peers) {
    const lines = ['[Peer]', `PublicKey = ${peer.publicKey}`];
    if (peer.presharedKey) {
      lines.push(`PresharedKey = ${peer.presharedKey}`);
    }
    lines.push(`AllowedIPs = ${peer.allowedIps.join(', ')}`);
    blocks.push(lines.join('\n'));
  }

  return `${blocks.join('\n\n')}\n`;
}
