import 'package:flutter/material.dart';
import 'package:flutter_markdown_plus/flutter_markdown_plus.dart';
import 'package:url_launcher/url_launcher.dart';

import '../../core/api_transport.dart';
import '../../core/prepared.dart';
import '../prepared/prepared_page.dart';

class TaskText extends StatelessWidget {
  const TaskText({required this.text, required this.transport, super.key});
  final String text;
  final NodApiTransport transport;

  @override
  Widget build(BuildContext context) => MarkdownBody(
    data: text,
    selectable: true,
    imageBuilder: (uri, title, alt) => Text(alt ?? 'Image'),
    onTapLink: (label, href, title) async {
      final id = preparedIdFromLink(href);
      if (id != null) {
        await Navigator.of(context).push<void>(
          MaterialPageRoute(
            builder: (_) => Scaffold(
              appBar: AppBar(title: const Text('Prepared work')),
              body: NodPreparedPage(transport: transport, issueId: id),
            ),
          ),
        );
        return;
      }
      final uri = Uri.tryParse(href ?? '');
      var opened = false;
      if (uri != null &&
          uri.scheme == 'https' &&
          uri.host.isNotEmpty &&
          uri.userInfo.isEmpty) {
        try {
          opened = await launchUrl(uri, mode: LaunchMode.externalApplication);
        } catch (_) {}
      }
      if (!opened && context.mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          const SnackBar(
            content: Text(
              'Could not open this link. Open the original message in chat for files.',
            ),
          ),
        );
      }
    },
  );
}
