import '../core/api_transport.dart';
import '../core/nod_errors.dart';
import '../core/settings.dart';

class NodOnboardingRepository {
  const NodOnboardingRepository(this.transport);
  final NodApiTransport transport;

  Future<Map<String, Object?>> session() async =>
      settingsMap(await transport.requestJson('GET', '/api/session'));

  Future<void> prepare() async {
    final result = settingsMap(
      await transport.requestJson('POST', '/api/account/prepare', body: {}),
    );
    if (result['ok'] != true) throw const NodProtocolException();
  }

  Future<void> saveProfile(Map<String, Object?> profile) async {
    await transport.requestJson(
      'POST',
      '/api/onboarding/profile',
      body: profile,
    );
  }

  Future<void> discoverIdeas() async {
    final accounts = await transport.requestJson('GET', '/api/apps');
    if (accounts is! List) throw const NodProtocolException();
    if (accounts
        .map(settingsMap)
        .any(
          (account) =>
              const ['gmail', 'outlook'].contains(account['slug']) &&
              account['status'] == 'connected' &&
              account['connectionId'] != null &&
              account['accountId'] != null &&
              account['disconnectPending'] != true,
        )) {
      await transport.requestJson(
        'POST',
        '/api/onboarding/suggestions',
        body: {},
      );
    }
  }

  Future<void> subscribe(String email, {required bool consent}) async {
    final current = await session();
    if (!consent ||
        settingsMap(current['capabilities'])['updatesEmail'] != true ||
        settingsMap(current['settings'])['usageData'] != true) {
      throw const NodForbiddenException();
    }
    await transport.requestJson(
      'POST',
      '/api/onboarding/updates-email',
      body: {'email': email.trim(), 'consent': true},
    );
  }

  Future<void> complete() async {
    final result = settingsMap(
      await transport.requestJson(
        'PATCH',
        '/api/account',
        body: {'onboardingCompleted': true},
      ),
    );
    if (settingsMap(result['settings'])['onboardingCompleted'] != true) {
      throw const NodProtocolException();
    }
  }
}
