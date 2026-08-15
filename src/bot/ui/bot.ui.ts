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
import type { IMtprotoProxyLink } from 'src/mtproto/mtproto.service';

// Экранирование специальных символов Markdown
function escapeMarkdown(text: string): string {
  return text.replace(/([_*[\]()~`>#+\-=|{}.!\\])/g, '\\$1');
}

/**
 * Строка с ссылками на оферту и политику конфиденциальности. Акцепт оферты —
 * действием (оплатой), 152-ФЗ уведомление об обработке ПДн. URL берутся из env
 * (LEGAL_OFFER_URL / LEGAL_PRIVACY_URL) в момент вызова, а не при импорте, —
 * ConfigModule к этому времени уже загрузил .env в process.env. Если ни один URL
 * не задан — строка пустая (ничего не показываем).
 */
function legalNoticeText(): string {
  const offer = process.env.LEGAL_OFFER_URL?.trim();
  const privacy = process.env.LEGAL_PRIVACY_URL?.trim();
  const links: string[] = [];
  if (offer) links.push(`[Оферту](${offer})`);
  if (privacy) links.push(`[Политику конфиденциальности](${privacy})`);
  if (links.length === 0) return '';
  return (
    'ℹ️ _Оплачивая подписку и пользуясь ботом, вы принимаете ' +
    links.join(' и ') +
    ', и даёте согласие на обработку персональных данных._'
  );
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

  // Главное меню для админов: тот же набор, что у обычного пользователя,
  // плюс отдельная точка входа в панель администратора внизу.
  adminMenuKeyboard: (showTrial = false) => {
    const kb = new InlineKeyboard();
    if (showTrial) {
      kb.text('🆓 Пробный период', 'create_trial_config').row();
    }
    kb.text('📄 Получить VPN', 'show_create_options').row();
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
    `🧪 Тестовая оплата: *${testPayment ? 'включена (1 ₽ — только для админов)' : 'выключена'}*\n\n` +
    (testPayment
      ? '🧪 _У админов «Получить VPN» ведёт в тарифы с ценой 1 ₽ — полный клиентский путь: счёт, оплата, выдача конфига._\n' +
        '✅ _Обычные клиенты продолжают платить полную цену — продажи не ломаются. Группу «Семья» режим не затрагивает._\n\n'
      : '') +
    'Изменения применяются мгновенно, без перезапуска бота.',

  adminSettingsKeyboard: (paymentEnabled: boolean, testPayment: boolean) =>
    new InlineKeyboard()
      .text(
        paymentEnabled ? '💳 Оплата: ВКЛ ✅' : '💳 Оплата: ВЫКЛ ⛔',
        'admin_toggle_payment',
      )
      .row()
      .text(
        testPayment
          ? '🧪 Тестовая оплата: ВКЛ ✅'
          : '🧪 Тестовая оплата: ВЫКЛ ⛔',
        'admin_toggle_test_payment',
      )
      .row()
      .text('« К панели администратора', 'admin_panel'),

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

  /** Строка с ссылками на оферту/политику (пустая, если URL не заданы). */
  legalNotice: legalNoticeText,

  // Меню оплаты для обычных пользователей (все платные тарифы)
  paymentPlansTitle: (hasDiscount: boolean, testPayment = false) =>
    '💳 *Тарифы TUNEL VPN*\n\n' +
    'Выберите срок — сразу откроется счёт ЮKassa. После успешной оплаты конфиг придёт в этот чат автоматически.\n\n' +
    '🛡 _AmneziaVPN с обфускацией — трафик не распознаётся как VPN_\n' +
    '📱 _Один конфиг: Android, iOS, Windows, macOS, Linux_\n' +
    `💰 _Чем длиннее срок, тем дешевле месяц: от ${PRICING_PLANS[30].price} ₽ до ${monthlyEquivalent(365)} ₽_\n\n` +
    (hasDiscount
      ? '🎁 *Разовая акция:* скидка на первую покупку от 60 дней — тариф на выбор, действует один раз.\n\n'
      : '') +
    '❗️ *iPhone / iPad:* перед покупкой откройте «📖 Инструкция» → «🍎 iOS / iPhone»: AmneziaVPN ставится только после смены региона Apple ID.\n\n' +
    (testPayment
      ? '⚠️ Тестовый режим админа: в ЮKassa спишется *1 ₽* за любой тариф. У клиентов — полная цена.\n\n'
      : '') +
    legalNoticeText(),

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
    `Чтобы VPN не отключился в неподходящий момент, бот может сам продлевать подписку на *${durationDays} дн.* — списание *${getPlanPrice(durationDays)} ₽* за сутки до окончания срока.\n\n` +
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
        : '_Включите, чтобы подписка продлевалась сама и VPN не отключился._')
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
      keyboard.text(`${status} ${peer.name}`, `manage_peer:${peer.name}`).row();
    });
    keyboard.text('« Назад в меню', 'main_menu');
    return keyboard;
  },

  // proxyAvailable — MTProto-прокси настроен на сервере (MtprotoService.enabled).
  // Флаг передаётся снаружи, а не читается из env здесь: доступность прокси —
  // состояние сервиса, и UI не должен решать это за него.
  peerDetailsKeyboard: (
    peer: TPeer,
    isAdmin: boolean = false,
    proxyAvailable: boolean = false,
  ) => {
    const expired = isExpired(peer);

    // Клавиатура собирается рядами, пустые ряды отсеиваются на сборке:
    // при построении цепочкой .row() набор кнопок зависит от состояния конфига
    // и в клавиатуре легко появляется пустая строка.
    const rows: IKeyboardButton[][] = [
      [{ text: '📷 QR-код', data: `show_qr:${peer.name}` }],
      [{ text: '📄 Получить файл', data: `get_config_file:${peer.name}` }],
    ];

    // Прокси — бонус к активной подписке: истёкшему или поставленному на паузу
    // конфигу кнопку не показываем.
    if (proxyAvailable && !expired && !peer.paused) {
      rows.push([
        { text: '✈️ Прокси для Telegram', data: `tg_proxy:${peer.name}` },
      ]);
    }

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

    if (isAdmin) {
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

    if (isAdmin) {
      rows.push([{ text: 'Удалить', data: `delete_peer:${peer.name}` }]);
    }

    rows.push([{ text: 'К списку', data: 'list_configs' }]);

    return buildKeyboard(rows);
  },

  // === Прокси для Telegram (MTProto) ===

  telegramProxyText: (link: IMtprotoProxyLink) =>
    '✈️ *Прокси для Telegram*\n\n' +
    'Отдельный канал только для Telegram: мессенджер соединяется с нашим ' +
    'сервером напрямую, VPN при этом включать не нужно. Остальной трафик ' +
    'устройства через прокси *не идёт* — для него по-прежнему нужен конфиг.\n\n' +
    '👇 Нажмите кнопку — Telegram сам предложит подключить прокси.\n\n' +
    'Если кнопка не сработала, скопируйте ссылку и откройте её:\n' +
    `\`${link.deepLink}\`\n\n` +
    `⚙️ Сервер: \`${link.host}:${link.port}\`\n` +
    (link.fakeTlsDomain
      ? `🔒 Соединение маскируется под TLS-сеанс с \`${link.fakeTlsDomain}\`\n`
      : '') +
    '\n_Прокси доступен, пока активна подписка._',

  telegramProxyKeyboard: (link: IMtprotoProxyLink, peerName: string) =>
    new InlineKeyboard()
      .url('✈️ Подключить прокси', link.shareUrl)
      .row()
      .text('« К конфигу', `manage_peer:${peerName}`),

  /** Прокси выключен на сервере либо подписка по конфигу уже неактивна */
  telegramProxyUnavailable: (peerName: string) => ({
    text:
      '✈️ *Прокси для Telegram*\n\n' +
      'Сейчас прокси недоступен — он либо отключён, либо подписка по этому ' +
      'конфигу неактивна. Продлите конфиг или попробуйте позже.',
    keyboard: new InlineKeyboard().text(
      '« К конфигу',
      `manage_peer:${peerName}`,
    ),
  }),

  // === Приветственные сообщения ===

  welcomeMessageAdmin:
    '👋 *Добро пожаловать, Администратор!*\n\n' +
    '🔧 Вы имеете полный доступ к управлению TUNEL VPN.\n\n' +
    '🛠 Группа «Семья», поиск и управление клиентами, статистика, аналитика, ' +
    'Рупор и Параметры — в разделе *«Панель администратора»* внизу меню.\n\n' +
    'Выберите действие:',

  welcomeMessageFamily:
    '👋 *Добро пожаловать в TUNEL VPN!*\n\n' +
    '📍 *Сервер:* Финляндия\n' +
    '⚡ *Скорость:* до *200 Мбит/с*\n' +
    '🛡 *Шифрование трафика* и приватность соединения\n\n' +
    '🏠 Вы являетесь членом группы «Семья».\n\n' +
    'Вам доступно:\n' +
    '• 📄 Создание VPN конфигов\n' +
    '• 📂 Управление своими конфигами\n' +
    '• 📖 Инструкции по установке\n\n' +
    '❗️ *iPhone / iPad:* AmneziaVPN нет в российском App Store — сначала смените регион Apple ID (раздел «📖 Инструкция» → «🍎 iOS / iPhone»).\n\n' +
    '_При возникновении вопросов обратитесь к администратору._\n\n' +
    'Выберите действие:',

  welcomeMessageUser:
    '🔐 *TUNEL VPN*\n\n' +
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

  welcomeMessage: '👋 *TUNEL VPN*\n\nВыберите действие:',
  creatingConfig: '⏳ *Создаю конфигурацию...*',
  noConfigs:
    '📂 *У вас пока нет конфигураций*\n\n' +
    'Нажмите «Получить VPN», чтобы:\n' +
    '• Получить пробный конфиг на 3 дня (_бесплатно, один раз_)\n' +
    '• Или выбрать тариф от 30 дней до года\n\n' +
    'После оплаты вы получите файл конфигурации и сможете подключиться за 2–3 минуты по инструкции.',

  configCreated: (name: string, ip: string, expiresAt?: Date | null) => {
    let msg = `✅ *Конфиг ${name} создан!*\n\n` + `🌐 IP: \`${ip}\`\n`;
    if (expiresAt) {
      msg += `📅 Действует до: ${expiresAt.toLocaleDateString('ru-RU')}\n\n`;
    } else {
      msg += '\n';
    }
    msg +=
      '*Дальнейшие шаги:*\n' +
      '1. Установите приложение AmneziaVPN\n' +
      '2. Откройте в нём этот файл и нажмите «Подключить»\n' +
      '3. Готово — VPN активен\n\n' +
      '⚠️ _Конфиг открывается только в AmneziaVPN — официальный клиент WireGuard его не примет._\n\n' +
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
      .text('📷 QR-код', `f_qr:${peer.name}:${mId}`)
      .text('📄 Получить файл', `f_gf:${peer.name}:${mId}`)
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

  memberConfigCreated: (name: string, ip: string, expiresAt?: Date | null) => {
    let msg = `✅ Конфиг создан\n\n🏷 Имя: \`${name}\`\nIP: \`${ip}\``;
    if (expiresAt) {
      msg += `\n📅 Действует до: ${expiresAt.toLocaleDateString('ru-RU')}`;
    } else {
      msg += '\n⏳ Срок: ♾️ Бессрочно';
    }
    msg +=
      '\n\n⚠️ _Открывается только в приложении AmneziaVPN, не в официальном клиенте WireGuard._';
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
      blockedText
    );
  },

  clientDetailsKeyboard: (
    telegramId: string,
    peers: TPeer[],
    isBlocked: boolean,
    hasUsedDiscount: boolean,
  ) => {
    const keyboard = new InlineKeyboard();

    // Кнопка создания конфига
    keyboard.text('➕ Добавить конфиг', `admin_cc:${telegramId}`).row();

    if (peers.length > 0) {
      keyboard.text('📂 Конфиги', `admin_client_configs:${telegramId}`).row();
      keyboard
        .text('🗑 Удалить все конфиги', `admin_delete_all_peers:${telegramId}`)
        .row();
    }

    if (hasUsedDiscount) {
      keyboard
        .text('🎁 Сбросить скидку', `admin_reset_discount:${telegramId}`)
        .row();
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
      .text('📷 QR-код', `admin_qr:${peer.name}:${telegramId}`)
      .text('📄 Получить файл', `admin_get_file:${peer.name}:${telegramId}`)
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

  // === Инструкции по установке AmneziaVPN ===

  instructionsMenuTitle:
    '📖 *Инструкция по установке AmneziaVPN*\n\n' +
    'Выберите вашу платформу — откроется пошаговая инструкция с прямыми ссылками на приложение.\n\n' +
    '❗️❗️ *У ВАС iPhone ИЛИ iPad? НАЧНИТЕ ОТСЮДА!* ❗️❗️\n' +
    'AmneziaVPN *нет в российском App Store*. Пока регион Apple ID — Россия, приложение не установится ни поиском, ни по ссылке.\n' +
    '👉 Нажмите *«🍎 iOS / iPhone»* ниже — там смена региона по шагам (бесплатно, ~5 минут).\n\n' +
    '⏱ _Обычно настройка занимает 2–3 минуты_\n' +
    '⚠️ _Конфиг открывается только в AmneziaVPN: официальный клиент WireGuard его не примет._\n\n' +
    '💬 _Не получается? Поддержка:_ @CharlieWaldo',

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
      .text('« Назад в меню', 'main_menu'),

  backToInstructionsKeyboard: () =>
    new InlineKeyboard()
      .text('« К списку платформ', 'show_instructions')
      .row()
      .text('« В меню', 'main_menu'),

  instructionAndroid:
    '📱 *Установка AmneziaVPN на Android*\n\n' +
    '*Шаг 1: Установите приложение*\n' +
    '• [AmneziaVPN в Google Play](https://play.google.com/store/apps/details?id=org.amnezia.vpn)\n' +
    '• Или APK со [страницы загрузки](https://amnezia.org/downloads)\n' +
    '• Нужна версия *5.0.0.5* или новее\n\n' +
    '*Шаг 2: Импортируйте конфиг*\n' +
    '• Скачайте файл .conf из бота\n' +
    '• Откройте AmneziaVPN → «У меня есть данные для подключения»\n' +
    '• Выберите «Файл с настройками» и укажите скачанный .conf\n' +
    '• Либо отсканируйте QR-код из карточки конфига\n\n' +
    '*Шаг 3: Подключитесь*\n' +
    '• Нажмите кнопку подключения\n' +
    '• Разрешите создание VPN-соединения\n' +
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
};
