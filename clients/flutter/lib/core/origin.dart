import 'dart:io';

import 'nod_errors.dart';

Uri validateNodOrigin(Uri value) {
  final uri = Uri.tryParse(value.toString().trim());
  if (uri == null ||
      !uri.hasScheme ||
      uri.host.isEmpty ||
      uri.userInfo.isNotEmpty ||
      uri.hasQuery ||
      uri.hasFragment ||
      (uri.path.isNotEmpty && uri.path != '/')) {
    throw const NodOriginException();
  }
  final scheme = uri.scheme.toLowerCase();
  if (scheme != 'https' && !(scheme == 'http' && _isLoopback(uri.host))) {
    throw const NodOriginException();
  }
  return Uri(
    scheme: scheme,
    host: uri.host,
    port: uri.hasPort ? uri.port : null,
  );
}

bool _isLoopback(String host) {
  if (host.toLowerCase() == 'localhost') return true;
  return InternetAddress.tryParse(host)?.isLoopback ?? false;
}
