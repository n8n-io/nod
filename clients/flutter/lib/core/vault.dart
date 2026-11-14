Map<String, Object?> vaultObject(Object? value) =>
    Map<String, Object?>.from(value! as Map);

final class NodVaultItem {
  NodVaultItem(Object? value) : data = vaultObject(value) {
    if (!['login', 'card', 'session'].contains(kind) || id.isEmpty) {
      throw const FormatException('Unexpected Vault item.');
    }
  }

  final Map<String, Object?> data;
  String get id => data['id']! as String;
  String get kind => data['kind']! as String;
  String get label => data['label']! as String;
  String get origin => data['origin'] as String? ?? '';
  String get revision => data['updatedAt'] as String? ?? '';
  bool get session => kind == 'session';
  bool get card => kind == 'card';
  bool get unreadable => data['unreadable'] == true;
  String get identity =>
      data[card ? 'cardholder' : 'username'] as String? ?? '';
  String get subtitle =>
      card ? '${data['brand']} •••• ${data['last4']}' : origin;
  String get sessionState => switch (data['state']) {
    'saved' => 'Signed in',
    'pending' => 'Sign-in not finished',
    'needs_sign_in' => 'Sign-in needed',
    'disconnecting' => 'Signing out',
    _ => 'Unknown',
  };

  bool sameTarget(NodVaultItem other) =>
      id == other.id && kind == other.kind && origin == other.origin;
}

final class NodVaultActivity {
  NodVaultActivity(Object? value) : data = vaultObject(value);
  final Map<String, Object?> data;
  List<Map<String, Object?>> get entries =>
      (data['entries']! as List).map(vaultObject).toList();
  Map<String, Object?>? get next =>
      data['next'] == null ? null : vaultObject(data['next']);
  Map<String, Object?> get week => vaultObject(data['week']);
}

final class NodVaultImport {
  NodVaultImport(this.logins, this.skipped);
  final List<Map<String, Object?>> logins;
  final int skipped;

  void clear() {
    for (final login in logins) {
      login.clear();
    }
    logins.clear();
  }
}

NodVaultImport parseVaultCsv(String text) {
  final rows = <List<String>>[];
  var row = <String>[];
  var field = StringBuffer();
  var quoted = false;
  var start = true;
  text = text.replaceFirst(RegExp('^\uFEFF'), '');
  for (var i = 0; i < text.length; i++) {
    final char = text[i];
    if (quoted) {
      if (char != '"') {
        field.write(char);
      } else if (i + 1 < text.length && text[i + 1] == '"') {
        field.write('"');
        i++;
      } else {
        quoted = false;
      }
    } else if (char == '"' && start) {
      quoted = true;
      start = false;
    } else if (char == ',') {
      row.add(field.toString());
      field = StringBuffer();
      start = true;
    } else if (char == '\n' || char == '\r') {
      if (char == '\r' && i + 1 < text.length && text[i + 1] == '\n') i++;
      rows.add([...row, field.toString()]);
      row = [];
      field = StringBuffer();
      start = true;
    } else {
      field.write(char);
      start = false;
    }
  }
  if (quoted) throw const FormatException('Incomplete CSV field.');
  if (field.isNotEmpty || row.isNotEmpty) rows.add([...row, field.toString()]);
  rows.removeWhere((row) => row.every((value) => value.trim().isEmpty));
  final names = rows.isEmpty
      ? <String>[]
      : rows.removeAt(0).map((name) => name.trim().toLowerCase()).toList();
  int column(List<String> keys) {
    for (final key in keys) {
      final index = names.indexOf(key);
      if (index >= 0) return index;
    }
    return -1;
  }

  final url = column(['url', 'login_uri', 'website', 'login uri', 'web site']);
  final password = column(['password', 'login_password']);
  final username = column(['username', 'login_username', 'user name', 'login']);
  final email = column(['email', 'e-mail']);
  final label = column(['title', 'name']);
  final archived = column(['archived']);
  final authenticator = column(['otpauth', 'login_totp', 'totp']);
  if (url < 0 || password < 0) {
    throw const FormatException('Choose a password-manager CSV export.');
  }
  final logins = <Map<String, Object?>>[];
  final upgraded = <Map<String, Object?>>[];
  var skipped = 0;
  for (final row in rows) {
    String value(int index) =>
        index < 0 || index >= row.length ? '' : row[index];
    if (row.length != names.length) {
      skipped++;
      continue;
    }
    if (value(password).isEmpty ||
        value(archived).trim().toLowerCase() == 'true') {
      skipped++;
      continue;
    }
    Uri? origin;
    var secure = true;
    for (final address in value(url).split(RegExp(r'[\s,]+'))) {
      final parsed = Uri.tryParse(
        address.contains('://') ? address : 'https://$address',
      );
      if (parsed == null ||
          parsed.host.isEmpty ||
          !['http', 'https'].contains(parsed.scheme)) {
        continue;
      }
      final loopback = [
        'localhost',
        '127.0.0.1',
        '::1',
        '[::1]',
      ].contains(parsed.host);
      secure = parsed.scheme == 'https' || loopback;
      origin = Uri(
        scheme: parsed.scheme == 'http' && !loopback ? 'https' : parsed.scheme,
        host: parsed.host,
        port: parsed.hasPort ? parsed.port : null,
      );
      break;
    }
    if (origin == null) {
      skipped++;
      continue;
    }
    (secure ? logins : upgraded).add({
      'label': value(label).trim(),
      'origin': origin.origin,
      'username': value(username).trim().isNotEmpty
          ? value(username).trim()
          : value(email).trim(),
      'password': value(password),
      if (value(authenticator).trim().isNotEmpty)
        'authenticatorKey': value(authenticator).trim(),
    });
  }
  return NodVaultImport([...logins, ...upgraded], skipped);
}
