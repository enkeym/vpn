import { spawn } from 'child_process';
import { generateKeyPair, randomBytes } from 'node:crypto';
import { promisify } from 'node:util';
import type { ITunnelCredentials } from './tunnel.types';

export const WG_KEY_REGEX = /^[A-Za-z0-9+/]{42,43}={0,2}$/;
const WG_KEY_BYTES = 32;
const generateKeyPairAsync = promisify(generateKeyPair);

/**
 * AllowedIPs для awg0 — ровно «0.0.0.0/0, ::/0», с пробелом после запятой. Это
 * не косметика: AmneziaVPN определяет «полный туннель» точным сравнением со
 * строкой «AllowedIPs = 0.0.0.0/0, ::/0» (serversUiController.cpp), и при любом
 * другом написании блокирует своё раздельное туннелирование с тостом
 * «Сервер по умолчанию не поддерживает раздельное туннелирование».
 */
export const AWG_DEFAULT_ALLOWED_IPS = '0.0.0.0/0, ::/0';

/** Список через запятую из .env, нормализованный к «a, b» — с пробелом после запятой */
function normalizeCsv(rawValue: string | undefined, fallback: string): string {
  return (rawValue || fallback)
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean)
    .join(', ');
}

/** AllowedIPs клиентского конфига: значение из .env либо дефолт туннеля */
export function readAllowedIps(rawValue: string | undefined): string {
  return normalizeCsv(rawValue, AWG_DEFAULT_ALLOWED_IPS);
}

/** DNS-серверы клиентского конфига. Только IPv4: у туннеля нет IPv6-маршрута */
export function readClientDns(rawValue: string | undefined): string {
  return normalizeCsv(rawValue, '1.1.1.1, 8.8.8.8');
}

/**
 * Первый IPv4-адрес из Address интерфейса, без маски. Address может быть списком
 * («10.9.0.1/16, fd42:9::1/64»), поэтому разбирать его как одиночный адрес нельзя.
 */
export function getIpv4Address(address: string): string {
  const ipv4 = address
    .split(',')
    .map((entry) => entry.trim().split('/')[0])
    .find((entry) => entry.includes('.'));

  if (!ipv4) {
    throw new Error(`В адресе интерфейса нет IPv4: ${address}`);
  }

  return ipv4;
}

/** '10.9.0.1/16' → '10.9' — первые два октета подсети интерфейса */
export function getSubnetPrefix(address: string): string {
  const [first, second] = getIpv4Address(address).split('.');
  if (!first || !second) {
    throw new Error(`Некорректный адрес интерфейса: ${address}`);
  }
  return `${first}.${second}`;
}

/**
 * Адрес клиента в IPv6-подсети туннеля, выведенный из его IPv4: при префиксе
 * fd42:9::1/64 клиент 10.9.0.2 получает fd42:9::2. Пара считается на лету и в
 * БД не хранится — один и тот же IPv4 всегда даёт один и тот же IPv6, поэтому
 * отдельный учёт занятых v6-адресов не нужен.
 */
export function deriveClientIpv6(
  interfaceAddress6: string,
  clientIpv4: string,
): string {
  const base = interfaceAddress6.split('/')[0].trim();
  const lastColon = base.lastIndexOf(':');
  if (lastColon < 0) {
    throw new Error(`Некорректный IPv6-адрес интерфейса: ${interfaceAddress6}`);
  }

  const octets = clientIpv4.split('.').map(Number);
  if (octets.length !== 4 || octets.some((octet) => !Number.isInteger(octet))) {
    throw new Error(`Некорректный IPv4-адрес клиента: ${clientIpv4}`);
  }

  // Те же два младших октета, что задают адрес внутри /16, — только в hex
  const offset = ((octets[2] << 8) | octets[3]).toString(16);

  return `${base.slice(0, lastColon + 1)}${offset}`;
}

/** Свободный IP внутри подсети `prefix` */
export function getNextFreeIp(usedIps: Set<string>, prefix: string): string {
  const usedOffsets = new Set<number>();

  for (const ip of usedIps) {
    const parts = ip.split('.');
    if (parts.length !== 4) continue;
    if (`${parts[0]}.${parts[1]}` !== prefix) continue;

    const p = parts.map(Number);
    usedOffsets.add((p[2] << 8) | p[3]);
  }

  for (let i = 2; i < 65535; i++) {
    if (!usedOffsets.has(i)) {
      const octet3 = (i >> 8) & 0xff;
      const octet4 = i & 0xff;

      return `${prefix}.${octet3}.${octet4}`;
    }
  }

  throw new Error('Свободных IP-адресов больше нет (подсеть /16 заполнена)');
}

/**
 * Вызов `awg <args>` с необязательным stdin.
 *
 * Ключи считает тот же бинарь, что поднимает интерфейс: awg — форк wg, команды
 * genkey/pubkey/genpsk у него побитово совместимы (те же ключи Curve25519).
 * Отдельный wg в образе ради генерации ключей держать не нужно.
 */
async function runAwg(args: string[], stdin?: string): Promise<string> {
  return await new Promise<string>((resolve, reject) => {
    const proc = spawn('awg', args, { stdio: ['pipe', 'pipe', 'pipe'] });

    let stdout = '';
    let stderr = '';
    proc.stdout?.on('data', (chunk) => (stdout += chunk));
    proc.stderr?.on('data', (chunk) => (stderr += chunk));
    proc.on('error', reject);
    proc.on('close', (code) => {
      if (code === 0) resolve(stdout.trim());
      else
        reject(
          new Error(
            `awg ${args.join(' ')} завершился с кодом ${code}: ${stderr.trim()}`,
          ),
        );
    });

    if (stdin !== undefined) proc.stdin?.write(`${stdin}\n`);
    proc.stdin?.end();
  });
}

/** Приватный ключ интерфейса — `awg genkey` */
export async function generatePrivateKey(): Promise<string> {
  return await runAwg(['genkey']);
}

/** Публичный ключ из приватного — `awg pubkey` */
export async function derivePublicKey(privateKey: string): Promise<string> {
  if (!WG_KEY_REGEX.test(privateKey)) {
    throw new Error('Неверный формат приватного ключа');
  }

  return await runAwg(['pubkey'], privateKey);
}

/** Пара ключей + preshared-ключ для клиента */
export async function generateKeys(ip: string): Promise<ITunnelCredentials> {
  const keys = await generateKeyPairAsync('x25519');
  const privateKey = keys.privateKey
    .export({ format: 'der', type: 'pkcs8' })
    .subarray(-WG_KEY_BYTES)
    .toString('base64');
  const publicKey = keys.publicKey
    .export({ format: 'der', type: 'spki' })
    .subarray(-WG_KEY_BYTES)
    .toString('base64');
  const presharedKey = randomBytes(WG_KEY_BYTES).toString('base64');
  return { publicKey, privateKey, presharedKey, ip };
}
