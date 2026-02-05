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

function formatSubscriptionDetails(peer: TPeer): string {
  if (!peer.expiresAt) {
    return `📅 Получен: ${
      peer.createdAt
        ? new Date(peer.createdAt).toLocaleDateString('ru-RU')
        : 'Неизвестно'
    }\n⏳ Срок: ♾️ Бессрочно`;
  }

  const now = new Date();
  const expiresAt = peer.expiresAt;
  const createdAt = peer.createdAt ? new Date(peer.createdAt) : null;

  const createdText = createdAt
    ? createdAt.toLocaleDateString('ru-RU')
    : 'Неизвестно';
  const expiresText = expiresAt.toLocaleDateString('ru-RU');

  if (now > expiresAt) {
    return (
      `📅 Получен: ${createdText}\n` +
      `🔚 Истёк: ${expiresText}\n` +
      `⏰ Статус: *Срок действия истёк*`
    );
  }

  const diffMs = expiresAt.getTime() - now.getTime();
  const diffDays = Math.ceil(diffMs / (1000 * 60 * 60 * 24));

  let remainingText: string;
  if (diffDays <= 3) {
    remainingText = `⚠️ Осталось: *${diffDays} дн.* (скоро истекает)`;
  } else {
    remainingText = `✅ Осталось: *${diffDays} дн.*`;
  }

  return (
    `📅 Получен: ${createdText}\n` +
    `🔚 Действует до: ${expiresText}\n` +
    remainingText
  );
}

function getPeerStatusIcon(peer: TPeer): string {
  if (peer.paused) return '🔴';
  if (isExpired(peer)) return '🟡';
  return '🟢';
}

