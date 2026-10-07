export const conversation = 'conversation';

type Claim = {
  owner: string;
  queue: { owner: string; grant(): void }[];
  expiry?: ReturnType<typeof setTimeout>;
};

export function createBrowserClaims(holdMs: number) {
  const claims = new Map<string, Claim>();

  function pass(threadId: string, claim: Claim) {
    clearTimeout(claim.expiry);
    claim.expiry = undefined;
    const next = claim.queue.shift();
    if (!next) return void claims.delete(threadId);
    claim.owner = next.owner;
    next.grant();
  }

  function hold(threadId: string, claim: Claim) {
    clearTimeout(claim.expiry);
    claim.expiry = setTimeout(() => pass(threadId, claim), holdMs);
    claim.expiry.unref?.();
  }

  return {
    take(threadId: string, owner: string, signal: AbortSignal): Promise<void> {
      signal.throwIfAborted();
      const claim = claims.get(threadId);
      if (!claim) {
        claims.set(threadId, { owner, queue: [] });
        return Promise.resolve();
      }
      if (claim.owner === owner) {
        clearTimeout(claim.expiry);
        claim.expiry = undefined;
        return Promise.resolve();
      }
      return new Promise((resolve, reject) => {
        const waiter = {
          owner,
          grant: () => {
            signal.removeEventListener('abort', abort);
            resolve();
          },
        };
        const abort = () => {
          claim.queue = claim.queue.filter((item) => item !== waiter);
          reject(signal.reason);
        };
        claim.queue.push(waiter);
        signal.addEventListener('abort', abort, { once: true });
      });
    },
    release(threadId: string, owner: string, keepForUser: boolean) {
      const claim = claims.get(threadId);
      if (claim?.owner !== owner) return;
      if (keepForUser && owner === conversation) hold(threadId, claim);
      else pass(threadId, claim);
    },
    holdForUser(threadId: string) {
      const claim = claims.get(threadId) ?? { owner: conversation, queue: [] };
      if (claim.owner !== conversation) return false;
      claims.set(threadId, claim);
      hold(threadId, claim);
      return true;
    },
  };
}
