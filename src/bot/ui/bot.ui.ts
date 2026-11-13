import { InlineKeyboard } from 'grammy';
import { TFamilyMember } from 'src/family/family.service';
import { TPeer } from 'src/peers/peers.service';
import {
  PAID_DURATIONS,
  PRICING_PLANS,
  getPlanPrice,
  monthlyEquivalent,
  savingsPercent,
  type PaidDuration,
} from 'src/payment/pricing';

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

interface IKeyboardButton {
  text: string;
  /** callback_data кнопки */
  data: string;
}

/** Клавиатура из рядов кнопок: пустые ряды отбрасываются, чтобы не отправлять «дыры» в Telegram */
function buildKeyboard(rows: IKeyboardButton[][]): InlineKeyboard {
  const keyboard = new InlineKeyboard();
  rows
    .filter((row) => row.length > 0)
    .forEach((row, index) => {
      if (index > 0) keyboard.row();
      row.forEach((button) => keyboard.text(button.text, button.data));
    });
  return keyboard;
}

/** Подпись кнопки тарифа: эмодзи, срок, цена и пометка акции/выгоды */
function paymentPlanButtonLabel(
  durationDays: PaidDuration,
  hasDiscount: boolean,
  testPayment: boolean,
): string {
  const plan = PRICING_PLANS[durationDays];
  const discounted = hasDiscount && plan.discountedPrice !== null;
  const priceText = testPayment
    ? '1 ₽ (тест)'
    : `${getPlanPrice(durationDays, hasDiscount)} ₽`;
  const saving = savingsPercent(durationDays);

  let suffix = '';
  if (discounted) {
    suffix = ' 🎁';
  } else if (saving > 0) {
    suffix = ` (−${saving}%)`;
  }

  return `${plan.emoji} ${durationDays} дн. — ${priceText}${suffix}`;
}