function getMemberDisplayName(member: TFamilyMember): string {
  return member.displayName || member.telegramId;
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

  peerDetailsKeyboard: (peer: TPeer, isAdmin: boolean = false) => {
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

    // Кнопка описания только для админов
    if (isAdmin) {
      const descriptionBtnText = peer.description
        ? '📝 Изменить описание'
        : '📝 Добавить описание';
      keyboard.text(descriptionBtnText, `edit_description:${peer.name}`);
    }

    keyboard
      .row()
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

  peerDetailsText: (peer: TPeer, isAdmin: boolean = false) => {
    const expired = isExpired(peer);
    let status: string;

    if (expired) {
      status = '🟡 Срок истёк';
    } else if (peer.paused) {
      status = '🔴 Приостановлен';
    } else {
      status = '🟢 Активен';
    }

    const subscriptionDetails = formatSubscriptionDetails(peer);

    let text =
      `⚙️ *Управление конфигом*\n\n` +
      `🏷 Имя: \`${peer.name}\`\n` +
      `🌐 IP: \`${peer.ip}\`\n` +
      `📊 Статус: ${status}\n\n` +
      subscriptionDetails;

    // Описание видят только админы
    if (isAdmin && peer.description) {
      text += `\n\n📝 *Описание:*\n${peer.description}`;
    }

    return text;
  },

  // === Группа "Семья" ===

  familyMenuTitle: (count: number) =>
    `👨‍👩‍👧‍👦 *Группа «Семья»*\n\n` +
    (count > 0 ? `Участников: ${count}` : 'Группа пуста'),

  familyMenuKeyboard: (members: TFamilyMember[]) => {
    const keyboard = new InlineKeyboard();

    keyboard.text('➕ Добавить в группу', 'family_add').row();

    members.forEach((member) => {
      const displayName = getMemberDisplayName(member);
      keyboard.text(`👤 ${displayName}`, `family_member:${member.id}`).row();
    });

    keyboard.text('« Назад в меню', 'main_menu');
    return keyboard;
  },

  addMemberPrompt:
    '➕ *Добавление в группу*\n\n' +
    'Отправьте Telegram ID пользователя:\n\n' +
    '• `123456789` — числовой ID\n\n' +
    '_Узнать ID можно через @Getmyid_bot',

  invalidInput:
    '❌ *Неверный формат*\n\n' +
    'Отправьте числовой Telegram ID:\n' +
    '• `123456789`\n\n' +
    '_Узнать ID можно через @Getmyid_bot',

  memberAdded: (member: TFamilyMember) => {
    return `✅ *Пользователь добавлен в группу*\n\n🆔 ID: \`${member.telegramId}\`\n\n_Вы можете изменить имя в настройках участника_`;
  },

  addMemberError: (msg: string) => `❌ *Ошибка:* ${msg}`,

  cancelKeyboard: () =>
    new InlineKeyboard().text('❌ Отмена', 'family_cancel_add'),

  backToFamilyKeyboard: () =>
    new InlineKeyboard().text('« К группе', 'family_menu'),

  memberDetailsText: (member: TFamilyMember, configsCount: number) => {
    const lines: string[] = [`👤 *Информация о члене группы*\n`];

    const displayName = getMemberDisplayName(member);
    lines.push(`📛 Имя: ${displayName}`);
    lines.push(`🆔 Telegram ID: \`${member.telegramId}\``);

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

    // Кнопка редактирования имени
    keyboard.text('✏️ Изменить имя', `family_edit_name:${member.id}`).row();

    if (peers.length > 0) {
      keyboard.text('📂 Конфиги', `family_member_configs:${member.id}`).row();
    }

    keyboard
      .text('🗑 Удалить из группы', `family_remove:${member.id}`)
      .row()
      .text('« К группе', 'family_menu');

    return keyboard;
  },

  memberConfigsListTitle: (displayName: string) =>
    `📂 *Конфиги ${displayName}:*`,

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

    const subscriptionDetails = formatSubscriptionDetails(peer);

    let text =
      `⚙️ *Конфиг члена группы*\n\n` +
      `🏷 Имя: \`${peer.name}\`\n` +
      `🌐 IP: \`${peer.ip}\`\n` +
      `📊 Статус: ${status}\n\n` +
      subscriptionDetails;

    if (peer.description) {
      text += `\n\n📝 *Описание:*\n${peer.description}`;
    }

    return text;
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

    const descriptionBtnText = peer.description
      ? '📝 Изменить описание'
      : '📝 Добавить описание';
    keyboard
      .text(descriptionBtnText, `family_edit_description:${peer.name}:${memberId}`)
      .row()
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

  // === Редактирование имени участника ===

  editNamePrompt: (member: TFamilyMember) => {
    const currentName = getMemberDisplayName(member);
    return (
      `✏️ *Изменение имени участника*\n\n` +
      `Текущее имя: ${currentName}\n\n` +
      `Отправьте новое имя (до 50 символов):`
    );
  },

  invalidNameInput:
    '❌ *Неверный формат*\n\n' +
    'Имя должно быть от 1 до 50 символов.',

  nameUpdated: (newName: string) =>
    `✅ *Имя обновлено*\n\nНовое имя: ${newName}`,

  editNameError: (msg: string) => `❌ *Ошибка:* ${msg}`,

  cancelEditNameKeyboard: (memberId: string) =>
    new InlineKeyboard().text('❌ Отмена', `family_cancel_edit_name:${memberId}`),

  backToMemberKeyboard: (memberId: string) =>
    new InlineKeyboard().text('« К участнику', `family_member:${memberId}`),

  // === Редактирование описания конфига ===

  editDescriptionPrompt: (peer: TPeer) => {
    const currentDesc = peer.description
      ? `Текущее описание:\n_${peer.description}_`
      : 'Описание не задано';
    return (
      `📝 *Изменение описания конфига*\n\n` +
      `🏷 Конфиг: \`${peer.name}\`\n\n` +
      `${currentDesc}\n\n` +
      `Отправьте новое описание (до 200 символов):\n` +
      `_Отправьте "-" чтобы удалить описание_`
    );
  },

  invalidDescriptionInput:
    '❌ *Неверный формат*\n\n' +
    'Описание должно быть до 200 символов.',

  descriptionUpdated: (description: string | null) =>
    description
      ? `✅ *Описание обновлено*\n\n${description}`
      : '✅ *Описание удалено*',

  editDescriptionError: (msg: string) => `❌ *Ошибка:* ${msg}`,

  cancelEditDescriptionKeyboard: (peerName: string, memberId: string) =>
    new InlineKeyboard().text(
      '❌ Отмена',
      `family_cancel_edit_description:${peerName}:${memberId}`,
    ),

  backToPeerKeyboard: (peerName: string, memberId: string) =>
    new InlineKeyboard().text(
      '« К конфигу',
      `family_peer:${peerName}:${memberId}`,
    ),

  // === Редактирование описания для своих конфигов ===

  cancelEditOwnDescriptionKeyboard: (peerName: string) =>
    new InlineKeyboard().text(
      '❌ Отмена',
      `cancel_edit_description:${peerName}`,
    ),

  backToOwnPeerKeyboard: (peerName: string) =>
    new InlineKeyboard().text('« К конфигу', `manage_peer:${peerName}`),
};
