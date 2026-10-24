import type { MessagingTransport } from '../../ports/messaging.ts';

export function combineMessagingTransports(
  ...transports: MessagingTransport[]
): MessagingTransport {
  const forChannel = (id: string) =>
    transports.findLast((transport) => transport.channels.some((channel) => channel.id === id));
  return {
    get channels() {
      return [
        ...new Map(
          transports.flatMap((transport) =>
            transport.channels.map((channel) => [channel.id, channel] as const),
          ),
        ).values(),
      ];
    },
    async poll(accept, pair, react) {
      const results = await Promise.allSettled(
        transports.map((transport) => transport.poll?.(accept, pair, react)),
      );
      const failed = results.find((result) => result.status === 'rejected');
      if (failed?.status === 'rejected') throw failed.reason;
    },
    async receive(input) {
      return (
        (await forChannel(input.channelId)?.receive(input)) ?? {
          status: 404,
          body: { error: 'Channel is not configured.' },
        }
      );
    },
    async post(input) {
      const transport = forChannel(input.channelId);
      if (!transport) throw new Error('Channel is not configured.');
      return transport.post(input);
    },
    async react(input) {
      return (await forChannel(input.channelId)?.react?.(input)) ?? 'unsupported';
    },
    async presence(input) {
      await forChannel(input.channelId)?.presence?.(input);
    },
    async pairing() {
      const transport = transports.findLast((transport) => transport.pairing);
      if (!transport?.pairing) throw new Error('QR pairing is unavailable.');
      return transport.pairing();
    },
    async unlink() {
      for (const transport of transports) await transport.unlink?.();
    },
    async cancelPairing(pairingId, restart) {
      const transport = transports.findLast((transport) => transport.cancelPairing);
      return (await transport?.cancelPairing?.(pairingId, restart)) ?? false;
    },
    async close() {
      const results = await Promise.allSettled(transports.map((transport) => transport.close()));
      if (results.some((result) => result.status === 'rejected'))
        throw new Error('A channel could not close.');
    },
  };
}
