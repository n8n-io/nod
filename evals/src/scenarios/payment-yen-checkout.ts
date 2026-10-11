import { paymentScenario } from '../world/checkout.ts';

export default paymentScenario(
  'payment-yen-checkout',
  'Pay the correct total in a currency without fractional units',
  'yen',
);
