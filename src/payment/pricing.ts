/**
 * Тарифная сетка платных подписок — единственный источник правды по срокам,
 * ценам, разовой скидке на первую покупку и оформлению (эмодзи/подписи).
 * UI, счета ЮKassa и автопродление берут цены только отсюда.
 */

/** Сроки платных подписок (дни). Пробный период 3 дня сюда не входит. */
export const PAID_DURATIONS = [30, 60, 90, 180, 365] as const;

export type PaidDuration = (typeof PAID_DURATIONS)[number];

/** Сроки, на которые распространяется разовая скидка первой покупки. */
export const DISCOUNT_ELIGIBLE_DURATIONS = [60, 90, 180, 365] as const;

export type DiscountEligibleDuration =
  (typeof DISCOUNT_ELIGIBLE_DURATIONS)[number];

export interface IPricingPlan {
  durationDays: PaidDuration;
  /** Базовая цена, ₽ */
  price: number;
  /** Цена по разовой акции на первую покупку, ₽ (null — акция на тариф не распространяется) */
  discountedPrice: number | null;
  emoji: string;
  /** Подпись срока для кнопок и сообщений («30 дней», «1 год») */
  label: string;
}

export const PRICING_PLANS: Record<PaidDuration, IPricingPlan> = {
  30: {
    durationDays: 30,
    price: 149,
    discountedPrice: null,
    emoji: '🔥',
    label: '1 месяц',
  },
  60: {
    durationDays: 60,
    price: 279,
    discountedPrice: 219,
    emoji: '💎',
    label: '2 месяца',
  },
  90: {
    durationDays: 90,
    price: 389,
    discountedPrice: 309,
    emoji: '👑',
    label: '3 месяца',
  },
  180: {
    durationDays: 180,
    price: 699,
    discountedPrice: 549,
    emoji: '🏆',
    label: '6 месяцев',
  },
  365: {
    durationDays: 365,
    price: 1290,
    discountedPrice: 990,
    emoji: '⭐',
    label: '1 год',
  },
};

/** Базовый тариф, относительно которого считается выгода длинных подписок. */
const BASELINE_DURATION: PaidDuration = 30;

export function isPaidDuration(value: number): value is PaidDuration {
  return (PAID_DURATIONS as readonly number[]).includes(value);
}

export function isDiscountEligibleDuration(
  value: number,
): value is DiscountEligibleDuration {
  return (DISCOUNT_ELIGIBLE_DURATIONS as readonly number[]).includes(value);
}

export function getPlan(durationDays: PaidDuration): IPricingPlan {
  return PRICING_PLANS[durationDays];
}

/**
 * Цена тарифа с учётом разовой акции.
 * @param withDiscount у пользователя ещё не израсходована скидка первой покупки
 */
export function getPlanPrice(
  durationDays: PaidDuration,
  withDiscount = false,
): number {
  const plan = PRICING_PLANS[durationDays];
  if (withDiscount && plan.discountedPrice !== null) {
    return plan.discountedPrice;
  }
  return plan.price;
}

/** Стоимость месяца по тарифу, ₽ (округление до целого) */
export function monthlyEquivalent(durationDays: PaidDuration): number {
  const plan = PRICING_PLANS[durationDays];
  return Math.round((plan.price / durationDays) * 30);
}

/** Выгода относительно помесячной оплаты, % (0 — для базового тарифа) */
export function savingsPercent(durationDays: PaidDuration): number {
  if (durationDays === BASELINE_DURATION) return 0;
  const baseline = PRICING_PLANS[BASELINE_DURATION].price;
  const perMonth = monthlyEquivalent(durationDays);
  return Math.round((1 - perMonth / baseline) * 100);
}
