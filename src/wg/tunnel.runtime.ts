import { exec } from 'child_process';
import { promisify } from 'util';
import * as os from 'os';
import * as path from 'path';
import { writeFile, unlink } from 'fs/promises';
import type { IPeerRuntimeStats } from './tunnel.types';

const execAsync = promisify(exec);

/**
 * Различия между туннелями сведены к паре бинарей и имени интерфейса:
 * wg/wg-quick + wg0 против awg/awg-quick + awg0.
 */
export interface ITunnelBinaries {
  /** `wg` или `awg` */
  cli: string;
  /** `wg-quick` или `awg-quick` */
  quick: string;
  interfaceName: string;
  /** Переменные окружения для quick-скрипта (userspace-реализация для awg) */
  env?: Record<string, string>;
}

/** `sudo` сбрасывает окружение, поэтому переменные передаём через `env` явно */
function withEnv(bin: ITunnelBinaries, command: string): string {
  const assignments = Object.entries(bin.env ?? {})
    .map(([key, value]) => `${key}=${value}`)
    .join(' ');

  return assignments ? `sudo env ${assignments} ${command}` : `sudo ${command}`;
}

export async function isInterfaceUp(interfaceName: string): Promise<boolean> {
  try {
    await execAsync(`ip link show ${interfaceName}`);
    return true;
  } catch {
    return false;
  }
}

export async function bringInterfaceUp(
  bin: ITunnelBinaries,
  filePath: string,
): Promise<void> {
  try {
    await execAsync(withEnv(bin, `${bin.quick} up ${filePath}`));
  } catch (error) {
    // Интерфейс мог остаться в полуподнятом состоянии — убираем за собой
    try {
      await execAsync(withEnv(bin, `${bin.quick} down ${filePath}`));
    } catch {
      // Уже опущен
    }

    throw new Error(
      `Не удалось поднять интерфейс ${bin.interfaceName}: ${
        error instanceof Error ? error.message : error
      }`,
    );
  }
}

/**
 * Применяет конфиг к живому интерфейсу без разрыва существующих сессий.
 * `strip` убирает поля, которых не понимает syncconf (Address, PostUp и т.д.).
 */
export async function syncInterface(
  bin: ITunnelBinaries,
  filePath: string,
): Promise<void> {
  const tmpConfigPath = path.join(
    os.tmpdir(),
    `${bin.interfaceName}-stripped-${Date.now()}-${process.pid}.conf`,
  );

  try {
    const { stdout: stripped } = await execAsync(
      `${bin.quick} strip ${filePath}`,
      { env: { ...process.env, ...bin.env } },
    );
    await writeFile(tmpConfigPath, stripped, { mode: 0o600 });
    await execAsync(
      `sudo ${bin.cli} syncconf ${bin.interfaceName} ${tmpConfigPath}`,
    );
  } finally {
    await unlink(tmpConfigPath).catch(() => {});
  }
}

/** Разбор `wg show <if> dump` / `awg show <if> dump` — формат идентичен */
export async function readRuntimeStats(
  bin: ITunnelBinaries,
): Promise<Map<string, IPeerRuntimeStats>> {
  const { stdout } = await execAsync(
    `${bin.cli} show ${bin.interfaceName} dump`,
  );
  const lines = stdout.trim().split('\n').filter(Boolean);
  const stats = new Map<string, IPeerRuntimeStats>();

  // Первая строка — сам интерфейс, пиры идут дальше
  for (const line of lines.slice(1)) {
    const fields = line.split('\t');
    const publicKey = fields[0];
    const latestHandshake = Number(fields[4] || 0);
    const rxBytes = Number(fields[5] || 0);
    const txBytes = Number(fields[6] || 0);

    if (!publicKey) continue;

    stats.set(publicKey, {
      publicKey,
      latestHandshakeAt:
        latestHandshake > 0 ? new Date(latestHandshake * 1000) : null,
      rxBytes: Number.isFinite(rxBytes) ? rxBytes : 0,
      txBytes: Number.isFinite(txBytes) ? txBytes : 0,
    });
  }

  return stats;
}

/** Есть ли бинарь в PATH — по нему решается, доступен ли туннель вообще */
export async function isBinaryAvailable(binary: string): Promise<boolean> {
  try {
    await execAsync(`command -v ${binary}`);
    return true;
  } catch {
    return false;
  }
}
