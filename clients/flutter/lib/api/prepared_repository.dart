import '../core/api_transport.dart';
import '../core/nod_errors.dart';
import '../core/prepared.dart';
import '../core/tasks.dart';

class NodPreparedRepository {
  const NodPreparedRepository(this.transport);
  final NodApiTransport transport;

  Future<NodPreparedWork> load(String id) async {
    final work = NodPreparedWork.fromJson(
      taskMap(
        await transport.requestJson(
          'GET',
          '/api/prepared/${Uri.encodeComponent(id)}',
        ),
      ),
    );
    if (work.id != id) throw const NodProtocolException();
    return work;
  }

  Future<List<NodPreparedFinding>> recentFindings() async {
    final state = taskMap(await transport.requestJson('GET', '/api/state'));
    final messages = state['messages'];
    if (messages is! List) throw const NodProtocolException();
    final findings = <String, NodPreparedFinding>{};
    for (final raw in messages.reversed) {
      final message = taskMap(raw);
      if (message['role'] != 'assistant') continue;
      final text = taskText(message, 'text');
      for (final link in RegExp(
        r'\]\((/prepared/[^\s)]+)\)',
      ).allMatches(text)) {
        final id = preparedIdFromLink(link.group(1));
        if (id != null) {
          findings.putIfAbsent(
            id,
            () => NodPreparedFinding(id: id, text: text),
          );
        }
      }
    }
    return findings.values.toList();
  }
}
