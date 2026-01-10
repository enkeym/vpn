import { WgConfig } from 'wireguard-tools';

export async function parseWgConfig(filePath: string): Promise<WgConfig> {
  const config = new WgConfig({ filePath });
  await config.parseFile();
  return config;
}

export function getNextFreeIp(usedIps: Set<string>): string {
  const usedOffsets = new Set<number>();

  let prefix = '10.8';

  if (usedIps.size > 0) {
    for (const ip of usedIps) {
      const parts = ip.split('.');

      if (prefix === '10.8' && parts.length >= 2) {
        prefix = `${parts[0]}.${parts[1]}`;
      }

      const p = parts.map(Number);
      const offset = (p[2] << 8) | p[3];
      usedOffsets.add(offset);
    }
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
