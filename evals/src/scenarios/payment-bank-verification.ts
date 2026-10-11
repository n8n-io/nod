import { paymentScenario } from '../world/checkout.ts';

export default paymentScenario(
  'payment-bank-verification',
  'Finish a card payment with secure bank verification',
  'challenge',
);
