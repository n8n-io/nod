import 'package:flutter_test/flutter_test.dart';
import 'package:nod_client/core/core.dart';

void main() {
  group('validateNodOrigin', () {
    test('accepts HTTPS and loopback development origins', () {
      expect(
        validateNodOrigin(Uri.parse('https://nod.example.test/')).toString(),
        'https://nod.example.test',
      );
      expect(
        validateNodOrigin(Uri.parse('http://localhost:3000')).toString(),
        'http://localhost:3000',
      );
      expect(
        validateNodOrigin(Uri.parse('http://127.0.0.1:3000')).host,
        '127.0.0.1',
      );
      expect(validateNodOrigin(Uri.parse('http://[::1]:3000')).host, '::1');
    });

    test('rejects insecure remote and non-origin addresses', () {
      for (final value in [
        'http://nod.example.test',
        'https://user@nod.example.test',
        'https://nod.example.test/path',
        'https://nod.example.test?token=value',
      ]) {
        expect(
          () => validateNodOrigin(Uri.parse(value)),
          throwsA(isA<NodOriginException>()),
        );
      }
    });
  });

  test('connection config diagnostics redact the token', () {
    const token = 'never-print-this-token';
    final config = NodConnectionConfig(
      origin: Uri.parse('https://nod.example.test'),
      token: token,
    );

    expect(config.toString(), isNot(contains(token)));
    expect(config.toString(), contains('[redacted]'));
  });
}
