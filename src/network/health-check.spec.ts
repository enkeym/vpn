import { createConnection, Socket } from 'node:net';
import { HEALTH_CHECK_TIMEOUT_MS, isTcpListening } from './health-check';

jest.mock('node:net', () => ({
  ...jest.requireActual<typeof import('node:net')>('node:net'),
  createConnection: jest.fn(),
}));

describe('isTcpListening', () => {
  it.each([
    ['connect', true],
    ['timeout', false],
    ['error', false],
  ] as const)(
    'returns the listener state on %s and closes the probe',
    async (event, expected) => {
      const socket = new Socket();
      const destroy = jest.spyOn(socket, 'destroy');
      const timeout = jest.spyOn(socket, 'setTimeout');
      jest.mocked(createConnection).mockReturnValue(socket);

      const result = isTcpListening(443);
      socket.emit(event, new Error('probe failure'));

      expect(await result).toBe(expected);
      expect(createConnection).toHaveBeenCalledWith({
        host: '127.0.0.1',
        port: 443,
      });
      expect(timeout).toHaveBeenCalledWith(HEALTH_CHECK_TIMEOUT_MS);
      expect(destroy).toHaveBeenCalled();
    },
  );
});
