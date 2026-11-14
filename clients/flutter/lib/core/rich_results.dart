import 'dart:convert';

final class NodRichResult {
  NodRichResult._(this.data);

  final Map<String, Object?> data;
  String get type => data['type']! as String;
  String get title => data['title']! as String;

  static NodRichResult? parse(Object? value) {
    if (value is! Map<String, Object?> ||
        value['version'] != 1 ||
        value['title'] is! String ||
        (value['title']! as String).trim().isEmpty ||
        !const {
          'image',
          'apps',
          'map',
          'chart',
          'flights',
          'seats',
          'booking',
          'diagram',
        }.contains(value['type'])) {
      return null;
    }
    try {
      if (utf8.encode(jsonEncode(value)).length > 24 * 1024) return null;
      if (value['sources'] is! List) return null;
      final collection = switch (value['type']) {
        'chart' => 'series',
        'map' => 'places',
        'apps' => 'services',
        'flights' => 'options',
        'seats' => 'sections',
        'diagram' => 'nodes',
        'booking' => 'facts',
        _ => null,
      };
      if (collection != null && value[collection] is! List) return null;
      if (value['type'] == 'chart' &&
          (value['series'] as List).any(
            (s) => s is! Map || s['points'] is! List,
          )) {
        return null;
      }
      return NodRichResult._(Map.unmodifiable(value));
    } catch (_) {
      return null;
    }
  }
}

enum NodArtifactFormat { image, text, external }

NodArtifactFormat artifactFormat(String name, String mimeType) {
  final mime = mimeType.toLowerCase().split(';').first.trim();
  final extension = name.toLowerCase().split('.').last;
  if (const {'html', 'htm', 'svg', 'xml', 'xhtml'}.contains(extension) ||
      mime.contains('html') ||
      mime.contains('xml') ||
      mime == 'image/svg+xml') {
    return NodArtifactFormat.text;
  }
  if (const {
    'image/png',
    'image/jpeg',
    'image/webp',
    'image/gif',
    'image/bmp',
    'image/avif',
    'image/heic',
  }.contains(mime)) {
    return NodArtifactFormat.image;
  }
  if (mime.startsWith('text/') ||
      const {
        'application/json',
        'application/javascript',
        'application/yaml',
        'application/x-yaml',
        'application/sql',
      }.contains(mime) ||
      const {
        'md',
        'json',
        'csv',
        'tsv',
        'txt',
        'dart',
        'py',
        'js',
        'ts',
        'css',
        'yaml',
        'yml',
        'sql',
        'sh',
        'n8n',
      }.contains(extension)) {
    return NodArtifactFormat.text;
  }
  return NodArtifactFormat.external;
}