function getPeerStatusIcon(peer: TPeer): string {
  if (peer.paused) return '🔴';
  if (isExpired(peer)) return '🟡';
  return '🟢';
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
      kb.text('📄 Получить доступ', 'show_create_options').row();
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
    kb.text('📄 Получить доступ', 'show_create_options').row();
    return kb
      .text('📂 Мои конфиги', 'list_configs')
      .row()
      .text('📖 Инструкция', 'show_instructions');
  },

  // Главное меню для админов: тот же набор, что у обычного пользователя,
  // плюс отдельная точка входа в панель администратора внизу.
  adminMenuKeyboard: (showTrial = false) => {
    const kb = new InlineKeyboard();
    if (showTrial) {
      kb.text('🆓 Пробный период', 'create_trial_config').row();
    }
    kb.text('📄 Получить доступ', 'show_create_options').row();
    return kb
      .text('📂 Мои конфиги', 'list_configs')
      .row()
      .text('📖 Инструкция', 'show_instructions')
      .row()
      .text('🛠 Панель администратора', 'admin_panel');
  },

  // === Панель администратора ===

  adminPanelTitle: '🛠 *Панель администратора*\n\nВыберите раздел:',

  adminPanelKeyboard: () =>
    new InlineKeyboard()
      .text('👨‍👩‍👧‍👦 Семья', 'family_menu')
      .text('🔍 Поиск клиента', 'admin_search')
      .row()
      .text('📊 Статистика', 'admin_stats')
      .text('📈 Аналитика', 'admin_analytics')
      .row()
      .text('📢 Рупор', 'admin_broadcast')
      .text('⚙️ Параметры', 'admin_settings')
      .row()
      .text('🚫 Бан-лист', 'admin_blocked_list')
      .row()
      .text('« В главное меню', 'main_menu'),

  backToAdminPanelKeyboard: () =>
    new InlineKeyboard().text('« К панели администратора', 'admin_panel'),

  // === Бан-лист ===

  blockedListTitle: (count: number) =>
    `🚫 *Заблокированные пользователи*\n\n` +
    (count > 0 ? `Всего: *${count}*` : '_Список пуст_'),

  blockedListKeyboard: (
    blocked: { telegramId: string; reason: string | null }[],
  ) => {
    const keyboard = new InlineKeyboard();
    blocked.forEach((u) => {
      const label = u.reason
        ? `🚫 ${u.telegramId} — ${u.reason}`
        : `🚫 ${u.telegramId}`;
      keyboard.text(label.slice(0, 64), `admin_client:${u.telegramId}`).row();
    });
    keyboard.text('« К панели администратора', 'admin_panel');
    return keyboard;
  },

  // === Параметры (runtime-переключатели) ===

  adminSettingsTitle: (paymentEnabled: boolean, testPayment: boolean) =>
    '⚙️ *Параметры*\n\n' +
    `💳 Приём оплаты: *${paymentEnabled ? 'включён' : 'выключен'}*\n` +
    (paymentEnabled
      ? `   └ 🧪 Тестовая оплата: *${testPayment ? 'включена (1 ₽ — только для админов)' : 'выключена'}*\n\n`
      : '   └ 🧪 Тестовая оплата: *недоступна* — сначала включите приём оплаты\n\n') +
    (paymentEnabled && testPayment
      ? '🧪 _У админов «Получить доступ» ведёт в тарифы с ценой 1 ₽ — полный клиентский путь: счёт, оплата, выдача конфига._\n' +
        '✅ _Обычные клиенты продолжают платить полную цену — продажи не ломаются. Группу «Семья» режим не затрагивает._\n\n'
      : '') +
    'Изменения применяются мгновенно, без перезапуска бота.',

  // Тестовая оплата — подрежим основной: её переключатель показывается только
  // при включённом приёме оплаты, иначе состояние «включена» вводит в
  // заблуждение (счёт всё равно не выставится).
  adminSettingsKeyboard: (paymentEnabled: boolean, testPayment: boolean) => {
    const kb = new InlineKeyboard()
      .text(
        paymentEnabled ? '💳 Оплата: ВКЛ ✅' : '💳 Оплата: ВЫКЛ ⛔',
        'admin_toggle_payment',
      )
      .row();

    if (paymentEnabled) {
      kb.text(
        testPayment
          ? '🧪 Тестовая оплата: ВКЛ ✅'
          : '🧪 Тестовая оплата: ВЫКЛ ⛔',
        'admin_toggle_test_payment',
      ).row();
    }

    return kb.text('« К панели администратора', 'admin_panel');
  },

  testPaymentRequiresPaymentAlert:
    'Сначала включите приём оплаты — тестовая оплата работает только внутри него',

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

  adminStatsKeyboard: () =>
    new InlineKeyboard().text('« В меню', 'admin_panel'),

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
      .text('« В меню', 'admin_panel'),

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

  createConfigKeyboard: () => {
    const kb = new InlineKeyboard().text(
      '♾️ Бессрочный',
      'create_config:unlimited',
    );
    PAID_DURATIONS.forEach((duration, index) => {
      if (index % 3 === 0) kb.row();
      kb.text(
        `${PRICING_PLANS[duration].emoji} ${duration} дн.`,
        `create_config:${duration}`,
      );
    });
    return kb.row().text('« Назад в меню', 'main_menu');
  },

  selectDurationTitle: '⏱ *Выберите срок действия конфига:*',

  // Меню оплаты для обычных пользователей (все платные тарифы)
  paymentPlansTitle: (hasDiscount: boolean, testPayment = false) =>
    '💳 *Тарифы TUNEL*\n\n' +
    'Выберите срок — сразу откроется счёт ЮKassa. После успешной оплаты конфиг придёт в этот чат автоматически.\n\n' +
    '🛡 _Современное шифрование трафика между вашим устройством и сервером_\n' +
    '📱 _Один конфиг: Android, iOS, Windows, macOS, Linux_\n' +
    `💰 _Чем длиннее срок, тем дешевле месяц: от ${PRICING_PLANS[30].price} ₽ до ${monthlyEquivalent(365)} ₽_\n\n` +
    (hasDiscount
      ? '🎁 *Разовая акция:* скидка на первую покупку от 60 дней — тариф на выбор, действует один раз.\n\n'
      : '') +
    '❗️ *iPhone / iPad:* перед покупкой откройте «📖 Инструкция» → «🍎 iOS / iPhone»: AmneziaVPN ставится только после смены региона Apple ID.\n\n' +
    (testPayment
      ? '⚠️ Тестовый режим админа: в ЮKassa спишется *1 ₽* за любой тариф. У клиентов — полная цена.\n\n'
      : ''),

  paymentMenuUnavailable:
    '💳 *Оплата временно недоступна*\n\n' +
    'Покупка и продление подписки сейчас отключены. Попробуйте позже.',

  paymentPlansKeyboard: (hasDiscount: boolean, testPayment = false) => {
    const kb = new InlineKeyboard();
    for (const duration of PAID_DURATIONS) {
      kb.text(
        paymentPlanButtonLabel(duration, hasDiscount, testPayment),
        `pay_plan:${duration}`,
      ).row();
    }
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
    for (const duration of PAID_DURATIONS) {
      kb.text(
        paymentPlanButtonLabel(duration, hasDiscount, testPayment),
        `extend_pay_plan:${duration}:${peerName}`,
      ).row();
    }
    kb.text('« Назад в меню', 'main_menu');
    return kb;
  },

  // === Автопродление (рекуррентные списания ЮKassa) ===

  /** Предложение после успешной оплаты — автосписание по умолчанию выключено */
  autopayOfferText: (durationDays: PaidDuration, methodTitle: string | null) =>
    '🔄 *Включить автопродление?*\n\n' +
    `Чтобы доступ не прервался в неподходящий момент, бот может сам продлевать подписку на *${durationDays} дн.* — списание *${getPlanPrice(durationDays)} ₽* за сутки до окончания срока.\n\n` +
    (methodTitle ? `💳 Карта: ${escapeMarkdown(methodTitle)}\n` : '') +
    '✅ Отключить можно в любой момент — в меню конфига.\n' +
    '🔔 О каждом списании предупредим заранее.\n\n' +
    '_Сейчас автопродление выключено._',

  autopayOfferKeyboard: (peerName: string, durationDays: PaidDuration) =>
    new InlineKeyboard()
      .text(
        '🔄 Включить автопродление',
        `autopay_on:${peerName}:${durationDays}`,
      )
      .row()
      .text('Не сейчас', 'autopay_skip'),

  autopayMenuText: (state: {
    enabled: boolean;
    durationDays: number;
    hasPaymentMethod: boolean;
    methodTitle: string | null;
    nextChargeAt: Date | null;
  }) => {
    if (!state.hasPaymentMethod) {
      return (
        '🔄 *Автопродление*\n\n' +
        '❗️ Для автосписаний нужна сохранённая карта. Она сохраняется при обычной оплате в ЮKassa.\n\n' +
        '_Оплатите любой тариф картой — после этого автопродление можно будет включить._'
      );
    }

    const next = state.nextChargeAt
      ? new Date(state.nextChargeAt).toLocaleDateString('ru-RU')
      : '—';

    return (
      '🔄 *Автопродление*\n\n' +
      `Статус: *${state.enabled ? 'включено ✅' : 'выключено ⛔'}*\n` +
      `Тариф: *${state.durationDays} дн.* — *${getPlanPrice(state.durationDays as PaidDuration)} ₽*\n` +
      (state.methodTitle
        ? `💳 Карта: ${escapeMarkdown(state.methodTitle)}\n`
        : '') +
      (state.enabled ? `📅 Следующее списание: *${next}*\n` : '') +
      '\n' +
      (state.enabled
        ? '_Спишем автоматически за сутки до окончания срока и пришлём конфиг. Предупреждение придёт за 3 дня._'
        : '_Включите, чтобы подписка продлевалась сама и доступ не прерывался._')
    );
  },

  autopayMenuKeyboard: (
    peerName: string,
    enabled: boolean,
    durationDays: PaidDuration,
    hasPaymentMethod: boolean,
  ) => {
    const kb = new InlineKeyboard();
    if (hasPaymentMethod) {
      kb.text(
        enabled ? '⛔ Выключить автопродление' : '🔄 Включить автопродление',
        enabled ? 'autopay_off' : `autopay_on:${peerName}:${durationDays}`,
      ).row();
    }
    return kb.text('« К конфигу', `manage_peer:${peerName}`);
  },

  autopayEnabledAlert: 'Автопродление включено',
  autopayDisabledAlert: 'Автопродление выключено',
  autopayNoMethodAlert:
    'Нужна сохранённая карта — оплатите любой тариф картой, и автопродление станет доступно',
  autopayNoPeerAlert: 'Нет активного конфига со сроком действия',

  /** Предупреждение за несколько дней до автосписания */
  autopayChargeSoonText: (
    durationDays: number,
    amount: number,
    chargeAt: Date,
    peerName: string,
  ) =>
    '🔔 *Скоро автопродление*\n\n' +
    `Конфиг \`${peerName}\`: *${chargeAt.toLocaleDateString('ru-RU')}* спишем *${amount} ₽* и продлим подписку на *${durationDays} дн.*\n\n` +
    '_Не нужно — выключите автопродление кнопкой ниже._',

  autopayChargeSoonKeyboard: (peerName: string) =>
    new InlineKeyboard()
      .text('⛔ Выключить автопродление', 'autopay_off')
      .row()
      .text('📂 Меню конфига', `manage_peer:${peerName}`),

  autopayChargeFailedText: (amount: number, attemptsLeft: number) =>
    '⚠️ *Не удалось списать оплату*\n\n' +
    `Автопродление на *${amount} ₽* не прошло — банк отклонил списание или на карте недостаточно средств.\n\n` +
    (attemptsLeft > 0
      ? `Повторим завтра (осталось попыток: *${attemptsLeft}*). Можно оплатить вручную в меню конфига.`
      : 'Автопродление отключено. Продлите подписку вручную в меню конфига.'),

  paymentSuccessTitle:
    '✅ *Оплата прошла успешно!*\n\n' +
    'Создаю ваш конфиг... Через секунду вы получите данные подключения.\n\n' +
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
      kb.text('📄 Получить доступ', 'show_create_options').row();
    }
    return kb.text('« Назад в меню', 'main_menu');
  },

  configsListKeyboard: (peers: TPeer[]) => {
    const keyboard = new InlineKeyboard();

    peers.forEach((peer) => {
      const status = getPeerStatusIcon(peer);
      keyboard.text(`${status} ${peer.name}`, `manage_peer:${peer.name}`).row();
    });
    keyboard.text('« Назад в меню', 'main_menu');
    return keyboard;
  },

  peerDetailsKeyboard: (
    peer: TPeer,
    isAdmin: boolean = false,
    canManageOwn = false,
    awgAvailable = true,
  ) => {
    const expired = isExpired(peer);

    // Клавиатура собирается рядами, пустые ряды отсеиваются на сборке:
    // при построении цепочкой .row() набор кнопок зависит от состояния конфига
    // и в клавиатуре легко появляется пустая строка.
    const rows: IKeyboardButton[][] = [];

    if (awgAvailable) {
      rows.push([
        { text: '📷 QR AmneziaWG', data: `show_qr:${peer.name}` },
        { text: '📄 Файл AmneziaWG', data: `get_config_file:${peer.name}` },
      ]);
    }

    rows.push([{ text: '🌐 VLESS Reality', data: `vless_menu:${peer.name}` }]);

    // Кнопка «Продлить» — если конфиг истёк или на паузе
    if (peer.paused || expired) {
      rows.push([{ text: '🔄 Продлить', data: `extend_peer:${peer.name}` }]);
    }

    const manageRow: IKeyboardButton[] = [];

    // Автопродление доступно только для конфигов со сроком действия
    if (peer.expiresAt) {
      manageRow.push({
        text: '♻️ Автопродление',
        data: `autopay_menu:${peer.name}`,
      });
    }

    if (isAdmin && !expired) {
      manageRow.push({
        text: peer.paused ? 'Включить' : 'Пауза',
        data: `toggle_peer:${peer.name}`,
      });
    }

    if (isAdmin || canManageOwn) {
      manageRow.push({
        text: peer.description
          ? '📝 Изменить описание'
          : '📝 Добавить описание',
        data: `edit_description:${peer.name}`,
      });
    }

    rows.push(manageRow);

    if (!expired) {
      rows.push([
        { text: '🔁 Заменить конфиг', data: `replace_peer:${peer.name}` },
      ]);
    }

    if (isAdmin || canManageOwn) {
      rows.push([{ text: 'Удалить', data: `delete_peer:${peer.name}` }]);
    }

    rows.push([{ text: 'К списку', data: 'list_configs' }]);

    return buildKeyboard(rows);
  },

  // === Второй канал: VLESS (Xray) ===

  /**
   * Сообщение с подпиской и ссылками. Приходит отдельным сообщением поверх
   * карточки конфига (как QR и .conf) — поэтому одна и та же кнопка работает
   * и в своих конфигах, и в «Семье», и в карточке клиента у админа.
   */
  vlessMenuText: (peerName: string, body: string) =>
    `🌐 *VLESS для* \`${peerName}\`\n\n` +
    'Прямое подключение Reality: Hiddify, NekoBox, v2rayNG, Happ, ' +
    'Streisand и другие клиенты.\n\n' +
    `${body}\n\n` +
    '_Каналов три: TCP, gRPC и XHTTP. Если один не подключается, возьмите ' +
    'соседнюю ссылку — остальные настройки те же._\n\n' +
    '_Пошагово — в разделе «Инструкция» → «VLESS»._',

  vlessMenuKeyboard: (peerName: string) =>
    new InlineKeyboard()
      .text('🔗 Одна ссылка — все протоколы', `all_protocols:${peerName}`)
      .row()
      .text('📷 QR-код', `vless_qr:${peerName}`)
      .row()
      .text('📥 Файл sing-box (.json)', `vless_json:${peerName}`)
      .row()
      .text('« Закрыть', 'close_media'),

  /**
   * Одна ссылка-подписка со всеми каналами и deep-link'ами клиентов. Deep-link
   * идёт текстом в code-блоке: Telegram не принимает произвольные схемы в
   * URL-кнопках, а code-строку пользователь копирует одним нажатием.
   */
  allProtocolsText: (peerName: string, url: string) =>
    `🔗 *Одна ссылка — все протоколы*\n\n` +
    `Для \`${peerName}\` в подписке три канала: Reality TCP, gRPC и XHTTP. ` +
    'Профиль «⚡ Авто-обход» сам выбирает откликнувшийся канал, отдельные ' +
    'профили — на случай, когда нужен конкретный.\n\n' +
    `*Ссылка-подписка:*\n\`${url}\`\n\n` +
    '*Открыть сразу в приложении:*\n' +
    `\`happ://add/${url}\`\n` +
    `\`hiddify://import/${url}\`\n` +
    `\`v2rayng://install-sub?url=${encodeURIComponent(url)}\`\n` +
    `\`sing-box://import-remote-profile?url=${encodeURIComponent(url)}\`\n\n` +
    '_Канал перестал подключаться — выберите в приложении профиль с другим ' +
    'каналом, ссылку менять не нужно._',

  allProtocolsUnavailable:
    '🔗 *Одна ссылка — все протоколы*\n\n' +
    'Ссылка-подписка сейчас недоступна. Прямые ссылки на каналы — в ' +
    'сообщении «🌐 VLESS».',

  allProtocolsKeyboard: (peerName: string) =>
    new InlineKeyboard()
      .text('« К VLESS', `vless_menu:${peerName}`)
      .row()
      .text('« Закрыть', 'close_media'),

  /** Xray не поднялся (нет бинарника, не задан хост, процесс упал). */
  vlessUnavailable:
    '🌐 *VLESS сейчас недоступен*\n\n' +
    'Попробуйте подключиться позже или обратитесь в поддержку.',

  // === Приветственные сообщения ===

  welcomeMessageAdmin:
    '👋 *Добро пожаловать, Администратор!*\n\n' +
    '🔧 Вы имеете полный доступ к управлению сервисом TUNEL.\n\n' +
    '🛠 Группа «Семья», поиск и управление клиентами, статистика, аналитика, ' +
    'Рупор и Параметры — в разделе *«Панель администратора»* внизу меню.\n\n' +
    'Выберите действие:',

  welcomeMessageFamily:
    '👋 *Добро пожаловать в TUNEL!*\n\n' +
    '📍 *Сервер:* Финляндия\n' +
    '⚡ *Скорость:* до *200 Мбит/с*\n' +
    '🛡 *Шифрование трафика* и приватность соединения\n\n' +
    '🏠 Вы являетесь членом группы «Семья».\n\n' +
    'Вам доступно:\n' +
    '• 📄 Создание конфигов доступа\n' +
    '• 📂 Управление своими конфигами\n' +
    '• 📖 Инструкции по установке\n\n' +
    '❗️ *iPhone / iPad:* AmneziaVPN нет в российском App Store — сначала смените регион Apple ID (раздел «📖 Инструкция» → «🍎 iOS / iPhone»).\n\n' +
    '_При возникновении вопросов обратитесь к администратору._\n\n' +
    'Выберите действие:',

  welcomeMessageUser:
    '🔐 *TUNEL — защищённое соединение*\n\n' +
    '📍 *Сервер:* Финляндия  ⚡ *до 200 Мбит/с*\n\n' +
    'Шифруем интернет-трафик между вашим устройством и нашим сервером: данные защищены в открытых Wi-Fi, а провайдер не видит содержимое соединения.\n\n' +
    '*Что вы получаете:*\n' +
    '• 🛡 Современное шифрование на базе AmneziaWG\n' +
    '• 🔐 Приватность — мы не храним логи вашей активности\n' +
    '• 🚀 Скорость до 200 Мбит/с, без лимита трафика\n' +
    '• 📱 Один конфиг на все устройства: Android, iOS, Windows, macOS, Linux\n' +
    '• 🚫 Без рекламы\n' +
    '• 🎁 Пробный доступ на 3 дня — бесплатно, один раз\n\n' +
    '❗️❗️ *ВЛАДЕЛЬЦАМ iPhone И iPad — ПРОЧТИТЕ ДО ПОКУПКИ!* ❗️❗️\n' +
    'Приложение AmneziaVPN *недоступно в российском App Store*. Его можно установить только после смены региона Apple ID — это бесплатно и занимает около 5 минут.\n' +
    '👉 Раздел *«📖 Инструкция» → «🍎 iOS / iPhone»* — там всё по шагам.\n' +
    '❗️ _Не меняли регион — приложение не установится, и конфиг открыть будет нечем._\n\n' +
    '💬 *По всем вопросам и за поддержкой:* @CharlieWaldo\n\n' +
    'Выберите действие 👇',

  welcomeMessage: '👋 *TUNEL*\n\nВыберите действие:',
  creatingConfig: '⏳ *Создаю конфигурацию...*',
  noConfigs:
    '📂 *У вас пока нет конфигураций*\n\n' +
    'Нажмите «Получить доступ», чтобы:\n' +
    '• Получить пробный конфиг на 3 дня (_бесплатно, один раз_)\n' +
    '• Или выбрать тариф от 30 дней до года\n\n' +
    'После оплаты вы получите данные подключения и сможете настроить приложение по инструкции.',

  configCreated: (name: string, ip: string | null, expiresAt?: Date | null) => {
    let msg = `✅ *Конфиг ${name} создан!*\n\n`;
    if (ip) {
      msg += `🌐 IP: \`${ip}\`\n`;
    }
    if (expiresAt) {
      msg += `📅 Действует до: ${expiresAt.toLocaleDateString('ru-RU')}\n\n`;
    } else {
      msg += '\n';
    }
    msg +=
      '*Дальнейшие шаги:*\n' +
      '1. Откройте раздел «Инструкция» и выберите вашу платформу\n' +
      '2. Импортируйте полученные данные в указанное приложение\n' +
      '3. Нажмите «Подключить»';
    return msg;
  },

  configDeliveryText: (
    caption: string,
    links: string,
    subscriptionUrl?: string | null,
  ) => {
    let msg = `${caption}\n\n${links}`;
    if (subscriptionUrl) {
      msg += `\n\n*Ссылка-подписка:*\n\`${subscriptionUrl}\``;
    }
    return msg;
  },

  configError: (msg: string) => `❌ *Ошибка:* ${msg}`,

  // Замена конфига
  configReplaced: (
    name: string,
    ip: string | null,
    expiresAt?: Date | null,
  ) => {
    let msg = `✅ Конфиг *${name}* успешно заменён!`;
    msg += ip ? `\n\n🌐 Новый IP: \`${ip}\`` : '\n';
    if (expiresAt) {
      msg += `\n📅 Действует до: ${expiresAt.toLocaleDateString('ru-RU')}`;
    } else {
      msg += '\n⏳ Срок: ♾️ Бессрочно';
    }
    msg +=
      '\n\n_Импортируйте новые данные подключения и удалите старый профиль из приложения._';
    return msg;
  },

  replacingConfig: '⏳ *Заменяю конфигурацию...*',

  configsListTitle: (count: number) =>
    `📂 *Ваши конфигурации (${count})*\n\n` +
    '_Нажмите на конфиг — откроется управление и данные подключения_',

  peerDetailsText: (
    peer: TPeer,
    isAdmin: boolean = false,
    canManageOwn = false,
    awgAvailable = true,
  ) => {
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
      (awgAvailable ? `🌐 IP: \`${peer.ip}\`\n` : '') +
      `📊 Статус: ${status}\n\n` +
      subscriptionDetails;

    if (!expired && !peer.paused) {
      if (awgAvailable) {
        text +=
          '\n📱 *Подключение:*\n' +
          '• Нажмите «QR-код» — для настройки на телефоне\n' +
          '• «Получить файл» — для компьютера или повторной загрузки';
      }
    } else if (expired) {
      text += '\n\n_Конфиг истёк. Нажмите «Продлить» для продления подписки._';
    } else if (peer.paused) {
      text += '\n\n_Конфиг на паузе. Администратор может включить его._';
    }

    // Описание видят только админы
    if ((isAdmin || canManageOwn) && peer.description) {
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

    keyboard.text('« Назад в меню', 'admin_panel');
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

  cannotAddAdmin:
    '⚠️ *Нельзя добавить администратора*\n\n' +
    'У администраторов уже есть полный доступ. В группу «Семья» добавляйте обычных пользователей.',

  adminConfigReadOnly:
    '🔒 Конфиги другого администратора доступны только для просмотра',

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

  memberDetailsText: (
    member: TFamilyMember,
    configsCount: number,
    readOnly = false,
  ) => {
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

    if (readOnly) {
      lines.push('', BotUi.adminConfigReadOnly);
    }

    return lines.join('\n');
  },

  memberDetailsKeyboard: (
    member: TFamilyMember,
    peers: TPeer[],
    readOnly = false,
  ) => {
    const keyboard = new InlineKeyboard();
    const mId = member.id.slice(0, 8);

    if (!readOnly) {
      // Кнопка создания конфига
      keyboard.text('➕ Добавить конфиг', `f_cc:${mId}`).row();
    }

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

  memberPeerDetailsText: (peer: TPeer, readOnly = false) => {
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

    if (readOnly) {
      text += `\n\n${BotUi.adminConfigReadOnly}`;
    }

    return text;
  },

  memberPeerDetailsKeyboard: (
    peer: TPeer,
    memberId: string,
    readOnly = false,
  ) => {
    const keyboard = new InlineKeyboard();
    const expired = isExpired(peer);
    // Сокращаем memberId для callback_data (первые 8 символов UUID достаточно уникальны)
    const mId = memberId.slice(0, 8);

    if (readOnly) {
      return keyboard
        .text('📷 QR AmneziaWG', `show_qr:${peer.name}`)
        .text('📄 Файл AmneziaWG', `get_config_file:${peer.name}`)
        .row()
        .text('🌐 VLESS Reality', `vless_menu:${peer.name}`)
        .row()
        .text('« К конфигам', `f_mc:${mId}`);
    }

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
      .text('📷 QR AmneziaWG', `show_qr:${peer.name}`)
      .text('📄 Файл AmneziaWG', `get_config_file:${peer.name}`)
      .row()
      .text('🌐 VLESS Reality', `vless_menu:${peer.name}`)
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
    const kb = new InlineKeyboard().text('♾️ Бессрочный', `f_dc:${mId}:u`);
    PAID_DURATIONS.forEach((duration, index) => {
      if (index % 3 === 0) kb.row();
      kb.text(`${duration} дн.`, `f_dc:${mId}:${duration}`);
    });
    return kb.row().text('« Назад', `f_m:${mId}`);
  },

  memberConfigCreated: (
    name: string,
    ip: string | null,
    expiresAt?: Date | null,
  ) => {
    let msg = `✅ Конфиг создан\n\n🏷 Имя: \`${name}\``;
    if (ip) {
      msg += `\nIP: \`${ip}\``;
    }
    if (expiresAt) {
      msg += `\n📅 Действует до: ${expiresAt.toLocaleDateString('ru-RU')}`;
    } else {
      msg += '\n⏳ Срок: ♾️ Бессрочно';
    }
    msg += '\n\n_Настройка приложения — в разделе «Инструкция»._';
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
      .text('« В меню', 'admin_panel'),

  cancelClientSearchKeyboard: () =>
    new InlineKeyboard().text('❌ Отмена', 'admin_cancel_search'),

  backToAdminSearchKeyboard: () =>
    new InlineKeyboard()
      .text('🔍 Искать снова', 'admin_search')
      .row()
      .text('« В меню', 'admin_panel'),

  // === Рупор (рассылка всем пользователям) ===

  broadcastPrompt:
    '📢 *Рупор*\n\n' +
    'Введите текст сообщения — бот отправит его всем пользователям с конфигами (кроме заблокированных):',

  broadcastConfirmText: (text: string, usersCount: number) =>
    '📢 *Подтверждение рассылки*\n\n' +
    `Получателей: *${usersCount}*\n\n` +
    'Текст сообщения:\n\n' +
    escapeMarkdown(text),

  broadcastEmptyText: '📢 *Рупор*\n\nНет пользователей для рассылки',

  broadcastSendingText: '📢 *Отправка...*',

  broadcastResultText: (sent: number, failed: number) =>
    '📢 *Рассылка завершена*\n\n' +
    `✅ Отправлено: *${sent}*` +
    (failed > 0 ? `\n❌ Не доставлено: *${failed}*` : ''),

  cancelBroadcastKeyboard: () =>
    new InlineKeyboard().text('❌ Отмена', 'admin_cancel_broadcast'),

  broadcastConfirmKeyboard: () =>
    new InlineKeyboard()
      .text('✅ Отправить', 'admin_confirm_broadcast')
      .text('❌ Отмена', 'admin_cancel_broadcast'),

  clientDetailsText: (
    telegramId: string,
    configsCount: number,
    isBlocked: boolean,
    hasUsedDiscount: boolean,
    readOnly = false,
  ) => {
    const blockedText = isBlocked ? '\n🚫 *Статус: ЗАБЛОКИРОВАН*' : '';
    const discountText = hasUsedDiscount
      ? '\n🎁 Скидка на первую покупку: *использована*'
      : '\n🎁 Скидка на первую покупку: *доступна*';
    return (
      `👤 *Информация о клиенте*\n\n` +
      `🆔 Telegram ID: \`${telegramId}\`\n` +
      `📂 Конфигов: ${configsCount}` +
      discountText +
      blockedText +
      (readOnly ? `\n\n${BotUi.adminConfigReadOnly}` : '')
    );
  },

  clientDetailsKeyboard: (
    telegramId: string,
    peers: TPeer[],
    isBlocked: boolean,
    hasUsedDiscount: boolean,
    readOnly = false,
  ) => {
    const keyboard = new InlineKeyboard();

    if (!readOnly) {
      // Кнопка создания конфига
      keyboard.text('➕ Добавить конфиг', `admin_cc:${telegramId}`).row();
    }

    if (peers.length > 0) {
      keyboard.text('📂 Конфиги', `admin_client_configs:${telegramId}`).row();
      if (!readOnly) {
        keyboard
          .text(
            '🗑 Удалить все конфиги',
            `admin_delete_all_peers:${telegramId}`,
          )
          .row();
      }
    }

    if (hasUsedDiscount && !readOnly) {
      keyboard
        .text('🎁 Сбросить скидку', `admin_reset_discount:${telegramId}`)
        .row();
    }

    // Кнопка блокировки/разблокировки
    if (!readOnly) {
      if (isBlocked) {
        keyboard.text('✅ Разблокировать', `admin_unblock:${telegramId}`).row();
      } else {
        keyboard.text('🚫 Заблокировать', `admin_block:${telegramId}`).row();
      }
    }

    keyboard
      .text('🔍 Искать другого', 'admin_search')
      .row()
      .text('« В меню', 'admin_panel');

    return keyboard;
  },

  // === Создание конфига для клиента ===

  clientCreateConfigTitle: (telegramId: string) =>
    `➕ *Создание конфига для клиента*\n\n🆔 ID: \`${telegramId}\`\n\nВыберите срок действия:`,

  clientCreateConfigKeyboard: (telegramId: string) => {
    const kb = new InlineKeyboard().text(
      '♾️ Бессрочный',
      `admin_dc:${telegramId}:u`,
    );
    PAID_DURATIONS.forEach((duration, index) => {
      if (index % 3 === 0) kb.row();
      kb.text(`${duration} дн.`, `admin_dc:${telegramId}:${duration}`);
    });
    return kb.row().text('« Назад', `admin_client:${telegramId}`);
  },

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

  clientPeerDetailsText: (
    peer: TPeer,
    readOnly = false,
    awgAvailable = true,
  ) => {
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
      (awgAvailable ? `🌐 IP: \`${peer.ip}\`\n` : '') +
      `📊 Статус: ${status}\n\n` +
      subscriptionDetails;

    if (peer.description) {
      text += `\n\n📝 *Описание:*\n${escapeMarkdown(peer.description)}`;
    }

    if (readOnly) {
      text += `\n\n${BotUi.adminConfigReadOnly}`;
    }

    return text;
  },

  clientPeerDetailsKeyboard: (
    peer: TPeer,
    telegramId: string,
    readOnly = false,
    awgAvailable = true,
  ) => {
    const keyboard = new InlineKeyboard();
    const expired = isExpired(peer);

    if (readOnly) {
      if (awgAvailable) {
        keyboard
          .text('📷 QR AmneziaWG', `show_qr:${peer.name}`)
          .text('📄 Файл AmneziaWG', `get_config_file:${peer.name}`)
          .row();
      }
      return keyboard
        .text('🌐 VLESS Reality', `vless_menu:${peer.name}`)
        .row()
        .text('« К конфигам', `admin_client_configs:${telegramId}`);
    }

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
      .row();
    if (awgAvailable) {
      keyboard
        .text('📷 QR AmneziaWG', `show_qr:${peer.name}`)
        .text('📄 Файл AmneziaWG', `get_config_file:${peer.name}`)
        .row();
    }
    keyboard
      .text('🌐 VLESS Reality', `vless_menu:${peer.name}`)
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

  /**
   * Кнопка возврата на сообщении с QR/файлом конфига. Карточка конфига осталась
   * выше нетронутой, поэтому возврат — просто закрытие медиа-сообщения; параметры
   * не нужны, и клавиатура одна для всех веток меню.
   */
  closeMediaKeyboard: () =>
    new InlineKeyboard().text('« К конфигу', 'close_media'),

  // === Инструкции: выбор способа подключения ===

  instructionsMenuTitle:
    '📖 *Инструкция по подключению*\n\n' +
    '🛡 *AmneziaWG* — откройте конфиг в AmneziaVPN или отсканируйте QR-код.\n\n' +
    '💬 _Не получается? Поддержка:_ @CharlieWaldo',

  instructionsMenuKeyboard: () => {
    const keyboard = new InlineKeyboard();
    return keyboard
      .text('🛡 AmneziaWG', 'instructions_awg')
      .row()
      .text('« Назад в меню', 'main_menu');
  },

  // === Инструкции по установке AmneziaVPN ===

  instructionsAwgTitle:
    '🛡 *Установка AmneziaVPN*\n\n' +
    'Выберите вашу платформу — откроется пошаговая инструкция с прямыми ссылками на приложение.\n\n' +
    '❗️❗️ *У ВАС iPhone ИЛИ iPad? НАЧНИТЕ ОТСЮДА!* ❗️❗️\n' +
    'AmneziaVPN *нет в российском App Store*. Пока регион Apple ID — Россия, приложение не установится ни поиском, ни по ссылке.\n' +
    '👉 Нажмите *«🍎 iOS / iPhone»* ниже — там смена региона по шагам (бесплатно, ~5 минут).\n\n' +
    '⏱ _Обычно настройка занимает 2–3 минуты_\n' +
    '⚠️ _Конфиг открывается только в AmneziaVPN: официальный клиент WireGuard его не примет._\n\n' +
    '💬 _Не получается? Поддержка:_ @CharlieWaldo',

  instructionsAwgKeyboard: () =>
    new InlineKeyboard()
      .text('📱 Android', 'instruction:android')
      .text('🍎 iOS / iPhone', 'instruction:ios')
      .row()
      .text('🪟 Windows', 'instruction:windows')
      .text('🍏 macOS', 'instruction:macos')
      .row()
      .text('🐧 Linux', 'instruction:linux')
      .row()
      .text('🔀 Раздельное туннелирование', 'instruction:split')
      .row()
      .text('« К способам подключения', 'show_instructions')
      .row()
      .text('« В меню', 'main_menu'),

  /**
   * Возврат со страницы платформы. Ведёт к списку платформ ТОГО ЖЕ протокола —
   * иначе пользователь, читавший инструкцию по VLESS, попадал бы в список
   * AmneziaVPN и терял место.
   */
  backToInstructionsKeyboard: (protocol: 'awg' | 'vless' = 'awg') =>
    new InlineKeyboard()
      .text(
        '« К списку платформ',
        protocol === 'vless' ? 'instructions_vless' : 'instructions_awg',
      )
      .row()
      .text('« В меню', 'main_menu'),

  instructionAndroid:
    '📱 *Установка AmneziaVPN на Android*\n\n' +
    '*Шаг 1: Установите приложение*\n' +
    '• [AmneziaVPN в Google Play](https://play.google.com/store/apps/details?id=org.amnezia.vpn)\n' +
    '• Или APK со [страницы загрузки](https://amnezia.org/downloads)\n' +
    '• Нужна версия *5.0.1.5* или новее\n\n' +
    '*Шаг 2: Импортируйте конфиг*\n' +
    '• Скачайте файл .conf из бота\n' +
    '• Откройте AmneziaVPN → «У меня есть данные для подключения»\n' +
    '• Выберите «Файл с настройками» и укажите скачанный .conf\n' +
    '• Либо отсканируйте QR-код из карточки конфига\n\n' +
    '*Шаг 3: Подключитесь*\n' +
    '• Нажмите кнопку подключения\n' +
    '• Разрешите приложению создать защищённое соединение\n' +
    '• Готово! 🎉\n\n' +
    '⚠️ _Официальный клиент WireGuard такой конфиг не откроет._',

  instructionIos:
    '🍎 *Установка AmneziaVPN на iOS / iPhone*\n\n' +
    '❗️❗️ *САМОЕ ГЛАВНОЕ — ПРОЧТИТЕ ПЕРВЫМ* ❗️❗️\n' +
    '*AmneziaVPN недоступен в российском App Store.* Пока регион вашего Apple ID — Россия, приложение не найдётся ни поиском, ни по прямой ссылке.\n' +
    '❗️ Сначала смените регион: это *бесплатно*, занимает *~5 минут*, ваши покупки и подписки сохраняются, вернуть регион обратно можно в любой момент.\n\n' +
    '*Шаг 1: Смените регион App Store*\n' +
    '1️⃣ «Настройки» → нажмите на своё имя вверху\n' +
    '2️⃣ «Медиаматериалы и покупки» → «Просмотреть» → войдите\n' +
    '3️⃣ «Страна/регион» → «Изменить страну или регион»\n' +
    '4️⃣ Выберите страну — подойдут *Турция*, *Казахстан*, *Армения* или *США*\n' +
    '5️⃣ Примите условия → в способе оплаты выберите *«Нет» / «None»*\n' +
    '6️⃣ Укажите любой корректный адрес выбранной страны и телефон в её формате (проще всего взять адрес любого отеля)\n' +
    '7️⃣ Сохраните — App Store переключится, AmneziaVPN станет доступен\n\n' +
    '⚠️ _Если вариант «Нет / None» не появляется — отмените активные подписки Apple и потратьте остаток на счету, затем повторите._\n\n' +
    '*Шаг 2: Установите приложение*\n' +
    '• [AmneziaVPN в App Store](https://apps.apple.com/app/amneziavpn/id1600529900)\n' +
    '• Или найдите "AmneziaVPN" в App Store\n\n' +
    '*Шаг 3: Импортируйте конфиг*\n\n' +
    '_Способ 1 (через QR-код — быстрее):_\n' +
    '• Откройте AmneziaVPN → «У меня есть данные для подключения»\n' +
    '• Выберите импорт по QR-коду и отсканируйте код из бота\n\n' +
    '_Способ 2 (через файл):_\n' +
    '• Скачайте файл .conf из бота\n' +
    '• Нажмите на файл → «Поделиться» → AmneziaVPN\n\n' +
    '*Шаг 4: Подключитесь*\n' +
    '• Нажмите кнопку подключения\n' +
    '• Разрешите добавление VPN-конфигурации\n' +
    '• Готово! 🎉\n\n' +
    '⚠️ _Официальный клиент WireGuard такой конфиг не откроет._\n\n' +
    '💬 *Не получилось? Напишите:* @CharlieWaldo',

  instructionWindows:
    '🪟 *Установка AmneziaVPN на Windows*\n\n' +
    '*TunnelVPN 1.0.21 — ещё один вариант для AmneziaWG*\n' +
    '• [Скачать](https://github.com/enkeym/tunnel-vpn/releases/tag/v1.0.21) → `TunnelVPN-1.0.21-setup.exe`\n' +
    '• Добавьте файл .conf из бота, выберите основной туннель и подключитесь. Автоподключение включается в настройках и работает также после сна.\n\n' +
    '*Шаг 1: Скачайте и установите*\n' +
    '• [Страница загрузки Amnezia](https://amnezia.org/downloads)\n' +
    '• Или [релизы на GitHub](https://github.com/amnezia-vpn/amnezia-client/releases)\n' +
    '• Запустите установщик и следуйте подсказкам\n\n' +
    '*Шаг 2: Импортируйте конфиг*\n' +
    '• Запустите AmneziaVPN\n' +
    '• «У меня есть данные для подключения» → «Файл с настройками»\n' +
    '• Выберите скачанный из бота файл .conf\n\n' +
    '*Шаг 3: Подключитесь*\n' +
    '• Нажмите кнопку подключения\n' +
    '• Подтвердите установку VPN-адаптера, если система спросит\n' +
    '• Готово! 🎉\n\n' +
    '⚠️ _Официальный клиент WireGuard такой конфиг не откроет._',

  instructionMacos:
    '🍏 *Установка AmneziaVPN на macOS*\n\n' +
    '*Шаг 1: Установите приложение*\n' +
    '• [Страница загрузки Amnezia](https://amnezia.org/downloads)\n' +
    '• Или [релизы на GitHub](https://github.com/amnezia-vpn/amnezia-client/releases)\n\n' +
    '*Шаг 2: Импортируйте конфиг*\n' +
    '• Запустите AmneziaVPN\n' +
    '• «У меня есть данные для подключения» → «Файл с настройками»\n' +
    '• Укажите скачанный из бота файл .conf\n\n' +
    '*Шаг 3: Подключитесь*\n' +
    '• Нажмите кнопку подключения\n' +
    '• Разрешите добавление VPN-конфигурации\n' +
    '• Готово! 🎉\n\n' +
    '⚠️ _Официальный клиент WireGuard такой конфиг не откроет._',

  instructionLinux:
    '🐧 *Установка на Linux*\n\n' +
    '*Вариант 1: приложение AmneziaVPN (проще)*\n' +
    '• Скачайте сборку со [страницы загрузки](https://amnezia.org/downloads) ' +
    'или из [релизов на GitHub](https://github.com/amnezia-vpn/amnezia-client/releases)\n' +
    '• Запустите приложение и импортируйте файл .conf из бота\n\n' +
    '*Вариант 2: консольные amneziawg-tools*\n' +
    '1. Соберите/установите [amneziawg-tools](https://github.com/amnezia-vpn/amneziawg-tools) ' +
    'и [amneziawg-go](https://github.com/amnezia-vpn/amneziawg-go)\n' +
    '2. Скопируйте конфиг:\n' +
    '```\nsudo cp путь/к/файлу.conf /etc/amnezia/amneziawg/awg0.conf\n```\n' +
    '3. Запустите VPN:\n' +
    '```\nsudo awg-quick up awg0\n```\n' +
    '4. Для автозапуска:\n' +
    '```\nsudo systemctl enable awg-quick@awg0\n```\n\n' +
    '⚠️ _Обычный `wg-quick` этот конфиг не поднимет: нужны awg-бинари._',

  /**
   * Раздельное туннелирование ломается в самом клиенте AmneziaVPN, а не в нашем
   * конфиге: домен в списке резолвится один раз и берётся только первый IPv4
   * (amnezia-client #2519, #2441, #1551 — открыты). Поэтому инструкция ведёт
   * к обходу списком в CIDR, а не к «попробуйте ещё раз».
   */
  instructionSplitTunneling:
    '🔀 *Раздельное туннелирование*\n\n' +
    'Это режим, когда через VPN идут не все сайты, а только выбранные ' +
    '(или наоборот — все, кроме выбранных).\n\n' +
    '⚠️ *Сначала обновите приложение*\n' +
    'Нужна версия *5.0.1.5* или новее — [страница загрузки](https://amnezia.org/downloads), ' +
    '[релизы на GitHub](https://github.com/amnezia-vpn/amnezia-client/releases).\n' +
    'В версии 5.0.0.5 подсети в списке обрезались, и он просто не работал.\n\n' +
    '*Списки задавайте адресами, а не доменами*\n' +
    'Разделение *по доменам* в приложении работает нестабильно: адрес сайта ' +
    'определяется один раз при добавлении, а у крупных сервисов он постоянно ' +
    'меняется — список перестаёт совпадать с реальностью.\n\n' +
    'Готовые списки в нужном формате: [iplist.opencck.org](https://iplist.opencck.org/)\n' +
    '• формат — *Amnezia*\n' +
    '• тип — *IPv4 IP zones*\n' +
    '• выберите нужные сервисы и скачайте файл\n\n' +
    '*После правки списка переподключите туннель* — на лету изменения не ' +
    'подхватываются.\n\n' +
    '💡 _Если нужно пустить через VPN конкретное приложение, а не сайт — ' +
    'используйте разделение по приложениям: оно работает надёжнее._\n\n' +
    '💬 _Не получилось? Поддержка:_ @CharlieWaldo',

  // === Инструкции по подключению VLESS (Xray) ===

  instructionsVlessTitle:
    '🌐 *Подключение по VLESS*\n\n' +
    'Бот выдаёт ссылку VLESS Reality для импорта в приложение.\n\n' +
    'Выберите вашу платформу — откроется пошаговая инструкция с точными названиями файлов для скачивания.\n\n' +
    '⚙️ _Пользуетесь Hiddify? Ниже есть кнопка «Готовые настройки» — файл со всеми рекомендуемыми параметрами, который применяется в одно касание, без ручной настройки._\n\n' +
    '⏱ _Обычно настройка занимает 2–3 минуты_\n\n' +
    '🔀 _Плохо работает или заблокировано на конкретной сети?_ Попробуйте переключить сеть или повторить подключение позже.\n\n' +
    '🌍 _IPv6 включён:_ сайты, доступные только по IPv6, открываются через тот же канал — отдельно ничего настраивать не нужно.',

  instructionsVlessKeyboard: () =>
    new InlineKeyboard()
      .text('📱 Android', 'instruction_vless:android')
      .text('🍎 iOS / iPhone', 'instruction_vless:ios')
      .row()
      .text('🪟 Windows', 'instruction_vless:windows')
      .text('🍏 macOS', 'instruction_vless:macos')
      .row()
      .text('🐧 Linux', 'instruction_vless:linux')
      .row()
      .text('⚙️ Готовые настройки Hiddify', 'send_hiddify_settings')
      .row()
      .text('📖 Официальные ресурсы', 'instruction_vless:resources')
      .row()
      .text('« К способам подключения', 'show_instructions')
      .row()
      .text('« В меню', 'main_menu'),

  instructionVlessResources:
    '📖 *Официальные ресурсы клиентов*\n\n' +
    '*Hiddify*\n' +
    '• [Сайт](https://hiddify.com/) · [GitHub](https://github.com/hiddify/hiddify-app/releases/latest)\n\n' +
    '*Happ (iOS)*\n' +
    '• [App Store](https://apps.apple.com/app/happ-proxy-utility/id6504287215)\n\n' +
    '*v2rayNG (Android)*\n' +
    '• [GitHub](https://github.com/2dust/v2rayNG/releases/latest)\n\n' +
    '*v2rayN (Windows/macOS/Linux)*\n' +
    '• [GitHub](https://github.com/2dust/v2rayN/releases/latest)\n\n' +
    '*NekoBox / NekoRay*\n' +
    '• [Android](https://github.com/MatsuriDayo/NekoBoxForAndroid/releases/latest) · [Desktop](https://github.com/MatsuriDayo/nekoray/releases/latest)\n\n' +
    '_gRPC и XHTTP требуют свежего ядра: обновляйте приложение и не откатывайтесь ' +
    'на старые версии — иначе эти каналы просто не появятся в списке._\n\n' +
    '_Выберите платформу для пошаговой инструкции_',

  instructionVlessAndroid:
    '📱 *VLESS на Android*\n\n' +
    '━━━ *1. NekoBox (рекомендуем)* ━━━\n' +
    '_Поддерживает VLESS Reality._\n' +
    '• [Скачать APK](https://github.com/MatsuriDayo/NekoBoxForAndroid/releases/latest) → `NekoBoxForAndroid-universal-release.apk`\n' +
    '• «➕» вверху справа → *«Import profile from clipboard»* (вставит ссылку) или *«Scan QR code»*\n' +
    '• Переключатель ⏻ внизу справа — подключиться\n\n' +
    '━━━ *2. Hiddify* ━━━\n' +
    '• [Google Play](https://play.google.com/store/apps/details?id=app.hiddify.com) · [GitHub `.apk`](https://github.com/hiddify/hiddify-app/releases/latest)\n' +
    '• «+» → *«Add Profile» → «From clipboard»* (вставит ссылку-подписку) или *«Scan QR»*\n' +
    '• Кнопка **⏻** по центру экрана — подключиться\n' +
    '• Разово выставьте Маршрутизация → Входящие → *TUN → Mixed*, либо нажмите «⚙️ Готовые настройки Hiddify» в списке платформ — настроится само\n' +
    '• Не грузятся сайты? Settings → DNS → Remote DNS → `1.1.1.1`\n\n' +
    '━━━ *3. v2rayNG* ━━━\n' +
    '_Поддерживает VLESS Reality._\n' +
    '• [Скачать APK](https://github.com/2dust/v2rayNG/releases/latest) — ищите файл с `arm64-v8a` в названии\n' +
    '• «+» → *«Импорт из буфера обмена»* — вставьте ссылку из бота\n' +
    '• Выберите профиль *Reality* и подключитесь\n\n' +
    '✅ Весь трафик (включая Telegram и YouTube) идёт через VPN.',

  instructionVlessIos:
    '🍎 *VLESS на iOS / iPhone*\n\n' +
    '⚠️ *Сначала главное.* В российском App Store сейчас нет ни одного подходящего приложения — Apple удалила их все по требованию Роскомнадзора. Это ограничение App Store, а не нашего сервиса: приложения существуют и работают, просто не отдаются аккаунтам с российским регионом.\n\n' +
    'Поэтому на iPhone нужен *один разовый шаг* — сменить регион Apple ID. Это бесплатно, занимает пять минут, ничего не удаляет с телефона и в любой момент отменяется.\n\n' +
    '*Шаг 1: Смените регион Apple ID на США*\n' +
    '• Настройки → нажмите на своё имя вверху → «Медиаматериалы и покупки» → «Просмотреть учётную запись»\n' +
    '• «Страна/регион» → «Изменить страну или регион» → *United States*\n' +
    '• Способ оплаты — *None*. Карта не нужна, приложение бесплатное\n' +
    '• Адрес — любой существующий американский, телефон в формате `+1 XXX XXX XXXX`\n' +
    '• Примите условия. Готово\n\n' +
    '_Перед сменой:_ баланс Apple ID должен быть нулевым, а подписки, купленные в российском регионе, нужно отменить. Установленные приложения, фото и данные iCloud остаются на месте.\n\n' +
    '*Шаг 2: Установите приложение*\n' +
    '• *Streisand* — рекомендуем: бесплатный, с открытым кодом, отлично держит наш протокол: [App Store](https://apps.apple.com/app/streisand/id6450534064)\n' +
    '• *Happ* — запасной вариант: [App Store](https://apps.apple.com/app/happ-proxy-utility/id6504287215)\n' +
    '• *Shadowrocket* — платный (~$3), самый гибкий, для опытных: [App Store](https://apps.apple.com/app/shadowrocket/id932747118)\n\n' +
    '💡 _Не хотите трогать основной Apple ID?_ Создайте отдельный Apple ID с регионом США и войдите им *только* в App Store (Настройки → App Store → аккаунт), не трогая iCloud. Тогда основной аккаунт, фото и переписки останутся нетронутыми.\n\n' +
    '*Шаг 3: Добавьте конфиг*\n' +
    '• Скопируйте ссылку из бота (нажмите на неё) — профиль Reality\n' +
    '• Откройте приложение → «+» → «Добавить из буфера обмена» (Import from clipboard)\n' +
    '• _Или_ «+» → «Сканировать QR-код» и наведите на QR из бота\n\n' +
    '*Шаг 4: Подключитесь*\n' +
    '• Нажмите кнопку подключения / переключатель\n' +
    '• Разрешите добавление VPN-конфигурации (запросит один раз)\n' +
    '• Готово! Весь трафик (включая Telegram и YouTube) идёт через VPN 🎉\n\n' +
    '⚙️ _Используете Hiddify?_ Выставьте TUN → *Mixed* в Маршрутизация → Входящие — или нажмите «⚙️ Готовые настройки Hiddify» в списке платформ.\n\n' +
    '⚠️ _Сайты не грузятся?_ Remote DNS → `1.1.1.1`, переподключитесь.',

  instructionVlessWindows:
    '🪟 *VLESS на Windows*\n\n' +
    '*Шаг 1: Скачайте приложение* (любое на выбор)\n' +
    '• *v2rayN* — рекомендуем, самый стабильный: [GitHub](https://github.com/2dust/v2rayN/releases/latest) (файл `v2rayN-windows-64.zip`)\n' +
    '• *Hiddify*: [GitHub](https://github.com/hiddify/hiddify-app/releases/latest) (файл `Hiddify-Windows-Setup-x64.exe`)\n' +
    '• *NekoRay*: [GitHub](https://github.com/MatsuriDayo/nekoray/releases/latest)\n\n' +
    '*Шаг 2: Добавьте конфиг*\n' +
    '• Скопируйте ссылку-подписку (или `vless://…`) из бота\n' +
    '• *v2rayN*: в трее правой кнопкой → «Импорт из буфера обмена» (или Ctrl+V в главном окне)\n' +
    '• *Hiddify*: «New Profile» / «+» → «Добавить из буфера обмена»\n\n' +
    '*Шаг 3: Подключитесь*\n' +
    '• *v2rayN*: выберите сервер → правой кнопкой по значку в трее → режим «Глобальный» (Global), чтобы весь трафик шёл через VPN\n' +
    '• *Hiddify*: большая кнопка подключения\n' +
    '• Готово! 🎉\n\n' +
    '⚠️ _Сайты не грузятся?_ Remote DNS → `1.1.1.1`, переподключитесь.\n' +
    '💡 _Совет:_ включите автозапуск в настройках приложения.\n\n' +
    '⚙️ _Используете Hiddify?_ Выставьте TUN → *Mixed* во Входящих — или нажмите «⚙️ Готовые настройки Hiddify» в списке платформ.',

  instructionVlessMacos:
    '🍏 *VLESS на macOS*\n\n' +
    '*Шаг 1: Установите приложение* (любое на выбор)\n' +
    '• *v2rayN* — рекомендуем, скачивается напрямую, без App Store: [GitHub](https://github.com/2dust/v2rayN/releases/latest) (файл `v2rayN-macos-64.dmg`)\n' +
    '• *Hiddify* — тоже есть вне App Store: [GitHub `.dmg`](https://github.com/hiddify/hiddify-app/releases/latest)\n' +
    '• *Streisand* / *V2Box* — только через App Store с аккаунтом региона США (см. инструкцию для iPhone — смена региона общая для всех устройств Apple)\n\n' +
    '_В российском App Store подобных приложений больше нет — на macOS проще всего скачать с GitHub, это ограничение обходит._\n\n' +
    '*Шаг 2: Добавьте конфиг*\n' +
    '• Скопируйте ссылку-подписку (или `vless://…`) из бота\n' +
    '• В приложении → «+» → «Добавить из буфера обмена»\n\n' +
    '*Шаг 3: Подключитесь*\n' +
    '• Нажмите кнопку подключения\n' +
    '• Разрешите добавление VPN-конфигурации (запросит один раз)\n' +
    '• Готово! Весь трафик (включая Telegram и YouTube) идёт через VPN 🎉\n\n' +
    '⚠️ _Сайты не грузятся?_ Remote DNS → `1.1.1.1`, переподключитесь.\n' +
    '💡 _Совет:_ иконка в меню-баре позволяет быстро включать/выключать VPN.\n\n' +
    '⚙️ _Используете Hiddify?_ Выставьте TUN → *Mixed* во Входящих — или нажмите «⚙️ Готовые настройки Hiddify» в списке платформ.',

  instructionVlessLinux:
    '🐧 *VLESS на Linux*\n\n' +
    '*Шаг 1: Скачайте приложение* (любое на выбор)\n' +
    '• *Hiddify*: [GitHub](https://github.com/hiddify/hiddify-app/releases/latest) — `Hiddify-Linux-x64.AppImage` (универсально) или `.deb`\n' +
    '• *NekoRay*: [GitHub](https://github.com/MatsuriDayo/nekoray/releases/latest)\n' +
    '• *v2rayN* (Linux): [GitHub](https://github.com/2dust/v2rayN/releases/latest)\n\n' +
    '*Шаг 2: Запустите*\n' +
    '• AppImage: сделайте исполняемым и запустите\n' +
    '```\nchmod +x Hiddify-Linux-x64.AppImage\n./Hiddify-Linux-x64.AppImage\n```\n' +
    '• `.deb`: `sudo dpkg -i Hiddify-*.deb`\n\n' +
    '*Шаг 3: Добавьте конфиг и подключитесь*\n' +
    '• Скопируйте ссылку-подписку (или `vless://…`) из бота\n' +
    '• В приложении: «+» → «Добавить из буфера обмена»\n' +
    '• Нажмите кнопку подключения (в NekoRay — включите режим Tun/Global для всего трафика)\n' +
    '• Готово! 🎉\n\n' +
    '⚠️ _Сайты не грузятся?_ Remote DNS → `1.1.1.1`, переподключитесь.\n\n' +
    '⚙️ _Используете Hiddify?_ Выставьте TUN → *Mixed* во Входящих — или нажмите «⚙️ Готовые настройки Hiddify» в списке платформ.',

  // === Готовые настройки Hiddify (options.json) ===

  hiddifySettingsIntro:
    '⚙️ *Готовые настройки Hiddify*\n\n' +
    'Сейчас пришлю файл с уже настроенными параметрами — вручную ничего выставлять не нужно. Внутри:\n' +
    '• 🔴 Реализация TUN → *Mixed* (самое важное)\n' +
    '• Регион → *Россия*\n' +
    '• Поддельный DNS → *включён*\n' +
    '• Строгая маршрутизация → *выключена*\n' +
    '• Маршрут IPv6 → *включён* (приоритет у IPv4)\n' +
    '• Balancer → *Sticky session*\n\n' +
    '_Ниже — файл для импорта и текст для копирования, чтобы вам было удобно в любом случае._',

  hiddifySettingsFileCaption:
    '📥 *Файл `hiddify-options.json`*\n\n' +
    '*Как импортировать через файл:*\n' +
    '1. Откройте Hiddify\n' +
    '2. Нажмите на *⋮* (три точки) в правом верхнем углу\n' +
    '3. Выберите *«Импорт» / «Import»* → *«Из файла» / «From file»*\n' +
    '4. Укажите этот файл — настройки применятся автоматически',

  hiddifySettingsCopyText: (json: string) =>
    '📋 *Или скопируйте текст ниже*\n\n' +
    'Нажмите на блок — он скопируется в буфер обмена:\n\n' +
    '```json\n' +
    json +
    '\n```\n\n' +
    'Затем в Hiddify: *⋮* (три точки сверху) → *«Импорт» / «Import»* → *«Из буфера обмена» / «From clipboard»*.',
};
