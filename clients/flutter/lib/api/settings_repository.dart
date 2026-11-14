import '../core/api_transport.dart';
import '../core/nod_errors.dart';
import '../core/settings.dart';

class NodSettingsRepository {
  const NodSettingsRepository(this.transport);
  final NodApiTransport transport;

  Future<Map<String, Object?>> _request(
    String method,
    String path, [
    Map<String, Object?>? body,
  ]) async =>
      settingsMap(await transport.requestJson(method, path, body: body));

  Future<Map<String, Object?>> session() => _request('GET', '/api/session');
  Future<Map<String, Object?>> preferences() =>
      _request('GET', '/api/preferences');
  Future<Map<String, Object?>> savePreferences(Map<String, Object?> patch) =>
      _request('PATCH', '/api/preferences', patch);
  Future<Map<String, Object?>> saveAccount(Map<String, Object?> patch) =>
      _request('PATCH', '/api/account', patch);
  Future<Map<String, Object?>> models() => _request('GET', '/api/models');
  Future<Map<String, Object?>> selectModel(
    String connectionId,
    String modelId,
    String effort,
  ) => _request('PUT', '/api/models/selection', {
    'connectionId': connectionId,
    'modelId': modelId,
    'effort': effort,
  });
  Future<Map<String, Object?>> connectProvider(Map<String, Object?> input) =>
      _request(
        'POST',
        input['provider'] == 'compatible'
            ? '/api/models/endpoints'
            : '/api/models/keys',
        {
          for (final entry in input.entries)
            if (entry.key != 'provider' || entry.value != 'compatible')
              entry.key: entry.value,
        },
      );
  Future<Map<String, Object?>> refreshConnection(String id) =>
      _request('POST', '/api/models/connections/${_segment(id)}/refresh');
  Future<Map<String, Object?>> removeConnection(String id) =>
      _request('DELETE', '/api/models/connections/${_segment(id)}');
  Future<Map<String, Object?>> startSignIn(
    String provider, {
    String? connectionId,
  }) => _request('POST', '/api/models/oauth', {
    'provider': provider,
    'connectionId': ?connectionId,
  });
  Future<Map<String, Object?>> signInStatus(String attempt) =>
      _request('GET', '/api/models/oauth/status/${_segment(attempt)}');
  Future<Map<String, Object?>> cancelSignIn(String attempt) =>
      _request('DELETE', '/api/models/oauth/${_segment(attempt)}');
  Future<Map<String, Object?>> completeSignIn(String url) =>
      _request('POST', '/api/models/oauth/complete', {'url': url});
  Future<Map<String, Object?>> speech() => _request('GET', '/api/speech');
  Future<Map<String, Object?>> refreshVoices() =>
      _request('POST', '/api/speech/voices/refresh');
  Future<Map<String, Object?>> prepareSpeech(String locale) =>
      _request('POST', '/api/speech/prepare', {'locale': locale});
  int? get connectionGeneration => switch (transport) {
    final NodConnectionScope scope => scope.connectionGeneration,
    _ => null,
  };

  Future<NodBinaryResponse> _binary(
    String method,
    String path,
    Set<String> mimeTypes, {
    Map<String, Object?>? body,
  }) async {
    final binary = transport;
    if (binary is! NodBinaryTransport) throw const NodProtocolException();
    final generation = connectionGeneration;
    final response = await (binary as NodBinaryTransport).requestBytes(
      method,
      path,
      body: body,
    );
    if (generation != connectionGeneration) throw const NodRequestException();
    final mimeType = response.mimeType.split(';').first.trim().toLowerCase();
    if (!mimeTypes.contains(mimeType) ||
        response.bytes.isEmpty ||
        response.bytes.length > 16 * 1024 * 1024) {
      throw const NodProtocolException();
    }
    return NodBinaryResponse(bytes: response.bytes, mimeType: mimeType);
  }

  Future<NodBinaryResponse> previewVoice(String? voice, String locale) =>
      _binary(
        'POST',
        '/api/speech/preview',
        {
          'audio/mpeg',
          'audio/wav',
          'audio/x-wav',
          'audio/mp4',
          'audio/x-m4a',
          'audio/aac',
          'audio/ogg',
          'audio/flac',
          'audio/webm',
        },
        body: {'voice': voice, 'locale': locale},
      );

  Future<NodBinaryResponse> exportMemory() =>
      _binary('GET', '/api/memory/export', {'text/markdown'});

  Future<Map<String, Object?>> memory() => _request('GET', '/api/memory');
  Future<Map<String, Object?>> saveMemorySettings(Map<String, Object?> patch) =>
      _request('PATCH', '/api/memory', patch);
  Future<Map<String, Object?>> addNote(
    String area,
    String text, {
    String? expires,
  }) => _request('POST', '/api/memory/notes', {
    'area': area,
    'text': text,
    'expires': ?expires,
  });
  Future<Map<String, Object?>> editNote(
    String path,
    Map<String, Object?> patch,
  ) => _request('PATCH', '/api/memory/notes/${_notePath(path)}', patch);
  Future<Map<String, Object?>> archiveNote(String path) =>
      _request('POST', '/api/memory/notes/${_notePath(path)}/archive');
  Future<Map<String, Object?>> forgetNote(String path) =>
      _request('DELETE', '/api/memory/notes/${_notePath(path)}');
  Future<Map<String, Object?>> archivedNote(
    Map<String, Object?> note, {
    required bool restore,
  }) => _request(
    'POST',
    '/api/memory/archive/${restore ? 'restore' : 'forget'}',
    {
      'path': settingsText(note, 'path'),
      'archived': settingsText(note, 'archived'),
    },
  );
  Future<Map<String, Object?>> editSkill(
    String name,
    String description,
    String body,
  ) => _request('PATCH', '/api/memory/skills/${_segment(name)}', {
    'description': description,
    'body': body,
  });
  Future<Map<String, Object?>> forgetSkill(String name) =>
      _request('DELETE', '/api/memory/skills/${_segment(name)}');
  Future<Map<String, Object?>> importNotes(List<NodMemoryImportNote> notes) =>
      _request('POST', '/api/memory/import', {
        'notes': notes.map((note) => note.toJson()).toList(),
      });
  Future<Map<String, Object?>> usage() => _request('GET', '/api/trust');
  Future<Map<String, Object?>> taskCheckIn(double? usd) {
    if (usd != null &&
        (!usd.isFinite || usd < 1 || (usd * 100).round() / 100 != usd)) {
      throw const NodRequestException();
    }
    return _request('PUT', '/api/trust/limit', {'taskUsd': usd});
  }

  Future<Map<String, Object?>> state() => _request('GET', '/api/state');
  Future<Map<String, Object?>> resetConversation(String threadId) =>
      _request('POST', '/api/conversation/reset', {'threadId': threadId});

  String _segment(String value) {
    if (value.isEmpty ||
        value == '.' ||
        value == '..' ||
        value.contains(RegExp(r'[/\\?#%]'))) {
      throw const NodRequestException();
    }
    return Uri.encodeComponent(value);
  }

  String _notePath(String path) {
    final parts = path.split('/');
    if (parts.length != 2 || !memoryAreas.contains(parts[0])) {
      throw const NodRequestException();
    }
    return '${parts[0]}/${_segment(parts[1])}';
  }
}
