import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:math';

import 'package:http/http.dart' as http;

final class ValidationFailure implements Exception {
  ValidationFailure(this.message);

  final String message;

  @override
  String toString() => message;
}

final class HttpStatusFailure implements Exception {
  HttpStatusFailure(this.statusCode, this.path);

  final int statusCode;
  final String path;

  @override
  String toString() => '$path returned HTTP $statusCode';
}

final class ValidationCheck {
  ValidationCheck({
    required this.name,
    required this.status,
    required this.durationMs,
    this.detail,
  });

  final String name;
  final String status;
  final int durationMs;
  final String? detail;

  Map<String, Object> toJson() {
    final result = <String, Object>{
      'name': name,
      'status': status,
      'durationMs': durationMs,
    };
    final failureDetail = detail;
    if (failureDetail != null) result['detail'] = failureDetail;
    return result;
  }
}

final class ValidationReport {
  ValidationReport({
    required this.checks,
    required this.processStopped,
    required this.disposableDataRemoved,
  });

  final List<ValidationCheck> checks;
  final bool processStopped;
  final bool disposableDataRemoved;

  bool get passed =>
      checks.isNotEmpty &&
      checks.every((check) => check.status == 'passed') &&
      processStopped &&
      disposableDataRemoved;

  List<String> get limitations => const <String>[
    'The disposable fixture uses Nod\'s real bearer, Host, Origin, and cross-site guard with synthetic conversation state.',
    'The companion Flutter integration test runs HttpNodRepository and NodClientApp without model execution or external providers.',
  ];

  Map<String, Object> toJson() => <String, Object>{
    'version': 1,
    'passed': passed,
    'checks': checks.map((check) => check.toJson()).toList(),
    'cleanup': <String, bool>{
      'processStopped': processStopped,
      'disposableDataRemoved': disposableDataRemoved,
    },
    'limitations': limitations,
  };
}

final class _FixtureProcess {
  _FixtureProcess({
    required this.repositoryRoot,
    required this.port,
    required this.token,
    required this.controlToken,
    required this.dataPath,
  });

  final Directory repositoryRoot;
  final int port;
  final String token;
  final String controlToken;
  final String dataPath;
  Process? _process;
  final List<String> _stderr = <String>[];

  Uri get origin => Uri.parse('http://127.0.0.1:$port');

  Future<void> start() async {
    final process = await Process.start(
      '${repositoryRoot.path}/node_modules/.bin/tsx',
      <String>['clients/flutter/tool/validation_server.ts'],
      workingDirectory: repositoryRoot.path,
      environment: <String, String>{
        ...Platform.environment,
        'NOD_VALIDATION_PORT': '$port',
        'NOD_VALIDATION_TOKEN': token,
        'NOD_VALIDATION_CONTROL_TOKEN': controlToken,
        'NOD_VALIDATION_DATA': dataPath,
      },
    );
    _process = process;
    final ready = Completer<void>();
    process.stdout
        .transform(utf8.decoder)
        .transform(const LineSplitter())
        .listen((line) {
          if (!ready.isCompleted && line == '{"ready":true}') ready.complete();
        });
    process.stderr
        .transform(utf8.decoder)
        .transform(const LineSplitter())
        .listen(_stderr.add);
    unawaited(
      process.exitCode.then((code) {
        if (!ready.isCompleted) {
          ready.completeError(
            ValidationFailure(
              'Synthetic server exited with code $code${_stderr.isEmpty ? '' : ': ${_stderr.join(' | ')}'}',
            ),
          );
        }
      }),
    );
    await ready.future.timeout(
      const Duration(seconds: 20),
      onTimeout: () => throw ValidationFailure(
        'Synthetic server did not become ready${_stderr.isEmpty ? '' : ': ${_stderr.join(' | ')}'}.',
      ),
    );
  }

  Future<bool> stop() async {
    final process = _process;
    if (process == null) return true;
    process.kill(ProcessSignal.sigterm);
    try {
      await process.exitCode.timeout(const Duration(seconds: 10));
    } on TimeoutException {
      process.kill(ProcessSignal.sigkill);
      await process.exitCode;
    }
    _process = null;
    return true;
  }
}

final class _SseConnection {
  _SseConnection();

