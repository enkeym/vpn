/** Протокол туннеля: классический WireGuard (wg0) или AmneziaWG с обфускацией (awg0) */
export type TVpnProtocol = 'wg' | 'awg';

export const VPN_PROTOCOLS: readonly TVpnProtocol[] = ['wg', 'awg'] as const;

export function isVpnProtocol(value: unknown): value is TVpnProtocol {
  return value === 'wg' || value === 'awg';
}

export interface ITunnelCredentials {
  publicKey: string;
  privateKey: string;
  presharedKey: string;
  ip: string;
}

/** Пир из БД — минимум для восстановления серверного конфига */
export interface IDbPeer {
  name: string;
  publicKey: string;
  presharedKey: string;
  ip: string;
}

export interface IPeerRuntimeStats {
  publicKey: string;
  latestHandshakeAt: Date | null;
  rxBytes: number;
  txBytes: number;
}

/** Данные существующего пира, из которых пересобирается клиентский конфиг */
export interface IClientConfigInput {
  privateKey: string;
  presharedKey: string | null;
  ip: string;
  endpoint: string;
}

/**
 * Общий контракт туннеля. Реализации: WgService (wg0) и AwgService (awg0).
 * PeersService работает только через него и не знает деталей протокола.
 */
export interface ITunnelService {
  readonly protocol: TVpnProtocol;
  readonly host: string;
  readonly port: number;

  /**
   * false — интерфейс не поднят (нет бинарей в образе или выключен в .env).
   * Выдавать новые конфиги такого протокола нельзя.
   */
  isEnabled(): boolean;

  getServerPublicKey(): Promise<string>;
  generateClientCredentials(usedIps: Set<string>): Promise<ITunnelCredentials>;
  createClientConfig(
    name: string,
    credentials: ITunnelCredentials,
  ): Promise<string>;
  buildClientConfig(peer: IClientConfigInput): Promise<string>;
  removePeer(publicKey: string): Promise<void>;
  removePeers(publicKeys: string[]): Promise<void>;
  restoreConfigs(peers: IDbPeer[]): Promise<void>;
  getPeerRuntimeStats(): Promise<Map<string, IPeerRuntimeStats>>;
}
