class NodAppConnection {
  const NodAppConnection({
    required this.slug,
    required this.name,
    required this.status,
    this.connectionId,
    this.account,
    this.description,
    this.broker = false,
    this.hasAccessPaths = false,
  });

  final String slug;
  final String name;
  final String status;
  final String? connectionId;
  final String? account;
  final String? description;
  final bool broker;
  final bool hasAccessPaths;
}

class NodAppSignIn {
  const NodAppSignIn({required this.url, required this.hash});

  final Uri url;
  final String hash;
}

enum NodAppSignInStatus { waiting, connected, unavailable }

abstract interface class NodAppsRepository {
  Future<List<NodAppConnection>> loadApps({bool catalog = false});
  Future<NodAppSignIn> startAppSignIn(NodAppConnection app);
  Future<NodAppSignInStatus> appSignInStatus(NodAppSignIn signIn);
  Future<void> cancelAppSignIn(NodAppSignIn signIn);
}
