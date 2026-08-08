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

/**
 * Данные существующего пира, из которых пересобирается клиентский конфиг.
 *
 * Endpoint сюда не входит намеренно: туннель знает свои host и port из .env и
 * подставляет их сам. Пока endpoint приходил из БД, смена AWG_PORT молча
 * оставляла всех ранее созданных пиров со старым портом — конфиг скачивался,
 * но подключиться было уже некуда.
 */
export interface IClientConfigInput {
  privateKey: string;
  presharedKey: string | null;
  ip: string;
}