  late final StreamSubscription<String> _subscription;
  final List<Map<String, Object?>> _events = <Map<String, Object?>>[];
  final List<Completer<Map<String, Object?>>> _waiters =
      <Completer<Map<String, Object?>>>[];

  factory _SseConnection.listen(Stream<String> lines) {
    final connection = _SseConnection();
    connection._subscription = lines.listen((line) {
      if (!line.startsWith('data: ')) return;
      final event = (jsonDecode(line.substring(6)) as Map)
          .cast<String, Object?>();
      if (connection._waiters.isNotEmpty) {
        connection._waiters.removeAt(0).complete(event);
      } else {
        connection._events.add(event);
      }
    });
    return connection;
  }

  Future<Map<String, Object?>> next() {
    if (_events.isNotEmpty) {
      return Future<Map<String, Object?>>.value(_events.removeAt(0));
    }
    final waiter = Completer<Map<String, Object?>>();
    _waiters.add(waiter);
    return waiter.future.timeout(const Duration(seconds: 5));
  }

  Future<void> close() async {
    await _subscription.cancel();
    for (final waiter in _waiters) {
      if (!waiter.isCompleted) {
        waiter.completeError(ValidationFailure('SSE connection closed.'));
      }
    }
    _waiters.clear();
  }
}

final class _ValidationClient {
  _ValidationClient(this.origin, this.token) : _http = http.Client();

  final Uri origin;
  final String token;
  final http.Client _http;

  Map<String, String> get _headers => <String, String>{
    HttpHeaders.authorizationHeader: 'Bearer $token',
    HttpHeaders.contentTypeHeader: 'application/json',
  };

  Future<Map<String, Object?>> session() => _get('/api/session');

  Future<Map<String, Object?>> state() => _get('/api/state');

  Future<Map<String, Object?>> history() => _get('/api/messages');

  Future<Map<String, Object?>> send({
    required String clientMessageId,
    required String text,
  }) => _post('/api/messages', <String, Object>{
    'clientMessageId': clientMessageId,
    'text': text,
  });

  Future<_SseConnection> events() async {
    final request = http.Request('GET', origin.resolve('/api/events'));
    request.headers.addAll(_headers);
    final response = await _http.send(request);
    if (response.statusCode != HttpStatus.ok) {
      await response.stream.drain<void>();
      throw HttpStatusFailure(response.statusCode, '/api/events');
    }
    return _SseConnection.listen(
      response.stream.transform(utf8.decoder).transform(const LineSplitter()),
    );
  }

  Future<Map<String, Object?>> _get(String path) async {
    final response = await _http.get(origin.resolve(path), headers: _headers);
    return _decode(response, path);
  }

  Future<Map<String, Object?>> _post(
    String path,
    Map<String, Object> body,
  ) async {
    final response = await _http.post(
      origin.resolve(path),
      headers: _headers,
      body: jsonEncode(body),
    );
    return _decode(response, path);
  }

  Map<String, Object?> _decode(http.Response response, String path) {
    if (response.statusCode < 200 || response.statusCode >= 300) {
      throw HttpStatusFailure(response.statusCode, path);
    }
    return (jsonDecode(response.body) as Map).cast<String, Object?>();
  }

  void close() => _http.close();
}

final class _FixtureControl {
  _FixtureControl(this.origin, this.controlToken) : _http = http.Client();

  final Uri origin;
  final String controlToken;
  final http.Client _http;

  Future<void> streamReply() => _post('/fixture/stream');

  Future<void> waitForOwner() => _post('/fixture/wait');

  Future<void> interruptAndCommit({required String id, required String text}) =>
      _post('/fixture/interrupt', <String, String>{'id': id, 'text': text});

  Future<void> commitReply({required String id, required String text}) =>
      _post('/fixture/reply', <String, String>{'id': id, 'text': text});

  Future<void> _post(
    String path, [
    Map<String, String> body = const <String, String>{},
  ]) async {
    final response = await _http.post(
      origin.resolve(path),
      headers: <String, String>{
        'x-fixture-control': controlToken,
        HttpHeaders.contentTypeHeader: 'application/json',
      },
      body: jsonEncode(body),
    );
    if (response.statusCode != HttpStatus.ok) {
      throw HttpStatusFailure(response.statusCode, path);
    }
  }

