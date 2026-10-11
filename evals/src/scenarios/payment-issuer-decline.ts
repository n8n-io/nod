import { paymentScenario } from '../world/checkout.ts';

export default paymentScenario(
  'payment-issuer-decline',
  'Try again after an issuer decline and fresh owner approval',
  'rejected',
);
