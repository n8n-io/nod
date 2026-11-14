enum NodPrivateRequestKind { credential, payment, browser }

abstract interface class NodPrivateBrowserTransport {
  Stream<List<int>> browserHandoffFrames(String turnId);
}

final class NodPrivateRequestRef {
  const NodPrivateRequestRef({required this.kind, required this.id});

  final NodPrivateRequestKind kind;
  final String id;

  static final _credential = RegExp(r'^[A-Za-z0-9_-]{43}$');
  static final _uuid = RegExp(
    r'^[a-fA-F0-9]{8}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{12}$',
  );

  bool get isValid => kind == NodPrivateRequestKind.credential
      ? _credential.hasMatch(id)
      : _uuid.hasMatch(id);

  static NodPrivateRequestRef? fromLink(String link) {
    if (link.startsWith('<') && link.endsWith('>')) {
      link = link.substring(1, link.length - 1);
    }
    final uri = Uri.tryParse(link);
    if (uri == null ||
        uri.hasScheme ||
        uri.hasAuthority ||
        uri.hasQuery ||
        uri.hasFragment) {
      return null;
    }
    final match = RegExp(r'^/(vault|credentials|payments)/([A-Za-z0-9_-]+)/?$')
        .firstMatch(uri.path);
    if (match == null) return null;
    final value = NodPrivateRequestRef(
      kind: match[1] == 'payments'
          ? NodPrivateRequestKind.payment
          : NodPrivateRequestKind.credential,
      id: match[2]!,
    );
    return value.isValid ? value : null;
  }

  String get path {
    if (!isValid || kind == NodPrivateRequestKind.browser) {
      throw StateError('Invalid private request.');
    }
    return '/api/${kind == NodPrivateRequestKind.payment ? 'payment' : 'credential'}-requests/$id';
  }

  String get title => switch (kind) {
    NodPrivateRequestKind.credential => 'Private sign-in',
    NodPrivateRequestKind.payment => 'Approve payment',
    NodPrivateRequestKind.browser => 'Open browser',
  };
}

Map<String, Object?> privateObject(Object? value) {
  if (value is! Map<String, Object?>) {
    throw const FormatException('Private request unavailable.');
  }
  return value;
}

final class NodPrivateDetails {
  NodPrivateDetails(this.ref, this.data, this.status);

  final NodPrivateRequestRef ref;
  final Map<String, Object?> data;
  final String status;

  bool get pending => status == 'pending';
  bool get payment => ref.kind == NodPrivateRequestKind.payment;
  String get kind => data['kind'] as String? ?? '';
  String get origin => data['origin'] as String? ?? '';
  List<Map<String, Object?>> get methods => _objects('methods');
  List<Map<String, Object?>> get savedEntries => _objects('savedEntries');
  List<Map<String, Object?>> _objects(String key) =>
      (data[key] as List? ?? []).map(privateObject).toList();

  String fieldLabel(String kind, String fallback) {
    for (final field in _objects('fields')) {
      if (field['kind'] == kind && field['label'] is String) {
        return field['label']! as String;
      }
    }
    return fallback;
  }
}
