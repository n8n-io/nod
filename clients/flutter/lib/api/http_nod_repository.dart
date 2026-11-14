import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:crypto/crypto.dart';
import 'package:http/http.dart' as http;
import 'package:http_parser/http_parser.dart';

import '../core/api_transport.dart';
import '../core/app_connections.dart';
import '../core/attachments.dart';
import '../core/audio.dart';
import '../core/core.dart';
import '../core/private_requests.dart';
import '../core/rich_results.dart';
import '../core/schedules.dart';
import '../core/usage.dart';
import 'sse.dart';

typedef NodDelay = Future<void> Function(Duration duration);
typedef NodHttpClientFactory = http.Client Function();

final class HttpNodRepository
    implements
        NodRepository,
        NodReplyRepository,
        NodMessageFocusRepository,
        NodPrivateBrowserTransport,
        NodApiTransport,
        NodPairedOrigin,
        NodBinaryTransport,
        NodConnectionScope,
        NodAppsRepository,
        NodAttachmentsRepository,
        NodAudioRepository,
        NodUsageRepository,
        NodSchedulesRepository {
  HttpNodRepository({
    NodCredentialStorage? credentials,
    http.Client? client,
    NodHttpClientFactory? eventClientFactory,
    NodHttpClientFactory? browserClientFactory,
    NodDelay? delay,
    this.requestTimeout = const Duration(seconds: 15),
    List<Duration>? reconnectDelays,
  }) : _credentials = credentials ?? FlutterNodCredentialStorage(),
       _apiClient = client ?? http.Client(),
       _closeApiClient = client == null,
       _eventClientFactory = eventClientFactory ?? http.Client.new,
       _browserClientFactory = browserClientFactory ?? http.Client.new,
       _delay = delay ?? Future<void>.delayed,
       _reconnectDelays =
           reconnectDelays ??
           const [
             Duration(seconds: 1),
             Duration(seconds: 2),
             Duration(seconds: 4),
             Duration(seconds: 8),
             Duration(seconds: 16),
             Duration(seconds: 30),
           ];

  final NodCredentialStorage _credentials;
  final http.Client _apiClient;
  final bool _closeApiClient;
  final NodHttpClientFactory _eventClientFactory;
  final NodHttpClientFactory _browserClientFactory;
  final Set<void Function()> _closeBrowserStreams = {};
  final NodDelay _delay;
  final Duration requestTimeout;
  final List<Duration> _reconnectDelays;
  final StreamController<NodConnectionState> _connectionController =
      StreamController<NodConnectionState>.broadcast(sync: true);
  final StreamController<NodEvent> _eventController =
      StreamController<NodEvent>.broadcast(sync: true);
  final Set<String> _messageIds = {};
  final Set<String> _clientMessageIds = {};
  final Set<String> _eventIds = {};

  NodConnectionConfig? _config;
  NodCapabilities? _capabilities;
  NodSession? _session;
  String? _threadId;
  http.Client? _eventClient;
  StreamSubscription<SseMessage>? _eventSubscription;
  Future<void>? _reconnectTask;
  Future<void> _eventWork = Future<void>.value();
  Future<NodState>? _reconciliation;
  NodConnectionState _connectionState = const NodConnectionState(
    phase: NodConnectionPhase.disconnected,
  );
  var _generation = 0;

  @override
  int get connectionGeneration => _generation;
  var _retryIndex = 0;
  var _disposed = false;

  NodCapabilities? get capabilities => _capabilities;
  NodSession? get session => _session;
  @override
  Uri? get pairedOrigin => _config?.origin;
  bool _attachmentsSupported = true;
  @override
  bool get attachmentsSupported => _attachmentsSupported;

  @override
  Stream<NodConnectionState> get connectionStates => Stream.multi((controller) {
    controller.addSync(_connectionState);
    final subscription = _connectionController.stream.listen(
      controller.addSync,
      onError: controller.addErrorSync,
      onDone: controller.closeSync,
    );
    controller.onCancel = subscription.cancel;
  }, isBroadcast: true);

  @override
  Stream<NodEvent> get events => _eventController.stream;

  @override
  Future<void> connect(NodConnectionConfig config) async {
    _ensureActive();
    final origin = validateNodOrigin(config.origin);
    if (config.token.isEmpty) throw const NodUnauthorizedException();
    final accepted = NodConnectionConfig(origin: origin, token: config.token);
    final generation = ++_generation;
    _closeBrowsers();
    await _closeEvents();
    _config = accepted;
    _retryIndex = 0;
    _emitConnection(NodConnectionPhase.connecting);
    try {
      _capabilities = await loadCapabilities();
      _session = await loadSession();
      await _openEvents(generation);
      await _reconcile(emit: false);
      if (!_isCurrent(generation)) return;
      await _useCredentials(() => _credentials.write(accepted));
      if (!_isCurrent(generation)) return;
      _emitConnection(NodConnectionPhase.connected);
    } catch (error) {
      if (_isCurrent(generation)) {
        try {
          await _closeEvents();
        } on Object {
          _eventClient?.close();
          _eventClient = null;
        }
        _clearConnection();
        _emitFailureConnection(error);
      }
      rethrow;
    }
  }

  Future<bool> connectStored() async {
    _ensureActive();
    final config = await _useCredentials(_credentials.read);
    if (config == null) return false;
    await connect(config);
    return true;
  }

  Future<NodCapabilities> loadCapabilities() async {
    final json = _expectMap(
      await _requestJson('GET', '/api/client/capabilities'),
    );
    final version = json['contractVersion'];
    final authentication = json['authentication'];
    final authMode = authentication is Map<Object?, Object?>
        ? _string(authentication['mode'])
        : null;
    if (version != 1 || authMode != 'bearer') {
      throw const NodProtocolException();
    }
    final features = json['features'];
    _attachmentsSupported =
        features is! Map || features['attachments'] != false;
    return NodCapabilities(
      contractVersion: version as int,
      authMode: authMode!,
    );
  }

  Future<NodSession> loadSession() async {
    final json = _expectMap(await _requestJson('GET', '/api/session'));
    final user = json['user'];
    return NodSession(
      userId: user is Map<Object?, Object?>
          ? _string(user['id'])
          : _string(json['userId']),
    );
  }

  @override
  Future<void> disconnect() async {
    if (_disposed) return;
    ++_generation;
    _closeBrowsers();
    _reconnectTask = null;
    await _closeEvents();
    _clearConnection();
    _emitConnection(NodConnectionPhase.disconnected);
  }

  Future<void> forgetCredentials() => _useCredentials(_credentials.delete);

  @override
  Future<NodState> loadState() async {
    final json = _expectMap(await _requestJson('GET', '/api/state'));
    final state = _parseState(json);
    _rememberState(state);
    return state;
  }

  @override
  Future<NodHistory> loadHistory({String? cursor}) async {
    final query = <String, String>{};
    if (cursor != null) {
      final decoded = _HistoryCursor.decode(cursor);
      if (decoded == null) {
        query['cursor'] = cursor;
      } else {
        query['threadId'] = decoded.threadId;
        query['before'] = decoded.createdAt;
        query['beforeId'] = decoded.messageId;
      }
    } else if (_threadId != null) {
      query['threadId'] = _threadId!;
    }
    final path = Uri(
      path: '/api/messages',
      queryParameters: query.isEmpty ? null : query,
    ).toString();
    final json = _expectMap(await _requestJson('GET', path));
    final messages = _deduplicateMessages(_parseMessages(json['messages']));
    final explicitCursor = _string(json['nextCursor']);
    final hasMore = json['hasMore'] == true;
    final first = messages.firstOrNull;
    final nextCursor =
        explicitCursor ??
        (hasMore && first != null && _threadId != null
            ? _HistoryCursor(
                threadId: _threadId!,
                createdAt: first.createdAt.toUtc().toIso8601String(),
                messageId: first.id,
              ).encode()
            : null);
    return NodHistory(messages: messages, nextCursor: nextCursor);
  }

  @override
  Future<void> sendText(String text, {required String clientMessageId}) async {
    final value = text.trim();
    if (value.isEmpty) throw const NodRequestException();
    await _requestJson(
      'POST',
      '/api/messages',
      body: {
        'text': value,
        'clientMessageId': clientMessageId,
        if (_threadId != null) 'threadId': _threadId,
      },
    );
  }

  @override
  Future<List<NodMessage>> loadMessageContext(String messageId) async {
    final value = await _requestJson(
      'GET',
      '/api/messages/around/${Uri.encodeComponent(messageId)}',
    );
    return _deduplicateMessages(_parseMessages(value));
  }

  @override
  Future<void> sendReply(
    String text, {
    required String clientMessageId,
    required String threadId,
    required String replyToMessageId,
    List<String>? choiceIds,
    bool customAnswer = false,
    List<NodArtifact> attachments = const [],
    NodUploadFile? recording,
  }) async {
    if ((text.trim().isEmpty && attachments.isEmpty && recording == null) ||
        (choiceIds != null && (customAnswer || recording != null))) {
      throw const NodRequestException();
    }
    if (recording != null) {
      await _sendAudio(
        text,
        recording,
        clientMessageId: clientMessageId,
        attachments: attachments,
        threadId: threadId,
        replyToMessageId: replyToMessageId,
        customAnswer: customAnswer,
      );
      await _reconcile(emit: true);
      return;
    }
    await _requestJson(
      'POST',
      '/api/messages',
      body: {
        'text': text.trim(),
        'clientMessageId': clientMessageId,
        'threadId': threadId,
        'replyToMessageId': replyToMessageId,
        'attachmentIds': attachments.map((file) => file.id).toList(),
        if (choiceIds != null) 'questionAnswer': {'choiceIds': choiceIds},
        if (customAnswer) 'questionAnswer': {'custom': true},
      },
    );
    await _reconcile(emit: true);
  }

  @override
  Future<void> sendAudio(
    String text,
    NodUploadFile recording, {
    required String clientMessageId,
    List<NodArtifact> attachments = const [],
  }) => _sendAudio(
    text,
    recording,
    clientMessageId: clientMessageId,
    attachments: attachments,
    threadId: _threadId,
  );

  Future<void> _sendAudio(
    String text,
    NodUploadFile recording, {
    required String clientMessageId,
    required String? threadId,
    List<NodArtifact> attachments = const [],
    String? replyToMessageId,
    bool customAnswer = false,
  }) async {
    _ensureConnected();
    if (threadId == null ||
        recording.size <= 0 ||
        recording.size > 25 * 1024 * 1024) {
      throw const NodRequestException();
    }
    final abort = Completer<void>();
    final timer = Timer(const Duration(seconds: 130), () => abort.complete());
    try {
      final request = http.AbortableMultipartRequest(
        'POST',
        _uri('/api/messages/audio'),
        abortTrigger: abort.future,
      )..followRedirects = false;
      request.headers.addAll(_headers());
      request.fields['message'] = jsonEncode({
        'text': text.trim(),
        'clientMessageId': clientMessageId,
        'threadId': threadId,
        'replyToMessageId': ?replyToMessageId,
        if (customAnswer) 'questionAnswer': {'custom': true},
        'attachmentIds': attachments.map((file) => file.id).toList(),
      });
      request.files.add(
        http.MultipartFile(
          'file',
          recording.read?.call() ?? File(recording.path).openRead(),
          recording.size,
          filename: recording.name,
          contentType: MediaType.parse(recording.mimeType),
        ),
      );
      final response = await _apiClient.send(request);
      final body = await response.stream.bytesToString();
      if (response.statusCode < 200 || response.statusCode >= 300) {
        throw _audioStatusError(response.statusCode, body);
      }
    } on NodException {
      rethrow;
    } catch (error) {
      if (error is http.RequestAbortedException) {
        throw const NodTimeoutException();
      }
      if (error is FileSystemException) {
        throw const NodAudioException(NodAudioFailure.send);
      }
      throw _transportError(error);
    } finally {
      timer.cancel();
      if (!abort.isCompleted) abort.complete();
    }
  }

  NodArtifact _parseArtifact(Object? value) {
    final json = _expectMap(value);
    final id = _requiredString(json['id']);
    if (!RegExp(
          r'^[a-fA-F0-9]{8}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{12}$',
        ).hasMatch(id) ||
        json['url'] != '/api/artifacts/$id' ||
        json['size'] is! int ||
        (json['size'] as int) < 0 ||
        (json['size'] as int) > nodAttachmentLimit) {
      throw const NodProtocolException();
    }
    return NodArtifact(
      id: id,
      name: _requiredString(json['name']),
      mimeType: _requiredString(json['mimeType']),
      size: json['size'] as int,
    );
  }

  @override
  Future<NodArtifact> uploadAttachment(
    NodUploadFile file, {
    required Future<void> cancelled,
    required void Function(double) onProgress,
  }) async {
    _ensureConnected();
    if (file.size <= 0 ||
        file.size > nodAttachmentLimit ||
        (file.read == null && await File(file.path).length() != file.size)) {
      throw const NodRequestException();
    }
    final abort = Completer<void>();
    void cancel() {
      if (!abort.isCompleted) abort.complete();
    }

    unawaited(cancelled.then((_) => cancel()));
    final timer = Timer(const Duration(minutes: 2), cancel);
    try {
      final request = http.AbortableMultipartRequest(
        'POST',
        _uri('/api/uploads'),
        abortTrigger: abort.future,
      )..followRedirects = false;
      request.headers.addAll(_headers());
      var sent = 0;
      final stream = (file.read?.call() ?? File(file.path).openRead()).map((
        bytes,
      ) {
        sent += bytes.length;
        onProgress(sent / file.size);
        return bytes;
      });
      request.files.add(
        http.MultipartFile(
          'file',
          stream,
          file.size,
          filename: file.name,
          contentType: MediaType.parse(file.mimeType),
        ),
      );
      final response = await _apiClient.send(request);
      final body = await response.stream.bytesToString();
      if (response.statusCode < 200 || response.statusCode >= 300) {
        throw _statusError(response.statusCode, body);
      }
      return _parseArtifact(jsonDecode(body));
    } on NodException {
      rethrow;
    } catch (_) {
      throw const NodRequestException();
    } finally {
      timer.cancel();
      cancel();
    }
  }

  @override
  Future<List<NodArtifact>> renewAttachments(List<String> ids) async {
    final result = await _requestJson(
      'POST',
      '/api/uploads/renew',
      body: {'ids': ids},
    );
    if (result is! List) throw const NodProtocolException();
    return result.map(_parseArtifact).toList();
  }

  @override
  Future<void> sendAttachments(
    String text,
    List<NodArtifact> attachments, {
    required String clientMessageId,
  }) async {
    if (attachments.isEmpty) {
      return sendText(text, clientMessageId: clientMessageId);
    }
    await _requestJson(
      'POST',
      '/api/messages',
      body: {
        'text': text.trim(),
        'attachmentIds': attachments.map((file) => file.id).toList(),
        'clientMessageId': clientMessageId,
        if (_threadId != null) 'threadId': _threadId,
      },
    );
  }

  @override
  Future<void> downloadAttachment(
    NodArtifact artifact,
    File destination, {
    required Future<void> cancelled,
  }) async {
    _ensureConnected();
    if (!RegExp(r'^[a-fA-F0-9-]{36}$').hasMatch(artifact.id)) {
      throw const NodProtocolException();
    }
    final abort = Completer<void>();
    void cancel() {
      if (!abort.isCompleted) abort.complete();
    }

    unawaited(cancelled.then((_) => cancel()));
    final timer = Timer(const Duration(minutes: 2), cancel);
    IOSink? sink;
    var completed = false;
    try {
      final request = http.AbortableRequest(
        'GET',
        _uri('/api/artifacts/${artifact.id}'),
        abortTrigger: abort.future,
      )..followRedirects = false;
      request.headers.addAll(_headers());
      final response = await _apiClient.send(request);
      if (response.statusCode != 200) {
        throw _statusError(response.statusCode, '');
      }
      sink = destination.openWrite();
      var size = 0;
      await for (final bytes in response.stream) {
        size += bytes.length;
        if (size > nodAttachmentLimit) throw const NodProtocolException();
        sink.add(bytes);
      }
      if (size != artifact.size) throw const NodProtocolException();
      await sink.flush();
      completed = true;
    } on NodException {
      rethrow;
    } catch (_) {
      throw const NodRequestException();
    } finally {
      timer.cancel();
      cancel();
      await sink?.close();
      if (!completed && await destination.exists()) await destination.delete();
    }
  }

  @override
  Future<void> stop() async {
    await _requestJson('POST', '/api/thread/stop');
    _closeBrowsers();
  }

  T _usageValue<T>(Object? value, T Function(Map<String, Object?>) parse) {
    try {
      return parse(_expectMap(value));
    } catch (_) {
      throw const NodProtocolException();
    }
  }

  @override
  Future<List<NodSchedule>> loadSchedules() async {
    final value = await _requestJson('GET', '/api/schedules');
    if (value is! List) throw const NodProtocolException();
    return value
        .map((item) => NodSchedule.fromJson(scheduleMap(item)))
        .toList();
  }

  @override
  Future<NodSchedule> updateSchedule(
    NodSchedule schedule,
    Map<String, Object?> changes,
  ) async => NodSchedule.fromJson(
    scheduleMap(
      await _requestJson(
        'PATCH',
        '/api/schedules/${Uri.encodeComponent(schedule.id)}',
        body: {...changes, 'expectedRevision': schedule.revision},
      ),
    ),
  );

  @override
  Future<void> deleteSchedule(String id) async {
    await _requestJson('DELETE', '/api/schedules/${Uri.encodeComponent(id)}');
  }

  @override
  Future<NodScheduleHistory> loadScheduleHistory(
    String id, {
    String? cursor,
  }) async => NodScheduleHistory.fromJson(
    scheduleMap(
      await _requestJson(
        'GET',
        '/api/schedule-runs?${Uri(queryParameters: {'scheduleId': id, 'cursor': ?cursor}).query}',
      ),
    ),
  );

  @override
  Future<NodUsageReport> loadUsage() async => _usageValue(
    await _requestJson('GET', '/api/trust'),
    NodUsageReport.fromJson,
  );

  @override
  Future<NodUsageEntries> loadUsageEntries(
    NodUsageCursor cursor,
  ) async => _usageValue(
    await _requestJson(
      'GET',
      '/api/trust/entries?${Uri(queryParameters: {'at': cursor.at, 'id': cursor.id}).query}',
    ),
    NodUsageEntries.fromJson,
  );

  @override
  Future<NodUsageLimit?> saveMonthlyLimit(double? monthlyUsd) async {
    if (monthlyUsd != null && (!monthlyUsd.isFinite || monthlyUsd < 1)) {
      throw const NodRequestException();
    }
    final result = _expectMap(
      await _requestJson(
        'PUT',
        '/api/trust/limit',
        body: {'monthlyUsd': monthlyUsd},
      ),
    );
    if (!result.containsKey('limit')) throw const NodProtocolException();
    return result['limit'] == null
        ? null
        : _usageValue(result['limit'], NodUsageLimit.fromJson);
  }

  @override
  Future<List<NodAppConnection>> loadApps({bool catalog = false}) async {
    final value = await _requestJson(
      'GET',
      catalog ? '/api/apps/catalog' : '/api/apps',
    );
    if (value is! List) throw const NodProtocolException();
    return value
        .map((entry) {
          final app = _expectMap(entry);
          return NodAppConnection(
            slug: _requiredString(app['slug']),
            name: _requiredString(app['name']),
            status: _requiredString(app['status']),
            connectionId: _string(app['connectionId']),
            account:
                _string(app['accountEmail']) ?? _string(app['accountName']),
            description: _string(app['description']),
            hasAccessPaths:
                app['accessPaths'] is List &&
                (app['accessPaths'] as List).isNotEmpty,
            broker:
                app['direct'] != true &&
                (app['accessPaths'] is! List ||
                    (app['accessPaths'] as List).isEmpty),
          );
        })
        .toList(growable: false);
  }

  @override
  Future<NodAppSignIn> startAppSignIn(NodAppConnection app) async {
    final value = _expectMap(
      await _requestJson(
        'POST',
        '/api/apps/${Uri.encodeComponent(app.slug)}/connect',
        body: {
          'returnTo': 'window',
          if (app.status == 'connected' && app.hasAccessPaths)
            'newAccount': true,
          if (app.connectionId != null &&
              (app.status != 'connected' || app.hasAccessPaths))
            'connectionId': app.connectionId,
        },
      ),
    );
    final raw = _requiredString(value['url']);
    final url = _config!.origin.resolve(raw);
    final hash = sha256.convert(utf8.encode(url.toString())).toString();
    final signIn = NodAppSignIn(url: url, hash: hash);
    if (url.userInfo.isNotEmpty ||
        url.host.isEmpty ||
        (url.scheme != 'https' &&
            !(url.scheme == 'http' && url.origin == _config!.origin.origin))) {
      await cancelAppSignIn(signIn);
      throw const NodProtocolException();
    }
    if (url.origin == _config!.origin.origin && url.path == '/apps') {
      await cancelAppSignIn(signIn);
      throw const NodAppSetupException();
    }
    return signIn;
  }

  @override
  Future<NodAppSignInStatus> appSignInStatus(NodAppSignIn signIn) async {
    final result = _expectMap(
      await _requestJson(
        'POST',
        '/api/apps/setup-status',
        body: {
          'hashes': [signIn.hash],
          'pairingUrl': signIn.url.toString(),
        },
      ),
    );
    final completed = result['completed'];
    final apps = result['apps'];
    if (completed is! List || apps is! List) throw const NodProtocolException();
    if (completed.contains(signIn.hash)) return NodAppSignInStatus.connected;
    for (final app in apps) {
      if (app is Map &&
          app['hash'] == signIn.hash &&
          app['available'] != false) {
        return NodAppSignInStatus.waiting;
      }
    }
    return NodAppSignInStatus.unavailable;
  }

  @override
  Future<void> cancelAppSignIn(NodAppSignIn signIn) async {
    await _requestJson(
      'POST',
      '/api/apps/setup-cancel',
      body: {'hash': signIn.hash},
    );
  }

  void _closeBrowsers() {
    for (final close in _closeBrowserStreams.toList()) {
      close();
    }
  }

  @override
  Stream<List<int>> browserHandoffFrames(String turnId) {
    _ensureConnected();
    if (!RegExp(
      r'^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$',
    ).hasMatch(turnId)) {
      throw const NodRequestException();
    }
    final generation = _generation;
    final client = _browserClientFactory();
    StreamSubscription<List<int>>? subscription;
    Timer? timer;
    var closed = false;
    final buffer = <int>[];
    int? length;
    late final StreamController<List<int>> controller;
    late final void Function() close;
    close = () {
      if (closed) return;
      closed = true;
      timer?.cancel();
      client.close();
      unawaited(subscription?.cancel());
      _closeBrowserStreams.remove(close);
      unawaited(controller.close());
    };
    void fail(Object error) {
      if (!closed) controller.addError(error);
      close();
    }

    void deadline() {
      timer?.cancel();
      timer = Timer(
        const Duration(seconds: 30),
        () => fail(const NodTimeoutException()),
      );
    }

    Future<void> start() async {
      if (!_isCurrent(generation)) {
        close();
        return;
      }
      _closeBrowserStreams.add(close);
      final request = http.Request(
        'GET',
        _uri('/api/browser-handoff/stream?turnId=$turnId'),
      )..followRedirects = false;
      request.headers.addAll(_headers());
      try {
        final response = await client.send(request).timeout(requestTimeout);
        if (closed || !_isCurrent(generation)) {
          close();
          return;
        }
        if (response.statusCode != 200) {
          fail(_statusError(response.statusCode, ''));
          return;
        }
        deadline();
        subscription = response.stream.listen(
          (bytes) {
            if (closed || !_isCurrent(generation)) {
              close();
              return;
            }
            var offset = 0;
            while (!closed && offset < bytes.length) {
              final needed = (length ?? 4) - buffer.length;
              final remaining = bytes.length - offset;
              final count = needed < remaining ? needed : remaining;
              buffer.addAll(bytes.getRange(offset, offset + count));
              offset += count;
              if (length == null) {
                if (buffer.length < 4) continue;
                length =
                    (buffer[0] << 24) |
                    (buffer[1] << 16) |
                    (buffer[2] << 8) |
                    buffer[3];
                buffer.clear();
                if (length! <= 0 || length! > 8 * 1024 * 1024) {
                  fail(const NodProtocolException());
                  return;
                }
              } else if (buffer.length == length) {
                controller.add(List<int>.unmodifiable(buffer));
                buffer.clear();
                length = null;
                deadline();
              }
            }
          },
          onError: (Object error) => fail(_transportError(error)),
          onDone: () {
            if (length != null || buffer.isNotEmpty) {
              fail(const NodProtocolException());
            } else {
              close();
            }
          },
        );
      } on Object catch (error) {
        if (!closed) fail(_transportError(error));
      }
    }

    controller = StreamController<List<int>>(
      onListen: () => unawaited(start()),
      onPause: () => subscription?.pause(),
      onResume: () {
        deadline();
        subscription?.resume();
      },
      onCancel: close,
    );
    return controller.stream;
  }

  Future<void> dispose() async {
    if (_disposed) return;
    _disposed = true;
    ++_generation;
    _closeBrowsers();
    await _closeEvents();
    if (_closeApiClient) _apiClient.close();
    await _connectionController.close();
    await _eventController.close();
  }

  Future<void> _openEvents(int generation) async {
    if (!_isCurrent(generation)) return;
    final client = _eventClientFactory();
    final request = http.Request('GET', _uri('/api/events'))
      ..followRedirects = false;
    request.headers.addAll(_headers());
    http.StreamedResponse response;
    try {
      response = await client.send(request).timeout(requestTimeout);
    } catch (error) {
      client.close();
      throw _transportError(error);
    }
    if (!_isCurrent(generation)) {
      client.close();
      return;
    }
    if (response.statusCode != 200) {
      final body = await response.stream.bytesToString();
      client.close();
      throw _statusError(response.statusCode, body);
    }
    await _closeEvents();
    if (!_isCurrent(generation)) {
      client.close();
      return;
    }
    _eventClient = client;
    late final StreamSubscription<SseMessage> subscription;
    subscription = response.stream
        .transform(const SseDecoder())
        .listen(
          (message) => _queueEvent(message, generation),
          onError: (Object error, StackTrace stackTrace) {
            _streamEnded(generation, subscription, _transportError(error));
          },
          onDone: () => _streamEnded(generation, subscription, null),
        );
    _eventSubscription = subscription;
  }

  void _queueEvent(SseMessage message, int generation) {
    _eventWork = _eventWork.then((_) async {
      if (!_isCurrent(generation)) return;
      try {
        await _handleEvent(message);
      } on NodException catch (error, stackTrace) {
        if (_isCurrent(generation)) {
          _eventController.addError(error, stackTrace);
        }
      }
    });
  }

  Future<void> _handleEvent(SseMessage message) async {
    if (message.id != null && message.id!.isNotEmpty) {
      if (!_eventIds.add(message.id!)) return;
      if (_eventIds.length > 512) _eventIds.remove(_eventIds.first);
    }
    Object? decoded;
    try {
      decoded = jsonDecode(message.data);
    } on FormatException {
      return;
    }
    if (decoded is! Map<Object?, Object?>) return;
    final json = Map<String, Object?>.from(decoded);
    final type = _string(json['type']) ?? message.event;
    switch (type) {
      case 'refresh':
        final inline = json['state'];
        if (inline is Map<Object?, Object?>) {
          final state = _parseState(Map<String, Object?>.from(inline));
          _rememberState(state);
          _eventController.add(NodRefreshEvent(state));
        } else {
          await _reconcile(emit: true);
        }
      case 'activity':
        final items = _parseActivity(json['items']);
        final explicit = _turnState(json['turn'] ?? json['status']);
        _eventController.add(
          NodActivityEvent(
            explicit ??
                (items.isEmpty ? NodTurnState.idle : NodTurnState.running),
            items: items,
          ),
        );
      case 'delta':
        final text = _string(json['text']) ?? '';
        final streamId = _string(json['streamId']);
        final turnId = _string(json['turnId']);
        final messageId =
            _string(json['messageId']) ?? streamId ?? turnId ?? 'stream';
        _eventController.add(
          NodMessageDeltaEvent(
            messageId: messageId,
            text: text,
            threadId: _string(json['threadId']),
            turnId: turnId,
            streamId: streamId,
            done: json['done'] == true,
          ),
        );
      case 'message':
        final value = json['message'];
        if (value is Map) {
          final parsed = _parseMessage(Map<String, Object?>.from(value));
          if (_rememberMessage(parsed)) {
            _eventController.add(NodMessageEvent(parsed));
          }
        }
    }
  }

  Future<NodState> _reconcile({required bool emit}) async {
    var request = _reconciliation;
    if (request == null) {
      late final Future<NodState> current;
      current = loadState().whenComplete(() {
        if (identical(_reconciliation, current)) _reconciliation = null;
      });
      _reconciliation = current;
      request = current;
    }
    final state = await request;
    if (emit) _eventController.add(NodRefreshEvent(state));
    return state;
  }

  void _streamEnded(
    int generation,
    StreamSubscription<SseMessage> subscription,
    NodException? error,
  ) {
    if (!_isCurrent(generation) ||
        !identical(_eventSubscription, subscription)) {
      return;
    }
    _eventSubscription = null;
    _eventClient?.close();
    _eventClient = null;
    if (error != null) _eventController.addError(error);
    _scheduleReconnect(generation, error);
  }

  void _scheduleReconnect(int generation, NodException? initialError) {
    if (!_isCurrent(generation) || _reconnectTask != null) return;
    if (initialError is NodUnauthorizedException ||
        initialError is NodForbiddenException) {
      _emitConnection(NodConnectionPhase.disconnected);
      return;
    }
    late final Future<void> task;
    task = () async {
      NodException? error = initialError;
      while (_isCurrent(generation) && _eventSubscription == null) {
        _emitConnection(
          error is NodOfflineException
              ? NodConnectionPhase.offline
              : NodConnectionPhase.reconnecting,
        );
        final delay =
            _reconnectDelays[_retryIndex.clamp(0, _reconnectDelays.length - 1)];
        if (_retryIndex < _reconnectDelays.length - 1) _retryIndex++;
        await _delay(delay);
        if (!_isCurrent(generation)) return;
        try {
          await _openEvents(generation);
          if (!_isCurrent(generation) || _eventSubscription == null) return;
          await _reconcile(emit: true);
          if (!_isCurrent(generation) || _eventSubscription == null) return;
          _retryIndex = 0;
          _emitConnection(NodConnectionPhase.connected);
          return;
        } catch (cause, stackTrace) {
          error = _asNodException(cause);
          if (_isCurrent(generation)) {
            _eventController.addError(error, stackTrace);
          }
          if (error is NodUnauthorizedException ||
              error is NodForbiddenException) {
            _emitConnection(NodConnectionPhase.disconnected);
            return;
          }
        }
      }
    }();
    _reconnectTask = task;
    unawaited(
      task.whenComplete(() {
        if (identical(_reconnectTask, task)) _reconnectTask = null;
      }),
    );
  }

  @override
  Future<Object?> requestJson(
    String method,
    String path, {
    Map<String, Object?>? body,
  }) {
    _validateApiPath(path);
    return _requestJson(method, path, body: body);
  }

  void _validateApiPath(String path) {
    final uri = Uri.tryParse(path);
    if (uri == null ||
        uri.hasScheme ||
        uri.hasAuthority ||
        uri.hasFragment ||
        !uri.path.startsWith('/api/') ||
        uri.pathSegments.any((segment) => segment == '..' || segment == '.')) {
      throw const NodProtocolException();
    }
  }

  @override
  Future<NodBinaryResponse> requestBytes(
    String method,
    String path, {
    Map<String, Object?>? body,
  }) {
    _validateApiPath(path);
    return _requestBytes(method, path, body: body);
  }

  Future<NodBinaryResponse> _requestBytes(
    String method,
    String path, {
    Map<String, Object?>? body,
  }) async {
    _ensureConnected();
    final generation = _generation;
    final abort = Completer<void>();
    final timer = Timer(requestTimeout, () => abort.complete());
    try {
      Future<NodBinaryResponse> perform() async {
        final request = http.AbortableRequest(
          method,
          _uri(path),
          abortTrigger: abort.future,
        )..followRedirects = false;
        request.headers.addAll(_headers(json: body != null));
        request.headers['Accept'] = '*/*';
        if (body != null) request.body = jsonEncode(body);
        final response = await _apiClient.send(request).timeout(requestTimeout);
        final bytes = <int>[];
        await for (final chunk in response.stream.timeout(requestTimeout)) {
          if (!_isCurrent(generation)) throw const NodRequestException();
          if (bytes.length + chunk.length > 16 * 1024 * 1024) {
            throw const NodProtocolException();
          }
          bytes.addAll(chunk);
        }
        if (!_isCurrent(generation)) throw const NodRequestException();
        if (response.statusCode < 200 || response.statusCode >= 300) {
          throw _statusError(
            response.statusCode,
            utf8.decode(bytes, allowMalformed: true),
          );
        }
        return NodBinaryResponse(
          bytes: List.unmodifiable(bytes),
          mimeType:
              response.headers['content-type']?.split(';').first.trim() ??
              'application/octet-stream',
        );
      }

      return await perform().timeout(requestTimeout);
    } on NodException {
      rethrow;
    } catch (error) {
      if (error is http.RequestAbortedException) {
        throw const NodTimeoutException();
      }
      throw _transportError(error);
    } finally {
      timer.cancel();
      if (!abort.isCompleted) abort.complete();
    }
  }

  Future<Object?> _requestJson(
    String method,
    String path, {
    Map<String, Object?>? body,
  }) async {
    _ensureConnected();
    final generation = _generation;
    final request = http.Request(method, _uri(path))..followRedirects = false;
    request.headers.addAll(_headers(json: body != null));
    if (body != null) request.body = jsonEncode(body);
    try {
      final response = await _apiClient.send(request).timeout(requestTimeout);
      if (!_isCurrent(generation)) throw const NodRequestException();
      final responseBody = await response.stream.bytesToString().timeout(
        requestTimeout,
      );
      if (!_isCurrent(generation)) throw const NodRequestException();
      if (response.statusCode < 200 || response.statusCode >= 300) {
        throw _statusError(response.statusCode, responseBody);
      }
      if (responseBody.isEmpty) return const <String, Object?>{};
      try {
        return jsonDecode(responseBody);
      } on FormatException {
        throw const NodProtocolException();
      }
    } on NodException {
      rethrow;
    } catch (error) {
      throw _transportError(error);
    }
  }

  Map<String, String> _headers({bool json = false}) => {
    'Accept': 'application/json',
    'Authorization': 'Bearer ${_config!.token}',
    'Origin': _config!.origin.origin,
    if (json) 'Content-Type': 'application/json',
  };

  Uri _uri(String path) => _config!.origin.resolve(path);

  NodState _parseState(Map<String, Object?> json) {
    final threadId = _requiredString(json['threadId']);
    final messages = _deduplicateMessages(_parseMessages(json['messages']));
    final turns = json['turns'];
    var turn = NodTurnState.idle;
    if (turns is List) {
      for (final value in turns) {
        if (value is! Map) continue;
        final state = _turnState(value['status']);
        if (state == null) continue;
        if (state == NodTurnState.queued ||
            state == NodTurnState.running ||
            state == NodTurnState.waiting) {
          turn = state;
          break;
        }
        if (turn == NodTurnState.idle) turn = state;
      }
    }
    final explicitTurn = _turnState(json['turn']);
    if (explicitTurn != null) turn = explicitTurn;
    final revision =
        _string(json['revision']) ??
        '$threadId:${messages.lastOrNull?.id ?? ''}:${turn.name}';
    if (_threadId != null && _threadId != threadId) _closeBrowsers();
    _threadId = threadId;
    final hiddenIds = json['hiddenMessageIds'];
    final hiddenCount = json['hiddenMessageCount'];
    if ((hiddenIds != null &&
            (hiddenIds is! List ||
                hiddenIds.any((id) => id is! String || id.isEmpty))) ||
        (hiddenCount != null && (hiddenCount is! int || hiddenCount < 0))) {
      throw const NodProtocolException();
    }
    return NodState(
      messages: messages,
      threadId: threadId,
      pendingAnswerChoiceMessageIds:
          json['pendingAnswerChoiceMessageIds'] is List
          ? List<String>.from(json['pendingAnswerChoiceMessageIds'] as List)
          : messages
                .where((message) => message.answerChoicesPending)
                .map((message) => message.id)
                .toList(),
      verificationRequests: (json['verificationRequests'] as List? ?? const [])
          .map((value) {
            final request = _expectMap(value);
            return NodVerificationRequest(
              id: _requiredString(request['id']),
              turnId: _requiredString(request['turnId']),
              kind: _requiredString(request['kind']),
            );
          })
          .toList(),
      turn: turn,
      revision: revision,
      hiddenMessageIds: hiddenIds == null
          ? const []
          : List<String>.unmodifiable(hiddenIds as List),
      hiddenMessageCount:
          hiddenCount as int? ?? (hiddenIds as List?)?.length ?? 0,
    );
  }

  List<NodMessage> _parseMessages(Object? value) {
    if (value is! List) throw const NodProtocolException();
    return value
        .map((entry) {
          if (entry is! Map) throw const NodProtocolException();
          return _parseMessage(Map<String, Object?>.from(entry));
        })
        .toList(growable: false);
  }

  NodMessage _parseMessage(Map<String, Object?> json) {
    final role = switch (_requiredString(json['role'])) {
      'user' || 'owner' => NodMessageRole.owner,
      'assistant' => NodMessageRole.assistant,
      'system' => NodMessageRole.system,
      _ => throw const NodProtocolException(),
    };
    final createdAt = DateTime.tryParse(_requiredString(json['createdAt']));
    if (createdAt == null) throw const NodProtocolException();
    return NodMessage(
      id: _requiredString(json['id']),
      clientMessageId:
          _string(json['clientMessageId']) ??
          _string(json['client_message_id']),
      role: role,
      turnId: _string(json['turnId']),
      replyToMessageId: _string(json['replyToMessageId']),
      reaction: _string(json['reaction']),
      presentation: role == NodMessageRole.assistant
          ? NodRichResult.parse(json['presentation'])
          : null,
      reactions: json['reactions'] is List
          ? (json['reactions'] as List)
                .whereType<Map<Object?, Object?>>()
                .where(
                  (item) =>
                      const {'user', 'assistant'}.contains(item['actor']) &&
                      item['reaction'] is String,
                )
                .map(
                  (item) => (
                    actor: item['actor'] as String,
                    reaction: item['reaction'] as String,
                  ),
                )
                .toList()
          : const [],
      answerChoices:
          role == NodMessageRole.assistant && json['answerChoices'] != null
          ? _parseChoices(json['answerChoices'])
          : null,
      answerChoicesPending: json['answerChoicesPending'] == true,
      text: _string(json['audioCaption']) ?? _string(json['text']) ?? '',
      attachments: json['attachments'] is List
          ? (json['attachments'] as List).map(_parseArtifact).toList()
          : const [],
      createdAt: createdAt,
    );
  }

  NodAnswerChoices _parseChoices(Object? value) {
    final choices = _expectMap(value);
    final options = choices['options'];
    if (options is! List ||
        options.isEmpty ||
        options.length > 6 ||
        choices['multiple'] is! bool) {
      throw const NodProtocolException();
    }
    final parsed = options.map((value) {
      final option = _expectMap(value);
      return NodAnswerChoice(
        id: _requiredString(option['id']),
        label: _requiredString(option['label']),
        description: _string(option['description']),
      );
    }).toList();
    if (parsed.map((option) => option.id).toSet().length != parsed.length) {
      throw const NodProtocolException();
    }
    return NodAnswerChoices(
      options: parsed,
      multiple: choices['multiple'] as bool,
    );
  }

  List<NodMessage> _deduplicateMessages(List<NodMessage> messages) {
    final result = <NodMessage>[];
    final ids = <String>{};
    final clientIds = <String>{};
    for (final message in messages.reversed) {
      final clientId = message.clientMessageId;
      if (ids.contains(message.id) ||
          (clientId != null && clientIds.contains(clientId))) {
        continue;
      }
      ids.add(message.id);
      if (clientId != null) clientIds.add(clientId);
      result.add(message);
    }
    return List.unmodifiable(result.reversed);
  }

  List<NodActivity> _parseActivity(Object? value) {
    if (value is! List) return const [];
    return value
        .whereType<Map<Object?, Object?>>()
        .map((entry) {
          final json = Map<String, Object?>.from(entry);
          return NodActivity(
            turnId: _string(json['turnId']) ?? '',
            taskId: _string(json['taskId']),
            title: _string(json['title']),
            step: _string(json['step']),
            site: _string(json['site']),
            since: DateTime.tryParse(_string(json['since']) ?? ''),
          );
        })
        .where((activity) => activity.turnId.isNotEmpty)
        .toList(growable: false);
  }

  void _rememberState(NodState state) {
    _messageIds.clear();
    _clientMessageIds.clear();
    for (final message in state.messages) {
      _rememberMessage(message);
    }
  }

  bool _rememberMessage(NodMessage message) {
    if (_messageIds.contains(message.id) ||
        (message.clientMessageId != null &&
            _clientMessageIds.contains(message.clientMessageId))) {
      return false;
    }
    _messageIds.add(message.id);
    if (message.clientMessageId != null) {
      _clientMessageIds.add(message.clientMessageId!);
    }
    return true;
  }

  Future<void> _closeEvents() async {
    final subscription = _eventSubscription;
    final client = _eventClient;
    _eventSubscription = null;
    _eventClient = null;
    try {
      await subscription?.cancel();
    } finally {
      client?.close();
    }
  }

  Future<T> _useCredentials<T>(Future<T> Function() operation) async {
    try {
      return await operation();
    } on NodCredentialStorageException {
      rethrow;
    } on Object {
      throw const NodCredentialStorageException();
    }
  }

  void _clearConnection() {
    _config = null;
    _capabilities = null;
    _session = null;
    _threadId = null;
    _messageIds.clear();
    _clientMessageIds.clear();
    _eventIds.clear();
  }

  void _emitFailureConnection(Object error) {
    final mapped = _asNodException(error);
    _emitConnection(
      mapped is NodOfflineException || mapped is NodTimeoutException
          ? NodConnectionPhase.offline
          : NodConnectionPhase.disconnected,
    );
  }

  void _emitConnection(NodConnectionPhase phase, {String? detail}) {
    if (_disposed ||
        (_connectionState.phase == phase &&
            _connectionState.detail == detail)) {
      return;
    }
    _connectionState = NodConnectionState(phase: phase, detail: detail);
    _connectionController.add(_connectionState);
  }

  bool _isCurrent(int generation) =>
      !_disposed && generation == _generation && _config != null;

  void _ensureActive() {
    if (_disposed) throw StateError('Repository is disposed.');
  }

  void _ensureConnected() {
    _ensureActive();
    if (_config == null) throw const NodOfflineException();
  }
}

