import 'dart:math' as math;

import 'package:flutter/material.dart';
import 'package:url_launcher/url_launcher.dart';

import '../../core/attachments.dart';
import '../../core/rich_results.dart' as models;
import '../chat/attachment_view.dart';

class NodRichResult extends StatelessWidget {
  const NodRichResult({
    required this.result,
    this.artifacts = const [],
    this.repository,
    this.onOpenApps,
    super.key,
  });
  final models.NodRichResult result;
  final List<NodArtifact> artifacts;
  final NodAttachmentsRepository? repository;
  final VoidCallback? onOpenApps;

  @override
  Widget build(BuildContext context) {
    final Map<String, Object?> data = result.data;
    return Card(
      margin: const EdgeInsets.symmetric(vertical: 8),
      child: Padding(
        padding: const EdgeInsets.all(12),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(result.title, style: Theme.of(context).textTheme.titleMedium),
            if (data['caption'] is String) Text(data['caption']! as String),
            if (result.type == 'apps') ...[
              for (final service in (data['services'] as List? ?? []))
                Text(service.toString()),
              TextButton(
                onPressed: onOpenApps,
                child: const Text('Connect in Apps'),
              ),
            ] else if (result.type == 'chart') ...[
              if (_series(data).isNotEmpty)
                SizedBox(
                  height: 160,
                  width: double.infinity,
                  child: CustomPaint(
                    painter: _ChartPainter(
                      data,
                      Theme.of(context).colorScheme.primary,
                    ),
                  ),
                ),
              ..._details(
                context,
                data,
                skip: const {
                  'version',
                  'type',
                  'title',
                  'caption',
                  'sources',
                  'asOf',
                  'chart',
                },
              ),
            ] else if (result.type == 'map') ...[
              for (final place
                  in (data['places'] as List? ?? [])
                      .whereType<Map<Object?, Object?>>()) ...[
                ..._details(context, Map<String, Object?>.from(place)),
                if (place['latitude'] is num && place['longitude'] is num)
                  _link(
                    'Open map',
                    'https://www.openstreetmap.org/?mlat=${place['latitude']}&mlon=${place['longitude']}#map=15/${place['latitude']}/${place['longitude']}',
                  ),
                const Divider(),
              ],
            ] else
              ..._details(
                context,
                data,
                skip: const {
                  'version',
                  'type',
                  'title',
                  'caption',
                  'sources',
                  'asOf',
                },
              ),
            if (data['asOf'] is String) Text('As of ${data['asOf']}'),
            if (data['sources'] is List && (data['sources'] as List).isNotEmpty)
              ExpansionTile(
                title: const Text('Sources'),
                children: [
                  for (final source
                      in (data['sources'] as List)
                          .whereType<Map<Object?, Object?>>())
                    _link(source['label'].toString(), source['url'].toString()),
                ],
              ),
          ],
        ),
      ),
    );
  }

  List<Widget> _details(
    BuildContext context,
    Map<String, Object?> data, {
    Set<String> skip = const {},
  }) {
    return [
      for (final entry in data.entries)
        if (!skip.contains(entry.key) &&
            entry.key != 'id' &&
            entry.value != null)
          ..._field(context, entry.key, entry.value),
    ];
  }

  List<Widget> _field(BuildContext context, String key, Object? value) {
    final label = key.replaceAllMapped(
      RegExp('[A-Z]'),
      (m) => ' ${m[0]!.toLowerCase()}',
    );
    if (key == 'artifactId') {
      final artifact = artifacts.where((item) => item.id == value).firstOrNull;
      return [
        if (artifact != null && repository != null)
          AttachmentTile(artifact: artifact, repository: repository!),
      ];
    }
    if (value is Map<Object?, Object?>) {
      return [
        Padding(
          padding: const EdgeInsets.only(top: 8),
          child: Text(label, style: Theme.of(context).textTheme.labelLarge),
        ),
        ..._details(context, Map<String, Object?>.from(value)),
      ];
    }
    if (value is List) {
      return [
        for (final item in value)
          if (item is Map<Object?, Object?>)
            Padding(
              padding: const EdgeInsets.only(left: 8, top: 8),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: _details(context, Map<String, Object?>.from(item)),
              ),
            )
          else if (item is List)
            Wrap(
              spacing: 8,
              children: [
                for (final seat in item)
                  if (seat is Map<Object?, Object?>)
                    Chip(
                      label: Text(
                        '${seat['label']}: ${seat['status']}${seat['price'] == null ? '' : ' · ${seat['price']}'}${seat['note'] == null ? '' : ' · ${seat['note']}'}',
                      ),
                    )
                  else
                    const Text('Empty position'),
              ],
            )
          else
            Text('$label: ${item ?? 'Empty position'}'),
      ];
    }
    if (key == 'url') return [_link('Open website', value.toString())];
    return [SelectableText('$label: $value')];
  }

  Widget _link(String label, String href) {
    final uri = Uri.tryParse(href);
    if (uri == null ||
        uri.scheme != 'https' ||
        uri.host.isEmpty ||
        uri.userInfo.isNotEmpty) {
      return Text(label);
    }
    return TextButton(
      onPressed: () async {
        try {
          await launchUrl(uri, mode: LaunchMode.externalApplication);
        } catch (_) {}
      },
      child: Text(label),
    );
  }
}