  void close() => _http.close();
}

final class DisposableValidationFixture {
  DisposableValidationFixture._({
    required this._temporary,
    required this._process,
    required this._control,
    required this.origin,
    required this.token,
  });

  final Directory _temporary;
  final _FixtureProcess _process;
  final _FixtureControl _control;
  final Uri origin;
  final String token;
  var _closed = false;

  static Future<DisposableValidationFixture> start() async {
    final temporary = await Directory.systemTemp.createTemp(
      'nod-flutter-app-validation-',
    );
    final port = await _reservedPort();
    final token = _token();
    final controlToken = _token();
    final process = _FixtureProcess(
      repositoryRoot: _repositoryRoot(),
      port: port,
      token: token,
      controlToken: controlToken,
      dataPath: '${temporary.path}/fixture.json',
    );
    try {
      await process.start();
      return DisposableValidationFixture._(
        temporary: temporary,
        process: process,
        control: _FixtureControl(process.origin, controlToken),
        origin: process.origin,
        token: token,
      );
    } catch (_) {
      await process.stop();
      await temporary.delete(recursive: true);
      rethrow;
    }
  }

  Future<void> streamReply() => _control.streamReply();

  Future<void> waitForOwner() => _control.waitForOwner();

  Future<void> interruptAndCommit({required String id, required String text}) =>
      _control.interruptAndCommit(id: id, text: text);

  Future<void> close() async {
    if (_closed) return;
    _closed = true;
    _control.close();
    await _process.stop();
    await _temporary.delete(recursive: true);
  }
}

void _expect(bool condition, String message) {
  if (!condition) throw ValidationFailure(message);
}

List<Map<String, Object?>> _messages(Map<String, Object?> payload) =>
    (payload['messages'] as List<Object?>)
        .map((message) => (message as Map).cast<String, Object?>())
        .toList();

Future<int> _reservedPort() async {
  final socket = await ServerSocket.bind(InternetAddress.loopbackIPv4, 0);
  final port = socket.port;
  await socket.close();
  return port;
}

String _token() {
  final random = Random.secure();
  return base64Url
      .encode(List<int>.generate(32, (_) => random.nextInt(256)))
      .replaceAll('=', '');
}

Directory _repositoryRoot() {
  var directory = Directory.current.absolute;
  while (true) {
    if (File('${directory.path}/package.json').existsSync() &&
        File('${directory.path}/src/server/access.ts').existsSync()) {
      return directory;
    }
    final parent = directory.parent;
    if (parent.path == directory.path) {
      throw ValidationFailure('Could not locate the Nod repository root.');
    }
    directory = parent;
  }
}

Future<int> _guardedStatus({
  required Uri origin,
  required String token,
  String? host,
  String? requestOrigin,
  String? secFetchSite,
}) async {
  final client = HttpClient();
  try {
    final request = await client.postUrl(origin.resolve('/api/messages'));
    request.headers.set(HttpHeaders.authorizationHeader, 'Bearer $token');
    request.headers.set(HttpHeaders.contentTypeHeader, 'application/json');
    if (host != null) request.headers.set(HttpHeaders.hostHeader, host);
    if (requestOrigin != null) {
      request.headers.set('origin', requestOrigin);
    }
    if (secFetchSite != null) {
      request.headers.set('sec-fetch-site', secFetchSite);
    }
    request.write(
      jsonEncode(<String, String>{
        'clientMessageId': '00000000-0000-4000-8000-000000000099',
        'text': 'Rejected synthetic request',
      }),
    );
    final response = await request.close();
    await response.drain<void>();
    return response.statusCode;
  } finally {
    client.close(force: true);
  }
}

Future<void> _expectStatus(
  Future<Object?> Function() action,
  int expected,
) async {
  try {
    await action();
  } on HttpStatusFailure catch (error) {
    _expect(
      error.statusCode == expected,
      'Expected HTTP $expected but received ${error.statusCode} from ${error.path}.',
    );
    return;
  }
  throw ValidationFailure('Expected HTTP $expected but the request succeeded.');
}

