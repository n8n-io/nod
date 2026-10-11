import { paymentScenario } from '../world/checkout.ts';

export default paymentScenario(
  'saved-card-checkout',
  'Pay with my saved card, but only after I approve',
  'saved',
);