List<Map<Object?, Object?>> _series(Map<Object?, Object?> data) =>
    (data['series'] as List? ?? []).whereType<Map<Object?, Object?>>().toList();

class _ChartPainter extends CustomPainter {
  _ChartPainter(this.data, this.color);
  final Map<String, Object?> data;
  final Color color;

  @override
  void paint(Canvas canvas, Size size) {
    final series = _series(data);
    final points = series
        .map(
          (s) => (s['points'] as List? ?? [])
              .whereType<Map<Object?, Object?>>()
              .where((p) => p['value'] is num && (p['value'] as num).isFinite)
              .toList(),
        )
        .toList();
    final values = points
        .expand((p) => p)
        .map((p) => (p['value'] as num).toDouble())
        .toList();
    if (values.isEmpty) return;
    final min = math.min(0.0, values.reduce(math.min));
    final max = math.max(0.0, values.reduce(math.max));
    final range = max == min ? 1.0 : max - min;
    final paint = Paint()..color = color;
    if (data['chart'] == 'pie' || data['chart'] == 'donut') {
      final total = values.fold(0.0, (a, b) => a + math.max(0, b));
      if (total <= 0) return;
      var angle = -math.pi / 2;
      for (var i = 0; i < values.length; i++) {
        final sweep = math.max(0, values[i]) / total * math.pi * 2;
        paint.color = HSLColor.fromColor(color)
            .withHue((i * 67.0) % 360)
            .toColor();
        paint.style = data['chart'] == 'donut'
            ? PaintingStyle.stroke
            : PaintingStyle.fill;
        paint.strokeWidth = 24;
        canvas.drawArc(
          Rect.fromCircle(
            center: size.center(Offset.zero),
            radius: size.height / 2 - 16,
          ),
          angle,
          sweep,
          data['chart'] != 'donut',
          paint,
        );
        angle += sweep;
      }
      return;
    }
    final count = points.map((p) => p.length).reduce(math.max);
    for (var s = 0; s < points.length; s++) {
      paint.color = HSLColor.fromColor(color)
          .withHue((HSLColor.fromColor(color).hue + s * 67) % 360)
          .toColor();
      final path = Path();
      for (var i = 0; i < points[s].length; i++) {
        final value = (points[s][i]['value'] as num).toDouble();
        final x = (i + 0.5) * size.width / count;
        final y = size.height * (1 - (value - min) / range);
        if (data['chart'] == 'line') {
          if (i == 0) {
            path.moveTo(x, y);
          } else {
            path.lineTo(x, y);
          }
          canvas.drawCircle(Offset(x, y), 3, paint);
        } else {
          final width = size.width / count / (points.length + 1);
          final zero = size.height * (1 + min / range);
          canvas.drawRect(
            Rect.fromLTRB(
              x + (s - points.length / 2) * width,
              math.min(y, zero),
              x + (s - points.length / 2 + 0.8) * width,
              math.max(y, zero),
            ),
            paint,
          );
        }
      }
      if (data['chart'] == 'line') {
        canvas.drawPath(
          path,
          paint
            ..style = PaintingStyle.stroke
            ..strokeWidth = 2,
        );
      }
      paint.style = PaintingStyle.fill;
    }
  }

  @override
  bool shouldRepaint(_ChartPainter oldDelegate) =>
      oldDelegate.data != data || oldDelegate.color != color;
}
