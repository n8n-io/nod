import 'package:app_links/app_links.dart';

import 'onboarding.dart';

abstract interface class NodMobileLinkSource {
  Future<Uri?> initialUri();
  Stream<Uri> get uris;
}

class NodPlatformMobileLinkSource implements NodMobileLinkSource {
  NodPlatformMobileLinkSource({AppLinks? links}) : _links = links ?? AppLinks();

  final AppLinks _links;

  Uri? _uri(String? value) {
    if (value == null || !nodMobileLinkTextIsSafe(value)) return null;
    final uri = Uri.tryParse(value);
    if (uri == null ||
        uri.toString() != value ||
        uri.userInfo.isNotEmpty ||
        uri.hasQuery ||
        uri.hasFragment) {
      return null;
    }
    return uri;
  }

  @override
  Future<Uri?> initialUri() async => _uri(await _links.getInitialLinkString());

  @override
  Stream<Uri> get uris =>
      _links.stringLinkStream.map(_uri).where((uri) => uri != null).cast<Uri>();
}
