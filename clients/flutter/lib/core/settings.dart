import 'nod_errors.dart';

Map<String, Object?> settingsMap(Object? value) {
  if (value is! Map<String, Object?>) throw const NodProtocolException();
  return value;
}

List<Map<String, Object?>> settingsRows(Object? value) {
  if (value is! List) throw const NodProtocolException();
  return value.map(settingsMap).toList();
}

String settingsText(Map<String, Object?> value, String key) {
  final text = value[key];
  if (text is! String) throw const NodProtocolException();
  return text;
}

const memoryAreas = ['about', 'preferences', 'people', 'routines', 'lessons'];
const memoryLabels = [
  'About you',
  'Preferences',
  'People',
  'Routines',
  'Lessons',
];

class NodMemoryImportNote {
  const NodMemoryImportNote(this.area, this.text);
  final String area;
  final String text;
  Map<String, Object?> toJson() => {'area': area, 'text': text};
}

List<NodMemoryImportNote> parseNodMemoryImport(String text) {
  var area = 'about';
  final rows = <({NodMemoryImportNote note, bool bullet})>[];
  for (final row in text.split(RegExp(r'\r?\n'))) {
    final heading = RegExp(r'^#{1,6}\s+(.+?)[\s:#]*$').firstMatch(row);
    if (heading != null) {
      final name = heading[1]!.toLowerCase();
      final index = memoryLabels.indexWhere(
        (item) => item.toLowerCase() == name,
      );
      area = memoryAreas.contains(name)
          ? name
          : index < 0
          ? 'about'
          : memoryAreas[index];
      continue;
    }
    final bullet = RegExp(r'^(?:[-*•]|\d+[.)])\s+(.*\S)').firstMatch(row);
    final line = (bullet?[1] ?? row).replaceAll(RegExp(r'\s+'), ' ').trim();
    if (line.isNotEmpty && !line.startsWith('```') && line.length <= 4000) {
      rows.add((note: NodMemoryImportNote(area, line), bullet: bullet != null));
    }
  }
  final bullets = rows.any((row) => row.bullet);
  return rows
      .where((row) => row.bullet || !bullets)
      .map((row) => row.note)
      .toList();
}
