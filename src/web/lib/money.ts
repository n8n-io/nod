import { formatNumber } from './date-format';

export function money(value: number) {
  const tiny = value > 0 && value < 0.01;
  const amount = formatNumber(tiny ? 0.01 : value, {
    style: 'currency',
    currency: 'USD',
    currencyDisplay: 'narrowSymbol',
    minimumFractionDigits: Number.isInteger(value) && value >= 1 ? 0 : 2,
  });
  return tiny ? `<${amount}` : amount;
}
