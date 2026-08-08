import { spawn } from 'child_process';
import { BadRequestException } from '@nestjs/common';
import type { ITunnelCredentials } from './tunnel.types';

export const WG_KEY_REGEX = /^[A-Za-z0-9+/]{42,43}={0,2}$/;

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

/** '10.9.0.1/16' → '10.9' — первые два октета подсети интерфейса */
export function getSubnetPrefix(address: string): string {
  const [first, second] = address.split('/')[0].split('.');
  if (!first || !second) {
    throw new Error(`Некорректный адрес интерфейса: ${address}`);
  }
  return `${first}.${second}`;
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
  const privateKey = await generatePrivateKey();
  const [publicKey, presharedKey] = await Promise.all([
    derivePublicKey(privateKey),
    runAwg(['genpsk']),
  ]);

  if (!publicKey || !privateKey || !presharedKey) {
    throw new BadRequestException('Не удалось сгенерировать ключи клиента');
  }

  return { publicKey, privateKey, presharedKey, ip };
}
