import '../core/api_transport.dart';

final class NodRichResultsRepository {
  const NodRichResultsRepository(this.transport);
  final NodApiTransport transport;

  Future<void> react(String messageId, String? reaction) async {
    await transport.requestJson(
      'POST',
      '/api/messages/${Uri.encodeComponent(messageId)}/reaction',
      body: {'reaction': reaction},
    );
  }
}
