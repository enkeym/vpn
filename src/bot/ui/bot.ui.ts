import { InlineKeyboard } from 'grammy';
import { TPeer } from 'src/peers/peers.service';

function isExpired(peer: TPeer): boolean {
  if (!peer.expiresAt) return false;
  return new Date() > peer.expiresAt;
}

function formatExpirationStatus(peer: TPeer): string {
  if (!peer.expiresAt) return '♾️ Бессрочно';

  const now = new Date();
  const expiresAt = peer.expiresAt;

  if (now > expiresAt) {
    return '⏰ Истёк';
  }

  const diffMs = expiresAt.getTime() - now.getTime();
  const diffDays = Math.ceil(diffMs / (1000 * 60 * 60 * 24));

  if (diffDays <= 3) {
    return `⚠️ Осталось ${diffDays} дн.`;
  }

  return `📆 Осталось ${diffDays} дн.`;
}

function getPeerStatusIcon(peer: TPeer): string {
  if (peer.paused) return '🔴';
  if (isExpired(peer)) return '🟡';
  return '🟢';
}

export const BotUi = {
  mainMenuKeyboard: () =>
    new InlineKeyboard()
      .text('📄 Создать конфиг', 'show_create_options')
      .row()
      .text('📂 Мои конфиги', 'list_configs'),

  createConfigKeyboard: () =>
    new InlineKeyboard()
      .text('♾️ Бессрочный', 'create_config:unlimited')
      .row()
      .text('30 дней', 'create_config:30')
      .text('60 дней', 'create_config:60')
      .text('90 дней', 'create_config:90')
      .row()
      .text('« Назад', 'main_menu'),

  selectDurationTitle: '⏱ *Выберите срок действия конфига:*',

  backToMenuKeyboard: () => new InlineKeyboard().text('В меню', 'main_menu'),

  emptyConfigsKeyboard: () =>
    new InlineKeyboard()
      .text('Создать', 'create_config')
      .row()
      .text('Назад', 'main_menu'),

  configsListKeyboard: (peers: TPeer[]) => {
    const keyboard = new InlineKeyboard();

    peers.forEach((peer) => {
      const status = getPeerStatusIcon(peer);
      keyboard.text(`${status} ${peer.name}`, `manage_peer:${peer.name}`).row();
    });
    keyboard.text('Назад в меню', 'main_menu');
    return keyboard;
  },

  peerDetailsKeyboard: (peer: TPeer) => {
    const keyboard = new InlineKeyboard();
    const expired = isExpired(peer);

    // Показываем кнопку "Продлить" если конфиг истёк или на паузе
    if (peer.paused || expired) {
      keyboard.text('🔄 Продлить', `extend_peer:${peer.name}`).row();
    }

    // Кнопка включить/пауза только если конфиг не истёк
    if (!expired) {
      const toggleBtnText = peer.paused ? 'Включить' : 'Пауза';
      keyboard.text(toggleBtnText, `toggle_peer:${peer.name}`);
    }

    keyboard
      .text('Удалить', `delete_peer:${peer.name}`)
      .row()
      .text('К списку', 'list_configs');

    return keyboard;
  },

  welcomeMessage: '👋 *VPN Manager*\n\nВыберите действие:',
  creatingConfig: '⏳ *Создаю конфигурацию...*',
  noConfigs: '📂 *У вас пока нет активных конфигураций.*',

  configCreated: (name: string, ip: string, expiresAt?: Date | null) => {
    let msg = `✅ Конфиг *${name}* создан!\nIP: \`${ip}\``;
    if (expiresAt) {
      msg += `\n📅 Действует до: ${expiresAt.toLocaleDateString('ru-RU')}`;
    }
    return msg;
  },

  configError: (msg: string) => `❌ *Ошибка:* ${msg}`,

  configsListTitle: (count: number) => `📂 *Ваши конфигурации (${count}):*`,

  peerDetailsText: (peer: TPeer) => {
    const expired = isExpired(peer);
    let status: string;

    if (expired) {
      status = '🟡 Срок истёк';
    } else if (peer.paused) {
      status = '🔴 Приостановлен';
    } else {
      status = '🟢 Активен';
    }

    const expirationText = formatExpirationStatus(peer);

    return (
      `⚙️ *Управление конфигом*\n\n` +
      `🏷 Имя: \`${peer.name}\`\n` +
      `🌐 IP: \`${peer.ip}\`\n` +
      `📊 Статус: ${status}\n` +
      `⏳ Срок: ${expirationText}\n` +
      `📅 Создан: ${
        peer.createdAt
          ? new Date(peer.createdAt).toLocaleDateString('ru-RU')
          : 'Неизвестно'
      }`
    );
  },
};
