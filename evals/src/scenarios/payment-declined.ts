import { paymentScenario } from '../world/checkout.ts';

export default paymentScenario(
  'payment-declined',
  'Decline a checkout without sending card details',
  'decline',
);