Future<ValidationReport> runValidation({required String outputPath}) async {
  final checks = <ValidationCheck>[];
  final temporary = await Directory.systemTemp.createTemp(
    'nod-flutter-validation-',
  );
  final dataPath = '${temporary.path}/fixture.json';
  final port = await _reservedPort();
  final controlToken = _token();
  final firstToken = _token();
  final secondToken = _token();
  final repositoryRoot = _repositoryRoot();
  _FixtureProcess? fixture;
  final clients = <_ValidationClient>[];
  final controls = <_FixtureControl>[];
  var processStopped = false;
  var disposableDataRemoved = false;

  Future<void> check(String name, Future<void> Function() action) async {
    final watch = Stopwatch()..start();
    try {
      await action();
      checks.add(
        ValidationCheck(
          name: name,
          status: 'passed',
          durationMs: watch.elapsedMilliseconds,
        ),
      );
    } catch (error) {
      checks.add(
        ValidationCheck(
          name: name,
          status: 'failed',
          durationMs: watch.elapsedMilliseconds,
          detail: '$error'
              .replaceAll(firstToken, '[redacted]')
              .replaceAll(secondToken, '[redacted]')
              .replaceAll(controlToken, '[redacted]'),
        ),
      );
      rethrow;
    }
  }

  try {
    fixture = _FixtureProcess(
      repositoryRoot: repositoryRoot,
      port: port,
      token: firstToken,
      controlToken: controlToken,
      dataPath: dataPath,
    );
    await check('disposable_fixture_start', fixture.start);
    final clientA = _ValidationClient(fixture.origin, firstToken);
    final clientB = _ValidationClient(fixture.origin, firstToken);
    final control = _FixtureControl(fixture.origin, controlToken);
    clients.addAll(<_ValidationClient>[clientA, clientB]);
    controls.add(control);

    await check('two_bearer_clients_connect', () async {
      final sessions = await Future.wait(<Future<Map<String, Object?>>>[
        clientA.session(),
        clientB.session(),
      ]);
      _expect(
        sessions.map((session) => session['threadId']).toSet().length == 1,
        'Bearer clients did not resolve the same synthetic thread.',
      );
    });

    const firstId = '00000000-0000-4000-8000-000000000010';
    const secondId = '00000000-0000-4000-8000-000000000011';
    await check('concurrent_distinct_sends_retained', () async {
      await Future.wait(<Future<Map<String, Object?>>>[
        clientA.send(
          clientMessageId: firstId,
          text: 'Synthetic message from client A',
        ),
        clientB.send(
          clientMessageId: secondId,
          text: 'Synthetic message from client B',
        ),
      ]);
      final messages = _messages(await clientA.state());
      _expect(
        messages.where((message) => message['id'] == firstId).length == 1,
        'Client A message was not retained exactly once.',
      );
      _expect(
        messages.where((message) => message['id'] == secondId).length == 1,
        'Client B message was not retained exactly once.',
      );
    });

    const duplicateId = '00000000-0000-4000-8000-000000000012';
    await check('repeated_client_message_id_deduplicated', () async {
      final receipts = await Future.wait(<Future<Map<String, Object?>>>[
        clientA.send(clientMessageId: duplicateId, text: 'Synthetic duplicate'),
        clientB.send(clientMessageId: duplicateId, text: 'Synthetic duplicate'),
      ]);
      _expect(
        receipts[0]['turnId'] == receipts[1]['turnId'],
        'Repeated clientMessageId returned different turns.',
      );
      final messages = _messages(await clientB.history());
      _expect(
        messages.where((message) => message['id'] == duplicateId).length == 1,
        'Repeated clientMessageId created an unintended duplicate.',
      );
    });

    const replyId = '00000000-0000-4000-8000-000000000020';
    await check('sse_interruption_recovers_state_and_history', () async {
      final firstEvents = await clientA.events();
      final initial = await firstEvents.next();
      _expect(
        initial['type'] == 'refresh',
        'SSE did not begin with a refresh event.',
      );
      await firstEvents.close();
      await control.commitReply(id: replyId, text: 'Synthetic committed reply');
      final recoveredEvents = await clientA.events();
      final recovered = await recoveredEvents.next();
      _expect(
        recovered['type'] == 'refresh',
        'Reconnected SSE did not request reconciliation.',
      );
      final stateMessages = _messages(await clientA.state());
      final historyMessages = _messages(await clientA.history());
      _expect(
        stateMessages.where((message) => message['id'] == replyId).length == 1,
        'Recovered state did not contain the committed reply exactly once.',
      );
      _expect(
        historyMessages.where((message) => message['id'] == replyId).length ==
            1,
        'Recovered history did not contain the committed reply exactly once.',
      );
      await recoveredEvents.close();
    });

    await check('host_origin_and_cross_site_rejected', () async {
      final fixtureOrigin = fixture!.origin;
      final statuses = await Future.wait(<Future<int>>[
        _guardedStatus(
          origin: fixtureOrigin,
          token: firstToken,
          host: 'attacker.example',
        ),
        _guardedStatus(
          origin: fixtureOrigin,
          token: firstToken,
          requestOrigin: 'https://attacker.example',
        ),
        _guardedStatus(
          origin: fixtureOrigin,
          token: firstToken,
          secFetchSite: 'cross-site',
        ),
      ]);
      _expect(
        statuses.every((status) => status == HttpStatus.forbidden),
        'Expected Host, Origin, and cross-site attempts to return 403, got $statuses.',
      );
    });

    await check(
      'token_rotation_rejects_old_clients_and_recovers_new_client',
      () async {
        await fixture!.stop();
        fixture = _FixtureProcess(
          repositoryRoot: repositoryRoot,
          port: port,
          token: secondToken,
          controlToken: controlToken,
          dataPath: dataPath,
        );
        await fixture!.start();
        await _expectStatus(clientA.state, HttpStatus.unauthorized);
        await _expectStatus(clientB.events, HttpStatus.unauthorized);
        final rotated = _ValidationClient(fixture!.origin, secondToken);
        clients.add(rotated);
        final stateMessages = _messages(await rotated.state());
        final historyMessages = _messages(await rotated.history());
        for (final id in <String>[firstId, secondId, duplicateId, replyId]) {
          _expect(
            stateMessages.where((message) => message['id'] == id).length == 1,
            'Rotated client state lost or duplicated $id.',
          );
          _expect(
            historyMessages.where((message) => message['id'] == id).length == 1,
            'Rotated client history lost or duplicated $id.',
          );
        }
        final events = await rotated.events();
        _expect(
          (await events.next())['type'] == 'refresh',
          'Rotated client did not reconnect to SSE.',
        );
        await events.close();
      },
    );
  } catch (_) {
  } finally {
    for (final client in clients) {
      client.close();
    }
    for (final control in controls) {
      control.close();
    }
    try {
      processStopped = await fixture?.stop() ?? true;
    } catch (error) {
      checks.add(
        ValidationCheck(
          name: 'cleanup_process',
          status: 'failed',
          durationMs: 0,
          detail: '$error',
        ),
      );
    }
    try {
      await temporary.delete(recursive: true);
      disposableDataRemoved = !temporary.existsSync();
    } catch (error) {
      checks.add(
        ValidationCheck(
          name: 'cleanup_data',
          status: 'failed',
          durationMs: 0,
          detail: '$error',
        ),
      );
    }
  }

  final report = ValidationReport(
    checks: checks,
    processStopped: processStopped,
    disposableDataRemoved: disposableDataRemoved,
  );
  final output = File(outputPath).absolute;
  await output.parent.create(recursive: true);
  await output.writeAsString(
    '${const JsonEncoder.withIndent('  ').convert(report.toJson())}\n',
  );
  return report;
}

String _outputPath(List<String> arguments) {
  for (var index = 0; index < arguments.length; index++) {
    final argument = arguments[index];
    if (argument.startsWith('--output=')) {
      return argument.substring('--output='.length);
    }
    if (argument == '--output' && index + 1 < arguments.length) {
      return arguments[index + 1];
    }
  }
  return '${Directory.systemTemp.path}/nod-flutter-validation/result.json';
}

Future<void> main(List<String> arguments) async {
  final outputPath = _outputPath(arguments);
  final report = await runValidation(outputPath: outputPath);
  stdout.writeln('Nod Flutter validation: ${report.passed ? 'PASS' : 'FAIL'}');
  stdout.writeln('Result: ${File(outputPath).absolute.path}');
  stdout.writeln('Limitations: ${report.limitations.join(' ')}');
  if (!report.passed) exitCode = 1;
}
