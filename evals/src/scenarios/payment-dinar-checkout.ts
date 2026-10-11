import { paymentScenario } from '../world/checkout.ts';

export default paymentScenario(
  'payment-dinar-checkout',
  'Pay the exact total in a currency with three decimal places',
  'dinar',
);
