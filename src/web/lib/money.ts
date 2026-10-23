import { formatNumber } from './date-format';

export function money(value: number) {
  if (value > 0 && value < 0.01) return '<$0.01';
  return formatNumber(value, {
    style: 'currency',
    currency: 'USD',
    currencyDisplay: 'narrowSymbol',
    minimumFractionDigits: Number.isInteger(value) && value >= 1 ? 0 : 2,
  });
}
