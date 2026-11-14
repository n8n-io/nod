import 'dart:convert';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:nod_client/api/http_nod_repository.dart';
import 'package:nod_client/api/private_requests_repository.dart';
import 'package:nod_client/core/core.dart';
import 'package:nod_client/core/private_requests.dart';

void main() {
  test('authenticated HTTP private lifecycle refuses replacement and submits only the bound new request', () async {
    final server = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
    final origin = Uri.parse('http://127.0.0.1:${server.port}');
    const bearer = 'synthetic-private-route-token';
    const old = NodPrivateRequestRef(
      kind: NodPrivateRequestKind.credential,
      id: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
    );
    const current = NodPrivateRequestRef(
      kind: NodPrivateRequestKind.credential,
      id: 'BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB',
    );
    var replaced = false;
    var consumed = false;
    var privatePosts = 0;
    final addresses = <Uri>[];
    final resumed = <String>[];
    server.listen((request) async {
      addresses.add(request.uri);
      final response = request.response;
      response.headers.contentType = ContentType.json;
      if (request.headers.value(HttpHeaders.authorizationHeader) !=
          'Bearer $bearer') {
        response.statusCode = 401;
        await response.close();
        return;
      }
      final path = request.uri.path;
      Object data;
      if (path == '/api/client/capabilities') {
        data = {
          'contractVersion': 1,
          'authentication': {'mode': 'bearer'},
        };
      } else if (path == '/api/session') {
        data = {
          'user': {'id': 'synthetic-owner'},
        };
      } else if (path == '/api/events') {
        response.headers.contentType = ContentType('text', 'event-stream');
        response.write(': ready\n\n');
        await response.flush();
        return;
      } else if (path == '/api/state') {
        data = {
          'threadId': 'synthetic-thread',
          'messages': <Object?>[],
          'turns': <Object?>[],
        };
      } else if (path == '${old.path}/flow') {
        data = replaced ? {'nextId': current.id} : <String, Object?>{};
      } else if (path == old.path || path == current.path) {
        final stale = path == old.path && replaced;
        if (request.method == 'POST') {
          privatePosts++;
          if (stale || consumed) {
            response.statusCode = 409;
            data = {'error': 'Synthetic request already closed'};
          } else {
            final body =
                jsonDecode(await utf8.decoder.bind(request).join()) as Map;
            expect(body.keys, ['code']);
            consumed = true;
            resumed.add('synthetic-background-turn');
            data = {'ok': true};
          }
        } else {
          data = {
            'id': path.split('/').last,
            'origin': 'https://login.example',
            'turnId': 'synthetic-background-turn',
            'kind': 'otp',
            'status': stale
                ? 'expired'
                : consumed
                ? 'filled'
                : 'pending',
          };
        }
      } else {
        response.statusCode = 404;
        data = {'error': 'Synthetic route missing'};
      }
      response.write(jsonEncode(data));
      await response.close();
    });
    final http = HttpNodRepository(credentials: RouteCredentials());
    addTearDown(() async {
      await http.dispose();
      await server.close(force: true);
    });
    await http.connect(NodConnectionConfig(origin: origin, token: bearer));
    final repository = NodPrivateRequestsRepository(http);
    final oldDetails = await repository.read(old);
    replaced = true;
    await expectLater(
      repository.submit(oldDetails, {
        'code': List.generate(6, (index) => '$index').join(),
      }),
      throwsStateError,
    );
    expect(privatePosts, 0);
    final replacement = await repository.next(await repository.read(old));
    expect(replacement?.id, current.id);
    final currentDetails = await repository.read(replacement!);
    await repository.submit(currentDetails, {
      'code': List.generate(6, (index) => '$index').join(),
    });
    expect(privatePosts, 1);
    expect(resumed, ['synthetic-background-turn']);
    expect((await repository.read(current)).status, 'filled');
    expect(
      addresses.every((uri) => !uri.hasQuery && !uri.hasAuthority),
      isTrue,
    );
    expect(addresses.any((uri) => uri.path == '/api/messages'), isFalse);
  });
}

final class RouteCredentials implements NodCredentialStorage {
  @override
  Future<void> delete() async {}
  @override
  Future<NodConnectionConfig?> read() async => null;
  @override
  Future<void> write(NodConnectionConfig config) async {}
}
