import { paymentScenario } from '../world/checkout.ts';

export default paymentScenario(
  'payment-security-code',
  'Pay with a saved card through a secure code reply',
  'code',
);
