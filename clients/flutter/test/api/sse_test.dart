import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:nod_client/api/sse.dart';

void main() {
  test(
    'parses split CRLF frames and ignores keepalives and malformed lines',
    () async {
      final chunks = <List<int>>[
        utf8.encode(': keepalive\r'),
        utf8.encode('\nbogus\r\nevent: delta\r\ndata: {"type":"delta",\r\n'),
        utf8.encode('data: "text":"Hi"}\r\nid: event-1\r\n\r\n'),
        [255],
      ];

      final events = await Stream.fromIterable(chunks)
          .transform(const SseDecoder())
          .toList();

      expect(events, hasLength(1));
      expect(events.single.event, 'delta');
      expect(events.single.id, 'event-1');
      expect(events.single.data, '{"type":"delta",\n"text":"Hi"}');
    },
  );

  test('dispatches a final unterminated event and retry metadata', () async {
    final events = await Stream<List<int>>.value(
      utf8.encode('retry: 250\ndata: refresh'),
    ).transform(const SseDecoder()).toList();

    expect(events.single.data, 'refresh');
    expect(events.single.retry, const Duration(milliseconds: 250));
  });
}
