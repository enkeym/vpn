import { getWanInterface } from '../wg/tunnel.runtime';

/**
 * Внешний интерфейс сервера. Имя NIC зависит от провайдера (eth0, ens3,
 * enp1s0...) — хардкод здесь однажды уже привёл к тому, что правило NAT молча
 * никогда не матчилось (реальный интерфейс отличался от зашитого), и трафик
 * уходил только благодаря постороннему ручному правилу на сервере.
 * AWG_WAN_IFACE — аварийный override, если авто-детект маршрута выберет не то.
 */
export async function resolveWanInterface(): Promise<string> {
  const override = process.env.AWG_WAN_IFACE?.trim();
  if (override) return override;

  const detected = await getWanInterface();
  if (!detected) {
    throw new Error(
      'Не удалось определить внешний интерфейс (ip route show default). ' +
        'Задайте его явно через AWG_WAN_IFACE.',
    );
  }

  return detected;
}
