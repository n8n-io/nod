import { useEffect } from 'react';
import { returnToChat } from '../lib/navigation';
import { BrandMark } from '../components/brand';
import { PaymentForm } from '../components/payment-form';

export function Payment({ token }: { token: string }) {
  useEffect(() => {
    if (window.location.search || window.location.hash)
      window.history.replaceState(null, '', window.location.pathname);
  }, []);
  return (
    <main className="credential-page">
      <a href="/" onClick={returnToChat} className="credential-brand" aria-label="Otto home">
        <BrandMark />
        <span>otto</span>
      </a>
      <div className="credential-card">
        <PaymentForm token={token} />
      </div>
    </main>
  );
}
