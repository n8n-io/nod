import 'nod_errors.dart';
import 'origin.dart';
import 'private_requests.dart';
import 'settings.dart';

const nodProfileScopes = {
  'work': 'Mostly work',
  'personal': 'Mostly personal life',
  'both': 'Both',
};
const nodProfileRoles = {
  'owner': 'I run my own business',
  'freelance': 'Freelance or consulting',
  'agency': 'Agency',
  'engineering': 'Engineering',
  'product': 'Product or design',
  'gtm': 'Sales, marketing or ops',
  'manager': 'Manager or executive',
  'student': 'Student',
  'not_working': 'Not working right now',
};
const nodProfileWhoFor = {
  'me': 'For me',
  'clients': 'For my clients',
  'both': 'Both',
};
const nodProfileSizes = {
  'solo': 'Just me',
  '2_10': '2–10',
  '11_100': '11–100',
  '101_1000': '101–1,000',
  '1000_plus': '1,000+',
};
const nodProfileJobs = {
  'email': 'Stay on top of email and Slack',
  'calendar': 'Manage my calendar',
  'meetings': 'Prep my meetings and day',
  'errands': 'Handle bookings and errands online',
  'research': 'Research things for me',
  'routines': 'Take care of recurring tasks',
};

bool nodOnboardingModelReady(Map<String, Object?> models) {
  if (models['selection'] == null) return false;
  final selection = settingsMap(models['selection']);
  return settingsRows(models['connections']).any(
    (connection) =>
        connection['id'] == selection['connectionId'] &&
        connection['status'] == 'connected' &&
        settingsRows(connection['models']).any(
          (model) =>
              model['id'] == selection['modelId'] &&
              model['efforts'] is List &&
              (model['efforts'] as List).contains(selection['effort']),
        ),
  );
}

enum NodMobileDestination {
  chat,
  tasks,
  prepared,
  credentials,
  payment,
  browser,
  apps,
  channels,
  usage,
  vault,
  settings,
  notifications,
  models,
  voice,
  memory,
  privacy,
}

bool nodMobileLinkTextIsSafe(String value) =>
    value.isNotEmpty &&
    !RegExp(r'[\x00-\x20\x7f%\\]').hasMatch(value) &&
    !value.split('/').any((part) => part == '.' || part == '..');

class NodMobileRoute {
  const NodMobileRoute(this.destination, {this.id});
  final NodMobileDestination destination;
  final String? id;

  static NodMobileRoute? parse(
    String value, {
    required Uri pairedOrigin,
    required bool authenticated,
  }) {
    if (!authenticated || !nodMobileLinkTextIsSafe(value)) return null;
    final uri = Uri.tryParse(value);
    if (uri == null ||
        uri.userInfo.isNotEmpty ||
        uri.hasQuery ||
        uri.hasFragment) {
      return null;
    }
    final custom = uri.scheme == 'nod';
    try {
      final origin = validateNodOrigin(pairedOrigin);
      if (custom) {
        if (!value.startsWith('nod://open/') || uri.authority != 'open') {
          return null;
        }
      } else if (uri.hasScheme || uri.hasAuthority) {
        if (!uri.hasScheme || uri.origin != origin.origin) return null;
      } else if (!value.startsWith('/') || value.startsWith('//')) {
        return null;
      }
    } on NodOriginException {
      return null;
    } on StateError {
      return null;
    }
    switch (uri.path) {
      case '/':
        return const NodMobileRoute(NodMobileDestination.chat);
      case '/tasks':
        return const NodMobileRoute(NodMobileDestination.tasks);
      case '/apps':
        return const NodMobileRoute(NodMobileDestination.apps);
      case '/channels':
        return const NodMobileRoute(NodMobileDestination.channels);
      case '/usage':
        return const NodMobileRoute(NodMobileDestination.usage);
      case '/vault':
        return const NodMobileRoute(NodMobileDestination.vault);
      case '/settings':
        return const NodMobileRoute(NodMobileDestination.settings);
      case '/settings/notifications':
        return const NodMobileRoute(NodMobileDestination.notifications);
      case '/settings/models':
        return const NodMobileRoute(NodMobileDestination.models);
      case '/settings/voice':
        return const NodMobileRoute(NodMobileDestination.voice);
      case '/settings/memory':
        return const NodMobileRoute(NodMobileDestination.memory);
      case '/settings/privacy':
        return const NodMobileRoute(NodMobileDestination.privacy);
      case '/browser':
        return custom
            ? null
            : const NodMobileRoute(NodMobileDestination.browser);
    }
    final private = custom ? null : NodPrivateRequestRef.fromLink(uri.path);
    if (private != null) {
      return NodMobileRoute(
        private.kind == NodPrivateRequestKind.payment
            ? NodMobileDestination.payment
            : NodMobileDestination.credentials,
        id: private.id,
      );
    }
    final match = RegExp(
      r'^/prepared/([a-fA-F0-9]{8}(?:-[a-fA-F0-9]{4}){3}-[a-fA-F0-9]{12})$',
    ).firstMatch(uri.path);
    return match == null
        ? null
        : NodMobileRoute(NodMobileDestination.prepared, id: match[1]);
  }
}
