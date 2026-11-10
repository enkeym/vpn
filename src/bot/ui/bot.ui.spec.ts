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

  it('shows both connection channels to regular users', () => {
    const keyboard = BotUi.peerDetailsKeyboard(peer, false);
    const serialized = JSON.stringify(keyboard);

    expect(serialized).toContain('vless_menu:test-peer');
    expect(serialized).toContain('show_qr:test-peer');
    expect(serialized).toContain('get_config_file:test-peer');
    expect(JSON.stringify(BotUi.instructionsMenuKeyboard())).toContain(
      'instructions_awg',
    );
  });

  it('shows both connection channels to administrators and client cards', () => {
    const serialized = JSON.stringify(BotUi.peerDetailsKeyboard(peer, true));

    expect(serialized).toContain('vless_menu:test-peer');
    expect(serialized).toContain('show_qr:test-peer');
    expect(serialized).toContain('get_config_file:test-peer');
    const clientKeyboard = JSON.stringify(
      BotUi.clientPeerDetailsKeyboard(peer, '123'),
    );
    expect(clientKeyboard).toContain('vless_menu:test-peer');
    expect(clientKeyboard).toContain('show_qr:test-peer');
    expect(clientKeyboard).toContain('get_config_file:test-peer');
  });

  it('keeps another administrator configs read-only in admin and family menus', () => {
    const clientKeyboard = JSON.stringify(
      BotUi.clientPeerDetailsKeyboard(peer, '123', true),
    );
    expect(clientKeyboard).toContain('vless_menu:test-peer');
    expect(clientKeyboard).toContain('show_qr:test-peer');
    expect(clientKeyboard).toContain('get_config_file:test-peer');
    expect(clientKeyboard).not.toContain('admin_delete_peer:');
    expect(clientKeyboard).not.toContain('admin_toggle_peer:');
    expect(clientKeyboard).not.toContain('admin_edit_description:');
    expect(clientKeyboard).not.toContain('admin_change_duration:');

    const memberKeyboard = JSON.stringify(
      BotUi.memberPeerDetailsKeyboard(peer, 'member-id', true),
    );
    expect(memberKeyboard).toContain('vless_menu:test-peer');
    expect(memberKeyboard).toContain('show_qr:test-peer');
    expect(memberKeyboard).toContain('get_config_file:test-peer');
    expect(memberKeyboard).not.toContain('f_dp:');
    expect(memberKeyboard).not.toContain('f_tp:');
    expect(memberKeyboard).not.toContain('f_ed:');
    expect(memberKeyboard).not.toContain('f_cd:');
  });

  it('shows both connection channels in editable family member cards', () => {
    const serialized = JSON.stringify(
      BotUi.memberPeerDetailsKeyboard(peer, 'member-id'),
    );

    expect(serialized).toContain('vless_menu:test-peer');
    expect(serialized).toContain('show_qr:test-peer');
    expect(serialized).toContain('get_config_file:test-peer');
  });

  it('offers delete and description editing to the config owner', () => {
    const serialized = JSON.stringify(
      BotUi.peerDetailsKeyboard(peer, false, true),
    );

    expect(serialized).toContain('delete_peer:test-peer');
    expect(serialized).toContain('edit_description:test-peer');
    expect(serialized).not.toContain('toggle_peer:test-peer');
  });
});
