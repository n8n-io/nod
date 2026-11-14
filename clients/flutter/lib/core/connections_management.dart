class NodManagedConnection {
  NodManagedConnection.fromJson(Map<String, Object?> json)
    : slug = json['slug'] as String,
      name = json['name'] as String,
      status = json['status'] as String,
      id = json['connectionId'] as String?,
      account =
          json['accountEmail'] as String? ?? json['accountName'] as String?,
      canReconnect = json['canReconnect'] == true,
      disconnectPending = json['disconnectPending'] == true,
      paths = (json['accessPaths'] as List? ?? [])
          .map((value) => Map<String, Object?>.from(value as Map))
          .toList();

  final String slug;
  final String name;
  final String status;
  final String? id;
  final String? account;
  final bool canReconnect;
  final bool disconnectPending;
  final List<Map<String, Object?>> paths;
}

class NodConnectionDiscovery {
  NodConnectionDiscovery.fromJson(this.id, Map<String, Object?> json)
    : name = json['name'] as String,
      needsAddress = json['needsAddress'] == true,
      localAddress = json['localAddress'] as String?,
      status = json['oauthStatus'] as String?,
      authorizationUrl = json['authorizationUrl'] as String?,
      attempt = json['attempt'] as String?,
      callbackUrl = json['callbackUrl'] as String?,
      setupText = json['setupText'] as String?,
      setupUrl = json['setupUrl'] as String?,
      paths = (json['paths'] as List)
          .map((value) => Map<String, Object?>.from(value as Map))
          .toList();

  final String id;
  final String name;
  final bool needsAddress;
  final String? localAddress;
  final String? status;
  final String? authorizationUrl;
  final String? attempt;
  final String? callbackUrl;
  final String? setupText;
  final String? setupUrl;
  final List<Map<String, Object?>> paths;
}

class NodConnectionAttempt {
  const NodConnectionAttempt({this.discoveryId, this.url, this.attempt});

  final String? discoveryId;
  final Uri? url;
  final String? attempt;
}

enum NodConnectionProgress { waiting, connected, unavailable }

class NodChannelSetup {
  NodChannelSetup.fromJson(this.values);

  final Map<String, Object?> values;
  String get provider => values['provider'] as String;
  bool get managed => values['managed'] == true;
  bool get enabled => values['enabled'] == true;
  String? get mode => values['mode'] as String?;
}
