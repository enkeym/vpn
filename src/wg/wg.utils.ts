import { WgConfig } from 'wireguard-tools';

export async function parseWgConfig(filePath: string): Promise<WgConfig> {
  const config = new WgConfig({ filePath });
  await config.parseFile();
  return config;
}

export function getNextFreeIp(usedIps: Set<string>): string {
  const BASE_IP_LONG = (10 << 24) | (8 << 16);

  for (let i = 1; i < 65535; i++) {
    if (i % 256 === 0 || i % 256 === 255) continue;

    const currentLong = BASE_IP_LONG + i;

    const candidate = [
      (currentLong >>> 24) & 255,
      (currentLong >>> 16) & 255,
      (currentLong >>> 8) & 255,
      currentLong & 255,
    ].join('.');

    if (!usedIps.has(candidate)) {
      return candidate;
    }
  }

  throw new Error('Свободных IP-адресов больше нет');
}
