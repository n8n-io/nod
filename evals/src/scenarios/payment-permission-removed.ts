import { paymentScenario } from '../world/checkout.ts';

export default paymentScenario(
  'payment-permission-removed',
  'Use a fresh secure code after the card permission is removed',
  'off',
);
