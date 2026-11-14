import 'dart:convert';

import 'package:flutter_secure_storage/flutter_secure_storage.dart';

import 'nod_errors.dart';
import 'nod_models.dart';
import 'origin.dart';

abstract interface class NodCredentialStorage {
  Future<NodConnectionConfig?> read();

  Future<void> write(NodConnectionConfig config);

  Future<void> delete();
}

final class FlutterNodCredentialStorage implements NodCredentialStorage {
  FlutterNodCredentialStorage({FlutterSecureStorage? storage})
    : _storage = storage ?? const FlutterSecureStorage();

  static const _connectionKey = 'nod.connection.v1';
  static const _originKey = 'nod.connection.origin';
  static const _tokenKey = 'nod.connection.token';

  final FlutterSecureStorage _storage;

  @override
  Future<NodConnectionConfig?> read() async {
    late final String? stored;
    try {
      stored = await _storage.read(key: _connectionKey);
    } on Object {
      throw const NodCredentialStorageException();
    }
    if (stored != null) return _decode(stored);

    late final String? origin;
    late final String? token;
    try {
      origin = await _storage.read(key: _originKey);
      token = await _storage.read(key: _tokenKey);
    } on Object {
      throw const NodCredentialStorageException();
    }
    final config = _legacy(origin, token);
    if (config == null) return null;
    try {
      await _storage.write(key: _connectionKey, value: _encode(config));
      await _deleteLegacy();
    } on Object {
      throw const NodCredentialStorageException();
    }
    return config;
  }

  @override
  Future<void> write(NodConnectionConfig config) async {
    final accepted = NodConnectionConfig(
      origin: validateNodOrigin(config.origin),
      token: config.token,
    );
    try {
      await _storage.write(key: _connectionKey, value: _encode(accepted));
      await _deleteLegacy();
    } on Object {
      throw const NodCredentialStorageException();
    }
  }

  @override
  Future<void> delete() async {
    try {
      await _deleteLegacy();
      await _storage.delete(key: _connectionKey);
    } on Object {
      throw const NodCredentialStorageException();
    }
  }

  Future<void> _deleteLegacy() async {
    await _storage.delete(key: _originKey);
    await _storage.delete(key: _tokenKey);
  }

  String _encode(NodConnectionConfig config) => jsonEncode({
    'version': 1,
    'origin': config.origin.toString(),
    'token': config.token,
  });

  NodConnectionConfig? _decode(String stored) {
    try {
      final decoded = jsonDecode(stored);
      if (decoded is! Map<Object?, Object?> || decoded['version'] != 1) {
        return null;
      }
      final origin = decoded['origin'];
      final token = decoded['token'];
      if (origin is! String || token is! String || token.isEmpty) return null;
      return NodConnectionConfig(
        origin: validateNodOrigin(Uri.parse(origin)),
        token: token,
      );
    } on Object {
      return null;
    }
  }

  NodConnectionConfig? _legacy(String? origin, String? token) {
    if (origin == null || token == null || token.isEmpty) return null;
    try {
      return NodConnectionConfig(
        origin: validateNodOrigin(Uri.parse(origin)),
        token: token,
      );
    } on Object {
      return null;
    }
  }
}
