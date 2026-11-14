import 'package:flutter/material.dart';
import 'package:flutter_markdown_plus/flutter_markdown_plus.dart';
import 'package:url_launcher/url_launcher.dart';

import '../../design_system/design_system.dart';

class AgentMessageBody extends StatefulWidget {
  const AgentMessageBody({
    required this.text,
    this.streaming = false,
    this.active = true,
    this.onArtifactLink,
    super.key,
  });

  final String text;
  final bool streaming;
  final bool active;
  final bool Function(String href, String label)? onArtifactLink;

  @override
  State<AgentMessageBody> createState() => _AgentMessageBodyState();
}

class _AgentMessageBodyState extends State<AgentMessageBody>
    with SingleTickerProviderStateMixin {
  late final _ticker = createTicker(_tick);
  late String _visible;
  bool _enabled = false;
  Duration _lastTick = Duration.zero;
  int _batch = 0;

  @override
  void initState() {
    super.initState();
    _visible = widget.streaming
        ? widget.text.characters.take(4).toString()
        : widget.text;
  }

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    _enabled =
        !MediaQuery.disableAnimationsOf(context) &&
        TickerMode.valuesOf(context).enabled;
    _sync();
  }

  @override
  void didUpdateWidget(AgentMessageBody oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (!widget.text.startsWith(_visible)) {
      _visible = widget.text;
    }
    _sync();
  }

  void _sync() {
    if (!_enabled || !widget.streaming || !widget.active) {
      _visible = widget.text;
    }
    if (_visible == widget.text) {
      _ticker.stop();
    } else if (!_ticker.isActive) {
      _lastTick = Duration.zero;
      _ticker.start();
    }
  }

  void _tick(Duration elapsed) {
    if (elapsed - _lastTick < const Duration(milliseconds: 32)) {
      return;
    }
    _lastTick = elapsed;
    final remaining = widget.text.substring(_visible.length).characters;
    final batch = (_batch++).isEven ? 4 : 3;
    final count = remaining.length > 64
        ? ((remaining.length / 16).ceil()).clamp(batch, 64)
        : batch;
    setState(() {
      _visible += remaining.take(count).toString();
    });
    if (_visible == widget.text) {
      _ticker.stop();
    }
  }

  @override
  void dispose() {
    _ticker.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final colors = theme.colorScheme;
    final body = theme.textTheme.bodyLarge!;
    final heading = body.copyWith(fontWeight: FontWeight.w600, height: 1.3);
    return MarkdownBody(
      data: _visible,
      selectable: true,
      fitContent: false,
      styleSheet: MarkdownStyleSheet.fromTheme(theme).copyWith(
        p: body,
        h1: heading.copyWith(fontSize: 24),
        h2: heading.copyWith(fontSize: 21),
        h3: heading.copyWith(fontSize: 18),
        h4: heading,
        h5: heading,
        h6: heading,
        blockSpacing: NodSpacing.md,
        listIndent: 24,
        listBullet: body,
        a: body.copyWith(
          color: colors.onSurface,
          decoration: TextDecoration.underline,
          decorationColor: colors.onSurface,
        ),
        code: theme.textTheme.bodyMedium!.copyWith(
          fontFamily: 'monospace',
          backgroundColor: colors.surfaceContainerHigh,
        ),
        codeblockPadding: const EdgeInsets.all(NodSpacing.md),
        codeblockDecoration: BoxDecoration(
          color: colors.surfaceContainerHigh,
          borderRadius: BorderRadius.circular(NodRadii.control),
        ),
        blockquote: body.copyWith(color: colors.onSurfaceVariant),
        blockquotePadding: const EdgeInsets.all(NodSpacing.md),
        blockquoteDecoration: BoxDecoration(
          color: colors.surfaceContainerLow,
          borderRadius: BorderRadius.circular(NodRadii.control),
        ),
        tableHead: body.copyWith(fontWeight: FontWeight.w600),
        tableBody: theme.textTheme.bodyMedium,
        tableColumnWidth: const IntrinsicColumnWidth(),
        tableCellsPadding: const EdgeInsets.all(NodSpacing.sm),
        tableBorder: TableBorder.all(color: colors.outlineVariant),
        horizontalRuleDecoration: BoxDecoration(
          border: Border(top: BorderSide(color: colors.outlineVariant)),
        ),
      ),
      imageBuilder: (uri, title, alt) => Text(
        alt?.isNotEmpty == true ? alt! : 'Image',
        style: body.copyWith(color: colors.onSurfaceVariant),
      ),
      onTapLink: (label, href, title) => _openLink(context, href, label),
    );
  }

  Future<void> _openLink(
    BuildContext context,
    String? href,
    String label,
  ) async {
    if (href != null && widget.onArtifactLink?.call(href, label) == true) {
      return;
    }
    final uri = Uri.tryParse(href ?? '');
    if (uri == null ||
        !const {'https', 'http'}.contains(uri.scheme) ||
        uri.host.isEmpty) {
      return;
    }
    var opened = false;
    try {
      opened = await launchUrl(uri, mode: LaunchMode.externalApplication);
    } catch (_) {
      opened = false;
    }
    if (!opened && context.mounted) {
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(content: Text('Could not open this link.')),
      );
    }
  }
}