Map<String, Object?> _expectMap(Object? value) {
  if (value is! Map) throw const NodProtocolException();
  return Map<String, Object?>.from(value);
}

String _requiredString(Object? value) {
  final result = _string(value);
  if (result == null || result.isEmpty) throw const NodProtocolException();
  return result;
}

String? _string(Object? value) => value is String ? value : null;

NodTurnState? _turnState(Object? value) => switch (value) {
  'idle' => NodTurnState.idle,
  'queued' => NodTurnState.queued,
  'running' => NodTurnState.running,
  'waiting' => NodTurnState.waiting,
  'succeeded' => NodTurnState.succeeded,
  'failed' => NodTurnState.failed,
  'cancelled' => NodTurnState.cancelled,
  _ => null,
};

NodException _asNodException(Object error) =>
    error is NodException ? error : _transportError(error);

NodException _transportError(Object error) {
  if (error is NodException) return error;
  if (error is TimeoutException) return const NodTimeoutException();
  if (error is SocketException ||
      error is HandshakeException ||
      error is TlsException ||
      error is http.ClientException) {
    return const NodOfflineException();
  }
  return const NodOfflineException();
}

NodException _audioStatusError(int status, String body) {
  if (status == 404) {
    return const NodAudioException(NodAudioFailure.unsupportedServer);
  }
  if (status == 413) return const NodAudioException(NodAudioFailure.tooLarge);
  String? message;
  var retryable = false;
  try {
    final decoded = jsonDecode(body);
    if (decoded is Map<String, dynamic>) {
      message = _string(decoded['error']);
      retryable = decoded['retryable'] == true;
    }
  } on FormatException {
    return _statusError(status, body);
  }
  final kind = switch (message) {
    'Set up audio in Settings → General → Voice. Choose free voices or connect a voice service.' =>
      NodAudioFailure.setup,
    'Connect an AI provider in Settings → Models before sending a message.' =>
      NodAudioFailure.modelSetup,
    'No speech was detected. Check your microphone and record again.' =>
      NodAudioFailure.noSpeech,
    'The recording could not be transcribed. Try again or send a text message.' =>
      NodAudioFailure.transcription,
    'This voice message is too long. Record a shorter message.' ||
    'Choose an audio recording smaller than 25 MB.' ||
    'Send a shorter voice message.' => NodAudioFailure.tooLarge,
    'This recording may already be in the conversation. Check before sending a new recording.' =>
      NodAudioFailure.uncertain,
    _ => null,
  };
  if (status == 400 && kind != null ||
      status == 409 && kind == NodAudioFailure.uncertain) {
    return NodAudioException(kind!, retryable: status == 400 && retryable);
  }
  if ((status == 400 || status == 503) && retryable) {
    return const NodAudioException(NodAudioFailure.send, retryable: true);
  }
  return _statusError(status, body);
}

