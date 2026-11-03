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

  it('preserves AWG controls for administrators', () => {
    const serialized = JSON.stringify(
      BotUi.peerDetailsKeyboard(peer, true, true),
    );

    expect(serialized).toContain('show_qr:test-peer');
    expect(serialized).toContain('get_config_file:test-peer');
    expect(JSON.stringify(BotUi.instructionsMenuKeyboard(true))).toContain(
      'instructions_awg',
    );
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
