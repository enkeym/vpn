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

  it('shows only VLESS connection controls to regular users', () => {
    const keyboard = BotUi.peerDetailsKeyboard(peer, false, true);
    const serialized = JSON.stringify(keyboard);

    expect(serialized).toContain('vless_menu:test-peer');
    expect(serialized).not.toContain('show_qr:');
    expect(serialized).not.toContain('get_config_file:');
    expect(JSON.stringify(BotUi.instructionsMenuKeyboard())).not.toContain(
      'instructions_awg',
    );
  });

  it('hides AWG controls from administrators and client cards', () => {
    const serialized = JSON.stringify(
      BotUi.peerDetailsKeyboard(peer, true, true),
    );

    expect(serialized).not.toContain('show_qr:');
    expect(serialized).not.toContain('get_config_file:');
    expect(JSON.stringify(BotUi.instructionsMenuKeyboard())).not.toContain(
      'instructions_awg',
    );
    const clientKeyboard = JSON.stringify(
      BotUi.clientPeerDetailsKeyboard(peer, '123'),
    );
    expect(clientKeyboard).not.toContain('admin_qr:');
    expect(clientKeyboard).not.toContain('admin_get_file:');
    expect(clientKeyboard).toContain('vless_menu:test-peer');
  });

  it('does not reveal AWG when VLESS is unavailable', () => {
    const serialized = JSON.stringify(
      BotUi.peerDetailsKeyboard(peer, false, false),
    );

    expect(serialized).not.toContain('show_qr:');
    expect(serialized).not.toContain('get_config_file:');
    expect(serialized).not.toContain('vless_menu:');
  });
});
