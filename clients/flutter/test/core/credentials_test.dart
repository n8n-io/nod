import 'dart:convert';

import 'package:flutter/services.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:nod_client/core/core.dart';

const _channel = MethodChannel('plugins.it_nomads.com/flutter_secure_storage');

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  tearDown(() {
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(_channel, null);
  });

  test('failed atomic rotation preserves the previous connection', () async {
    const backendDetail = 'failed write containing new-token';
    final platform = MemorySecureStorageChannel(
      values: {
        'nod.connection.v1': _stored(
          origin: 'https://old.example',
          token: 'old-token',
        ),
      },
      writeFailures: {'nod.connection.v1': StateError(backendDetail)},
    );
    _install(platform);
    final storage = FlutterNodCredentialStorage(
      storage: const FlutterSecureStorage(),
    );

    Object? thrown;
    try {
      await storage.write(
        NodConnectionConfig(
          origin: Uri.parse('https://new.example'),
          token: 'new-token',
        ),
      );
    } on Object catch (error) {
      thrown = error;
    }
    final restored = await storage.read();

    expect(thrown, isA<NodCredentialStorageException>());
    expect(thrown.toString(), isNot(contains(backendDetail)));
    expect(thrown.toString(), isNot(contains('new-token')));
    expect(restored?.origin, Uri.parse('https://old.example'));
    expect(restored?.token, 'old-token');
  });

  test('migrates legacy keys into one versioned value', () async {
    final platform = MemorySecureStorageChannel(
      values: {
        'nod.connection.origin': 'https://legacy.example',
        'nod.connection.token': 'legacy-token',
      },
    );
    _install(platform);
    final storage = FlutterNodCredentialStorage(
      storage: const FlutterSecureStorage(),
    );

    final restored = await storage.read();
    final stored = jsonDecode(platform.values['nod.connection.v1']!);

    expect(restored?.origin, Uri.parse('https://legacy.example'));
    expect(restored?.token, 'legacy-token');
    expect(stored, {
      'version': 1,
      'origin': 'https://legacy.example',
      'token': 'legacy-token',
    });
    expect(platform.values, isNot(contains('nod.connection.origin')));
    expect(platform.values, isNot(contains('nod.connection.token')));
  });

  test(
    'partial migration cleanup leaves the atomic value authoritative',
    () async {
      const backendDetail = 'legacy cleanup failure';
      final platform = MemorySecureStorageChannel(
        values: {
          'nod.connection.origin': 'https://legacy.example',
          'nod.connection.token': 'legacy-token',
        },
        deleteFailures: {'nod.connection.token': StateError(backendDetail)},
      );
      _install(platform);
      final storage = FlutterNodCredentialStorage(
        storage: const FlutterSecureStorage(),
      );

      Object? thrown;
      try {
        await storage.read();
      } on Object catch (error) {
        thrown = error;
      }
      platform.deleteFailures.clear();
      final restored = await storage.read();

      expect(thrown, isA<NodCredentialStorageException>());
      expect(thrown.toString(), isNot(contains(backendDetail)));
      expect(restored?.origin, Uri.parse('https://legacy.example'));
      expect(restored?.token, 'legacy-token');
    },
  );

  test('partial delete keeps the atomic connection authoritative', () async {
    const backendDetail = 'legacy delete failure';
    final platform = MemorySecureStorageChannel(
      values: {
        'nod.connection.v1': _stored(
          origin: 'https://current.example',
          token: 'current-token',
        ),
        'nod.connection.origin': 'https://legacy.example',
        'nod.connection.token': 'legacy-token',
      },
      deleteFailures: {'nod.connection.token': StateError(backendDetail)},
    );
    _install(platform);
    final storage = FlutterNodCredentialStorage(
      storage: const FlutterSecureStorage(),
    );

    Object? thrown;
    try {
      await storage.delete();
    } on Object catch (error) {
      thrown = error;
    }
    final restored = await storage.read();

    expect(thrown, isA<NodCredentialStorageException>());
    expect(thrown.toString(), isNot(contains(backendDetail)));
    expect(restored?.origin, Uri.parse('https://current.example'));
    expect(restored?.token, 'current-token');
  });

  test('delete removes the atomic and legacy formats', () async {
    final platform = MemorySecureStorageChannel(
      values: {
        'nod.connection.v1': _stored(
          origin: 'https://current.example',
          token: 'current-token',
        ),
        'nod.connection.origin': 'https://legacy.example',
        'nod.connection.token': 'legacy-token',
      },
    );
    _install(platform);
    final storage = FlutterNodCredentialStorage(
      storage: const FlutterSecureStorage(),
    );

    await storage.delete();

    expect(platform.values, isEmpty);
  });
}

void _install(MemorySecureStorageChannel platform) {
  TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
      .setMockMethodCallHandler(_channel, platform.handle);
}

String _stored({required String origin, required String token}) =>
    jsonEncode({'version': 1, 'origin': origin, 'token': token});

final class MemorySecureStorageChannel {
  MemorySecureStorageChannel({
    Map<String, String>? values,
    Map<String, Object>? writeFailures,
    Map<String, Object>? deleteFailures,
  }) : values = values ?? {},
       writeFailures = writeFailures ?? {},
       deleteFailures = deleteFailures ?? {};

  final Map<String, String> values;
  final Map<String, Object> writeFailures;
  final Map<String, Object> deleteFailures;

  Future<Object?> handle(MethodCall call) async {
    final arguments = Map<String, Object?>.from(
      call.arguments as Map<Object?, Object?>,
    );
    final key = arguments['key'];
    switch (call.method) {
      case 'read':
        return values[key];
      case 'write':
        final failure = writeFailures[key];
        if (failure != null) throw failure;
        values[key! as String] = arguments['value']! as String;
        return null;
      case 'delete':
        final failure = deleteFailures[key];
        if (failure != null) throw failure;
        values.remove(key);
        return null;
      case 'deleteAll':
        values.clear();
        return null;
      case 'readAll':
        return Map.of(values);
      case 'containsKey':
        return values.containsKey(key);
      default:
        throw MissingPluginException(call.method);
    }
  }
}
