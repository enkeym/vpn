import { createConnection } from 'node:net';

export const HEALTH_CHECK_TIMEOUT_MS = 2000;
export const HEALTH_FAILURE_THRESHOLD = 2;

export function isTcpListening(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection({ host: '127.0.0.1', port });
    const finish = (healthy: boolean) => {
      socket.destroy();
      resolve(healthy);
    };
    socket.setTimeout(HEALTH_CHECK_TIMEOUT_MS);
    socket.once('connect', () => finish(true));
    socket.once('timeout', () => finish(false));
    socket.once('error', () => finish(false));
  });
}
