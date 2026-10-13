export function PairingCode({ code }: { code: string }) {
  return (
    <div className="pairing-code" role="status">
      <p>Check that your browser shows this code</p>
      <p className="pairing-code-value" data-analytics-private>
        {code}
      </p>
      <p>If it’s different, close that window and start again.</p>
    </div>
  );
}
