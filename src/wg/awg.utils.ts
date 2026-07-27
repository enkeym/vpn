import { randomInt } from 'node:crypto';

/**
 * Параметры обфускации AmneziaWG. Должны совпадать на сервере и у клиента:
 * при расхождении хендшейк не проходит вообще.
 *
 * Jc/Jmin/Jmax — мусорные пакеты перед хендшейком, S1/S2 — добивка init/response
 * пакетов, H1..H4 — подменённые типы заголовков (у обычного WireGuard это 1..4).
 */
export interface IAwgObfuscation {
  jc: number;
  jmin: number;
  jmax: number;
  s1: number;
  s2: number;
  h1: number;
  h2: number;
  h3: number;
  h4: number;
}

/**
 * Параметры обфускации AmneziaWG 1.5 (I1..I5 — пакеты-имитации других протоколов,
 * J1..J3 и Itime — управление мусорным трафиком). Опциональны и обратно
 * совместимы: клиент без их поддержки работает на базовом наборе выше.
 *
 * Значения имеют собственный синтаксис (`<b 0x...><c><t><r 10>` и т.п.) и
 * пробрасываются в конфиг как есть — задаются в .env целиком.
 */
export type TAwgAdvanced = Partial<Record<TAwgAdvancedKey, string>>;

export type TAwgAdvancedKey =
  | 'I1'
  | 'I2'
  | 'I3'
  | 'I4'
  | 'I5'
  | 'J1'
  | 'J2'
  | 'J3'
  | 'Itime';

export const AWG_ADVANCED_KEYS: readonly TAwgAdvancedKey[] = [
  'I1',
  'I2',
  'I3',
  'I4',
  'I5',
  'J1',
  'J2',
  'J3',
  'Itime',
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
  postUp: string[];
  postDown: string[];
  peers: IAwgServerPeer[];
}

/** Типы заголовков 1..4 заняты самим протоколом — подмены начинаются с 5 */
const HEADER_MIN = 5;
const HEADER_MAX = 2_147_483_647;
/** Верхняя граница размера мусора: пакет не должен вылезать за MTU */
const JUNK_SIZE_MAX = 1280;
/** Предел добивки хендшейк-пакетов в amneziawg-go */
const SIGNATURE_SIZE_MAX = 1132;
/** Разница размеров init- и response-пакетов WireGuard */
const HANDSHAKE_SIZE_DELTA = 56;

const ENV_KEYS: Record<keyof IAwgObfuscation, string> = {
  jc: 'AWG_JC',
  jmin: 'AWG_JMIN',
  jmax: 'AWG_JMAX',
  s1: 'AWG_S1',
  s2: 'AWG_S2',
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

  const headers = new Set<number>();
  while (headers.size < 4) {
    headers.add(randomInt(HEADER_MIN, HEADER_MAX));
  }
  const [h1, h2, h3, h4] = [...headers];

  return { jc: randomInt(3, 11), jmin: 40, jmax: 70, s1, s2, h1, h2, h3, h4 };
}

/** Бросает с понятным текстом — параметры править вручную опасно, ошибка ломает весь awg0 */
export function assertValidObfuscation(o: IAwgObfuscation): void {
  const ints = Object.entries(o).filter(
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
  if (
    o.s1 < 0 ||
    o.s2 < 0 ||
    o.s1 > SIGNATURE_SIZE_MAX ||
    o.s2 > SIGNATURE_SIZE_MAX
  ) {
    throw new Error(`AWG_S1 и AWG_S2 должны быть в 0..${SIGNATURE_SIZE_MAX}`);
  }
  if (o.s1 + HANDSHAKE_SIZE_DELTA === o.s2) {
    throw new Error(
      'AWG_S1 + 56 не должно равняться AWG_S2: init- и response-пакеты станут неразличимы по размеру',
    );
  }

  const headers = [o.h1, o.h2, o.h3, o.h4];
  if (headers.some((h) => h < HEADER_MIN || h > HEADER_MAX)) {
    throw new Error(
      `AWG_H1..AWG_H4 должны быть в ${HEADER_MIN}..${HEADER_MAX}`,
    );
  }
  if (new Set(headers).size !== headers.length) {
    throw new Error('AWG_H1..AWG_H4 должны быть различными');
  }
}

/**
 * Параметры из .env. Либо задан весь набор, либо ни одного —
 * частичный набор молча смешивать с генерацией нельзя.
 */
export function readObfuscationFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): IAwgObfuscation | null {
  const keys = Object.keys(ENV_KEYS) as (keyof IAwgObfuscation)[];
  const present = keys.filter((key) => {
    const raw = env[ENV_KEYS[key]];
    return raw !== undefined && raw.trim() !== '';
  });

  if (present.length === 0) return null;

  const missing = keys.filter((key) => !present.includes(key));
  if (missing.length > 0) {
    throw new Error(
      `В .env заданы не все параметры AmneziaWG. Не хватает: ${missing
        .map((key) => ENV_KEYS[key])
        .join(', ')}`,
    );
  }

  const obfuscation = keys.reduce((acc, key) => {
    acc[key] = Number(env[ENV_KEYS[key]]);
    return acc;
  }, {} as IAwgObfuscation);

  assertValidObfuscation(obfuscation);
  return obfuscation;
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
    h1: requireNumber(iface, 'h1'),
    h2: requireNumber(iface, 'h2'),
    h3: requireNumber(iface, 'h3'),
    h4: requireNumber(iface, 'h4'),
  };
  assertValidObfuscation(obfuscation);

  // Параметры 1.5 сохраняем как есть, чтобы не потерять их при перезаписи файла
  const advanced: TAwgAdvanced = {};
  for (const key of AWG_ADVANCED_KEYS) {
    const value = iface.get(key.toLowerCase())?.[0];
    if (value) advanced[key] = value;
  }

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
    postUp: iface.get('postup') ?? [],
    postDown: iface.get('postdown') ?? [],
    peers,
  };
}

/**
 * Строки Jc/Jmin/.../H4 (+ параметры 1.5, если заданы) — идентичны в серверном и
 * клиентском конфиге, расхождение любого значения ломает хендшейк.
 */
export function obfuscationLines(
  o: IAwgObfuscation,
  advanced: TAwgAdvanced = {},
): string {
  return [
    `Jc = ${o.jc}`,
    `Jmin = ${o.jmin}`,
    `Jmax = ${o.jmax}`,
    `S1 = ${o.s1}`,
    `S2 = ${o.s2}`,
    `H1 = ${o.h1}`,
    `H2 = ${o.h2}`,
    `H3 = ${o.h3}`,
    `H4 = ${o.h4}`,
    ...AWG_ADVANCED_KEYS.filter((key) => advanced[key]).map(
      (key) => `${key} = ${advanced[key]}`,
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
      obfuscationLines(config.obfuscation, config.advanced),
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
