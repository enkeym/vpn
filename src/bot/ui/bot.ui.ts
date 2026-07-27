import { InlineKeyboard } from 'grammy';
import { TFamilyMember } from 'src/family/family.service';
import { TPeer } from 'src/peers/peers.service';
import type { TVpnProtocol } from 'src/wg/tunnel.types';

// Экранирование специальных символов Markdown
function escapeMarkdown(text: string): string {
  return text.replace(/([_*[\]()~`>#+\-=|{}.!\\])/g, '\\$1');
}

function isExpired(peer: TPeer): boolean {
  if (!peer.expiresAt) return false;
  return new Date() > peer.expiresAt;
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

/**
 * Подпись протокола: у AmneziaWG другое приложение и другая инструкция.
 * У конфигов, созданных до появления awg, поле может быть не заполнено — это wg.
 */
function getProtocolLabel(protocol?: TVpnProtocol): string {
  return protocol === 'awg' ? '🥷 AmneziaWG' : '🛡 WireGuard';
}

function getMemberDisplayName(member: TFamilyMember, escape = false): string {
  const name = member.displayName || member.telegramId;
  return escape ? escapeMarkdown(name) : name;
}

export const BotUi = {
  // Главное меню для обычных пользователей (showTrial — показывать кнопку пробного периода,
  // showGetVpn — показывать кнопку покупки; временно скрывается флагом HIDE_USER_PAYMENT_MENU)
  mainMenuKeyboard: (showTrial = false, showGetVpn = true) => {
    const kb = new InlineKeyboard();
    if (showTrial) {
      kb.text('🆓 Пробный период', 'create_trial_config').row();
    }
    if (showGetVpn) {
      kb.text('📄 Получить VPN', 'show_create_options').row();
    }
    return kb
      .text('📂 Мои конфиги', 'list_configs')
      .row()
      .text('📖 Инструкция', 'show_instructions');
  },

  // Главное меню для членов семьи
  familyMemberMenuKeyboard: (showTrial = false) => {
    const kb = new InlineKeyboard();
    if (showTrial) {
      kb.text('🆓 Пробный период', 'create_trial_config').row();
    }
    kb.text('📄 Получить VPN', 'show_create_options').row();
    return kb
      .text('📂 Мои конфиги', 'list_configs')
      .row()
      .text('📖 Инструкция', 'show_instructions');
  },

  // Главное меню для админов (2 кнопки в ряд — чтобы всё было видно на мобильных)
  adminMenuKeyboard: (showTrial = false) => {
    const kb = new InlineKeyboard();
    if (showTrial) {
      kb.text('🆓 Пробный период', 'create_trial_config').row();
    }
    kb.text('📄 Получить VPN', 'show_create_options').row();
    return kb
      .text('📂 Мои конфиги', 'list_configs')
      .row()
      .text('👨‍👩‍👧‍👦 Семья', 'family_menu')
      .text('🔍 Поиск клиента', 'admin_search')
      .row()
      .text('📊 Статистика', 'admin_stats')
      .text('📈 Аналитика', 'admin_analytics')
      .row()
      .text('📖 Инструкция', 'show_instructions');
  },

  adminStatsText: (stats: {
    totalConfigs: number;
    uniqueUsers: number;
    activeConfigs: number;
    pausedConfigs: number;
    expiredConfigs: number;
    expiringSoonConfigs: number;
    unlimitedConfigs: number;
    familyMembersCount: number;
    blockedUsersCount: number;
  }) =>
    '📊 *Статистика*\n\n' +
    '📄 *Конфиги*\n' +
    `  Всего: *${stats.totalConfigs}* | Активных: *${stats.activeConfigs}* | На паузе: *${stats.pausedConfigs}*\n` +
    `  Истекших: *${stats.expiredConfigs}* | Истекают в течение 7 дн.: *${stats.expiringSoonConfigs}*\n` +
    `  Бессрочных: *${stats.unlimitedConfigs}*\n\n` +
    `👤 Пользователей (уникальных): *${stats.uniqueUsers}*\n\n` +
    `👨‍👩‍👧‍👦 В группе «Семья»: *${stats.familyMembersCount}*\n` +
    `🚫 Заблокировано: *${stats.blockedUsersCount}*`,

  adminStatsKeyboard: () => new InlineKeyboard().text('« В меню', 'main_menu'),

  // === Аналитика конфигов (для админа) ===

  analyticsMenuTitle: '📈 *Аналитика конфигов*\n\nВыберите раздел:',

  analyticsMenuKeyboard: () =>
    new InlineKeyboard()
      .text('📋 Сводка', 'admin_analytics_overview')
      .row()
      .text('📅 По срокам', 'admin_analytics_duration')
      .row()
      .text('🆓 Пробные', 'admin_analytics_trial')
      .row()
      .text('🆕 Последние созданные', 'admin_analytics_recent')
      .row()
      .text('⏰ Истекают скоро', 'admin_analytics_expiring')
      .row()
      .text('« В меню', 'main_menu'),

  analyticsOverviewText: (data: {
    totalConfigs: number;
    uniqueUsers: number;
    activeConfigs: number;
    pausedConfigs: number;
    expiredConfigs: number;
    expiringSoonConfigs: number;
    unlimitedConfigs: number;
    trialConfigs: number;
    configsWithDescription: number;
    configsCreatedToday: number;
    configsCreatedThisWeek: number;
  }) =>
    '📋 *Сводка по конфигам*\n\n' +
    '📄 *Общее*\n' +
    `  Всего: *${data.totalConfigs}* | Пользователей: *${data.uniqueUsers}*\n\n` +
    '📊 *По статусу*\n' +
    `  🟢 Активных: *${data.activeConfigs}*\n` +
    `  🔴 На паузе: *${data.pausedConfigs}*\n` +
    `  🟡 Истекших: *${data.expiredConfigs}*\n` +
    `  ⏰ Истекают в течение 7 дн.: *${data.expiringSoonConfigs}*\n\n` +
    '📅 *По типу*\n' +
    `  ♾️ Бессрочных: *${data.unlimitedConfigs}*\n` +
    `  🆓 Пробных: *${data.trialConfigs}*\n` +
    `  📝 С описанием: *${data.configsWithDescription}*\n\n` +
    '🆕 *Создано*\n' +
    `  Сегодня: *${data.configsCreatedToday}*\n` +
    `  За 7 дней: *${data.configsCreatedThisWeek}*`,

  analyticsByDurationText: (
    items: { days: number | null; count: number }[],
  ) => {
    const lines = ['📅 *Конфиги по сроку действия*\n\n'];
    for (const { days, count } of items) {
      const label = days === null ? '♾️ Бессрочные' : `${days} дн.`;
      lines.push(`  ${label}: *${count}*`);
    }
    return lines.join('\n');
  },

  analyticsTrialText: (count: number) =>
    `🆓 *Пробные конфиги*\n\nВсего: *${count}*`,

  analyticsRecentText: (
    configs: Array<{
      name: string;
      telegramId: string;
      username: string | null;
      ip: string;
      createdAt: Date | null;
      expiresAt: Date | null;
      paused: boolean;
      isTrial: boolean;
    }>,
  ) => {
    if (configs.length === 0) {
      return '🆕 *Последние созданные конфиги*\n\n_За 7 дней конфигов не создано_';
    }
    const lines = ['🆕 *Последние созданные (7 дней)*\n'];
    for (const c of configs) {
      const status = c.paused ? '🔴' : '🟢';
      const trial = c.isTrial ? ' 🆓' : '';
      const exp = c.expiresAt ? c.expiresAt.toLocaleDateString('ru-RU') : '♾️';
      const created = c.createdAt
        ? c.createdAt.toLocaleDateString('ru-RU')
        : '—';
      lines.push(
        `${status} \`${c.name}\` ${c.ip} | ${created} → ${exp}${trial}`,
      );
    }
    return lines.join('\n');
  },

  analyticsExpiringText: (
    configs: Array<{
      name: string;
      telegramId: string;
      ip: string;
      expiresAt: Date | null;
    }>,
  ) => {
    if (configs.length === 0) {
      return '⏰ *Истекают в течение 7 дней*\n\n_Нет конфигов, истекающих скоро_';
    }
    const lines = ['⏰ *Истекают в течение 7 дней*\n'];
    for (const c of configs) {
      const exp = c.expiresAt ? c.expiresAt.toLocaleDateString('ru-RU') : '—';
      lines.push(`  \`${c.name}\` ${c.ip} | до ${exp} | ID: ${c.telegramId}`);
    }
    return lines.join('\n');
  },

  backToAnalyticsKeyboard: () =>
    new InlineKeyboard().text('« К аналитике', 'admin_analytics'),

  createConfigKeyboard: () =>
    new InlineKeyboard()
      .text('♾️ Бессрочный', 'create_config:unlimited')
      .row()
      .text('🔥 30 дней', 'create_config:30')
      .text('💎 60 дней', 'create_config:60')
      .text('👑 90 дней', 'create_config:90')
      .row()
      .text('« Назад в меню', 'main_menu'),

  selectDurationTitle: '⏱ *Выберите срок действия конфига:*',

  // === Выбор протокола ===

  selectProtocolTitle:
    '🔐 *Выберите тип подключения*\n\n' +
    '🛡 *WireGuard* — обычный вариант. Быстрый, работает в официальном приложении WireGuard на любой платформе.\n\n' +
    '🥷 *AmneziaWG* — тот же VPN, но трафик замаскирован. Берите, если обычный конфиг блокируется или отваливается.\n' +
    '⚠️ _Требует приложение AmneziaVPN — официальный клиент WireGuard такой конфиг не откроет._',

  /**
   * `actionPrefix` — всё до протокола в callback_data (напр. `create_config:30`),
   * к нему добавляется `:wg` или `:awg`.
   */
  selectProtocolKeyboard: (actionPrefix: string, backCallback = 'main_menu') =>
    new InlineKeyboard()
      .text('🛡 WireGuard', `${actionPrefix}:wg`)
      .row()
      .text('🥷 AmneziaWG (обход блокировок)', `${actionPrefix}:awg`)
      .row()
      .text('« Назад', backCallback),

  // Меню оплаты для обычных пользователей (30, 60, 90 дней)
  paymentPlansTitle: (hasDiscount: boolean, testPayment = false) =>
    '💳 *Тарифы TUNEL VPN*\n\n' +
    'Выберите срок — сразу откроется счёт ЮKassa. После успешной оплаты конфиг придёт в этот чат автоматически.\n\n' +
    '📱 _Конфиг подходит для Android, iOS, Windows, macOS, Linux_\n' +
    '🛡 _Шифрование, обход блокировок, стриминг_\n\n' +
    (hasDiscount
      ? '🎁 *Разовая акция:* скидка на 60 или 90 дней при первой покупке.\n\n'
      : '') +
    (testPayment
      ? '⚠️ TEST\\_PAYMENT: в ЮKassa списывается *1 ₽* за любой тариф.\n\n'
      : ''),

  paymentMenuUnavailable:
    '💳 *Оплата временно недоступна*\n\n' +
    'Покупка и продление подписки сейчас отключены. Попробуйте позже.',

  paymentPlansKeyboard: (hasDiscount: boolean, testPayment = false) => {
    const kb = new InlineKeyboard();
    const p = (n: number) => (testPayment ? `1 ₽ (тест)` : `${n} ₽`);
    kb.text(`🔥 30 дней — ${p(99)}`, 'pay_plan:30').row();
    kb.text(
      hasDiscount ? `💎 60 дней — ${p(143)} 🎁` : `💎 60 дней — ${p(179)}`,
      'pay_plan:60',
    ).row();
    kb.text(
      hasDiscount ? `👑 90 дней — ${p(199)} 🎁` : `👑 90 дней — ${p(249)}`,
      'pay_plan:90',
    ).row();
    kb.text('« Назад в меню', 'main_menu');
    return kb;
  },

  /** Клавиатура тарифов для продления существующего конфига */
  paymentPlansKeyboardForExtend: (
    peerName: string,
    hasDiscount: boolean,
    testPayment = false,
  ) => {
    const kb = new InlineKeyboard();
    const p = (n: number) => (testPayment ? `1 ₽ (тест)` : `${n} ₽`);
    kb.text(`🔥 30 дней — ${p(99)}`, `extend_pay_plan:30:${peerName}`).row();
    kb.text(
      hasDiscount ? `💎 60 дней — ${p(143)} 🎁` : `💎 60 дней — ${p(179)}`,
      `extend_pay_plan:60:${peerName}`,
    ).row();
    kb.text(
      hasDiscount ? `👑 90 дней — ${p(199)} 🎁` : `👑 90 дней — ${p(249)}`,
      `extend_pay_plan:90:${peerName}`,
    ).row();
    kb.text('« Назад в меню', 'main_menu');
    return kb;
  },

  paymentPlanPrices: { 30: 99, 60: 179, 90: 249 } as Record<number, number>,
  paymentPlanDiscountedPrices: { 60: 143, 90: 199 } as Record<number, number>,

  paymentSuccessTitle:
    '✅ *Оплата прошла успешно!*\n\n' +
    'Создаю ваш конфиг... Через секунду вы получите файл.\n\n' +
    '_Далее: откройте раздел «Инструкция» и выберите вашу платформу для пошаговой настройки._',

  backToMenuKeyboard: () => new InlineKeyboard().text('В меню', 'main_menu'),

  /** После выдачи .conf — те же действия, что в главном меню (инструкция + меню). */
  configDeliveredKeyboard: (peerName?: string) => {
    const kb = new InlineKeyboard();
    if (peerName) {
      kb.text('📂 Меню конфига', `manage_peer:${peerName}`).row();
    }
    return kb
      .text('📖 Инструкция', 'show_instructions')
      .row()
      .text('В меню', 'main_menu');
  },

  emptyConfigsKeyboard: (showGetVpn = true) => {
    const kb = new InlineKeyboard();
    if (showGetVpn) {
      kb.text('📄 Получить VPN', 'show_create_options').row();
    }
    return kb.text('« Назад в меню', 'main_menu');
  },

  configsListKeyboard: (peers: TPeer[]) => {
    const keyboard = new InlineKeyboard();

    peers.forEach((peer) => {
      const status = getPeerStatusIcon(peer);
      const protocol = peer.protocol === 'awg' ? ' 🥷' : '';
      keyboard
        .text(`${status} ${peer.name}${protocol}`, `manage_peer:${peer.name}`)
        .row();
    });
    keyboard.text('« Назад в меню', 'main_menu');
    return keyboard;
  },

  peerDetailsKeyboard: (peer: TPeer, isAdmin: boolean = false) => {
    const keyboard = new InlineKeyboard();
    const expired = isExpired(peer);

    // Кнопка QR-кода всегда первая
    keyboard.text('📷 QR-код', `show_qr:${peer.name}`).row();

    // Кнопка получения файла конфига
    keyboard.text('📄 Получить файл', `get_config_file:${peer.name}`).row();

    // Показываем кнопку "Продлить" если конфиг истёк или на паузе
    if (peer.paused || expired) {
      keyboard.text('🔄 Продлить', `extend_peer:${peer.name}`).row();
    }

    if (isAdmin && !expired) {
      const toggleBtnText = peer.paused ? 'Включить' : 'Пауза';
      keyboard.text(toggleBtnText, `toggle_peer:${peer.name}`);
    }

    if (isAdmin) {
      const descriptionBtnText = peer.description
        ? '📝 Изменить описание'
        : '📝 Добавить описание';
      keyboard.text(descriptionBtnText, `edit_description:${peer.name}`);
    }

    if (!expired) {
      keyboard.row().text('🔁 Заменить конфиг', `replace_peer:${peer.name}`);
    }

    if (isAdmin) {
      keyboard.row().text('Удалить', `delete_peer:${peer.name}`);
    }

    keyboard.row().text('К списку', 'list_configs');

    return keyboard;
  },

  // === Приветственные сообщения ===

  welcomeMessageAdmin:
    '👋 *Добро пожаловать, Администратор!*\n\n' +
    '🔧 Вы имеете полный доступ к управлению TUNEL VPN:\n' +
    '• Создание и управление конфигами\n' +
    '• Управление группой «Семья»\n' +
    '• Поиск и управление клиентами\n' +
    '• Блокировка/разблокировка пользователей\n\n' +
    'Выберите действие:',

  welcomeMessageFamily:
    '👋 *Добро пожаловать в TUNEL VPN!*\n\n' +
    '📍 *Сервер:* Финляндия\n' +
    '⚡ *Скорость:* до *200 Мбит/с*\n' +
    '🛡 *Защищённый доступ* к сайтам, стримингу и сервисам\n\n' +
    '🏠 Вы являетесь членом группы «Семья».\n\n' +
    'Вам доступно:\n' +
    '• 📄 Создание VPN конфигов\n' +
    '• 📂 Управление своими конфигами\n' +
    '• 📖 Инструкции по установке\n\n' +
    '_При возникновении вопросов обратитесь к администратору._\n\n' +
    'Выберите действие:',

  welcomeMessageUser:
    '👋 *Добро пожаловать в TUNEL VPN!*\n\n' +
    '📍 *Сервер:* Финляндия\n' +
    '⚡ *Скорость:* до *200 Мбит/с*\n' +
    '🛡 *Защищённый доступ* — обход блокировок, стриминг, приватность\n\n' +
    'С TUNEL VPN вы получаете:\n' +
    '• 🔐 Шифрование трафика\n' +
    '• 🌍 Свободу доступа к сайтам\n' +
    '• 🚀 Стабильное соединение\n' +
    '• 📱 Поддержку всех устройств\n' +
    '• 🎁 Пробный конфиг на 3 дня — один раз для каждого пользователя\n\n' +
    'Выберите действие 👇',

  welcomeMessage: '👋 *TUNEL VPN*\n\nВыберите действие:',
  creatingConfig: '⏳ *Создаю конфигурацию...*',
  noConfigs:
    '📂 *У вас пока нет конфигураций*\n\n' +
    'Нажмите «Получить VPN», чтобы:\n' +
    '• Получить пробный конфиг на 3 дня (_бесплатно, один раз_)\n' +
    '• Или выбрать тариф 30, 60 или 90 дней\n\n' +
    'После оплаты вы получите файл конфигурации и сможете подключиться за 2–3 минуты по инструкции.',

  configCreated: (
    name: string,
    ip: string,
    expiresAt?: Date | null,
    protocol: TVpnProtocol = 'wg',
  ) => {
    const app = protocol === 'awg' ? 'AmneziaVPN' : 'WireGuard';

    let msg =
      `✅ *Конфиг ${name} создан!*\n\n` +
      `🔐 Тип: ${getProtocolLabel(protocol)}\n` +
      `🌐 IP: \`${ip}\`\n`;
    if (expiresAt) {
      msg += `📅 Действует до: ${expiresAt.toLocaleDateString('ru-RU')}\n\n`;
    } else {
      msg += '\n';
    }
    msg +=
      '*Дальнейшие шаги:*\n' +
      `1. Откройте файл в приложении ${app}\n` +
      '2. Нажмите «Подключить» в приложении\n' +
      '3. Готово — VPN активен\n\n' +
      (protocol === 'awg'
        ? '⚠️ _Этот конфиг открывается только в AmneziaVPN — официальный клиент WireGuard его не примет._\n\n'
        : '') +
      '_Подробная инструкция для каждой платформы — в разделе «Инструкция»._\n\n' +
      '_На телефоне можно использовать кнопку «QR-код» в карточке конфига для быстрой настройки._';
    return msg;
  },

  configError: (msg: string) => `❌ *Ошибка:* ${msg}`,

  // Замена конфига
  configReplaced: (name: string, ip: string, expiresAt?: Date | null) => {
    let msg = `✅ Конфиг *${name}* успешно заменён!\n\n🌐 Новый IP: \`${ip}\``;
    if (expiresAt) {
      msg += `\n📅 Действует до: ${expiresAt.toLocaleDateString('ru-RU')}`;
    } else {
      msg += '\n⏳ Срок: ♾️ Бессрочно';
    }
    msg += '\n\n_Скачайте новый конфиг и удалите старый из приложения._';
    return msg;
  },

  replaceNotAvailable: (hoursLeft: number) =>
    `⏳ *Замена конфига пока недоступна*\n\nВы можете заменить конфиг раз в 24 часа.\nОсталось: *${hoursLeft} ч.*`,

  replacingConfig: '⏳ *Заменяю конфигурацию...*',

  configsListTitle: (count: number) =>
    `📂 *Ваши конфигурации (${count})*\n\n` +
    '_Нажмите на конфиг — откроется управление, QR-код и файл для скачивания_',

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
      `🔐 Тип: ${getProtocolLabel(peer.protocol)}\n` +
      `🌐 IP: \`${peer.ip}\`\n` +
      `📊 Статус: ${status}\n\n` +
      subscriptionDetails;

    if (!expired && !peer.paused) {
      text +=
        '\n📱 *Подключение:*\n' +
        '• Нажмите «QR-код» — для настройки на телефоне\n' +
        '• «Получить файл» — для компьютера или повторной загрузки';
    } else if (expired) {
      text += '\n\n_Конфиг истёк. Нажмите «Продлить» для продления подписки._';
    } else if (peer.paused) {
      text += '\n\n_Конфиг на паузе. Администратор может включить его._';
    }

    // Описание видят только админы
    if (isAdmin && peer.description) {
      text += `\n\n📝 *Описание:*\n${escapeMarkdown(peer.description)}`;
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
      const mId = member.id.slice(0, 8);
      keyboard.text(`👤 ${displayName}`, `f_m:${mId}`).row();
    });

    keyboard.text('« Назад в меню', 'main_menu');
    return keyboard;
  },

  addMemberPrompt:
    '➕ *Добавление в группу*\n\n' +
    'Отправьте Telegram ID пользователя *или* перешлите любое его сообщение сюда:\n\n' +
    '• `123456789` — числовой ID\n' +
    '• Пересланное сообщение — ID возьмётся автоматически\n\n' +
    '_Узнать ID можно через_ @Getmyid\\_bot',

  invalidInput:
    '❌ *Неверный формат*\n\n' +
    'Отправьте числовой Telegram ID или перешлите сообщение от пользователя:\n' +
    '• `123456789`\n\n' +
    '_Узнать ID можно через_ @Getmyid\\_bot',

  cannotAddAdminSelf:
    '⚠️ *Нельзя добавить себя*\n\n' +
    'Вы администратор группы. Добавьте другого пользователя: ID или пересланное сообщение *не от вас*.',

  forwardHiddenUser:
    '⚠️ *Не удалось определить ID*\n\n' +
    'У отправителя скрыт профиль при пересылке. Попросите его написать боту или отправьте числовой ID.',

  forwardNotFromUser:
    '⚠️ *Нужно сообщение от человека*\n\n' +
    'Пересылайте сообщение от пользователя, а не из канала или анонимного чата.',

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

    const displayName = getMemberDisplayName(member, true);
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
    const mId = member.id.slice(0, 8);

    // Кнопка создания конфига
    keyboard.text('➕ Добавить конфиг', `f_cc:${mId}`).row();

    // Кнопка редактирования имени
    keyboard.text('✏️ Изменить имя', `f_en:${mId}`).row();

    if (peers.length > 0) {
      keyboard.text('📂 Конфиги', `f_mc:${mId}`).row();
    }

    keyboard
      .text('🗑 Удалить из группы', `f_rm:${mId}`)
      .row()
      .text('« К группе', 'family_menu');

    return keyboard;
  },

  memberConfigsListTitle: (displayName: string) =>
    `📂 *Конфиги ${escapeMarkdown(displayName)}:*`,

  memberConfigsListKeyboard: (peers: TPeer[], memberId: string) => {
    const keyboard = new InlineKeyboard();
    const mId = memberId.slice(0, 8);

    peers.forEach((peer) => {
      const status = getPeerStatusIcon(peer);
      keyboard.text(`${status} ${peer.name}`, `f_p:${peer.name}:${mId}`).row();
    });

    keyboard.text('« Назад', `f_m:${mId}`);
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
      text += `\n\n📝 *Описание:*\n${escapeMarkdown(peer.description)}`;
    }

    return text;
  },

  memberPeerDetailsKeyboard: (peer: TPeer, memberId: string) => {
    const keyboard = new InlineKeyboard();
    const expired = isExpired(peer);
    // Сокращаем memberId для callback_data (первые 8 символов UUID достаточно уникальны)
    const mId = memberId.slice(0, 8);

    // Кнопка включить/пауза
    if (!expired) {
      const toggleBtnText = peer.paused ? '▶️ Включить' : '⏸ Пауза';
      keyboard.text(toggleBtnText, `f_tp:${peer.name}:${mId}`);
    }

    const descriptionBtnText = peer.description
      ? '📝 Изменить описание'
      : '📝 Добавить описание';
    keyboard
      .text(descriptionBtnText, `f_ed:${peer.name}:${mId}`)
      .row()
      .text('📅 Изменить срок', `f_cd:${peer.name}:${mId}`)
      .row()
      .text('🗑 Удалить', `f_dp:${peer.name}:${mId}`)
      .row()
      .text('« К конфигам', `f_mc:${mId}`);

    return keyboard;
  },

  changeDurationTitle: '📅 *Выберите новый срок действия:*',

  // === Создание конфига для члена группы ===

  memberCreateConfigTitle: (displayName: string) =>
    `➕ *Создание конфига для ${escapeMarkdown(displayName)}*\n\nВыберите срок действия:`,

  memberCreateConfigKeyboard: (memberId: string) => {
    const mId = memberId.slice(0, 8);
    return new InlineKeyboard()
      .text('♾️ Бессрочный', `f_dc:${mId}:u`)
      .row()
      .text('30 дней', `f_dc:${mId}:30`)
      .text('60 дней', `f_dc:${mId}:60`)
      .text('90 дней', `f_dc:${mId}:90`)
      .row()
      .text('« Назад', `f_m:${mId}`);
  },

  memberConfigCreated: (
    name: string,
    ip: string,
    expiresAt?: Date | null,
    protocol?: TVpnProtocol,
  ) => {
    let msg =
      `✅ Конфиг создан\n\n🏷 Имя: \`${name}\`\n` +
      `🔐 Тип: ${getProtocolLabel(protocol)}\nIP: \`${ip}\``;
    if (expiresAt) {
      msg += `\n📅 Действует до: ${expiresAt.toLocaleDateString('ru-RU')}`;
    } else {
      msg += '\n⏳ Срок: ♾️ Бессрочно';
    }
    if (protocol === 'awg') {
      msg +=
        '\n\n⚠️ _Открывается только в приложении AmneziaVPN, не в WireGuard._';
    }
    return msg;
  },

  backToMemberDetailsKeyboard: (memberId: string) => {
    const mId = memberId.slice(0, 8);
    return new InlineKeyboard().text('« К участнику', `f_m:${mId}`);
  },

  changeDurationKeyboard: (peerName: string, memberId: string) => {
    const mId = memberId.slice(0, 8);
    return new InlineKeyboard()
      .text('♾️ Бессрочный', `f_sd:${peerName}:${mId}:u`)
      .row()
      .text('30 дней', `f_sd:${peerName}:${mId}:30`)
      .text('60 дней', `f_sd:${peerName}:${mId}:60`)
      .text('90 дней', `f_sd:${peerName}:${mId}:90`)
      .row()
      .text('« Назад', `f_p:${peerName}:${mId}`);
  },

  // === Редактирование имени участника ===

  editNamePrompt: (member: TFamilyMember) => {
    const currentName = getMemberDisplayName(member, true);
    return (
      `✏️ *Изменение имени участника*\n\n` +
      `Текущее имя: ${currentName}\n\n` +
      `Отправьте новое имя (до 50 символов):`
    );
  },

  invalidNameInput:
    '❌ *Неверный формат*\n\n' + 'Имя должно быть от 1 до 50 символов.',

  nameUpdated: (newName: string) =>
    `✅ *Имя обновлено*\n\nНовое имя: ${escapeMarkdown(newName)}`,

  editNameError: (msg: string) => `❌ *Ошибка:* ${msg}`,

  cancelEditNameKeyboard: (memberId: string) => {
    const mId = memberId.slice(0, 8);
    return new InlineKeyboard().text('❌ Отмена', `f_cen:${mId}`);
  },

  backToMemberKeyboard: (memberId: string) => {
    const mId = memberId.slice(0, 8);
    return new InlineKeyboard().text('« К участнику', `f_m:${mId}`);
  },

  // === Редактирование описания конфига ===

  editDescriptionPrompt: (peer: TPeer) => {
    const currentDesc = peer.description
      ? `Текущее описание:\n${escapeMarkdown(peer.description)}`
      : 'Описание не задано';
    return (
      `📝 *Изменение описания конфига*\n\n` +
      `🏷 Конфиг: \`${peer.name}\`\n\n` +
      `${currentDesc}\n\n` +
      `Отправьте новое описание (до 200 символов):\n` +
      `Отправьте "-" чтобы удалить описание`
    );
  },

  invalidDescriptionInput:
    '❌ *Неверный формат*\n\n' + 'Описание должно быть до 200 символов.',

  descriptionUpdated: (description: string | null) =>
    description
      ? `✅ *Описание обновлено*\n\n${escapeMarkdown(description)}`
      : '✅ *Описание удалено*',

  editDescriptionError: (msg: string) => `❌ *Ошибка:* ${msg}`,

  cancelEditDescriptionKeyboard: (peerName: string, memberId: string) => {
    const mId = memberId.slice(0, 8);
    return new InlineKeyboard().text('❌ Отмена', `f_ced:${peerName}:${mId}`);
  },

  backToPeerKeyboard: (peerName: string, memberId: string) => {
    const mId = memberId.slice(0, 8);
    return new InlineKeyboard().text('« К конфигу', `f_p:${peerName}:${mId}`);
  },

  // === Редактирование описания для своих конфигов ===

  cancelEditOwnDescriptionKeyboard: (peerName: string) =>
    new InlineKeyboard().text(
      '❌ Отмена',
      `cancel_edit_description:${peerName}`,
    ),

  backToOwnPeerKeyboard: (peerName: string) =>
    new InlineKeyboard().text('« К конфигу', `manage_peer:${peerName}`),

  backToOwnPeerKeyboardReply: (peerName: string) =>
    new InlineKeyboard().text('« К конфигу', `goto_peer:${peerName}`),
  backToOwnPeerKeyboardReplyAfterReplace: (peerName: string) =>
    new InlineKeyboard().text(
      '« К конфигу',
      `goto_peer_after_replace:${peerName}`,
    ),

  clientSearchPrompt:
    '🔍 *Поиск клиента*\n\n' +
    'Введите Telegram ID клиента:\n\n' +
    '• `123456789` — числовой ID\n\n' +
    'Узнать ID можно через @Getmyid\\_bot',

  invalidClientIdInput:
    '❌ *Неверный формат*\n\n' +
    'Введите числовой Telegram ID:\n' +
    '• `123456789`\n\n' +
    'Узнать ID можно через @Getmyid\\_bot',

  clientFoundText: (
    telegramId: string,
    configsCount: number,
    isBlocked: boolean,
  ) => {
    const blockedText = isBlocked ? '\n🚫 *Статус: ЗАБЛОКИРОВАН*' : '';
    return (
      `👤 *Клиент*\n\n` +
      `🆔 Telegram ID: \`${telegramId}\`\n` +
      `📂 Конфигов: ${configsCount}` +
      blockedText +
      `\n\nНажмите "Открыть меню" для управления`
    );
  },

  clientFoundKeyboard: (telegramId: string) =>
    new InlineKeyboard()
      .text('👤 Открыть меню', `admin_client:${telegramId}`)
      .row()
      .text('🔍 Искать другого', 'admin_search')
      .row()
      .text('« В меню', 'main_menu'),

  cancelClientSearchKeyboard: () =>
    new InlineKeyboard().text('❌ Отмена', 'admin_cancel_search'),

  backToAdminSearchKeyboard: () =>
    new InlineKeyboard()
      .text('🔍 Искать снова', 'admin_search')
      .row()
      .text('« В меню', 'main_menu'),

  clientDetailsText: (
    telegramId: string,
    configsCount: number,
    isBlocked: boolean,
  ) => {
    const blockedText = isBlocked ? '\n🚫 *Статус: ЗАБЛОКИРОВАН*' : '';
    return (
      `👤 *Информация о клиенте*\n\n` +
      `🆔 Telegram ID: \`${telegramId}\`\n` +
      `📂 Конфигов: ${configsCount}` +
      blockedText
    );
  },

  clientDetailsKeyboard: (
    telegramId: string,
    peers: TPeer[],
    isBlocked: boolean,
  ) => {
    const keyboard = new InlineKeyboard();

    // Кнопка создания конфига
    keyboard.text('➕ Добавить конфиг', `admin_cc:${telegramId}`).row();

    if (peers.length > 0) {
      keyboard.text('📂 Конфиги', `admin_client_configs:${telegramId}`).row();
    }

    // Кнопка блокировки/разблокировки
    if (isBlocked) {
      keyboard.text('✅ Разблокировать', `admin_unblock:${telegramId}`).row();
    } else {
      keyboard.text('🚫 Заблокировать', `admin_block:${telegramId}`).row();
    }

    keyboard
      .text('🔍 Искать другого', 'admin_search')
      .row()
      .text('« В меню', 'main_menu');

    return keyboard;
  },

  // === Создание конфига для клиента ===

  clientCreateConfigTitle: (telegramId: string) =>
    `➕ *Создание конфига для клиента*\n\n🆔 ID: \`${telegramId}\`\n\nВыберите срок действия:`,

  clientCreateConfigKeyboard: (telegramId: string) =>
    new InlineKeyboard()
      .text('♾️ Бессрочный', `admin_dc:${telegramId}:u`)
      .row()
      .text('30 дней', `admin_dc:${telegramId}:30`)
      .text('60 дней', `admin_dc:${telegramId}:60`)
      .text('90 дней', `admin_dc:${telegramId}:90`)
      .row()
      .text('« Назад', `admin_client:${telegramId}`),

  backToClientDetailsKeyboard: (telegramId: string) =>
    new InlineKeyboard().text('« К клиенту', `admin_client:${telegramId}`),

  clientConfigsListTitle: (telegramId: string, count: number) =>
    count > 0
      ? `📂 *Конфиги клиента* \`${telegramId}\`:`
      : `📂 *У клиента* \`${telegramId}\` *нет конфигов*`,

  clientConfigsListKeyboard: (peers: TPeer[], telegramId: string) => {
    const keyboard = new InlineKeyboard();

    peers.forEach((peer) => {
      const status = getPeerStatusIcon(peer);
      keyboard
        .text(`${status} ${peer.name}`, `admin_peer:${peer.name}:${telegramId}`)
        .row();
    });

    keyboard.text('« Назад', `admin_client:${telegramId}`);
    return keyboard;
  },

  clientPeerDetailsText: (peer: TPeer) => {
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
      `⚙️ *Конфиг клиента*\n\n` +
      `🏷 Имя: \`${peer.name}\`\n` +
      `🌐 IP: \`${peer.ip}\`\n` +
      `📊 Статус: ${status}\n\n` +
      subscriptionDetails;

    if (peer.description) {
      text += `\n\n📝 *Описание:*\n${escapeMarkdown(peer.description)}`;
    }

    return text;
  },

  clientPeerDetailsKeyboard: (peer: TPeer, telegramId: string) => {
    const keyboard = new InlineKeyboard();
    const expired = isExpired(peer);

    // Кнопка включить/пауза
    if (!expired) {
      const toggleBtnText = peer.paused ? '▶️ Включить' : '⏸ Пауза';
      keyboard.text(
        toggleBtnText,
        `admin_toggle_peer:${peer.name}:${telegramId}`,
      );
    }

    const descriptionBtnText = peer.description
      ? '📝 Изменить описание'
      : '📝 Добавить описание';
    keyboard
      .text(
        descriptionBtnText,
        `admin_edit_description:${peer.name}:${telegramId}`,
      )
      .row()
      .text(
        '📅 Изменить срок',
        `admin_change_duration:${peer.name}:${telegramId}`,
      )
      .row()
      .text('🗑 Удалить', `admin_delete_peer:${peer.name}:${telegramId}`)
      .row()
      .text('« К конфигам', `admin_client_configs:${telegramId}`);

    return keyboard;
  },

  clientChangeDurationKeyboard: (peerName: string, telegramId: string) =>
    new InlineKeyboard()
      .text(
        '♾️ Бессрочный',
        `admin_set_duration:${peerName}:${telegramId}:unlimited`,
      )
      .row()
      .text('30 дней', `admin_set_duration:${peerName}:${telegramId}:30`)
      .text('60 дней', `admin_set_duration:${peerName}:${telegramId}:60`)
      .text('90 дней', `admin_set_duration:${peerName}:${telegramId}:90`)
      .row()
      .text('« Назад', `admin_peer:${peerName}:${telegramId}`),

  cancelClientEditDescriptionKeyboard: (peerName: string, telegramId: string) =>
    new InlineKeyboard().text(
      '❌ Отмена',
      `admin_cancel_edit_description:${peerName}:${telegramId}`,
    ),

  backToClientPeerKeyboard: (peerName: string, telegramId: string) =>
    new InlineKeyboard().text(
      '« К конфигу',
      `admin_peer:${peerName}:${telegramId}`,
    ),

  // === Инструкции по установке WireGuard ===

  instructionsMenuTitle:
    '📖 *Инструкция по установке WireGuard*\n\n' +
    'Выберите вашу платформу — откроется пошаговая инструкция с прямыми ссылками на приложение.\n\n' +
    '⏱ _Обычно настройка занимает 2–3 минуты_\n' +
    '🎬 _Есть видео-инструкции — кнопка ниже_',

  instructionsMenuKeyboard: () =>
    new InlineKeyboard()
      .text('📱 Android', 'instruction:android')
      .text('🍎 iOS / iPhone', 'instruction:ios')
      .row()
      .text('🪟 Windows', 'instruction:windows')
      .text('🍏 macOS', 'instruction:macos')
      .row()
      .text('🐧 Linux', 'instruction:linux')
      .row()
      .text('🎬 Видео-инструкции', 'instruction:video')
      .row()
      .text('« Назад в меню', 'main_menu'),

  backToInstructionsKeyboard: () =>
    new InlineKeyboard()
      .text('« К списку платформ', 'show_instructions')
      .row()
      .text('« В меню', 'main_menu'),

  instructionVideo:
    '🎬 *Видео-инструкции по WireGuard*\n\n' +
    'Полезные видео для наглядной настройки:\n\n' +
    '📺 *Общая настройка (на русском):*\n' +
    '[WireGuard VPN — полная настройка](https://www.youtube.com/watch?v=5Aql0V-ta8A)\n\n' +
    '📺 *Официальные ресурсы:*\n' +
    '• [Сайт WireGuard](https://www.wireguard.com/)\n' +
    '• [Страница загрузки](https://www.wireguard.com/install/)\n\n' +
    '_Выберите платформу для текстовой инструкции с прямыми ссылками_',

  instructionAndroid:
    '📱 *Установка WireGuard на Android*\n\n' +
    '*Шаг 1: Установите приложение*\n' +
    '• [WireGuard в Google Play](https://play.google.com/store/apps/details?id=com.wireguard.android)\n' +
    '• Или найдите "WireGuard" в Play Store\n' +
    '• Установите приложение от WireGuard Development Team\n\n' +
    '*Шаг 2: Импортируйте конфиг*\n' +
    '• Откройте WireGuard\n' +
    '• Нажмите кнопку "+" внизу справа\n' +
    '• Выберите "Импорт из файла или архива"\n' +
    '• Найдите скачанный файл .conf (в папке "Загрузки" или "Downloads")\n\n' +
    '*Шаг 3: Подключитесь*\n' +
    '• Включите переключатель рядом с конфигом\n' +
    '• Разрешите создание VPN-соединения\n' +
    '• Готово! 🎉\n\n' +
    '_💡 Совет: Для автоподключения удерживайте конфиг и включите "Auto-activate"_\n\n' +
    '📺 [Видео-инструкция](https://www.youtube.com/watch?v=5Aql0V-ta8A)',

  instructionIos:
    '🍎 *Установка WireGuard на iOS / iPhone*\n\n' +
    '*Шаг 1: Установите приложение*\n' +
    '• [WireGuard в App Store](https://apps.apple.com/app/wireguard/id1441195209)\n' +
    '• Или найдите "WireGuard" в App Store\n\n' +
    '*Шаг 2: Импортируйте конфиг*\n\n' +
    '_Способ 1 (через файл):_\n' +
    '• Скачайте файл .conf из бота\n' +
    '• Нажмите на файл → "Поделиться"\n' +
    '• Выберите "WireGuard"\n\n' +
    '_Способ 2 (через QR-код — быстрее):_\n' +
    '• Откройте WireGuard\n' +
    '• Нажмите "+" → "Создать из QR-кода"\n' +
    '• Отсканируйте QR-код из бота\n\n' +
    '*Шаг 3: Подключитесь*\n' +
    '• Включите переключатель рядом с конфигом\n' +
    '• Разрешите добавление VPN-конфигурации\n' +
    '• Готово! 🎉\n\n' +
    '_💡 Совет: Добавьте виджет WireGuard для быстрого подключения_\n\n' +
    '📺 [Видео-инструкция](https://www.youtube.com/watch?v=5Aql0V-ta8A)',

  instructionWindows:
    '🪟 *Установка WireGuard на Windows*\n\n' +
    '*Шаг 1: Скачайте и установите*\n' +
    '• [Скачать установщик](https://download.wireguard.com/windows-client/wireguard-installer.exe)\n' +
    '• Или [все версии на wireguard.com](https://www.wireguard.com/install/)\n' +
    '• Запустите установщик и следуйте подсказкам\n\n' +
    '*Шаг 2: Импортируйте конфиг*\n' +
    '• Запустите WireGuard\n' +
    '• Нажмите "Импортировать туннель из файла"\n' +
    '• Выберите скачанный из бота файл .conf\n\n' +
    '*Шаг 3: Подключитесь*\n' +
    '• Выберите конфиг в списке слева\n' +
    '• Нажмите "Подключить" — появится зелёный щит\n' +
    '• Готово! 🎉\n\n' +
    '_💡 Совет: В настройках включите "Запускать при входе в систему"_\n\n' +
    '📺 [Видео-инструкция](https://www.youtube.com/watch?v=5Aql0V-ta8A)',

  instructionMacos:
    '🍏 *Установка WireGuard на macOS*\n\n' +
    '*Шаг 1: Установите приложение*\n' +
    '• [WireGuard в App Store для Mac](https://apps.apple.com/app/wireguard/id1451685025)\n' +
    '• Или найдите "WireGuard" в App Store\n\n' +
    '*Шаг 2: Импортируйте конфиг*\n' +
    '• Запустите WireGuard\n' +
    '• Нажмите "Импортировать туннель(и) из файла"\n' +
    '• Или перетащите файл .conf в окно приложения\n\n' +
    '*Шаг 3: Подключитесь*\n' +
    '• Выберите конфиг в списке\n' +
    '• Нажмите "Активировать"\n' +
    '• Разрешите добавление VPN-конфигурации\n' +
    '• Готово! 🎉\n\n' +
    '_💡 Совет: Иконка в меню-баре позволяет быстро включать/выключать VPN_\n\n' +
    '📺 [Видео-инструкция](https://www.youtube.com/watch?v=5Aql0V-ta8A)',

  instructionLinux:
    '🐧 *Установка WireGuard на Linux*\n\n' +
    '*Пакеты (выберите для вашего дистрибутива):*\n\n' +
    '_Ubuntu / Debian:_\n' +
    '```\nsudo apt update\nsudo apt install wireguard\n```\n\n' +
    '_Fedora:_\n' +
    '```\nsudo dnf install wireguard-tools\n```\n\n' +
    '_Arch Linux:_\n' +
    '```\nsudo pacman -S wireguard-tools\n```\n\n' +
    '*Настройка:*\n' +
    '1. Скачайте файл .conf из бота\n' +
    '2. Скопируйте в /etc/wireguard/\n' +
    '```\nsudo cp путь/к/файлу.conf /etc/wireguard/wg0.conf\n```\n' +
    '3. Запустите VPN:\n' +
    '```\nsudo wg-quick up wg0\n```\n' +
    '4. Для автозапуска:\n' +
    '```\nsudo systemctl enable wg-quick@wg0\n```\n\n' +
    '_💡 Для GUI: установите network-manager-wireguard_\n\n' +
    '📖 [Официальная документация](https://www.wireguard.com/install/)\n' +
    '📺 [Видео на русском](https://www.youtube.com/watch?v=5Aql0V-ta8A)',
};
