import '../core/api_transport.dart';
import '../core/vault.dart';

final class NodVaultRepository {
  NodVaultRepository(this.transport)
    : _scope = transport as NodConnectionScope,
      _generation = (transport as NodConnectionScope).connectionGeneration;

  final NodApiTransport transport;
  final NodConnectionScope _scope;
  final int _generation;
  final Set<String> _busy = {};

  bool get isCurrent => _scope.connectionGeneration == _generation;

  Future<Object?> _request(
    String method,
    String path, {
    Map<String, Object?>? body,
  }) async {
    void check() {
      if (_scope.connectionGeneration != _generation) {
        throw StateError('The Nod connection changed. Reopen Vault.');
      }
    }

    check();
    final result = await transport.requestJson(method, path, body: body);
    check();
    return result;
  }

  String _path(String id) => '/api/vault/${Uri.encodeComponent(id)}';

  Future<List<NodVaultItem>> list() async =>
      (await _request('GET', '/api/vault') as List)
          .map(NodVaultItem.new)
          .toList();

  Future<List<NodVaultItem>> sessions() async =>
      (await _request('GET', '/api/vault/sessions') as List)
          .map(NodVaultItem.new)
          .toList();

  Future<NodVaultItem> details(NodVaultItem item) async {
    if (item.session) throw StateError('Use the current session list.');
    final result = NodVaultItem(
      await _request('POST', '${_path(item.id)}/details', body: {}),
    );
    if (!item.sameTarget(result)) {
      throw StateError('This Vault item changed.');
    }
    return result;
  }

  Future<NodVaultItem> _fresh(NodVaultItem item) async {
    final latest = item.session
        ? (await sessions()).where((value) => value.id == item.id).firstOrNull
        : await details(item);
    if (latest == null ||
        !item.sameTarget(latest) ||
        latest.revision != item.revision ||
        (item.session &&
            (latest.data['state'] != item.data['state'] ||
                latest.data['url'] != item.data['url'] ||
                latest.label != item.label))) {
      throw StateError('This Vault item changed. Reopen it before continuing.');
    }
    return latest;
  }

  Future<String> copyIdentity(NodVaultItem item) async {
    if (item.session) throw StateError('This session has no saved identity.');
    return (await _fresh(item)).identity;
  }

  Future<NodVaultItem> save(
    Map<String, Object?> values, {
    NodVaultItem? item,
  }) async {
    final key = item?.id ?? 'new';
    if (!_busy.add(key)) {
      values.clear();
      throw StateError('A Vault change is already pending.');
    }
    try {
      if (item != null) await _fresh(item);
      final result = NodVaultItem(
        await _request(
          item == null ? 'POST' : 'PATCH',
          item == null ? '/api/vault' : _path(item.id),
          body: values,
        ),
      );
      if (result.kind != values['kind'] ||
          (item != null && !item.sameTarget(result))) {
        throw StateError('The saved Vault item could not be confirmed.');
      }
      return result;
    } finally {
      values.clear();
      _busy.remove(key);
    }
  }

  Future<void> remove(NodVaultItem item) async {
    if (!_busy.add(item.id)) {
      throw StateError('A Vault change is already pending.');
    }
    try {
      if (item.session) {
        await _fresh(item);
      } else {
        final latest = (await list())
            .where((value) => value.id == item.id)
            .firstOrNull;
        if (latest == null ||
            !item.sameTarget(latest) ||
            item.revision != latest.revision) {
          throw StateError(
            'This Vault item changed. Reopen it before continuing.',
          );
        }
      }
      final result = vaultObject(
        await _request(
          'DELETE',
          item.session
              ? '/api/vault/sessions/${Uri.encodeComponent(item.id)}'
              : _path(item.id),
        ),
      );
      if (result['ok'] != true) throw StateError('Removal was not confirmed.');
    } finally {
      _busy.remove(item.id);
    }
  }

  Future<String> signInAgainRequest(NodVaultItem item) async {
    if (!item.session ||
        !['needs_sign_in', 'pending'].contains(item.data['state'])) {
      throw StateError('This session does not need sign-in.');
    }
    await _fresh(item);
    if (!isCurrent) throw StateError('The Nod connection changed.');
    return 'Use browser connection ${item.id} to open ${item.data['url']}. Check whether it works. If the session expired, help me sign in through the secure form and save the session.';
  }

  Future<String> reveal(NodVaultItem item) async {
    await _fresh(item);
    final field = item.card ? 'cardNumber' : 'password';
    final result = vaultObject(
      await _request(
        'POST',
        '${_path(item.id)}/${item.card ? 'card-number' : 'password'}',
        body: {},
      ),
    );
    return result[field]! as String;
  }

  Future<Map<String, Object?>> import(NodVaultImport input) async {
    if (!_busy.add('import')) {
      input.clear();
      throw StateError('An import is already pending.');
    }
    try {
      return vaultObject(
        await _request(
          'POST',
          '/api/vault/import',
          body: {'logins': input.logins},
        ),
      );
    } finally {
      input.clear();
      _busy.remove('import');
    }
  }

  Future<NodVaultActivity> activity({
    NodVaultItem? item,
    Map<String, Object?>? next,
  }) async {
    final query = <String, String>{
      if (item != null && !item.card) 'origin': item.origin,
      if (item != null && item.card) 'item': item.id,
      if (next != null) 'at': next['at']! as String,
      if (next != null) 'id': next['id']! as String,
    };
    final uri = Uri(
      path: '/api/vault/activity',
      queryParameters: query.isEmpty ? null : query,
    );
    return NodVaultActivity(await _request('GET', uri.toString()));
  }
}
