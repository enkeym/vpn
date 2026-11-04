import type { TPeer } from 'src/peers/peers.service';
import { BotUi } from './bot.ui';

describe('BotUi connection visibility', () => {
  const peer: TPeer = {
    telegramId: '123',
    name: 'test-peer',
    publicKey: 'test-public',
    privateKey: 'test-private',
    ip: '10.0.0.2',
    endpoint: 'direct.example.test:51820',
  };

  it('shows only AmneziaWG connection controls to regular users', () => {
    const keyboard = BotUi.peerDetailsKeyboard(peer, false);
    const serialized = JSON.stringify(keyboard);

    expect(serialized).not.toContain('vless_menu:');
    expect(serialized).toContain('show_qr:test-peer');
    expect(serialized).toContain('get_config_file:test-peer');
    expect(JSON.stringify(BotUi.instructionsMenuKeyboard())).toContain(
      'instructions_awg',
    );
  });

  it('shows AmneziaWG controls to administrators and client cards', () => {
    const serialized = JSON.stringify(BotUi.peerDetailsKeyboard(peer, true));

    expect(serialized).toContain('show_qr:test-peer');
    expect(serialized).toContain('get_config_file:test-peer');
    const clientKeyboard = JSON.stringify(
      BotUi.clientPeerDetailsKeyboard(peer, '123'),
    );
    expect(clientKeyboard).toContain('show_qr:test-peer');
    expect(clientKeyboard).toContain('get_config_file:test-peer');
    expect(clientKeyboard).not.toContain('vless_menu:');
  });
});
