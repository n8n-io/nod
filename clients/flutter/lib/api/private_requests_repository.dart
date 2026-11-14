import '../core/api_transport.dart';
import '../core/private_requests.dart';

final class NodPrivateRequestsRepository {
  NodPrivateRequestsRepository(this.transport);

  final NodApiTransport transport;
  final Set<String> _used = {};
  final Set<String> _busy = {};

  bool wasSubmitted(NodPrivateRequestRef ref) => _used.contains(ref.path);

  Future<List<NodPrivateRequestRef>> list() async {
    final state = privateObject(
      await transport.requestJson('GET', '/api/state'),
    );
    final found = <String, NodPrivateRequestRef>{};
    for (final message in state['messages'] as List? ?? []) {
      final data = privateObject(message);
      if (data['role'] != 'assistant') continue;
      final text = data['text'] as String? ?? '';
      for (final match in RegExp(r'\]\(([^\s)]+)\)').allMatches(text)) {
        final ref = NodPrivateRequestRef.fromLink(match[1]!);
        if (ref != null) found['${ref.kind}:${ref.id}'] = ref;
      }
    }
    for (final turn in state['turns'] as List? ?? []) {
      final data = privateObject(turn);
      if (data['status'] != 'waiting' || data['handoffMessageId'] == null) {
        continue;
      }
      final ref = NodPrivateRequestRef(
        kind: NodPrivateRequestKind.browser,
        id: data['id']! as String,
      );
      if (ref.isValid) found['browser:${ref.id}'] = ref;
    }
    return found.values.toList().reversed.toList();
  }

  Future<NodPrivateDetails> read(NodPrivateRequestRef ref) async {
    final path = ref.path;
    if (ref.kind == NodPrivateRequestKind.payment) {
      final status =
          privateObject(
                await transport.requestJson('GET', '$path/status'),
              )['status']!
              as String;
      final data = status == 'pending'
          ? privateObject(await transport.requestJson('GET', path))
          : <String, Object?>{};
      return NodPrivateDetails(ref, data, status);
    }
    final data = privateObject(await transport.requestJson('GET', path));
    if (data['id'] != ref.id) {
      throw const FormatException('Private request changed.');
    }
    return NodPrivateDetails(ref, data, data['status']! as String);
  }

  Future<NodPrivateRequestRef?> next(
    NodPrivateDetails details, {
    bool afterRetry = false,
  }) async {
    if (details.payment ||
        (!afterRetry && !['filled', 'expired'].contains(details.status))) {
      return null;
    }
    final data = privateObject(
      await transport.requestJson('GET', '${details.ref.path}/flow'),
    );
    final id = data['nextId'];
    if (id is! String || id == details.ref.id) return null;
    final ref = NodPrivateRequestRef(
      kind: NodPrivateRequestKind.credential,
      id: id,
    );
    return ref.isValid ? ref : null;
  }

  Future<NodPrivateRequestRef?> submit(
    NodPrivateDetails details,
    Map<String, Object?> values, {
    String suffix = '',
  }) async {
    final path = details.ref.path;
    if (!details.pending || _used.contains(path) || !_busy.add(path)) {
      values.clear();
      throw StateError('This request cannot be submitted again.');
    }
    try {
      final fresh = await read(details.ref);
      if (!fresh.pending) {
        throw StateError('This private request is no longer open.');
      }
      _used.add(path);
      final result = privateObject(
        await transport.requestJson('POST', '$path$suffix', body: values),
      );
      if (result['ok'] == true) return null;
      final retry = result['retryUrl'];
      final ref = retry is String ? NodPrivateRequestRef.fromLink(retry) : null;
      if (!details.payment && ref?.kind == NodPrivateRequestKind.credential) {
        return ref;
      }
      throw StateError('Private submission was not confirmed.');
    } finally {
      values.clear();
      _busy.remove(path);
    }
  }

  Future<List<Map<String, Object?>>> managedLogins(
    NodPrivateDetails details,
    String account,
  ) async {
    final fresh = await read(details.ref);
    if (!fresh.pending) throw StateError('This request is no longer open.');
    final result = privateObject(
      await transport.requestJson(
        'POST',
        '${details.ref.path}/password-manager',
        body: {'account': account},
      ),
    );
    return (result['logins'] as List).map(privateObject).toList();
  }

  Future<void> requestFreshStep(NodPrivateRequestRef ref) async {
    final result = privateObject(
      await transport.requestJson('POST', '${ref.path}/retry', body: {}),
    );
    if (result['ok'] != true) {
      throw StateError('A fresh step could not be requested.');
    }
  }

  Future<void> browserInput(String turnId, List<Map<String, Object?>> inputs) =>
      _browserPost('/api/browser-handoff', {
        'turnId': turnId,
        'inputs': inputs,
      });

  Future<void> browserNavigate(String turnId, String action) => _browserPost(
    '/api/browser-handoff/navigate',
    {'turnId': turnId, 'action': action},
  );

  Future<void> browserDone(String turnId) =>
      _browserPost('/api/browser-handoff/done', {'turnId': turnId});

  Future<void> _browserPost(String path, Map<String, Object?> body) async {
    final result = privateObject(
      await transport.requestJson('POST', path, body: body),
    );
    if (result['ok'] != true) {
      throw StateError('Browser input was not confirmed.');
    }
  }
}
