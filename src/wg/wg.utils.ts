import { spawn } from 'child_process';
import { WgConfig } from 'wireguard-tools';
import { BadRequestException } from '@nestjs/common';
import type { ITunnelCredentials } from './tunnel.types';

export const WG_KEY_REGEX = /^[A-Za-z0-9+/]{42,43}={0,2}$/;

export async function parseWgConfig(filePath: string): Promise<WgConfig> {
  const config = new WgConfig({ filePath });
  await config.parseFile();
  return config;
}

/**
 * AllowedIPs для wg0. Только IPv4: туннель чисто четвёртой версии — адрес
 * интерфейса 10.8.0.1/16, NAT настроен одним iptables, IPv6-адрес клиенту не
 * выдаётся. С «::/0» официальный клиент WireGuard честно поднимает маршрут по
 * умолчанию для IPv6 и роняет весь IPv6-трафик в туннель, откуда тот уже никуда
 * не идёт: сеть без IPv6 работает, а сотовый оператор или домашний провайдер с
 * IPv6 даёт «подключено, но интернета нет». IPv6 в обход туннеля — осознанный
 * размен: утечка IPv6-адреса против неработающего VPN.
 */
export const WG_DEFAULT_ALLOWED_IPS = '0.0.0.0/0';

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

/** AllowedIPs клиентского конфига: значение из .env либо дефолт своего туннеля */
export function readAllowedIps(
  rawValue: string | undefined,
  fallback: string,
): string {
  return normalizeCsv(rawValue, fallback);
}

/** DNS-серверы клиентского конфига. Только IPv4: у туннеля нет IPv6-маршрута */
export function readClientDns(rawValue: string | undefined): string {
  return normalizeCsv(rawValue, '1.1.1.1, 8.8.8.8');
}

/** '10.8.0.1/16' → '10.8' — первые два октета подсети интерфейса */
export function getSubnetPrefix(address: string): string {
  const [first, second] = address.split('/')[0].split('.');
  if (!first || !second) {
    throw new Error(`Некорректный адрес интерфейса: ${address}`);
  }
  return `${first}.${second}`;
}

/**
 * Свободный IP внутри подсети `prefix`. Адреса других подсетей (второй туннель)
 * игнорируются — у каждого интерфейса свой независимый пул.
 */
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
 * Публичный ключ из приватного через `wg pubkey`.
 * AmneziaWG использует те же ключи Curve25519, поэтому подходит обоим туннелям.
 */
export async function derivePublicKey(privateKey: string): Promise<string> {
  if (!WG_KEY_REGEX.test(privateKey)) {
    throw new Error('Неверный формат приватного ключа');
  }

  return await new Promise<string>((resolve, reject) => {
    const proc = spawn('wg', ['pubkey'], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    proc.stdout?.on('data', (chunk) => (stdout += chunk));
    proc.on('error', reject);
    proc.on('close', (code) => {
      if (code === 0) resolve(stdout.trim());
      else reject(new Error(`wg pubkey exited with code ${code}`));
    });
    proc.stdin?.write(privateKey + '\n');
    proc.stdin?.end();
  });
}

/** Пара ключей + preshared-ключ для клиента (общее для wg0 и awg0) */
export async function generateKeys(ip: string): Promise<ITunnelCredentials> {
  const client = new WgConfig({});
  await client.generateKeys({ preSharedKey: true });

  if (
    !client.publicKey ||
    !client.wgInterface.privateKey ||
    !client.preSharedKey
  ) {
    throw new BadRequestException('Не удалось сгенерировать ключи клиента');
  }

  return {
    publicKey: client.publicKey,
    privateKey: client.wgInterface.privateKey,
    presharedKey: client.preSharedKey,
    ip,
  };
}
