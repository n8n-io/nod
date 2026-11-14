import 'dart:async';
import 'dart:convert';
import 'dart:io';

final class ParityFixture {
  ParityFixture(this.directory, this.process, this.origin);
  final Directory directory;
  final Process process;
  final Uri origin;
  static const token = 'synthetic-native-token';
  static const controlToken = 'synthetic-native-control';

  static Future<ParityFixture> start() async {
    final directory = await Directory.systemTemp.createTemp(
      'nod-mobile-parity-',
    );
    final socket = await ServerSocket.bind(InternetAddress.loopbackIPv4, 0);
    final port = socket.port;
    await socket.close();
    final root = Directory.current.path.endsWith('/clients/flutter')
        ? Directory.current.parent.parent
        : Directory.current;
    Process? process;
    try {
      process = await Process.start(
        '${root.path}/node_modules/.bin/tsx',
        ['clients/flutter/tool/validation_server.ts'],
        workingDirectory: root.path,
        environment: {
          'NOD_VALIDATION_PORT': '$port',
          'NOD_VALIDATION_TOKEN': token,
          'NOD_VALIDATION_CONTROL_TOKEN': controlToken,
          'NOD_VALIDATION_DATA': '${directory.path}/state.json',
        },
      );
      final ready = Completer<void>();
      process.stdout
          .transform(utf8.decoder)
          .transform(const LineSplitter())
          .listen((line) {
            if (line == '{"ready":true}' && !ready.isCompleted) {
              ready.complete();
            }
          });
      unawaited(process.stderr.drain<void>());
      unawaited(
        process.exitCode.then((code) {
          if (!ready.isCompleted) {
            ready.completeError(StateError('Synthetic fixture exited: $code'));
          }
        }),
      );
      await ready.future.timeout(const Duration(seconds: 15));
      return ParityFixture(
        directory,
        process,
        Uri.parse('http://127.0.0.1:$port'),
      );
    } catch (_) {
      process?.kill();
      if (process != null) await process.exitCode;
      await directory.delete(recursive: true);
      rethrow;
    }
  }

  Future<void> close() async {
    process.kill();
    await process.exitCode.timeout(const Duration(seconds: 10));
    await directory.delete(recursive: true);
  }
}
