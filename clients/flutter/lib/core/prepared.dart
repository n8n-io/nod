import 'nod_errors.dart';
import 'tasks.dart';

String? preparedIdFromLink(String? value) {
  final uri = Uri.tryParse(value ?? '');
  if (uri == null ||
      uri.hasScheme ||
      uri.hasAuthority ||
      uri.hasQuery ||
      uri.hasFragment) {
    return null;
  }
  final match = RegExp(
    r'^/prepared/([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})$',
  ).firstMatch(uri.path);
  return match?.group(1);
}

class NodPreparedSource {
  NodPreparedSource.fromJson(Map<String, dynamic> json)
    : sourceId = taskText(json, 'sourceId'),
      id = taskText(json, 'id'),
      version = taskText(json, 'version'),
      label = taskText(json, 'label'),
      checkedAt = taskText(json, 'checkedAt'),
      url = taskOptionalText(json, 'url');
  final String sourceId, id, version, label, checkedAt;
  final String? url;
  Uri? get externalUri {
    final uri = Uri.tryParse(url ?? '');
    return uri != null &&
            uri.scheme == 'https' &&
            uri.host.isNotEmpty &&
            uri.userInfo.isEmpty
        ? uri
        : null;
  }
}

class NodPreparedWork {
  NodPreparedWork.fromJson(Map<String, dynamic> json)
    : id = taskText(json, 'id'),
      title = taskText(json, 'title'),
      draft = taskText(json, 'draft'),
      state = taskText(json, 'state'),
      updatedAt = taskText(json, 'updatedAt'),
      unknowns = taskStrings(json['unknowns']),
      sources = (json['sources'] as List)
          .map((item) => NodPreparedSource.fromJson(taskMap(item)))
          .toList() {
    if (!['open', 'offered', 'resolved', 'dismissed'].contains(state)) {
      throw const NodProtocolException();
    }
  }
  final String id, title, draft, state, updatedAt;
  final List<String> unknowns;
  final List<NodPreparedSource> sources;
}

class NodPreparedFinding {
  const NodPreparedFinding({required this.id, required this.text});
  final String id, text;
}
