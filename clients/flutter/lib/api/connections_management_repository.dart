import 'dart:convert';

import 'package:crypto/crypto.dart';

import '../core/api_transport.dart';
import '../core/connections_management.dart';

class NodConnectionsManagementRepository {
  NodConnectionsManagementRepository(this.transport);

  final NodApiTransport transport;

  Future<Map<String, Object?>> _map(
    String method,
    String path, {
    Map<String, Object?>? body,
  }) async => Map<String, Object?>.from(
    await transport.requestJson(method, path, body: body) as Map,
  );

  Future<List<NodManagedConnection>> load({bool catalog = false}) async =>
      (await transport.requestJson(
            'GET',
            catalog ? '/api/apps/catalog' : '/api/apps',
          ) as List)
          .map(
            (value) => NodManagedConnection.fromJson(
              Map<String, Object?>.from(value as Map),
            ),
          )
          .toList();

  Future<void> disconnect(NodManagedConnection account) async {
    final id = account.id;
    if (id == null) throw const FormatException('No saved account');
    await _map(
      'POST',
      '/api/apps/${Uri.encodeComponent(account.slug)}/accounts/${Uri.encodeComponent(id)}/disconnect',
      body: {},
    );
  }

  Future<NodConnectionAttempt> connect(
    NodManagedConnection account, {
    bool additional = false,
  }) async => _attempt(
    await _map(
      'POST',
      '/api/apps/${Uri.encodeComponent(account.slug)}/connect',
      body: {
        'returnTo': 'window',
        if (additional && account.paths.isNotEmpty) 'newAccount': true,
        if (account.id != null && (!additional || account.paths.isNotEmpty))
          'connectionId': account.id,
      },
    ),
  );

  NodConnectionAttempt _attempt(
    Map<String, Object?> result, {
    bool allowCompleted = false,
  }) {
    final raw = result['url'];
    if (raw == null) {
      if (allowCompleted && result['ok'] == true) {
        return const NodConnectionAttempt();
      }
      throw const FormatException('Missing sign-in address');
    }
    final url = Uri.parse(raw as String);
    if (url.path == '/apps' && url.queryParameters.containsKey('connect')) {
      final id = url.queryParameters['connect']!;
      if (url.userInfo.isNotEmpty ||
          url.fragment.isNotEmpty ||
          url.queryParameters.length != 1 ||
          !RegExp(r'^[a-fA-F0-9]{8}(-[a-fA-F0-9]{4}){3}-[a-fA-F0-9]{12}$')
              .hasMatch(id)) {
        throw const FormatException('Invalid setup response');
      }
      return NodConnectionAttempt(discoveryId: id);
    }
    final attempt = result['attempt'] as String?;
    if (attempt != null && !RegExp(r'^[A-Za-z0-9_-]{43}$').hasMatch(attempt)) {
      throw const FormatException('Invalid setup attempt');
    }
    return NodConnectionAttempt(url: url, attempt: attempt);
  }

  Uri launchAddress(Uri url, {String? instance}) {
    final local = instance == null
        ? null
        : Uri.tryParse(
            instance.contains('://') ? instance : 'http://$instance',
          );
    const loopback = {'localhost', '127.0.0.1', '[::1]', '::1'};
    final explicitInstance =
        local != null &&
        (url.host == local.host ||
            (loopback.contains(url.host) && loopback.contains(local.host))) &&
        url.port == local.port;
    if (url.userInfo.isNotEmpty ||
        url.host.isEmpty ||
        (url.scheme != 'https' &&
            !(url.scheme == 'http' && explicitInstance)) ||
        url.queryParameters.keys.any(
          (key) => {
            'access_token',
            'token',
            'api_key',
            'apikey',
            'authorization',
            'access',
          }.contains(key.toLowerCase()),
        ) ||
        url.fragment.isNotEmpty) {
      throw const FormatException('Unsafe sign-in address');
    }
    return url;
  }

  String _hash(Uri url) =>
      sha256.convert(utf8.encode(url.toString())).toString();

  Future<NodConnectionProgress> progress(Uri url) async {
    final hash = _hash(url);
    final result = await _map(
      'POST',
      '/api/apps/setup-status',
      body: {
        'hashes': [hash],
        'pairingUrl': url.toString(),
      },
    );
    if ((result['completed'] as List).contains(hash)) {
      return NodConnectionProgress.connected;
    }
    for (final value in result['apps'] as List) {
      final app = value as Map;
      if (app['hash'] == hash && app['available'] != false) {
        return NodConnectionProgress.waiting;
      }
    }
    return NodConnectionProgress.unavailable;
  }

  Future<void> cancel(Uri url) async {
    await _map('POST', '/api/apps/setup-cancel', body: {'hash': _hash(url)});
  }

  Future<String> createMcp({
    required String name,
    required String endpoint,
    required String auth,
    required bool clientIdRequired,
  }) async =>
      (await _map(
            'POST',
            '/api/apps/mcp',
            body: {
              'name': name,
              'endpoint': endpoint,
              'auth': auth,
              if (auth == 'oauth' && clientIdRequired) 'clientIdRequired': true,
            },
          ))['id']
          as String;

  String _discovery(String id) =>
      '/api/apps/discovery/${Uri.encodeComponent(id)}';

  Future<NodConnectionDiscovery> discovery(String id) async =>
      NodConnectionDiscovery.fromJson(id, await _map('GET', _discovery(id)));

  Future<NodConnectionAttempt> authorize(
    NodConnectionDiscovery discovery, {
    String? clientId,
  }) async => _attempt(
    await _map(
      'POST',
      '${_discovery(discovery.id)}/authorize',
      body: {
        'returnTo': 'window',
        'restart': true,
        'restartAttempt': discovery.attempt,
        if (clientId != null && clientId.isNotEmpty) 'clientId': clientId,
      },
    ),
  );

  Future<NodConnectionAttempt> instance(
    String id,
    String address,
    String token,
  ) async => _attempt(
    await _map(
      'POST',
      '${_discovery(id)}/instance',
      body: {
        'instanceUrl': address,
        if (token.isNotEmpty) 'token': token,
        'returnTo': 'window',
      },
    ),
    allowCompleted: token.isNotEmpty,
  );

  Future<void> complete(String id, String accountName, Object token) async {
    final result = await _map(
      'POST',
      '${_discovery(id)}/complete',
      body: {'accountName': accountName, 'token': token},
    );
    if (result['ok'] != true) {
      throw const FormatException('Connection not confirmed');
    }
  }

  Future<List<NodChannelSetup>> channels() async =>
      ((await _map('GET', '/api/channel-settings'))['channels'] as List)
          .map(
            (value) => NodChannelSetup.fromJson(
              Map<String, Object?>.from(value as Map),
            ),
          )
          .toList();

  String _provider(String provider) {
    if (!{'telegram', 'whatsapp'}.contains(provider)) {
      throw const FormatException('Unknown channel');
    }
    return '/api/channel-settings/$provider';
  }

  Future<Map<String, Object?>> saveChannel(
    String provider,
    Map<String, Object?> input,
  ) => _map('PUT', _provider(provider), body: input);

  Future<void> removeChannel(String provider) async {
    await _map('DELETE', _provider(provider));
  }

  Future<Map<String, Object?>> telegram(String action, {String? userId}) {
    if (!{'pairing', 'confirm', 'user'}.contains(action)) {
      throw const FormatException('Unknown pairing action');
    }
    return _map(
      'POST',
      '${_provider('telegram')}/$action',
      body: {'allowedUserId': ?userId},
    );
  }
}