NodException _statusError(int status, String body) {
  switch (status) {
    case 401:
      return const NodUnauthorizedException();
    case 403:
      return const NodForbiddenException();
    case 409:
      var code = '';
      var message = '';
      try {
        final decoded = jsonDecode(body);
        if (decoded is Map<Object?, Object?>) {
          code = _string(decoded['code'])?.toLowerCase() ?? '';
          message = _string(decoded['error'])?.toLowerCase() ?? '';
        }
      } on FormatException {
        return const NodConflictException(NodConflictKind.unknown);
      }
      if (code.contains('reset') || message.contains('reset')) {
        return const NodConflictException(NodConflictKind.conversationReset);
      }
      if (code.contains('client_message') ||
          message.contains('message id is already in use')) {
        return const NodConflictException(
          NodConflictKind.duplicateClientMessage,
        );
      }
      return const NodConflictException(NodConflictKind.unknown);
    case 503:
      return const NodUnavailableException();
    default:
      return const NodRequestException();
  }
}

final class _HistoryCursor {
  const _HistoryCursor({
    required this.threadId,
    required this.createdAt,
    required this.messageId,
  });

  final String threadId;
  final String createdAt;
  final String messageId;

  String encode() =>
      'nod:${base64Url.encode(utf8.encode(jsonEncode(<String, String>{'threadId': threadId, 'createdAt': createdAt, 'messageId': messageId}))).replaceAll('=', '')}';

  static _HistoryCursor? decode(String value) {
    if (!value.startsWith('nod:')) return null;
    try {
      final encoded = value.substring(4);
      final padded = encoded.padRight((encoded.length + 3) ~/ 4 * 4, '=');
      final json = jsonDecode(utf8.decode(base64Url.decode(padded)));
      if (json is! Map<Object?, Object?>) return null;
      return _HistoryCursor(
        threadId: _requiredString(json['threadId']),
        createdAt: _requiredString(json['createdAt']),
        messageId: _requiredString(json['messageId']),
      );
    } on Object {
      return null;
    }
  }
}

extension<T> on List<T> {
  T? get firstOrNull => isEmpty ? null : first;
  T? get lastOrNull => isEmpty ? null : last;
}
