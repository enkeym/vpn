import { InlineKeyboard } from 'grammy';
import { TFamilyMember } from 'src/family/family.service';
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
  // Главное меню для обычных пользователей
  mainMenuKeyboard: () =>
    new InlineKeyboard()
      .text('📄 Создать конфиг', 'show_create_options')
      .row()
      .text('📂 Мои конфиги', 'list_configs'),

  // Главное меню для админов (с кнопкой управления группой)
  adminMenuKeyboard: () =>
    new InlineKeyboard()
      .text('📄 Создать конфиг', 'show_create_options')
      .row()
      .text('📂 Мои конфиги', 'list_configs')
      .row()
      .text('👨‍👩‍👧‍👦 Группа «Семья»', 'family_menu'),

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

  // === Группа "Семья" ===

  familyMenuTitle: (count: number) =>
    `👨‍👩‍👧‍👦 *Группа «Семья»*\n\n` +
    (count > 0 ? `Участников: ${count}` : 'Группа пуста'),

  familyMenuKeyboard: (members: TFamilyMember[]) => {
    const keyboard = new InlineKeyboard();

    keyboard.text('➕ Добавить в группу', 'family_add').row();

    members.forEach((member) => {
      // Показываем @username или просто telegramId
      const displayName = member.username
        ? `@${member.username}`
        : member.telegramId || 'Не привязан';
      keyboard.text(`👤 ${displayName}`, `family_member:${member.id}`).row();
    });

    keyboard.text('« Назад в меню', 'main_menu');
    return keyboard;
  },

  addMemberPrompt:
    '➕ *Добавление в группу*\n\n' +
    'Отправьте данные пользователя:\n\n' +
    '• `@username` — если есть username\n' +
    '• `123456789` — Telegram ID, если нет username\n\n' +
    '_Узнать ID можно через @userinfobot_',

  invalidInput:
    '❌ *Неверный формат*\n\n' +
    'Отправьте:\n' +
    '• `@username` — если есть username\n' +
    '• `123456789` — Telegram ID, если нет',

  memberAdded: (member: TFamilyMember) => {
    if (member.username) {
      return `✅ *Пользователь добавлен в группу*\n\n👤 Username: @${member.username}`;
    }
    return `✅ *Пользователь добавлен в группу*\n\n🆔 ID: \`${member.telegramId}\``;
  },

  addMemberError: (msg: string) => `❌ *Ошибка:* ${msg}`,

  cancelKeyboard: () =>
    new InlineKeyboard().text('❌ Отмена', 'family_cancel_add'),

  backToFamilyKeyboard: () =>
    new InlineKeyboard().text('« К группе', 'family_menu'),

  memberDetailsText: (member: TFamilyMember, configsCount: number) => {
    const lines: string[] = [`👤 *Информация о члене группы*\n`];

    if (member.username) {
      lines.push(`👤 Username: @${member.username}`);
    }
    if (member.telegramId) {
      lines.push(`🆔 ID: \`${member.telegramId}\``);
    }
    if (!member.telegramId) {
      lines.push(`⏳ _ID будет привязан при первом обращении к боту_`);
    }

    lines.push(`📂 Конфигов: ${configsCount}`);
    lines.push(
      `📅 Добавлен: ${
        member.createdAt
          ? new Date(member.createdAt).toLocaleDateString('ru-RU')
          : 'Неизвестно'
      }`,
    );

    return lines.join('\n');
  },

  memberDetailsKeyboard: (member: TFamilyMember, peers: TPeer[]) => {
    const keyboard = new InlineKeyboard();

    if (peers.length > 0) {
      keyboard.text('📂 Конфиги', `family_member_configs:${member.id}`).row();
    }

    keyboard
      .text('🗑 Удалить из группы', `family_remove:${member.id}`)
      .row()
      .text('« К группе', 'family_menu');

    return keyboard;
  },

  memberConfigsListTitle: (username?: string | null) =>
    `📂 *Конфиги ${username ? `@${username}` : 'пользователя'}:*`,

  memberConfigsListKeyboard: (peers: TPeer[], memberId: string) => {
    const keyboard = new InlineKeyboard();

    peers.forEach((peer) => {
      const status = getPeerStatusIcon(peer);
      keyboard
        .text(`${status} ${peer.name}`, `family_peer:${peer.name}:${memberId}`)
        .row();
    });

    keyboard.text('« Назад', `family_member:${memberId}`);
    return keyboard;
  },

  memberPeerDetailsText: (peer: TPeer) => {
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
      `⚙️ *Конфиг члена группы*\n\n` +
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

  memberPeerDetailsKeyboard: (peer: TPeer, memberId: string) => {
    const keyboard = new InlineKeyboard();
    const expired = isExpired(peer);

    // Кнопка включить/пауза
    if (!expired) {
      const toggleBtnText = peer.paused ? '▶️ Включить' : '⏸ Пауза';
      keyboard.text(
        toggleBtnText,
        `family_toggle_peer:${peer.name}:${memberId}`,
      );
    }

    keyboard
      .text(
        '📅 Изменить срок',
        `family_change_duration:${peer.name}:${memberId}`,
      )
      .row()
      .text('🗑 Удалить', `family_delete_peer:${peer.name}:${memberId}`)
      .row()
      .text('« К конфигам', `family_member_configs:${memberId}`);

    return keyboard;
  },

  changeDurationTitle: '📅 *Выберите новый срок действия:*',

  changeDurationKeyboard: (peerName: string, memberId: string) =>
    new InlineKeyboard()
      .text(
        '♾️ Бессрочный',
        `family_set_duration:${peerName}:${memberId}:unlimited`,
      )
      .row()
      .text('30 дней', `family_set_duration:${peerName}:${memberId}:30`)
      .text('60 дней', `family_set_duration:${peerName}:${memberId}:60`)
      .text('90 дней', `family_set_duration:${peerName}:${memberId}:90`)
      .row()
      .text('« Назад', `family_peer:${peerName}:${memberId}`),
};
