import { InlineKeyboard } from 'grammy';
import { TPeer } from 'src/peers/peers.service';

export const BotUi = {
  mainMenuKeyboard: () =>
    new InlineKeyboard()
      .text('Создать конфиг', 'create_config')
      .row()
      .text('Мои конфиги', 'list_configs'),

  backToMenuKeyboard: () => new InlineKeyboard().text('В меню', 'main_menu'),

  emptyConfigsKeyboard: () =>
    new InlineKeyboard()
      .text('Создать', 'create_config')
      .row()
      .text('Назад', 'main_menu'),

  configsListKeyboard: (peers: TPeer[]) => {
    const keyboard = new InlineKeyboard();

    peers.forEach((peer) => {
      const status = peer.paused ? '🔴' : '🟢';
      keyboard.text(`${status} ${peer.name}`, `manage_peer:${peer.name}`).row();
    });
    keyboard.text('Назад в меню', 'main_menu');
    return keyboard;
  },

  peerDetailsKeyboard: (peer: TPeer) => {
    const toggleBtnText = peer.paused ? 'Включить' : 'Пауза';
    return new InlineKeyboard()
      .text(toggleBtnText, `toggle_peer:${peer.name}`)
      .text('Удалить', `delete_peer:${peer.name}`)
      .row()
      .text('К списку', 'list_configs');
  },

  welcomeMessage: '👋 *VPN Manager*\n\nВыберите действие:',
  creatingConfig: '⏳ *Создаю конфигурацию...*',
  noConfigs: '📂 *У вас пока нет активных конфигураций.*',

  configCreated: (name: string, ip: string) =>
    `✅ Конфиг *${name}* создан!\nIP: \`${ip}\``,

  configError: (msg: string) => `❌ *Ошибка:* ${msg}`,

  configsListTitle: (count: number) => `📂 *Ваши конфигурации (${count}):*`,

  peerDetailsText: (peer: TPeer) => {
    const status = peer.paused ? '🔴 Приостановлен' : '🟢 Активен';
    return (
      `⚙️ *Управление конфигом*\n\n` +
      `🏷 Имя: \`${peer.name}\`\n` +
      `🌐 IP: \`${peer.ip}\`\n` +
      `📊 Статус: ${status}\n` +
      `📅 Создан: ${
        peer.createdAt
          ? new Date(peer.createdAt).toLocaleDateString()
          : 'Неизвестно'
      }`
    );
  },
};
