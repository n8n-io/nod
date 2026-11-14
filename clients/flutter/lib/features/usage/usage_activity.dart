import 'package:flutter/material.dart';

import '../../core/usage.dart';
import 'usage_summary.dart';

class UsageActivityTile extends StatelessWidget {
  const UsageActivityTile({required this.entry, super.key});
  final NodUsageEntry entry;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final colors = theme.colorScheme;
    final format = MaterialLocalizations.of(context);
    final local = entry.at.toLocal();
    final icon = switch (entry.source) {
      'schedule' => Icons.calendar_today_outlined,
      'check' => Icons.manage_search_rounded,
      'event' => Icons.bolt_outlined,
      'resume' => Icons.undo_rounded,
      _ => Icons.chat_bubble_outline_rounded,
    };
    final source = switch (entry.source) {
      'chat' => 'Chat',
      'task' => 'Task',
      'schedule' => 'Schedule',
      'event' => 'Background activity',
      'check' => 'Activity check',
      'resume' => 'Approved action',
      _ => 'Activity',
    };
    final cost = entry.costUsd != null
        ? usageMoney(entry.costUsd!)
        : entry.pricing == 'plan'
        ? 'Plan'
        : 'Unpriced';
    return ExpansionTile(
      tilePadding: const EdgeInsets.symmetric(vertical: 8),
      childrenPadding: const EdgeInsets.only(left: 8, right: 8, bottom: 16),
      leading: Container(
        width: 36,
        height: 36,
        decoration: BoxDecoration(
          color: colors.surfaceContainerHigh,
          borderRadius: BorderRadius.circular(10),
        ),
        child: Icon(
          entry.error == null ? icon : Icons.error_outline,
          size: 18,
          color: entry.error == null ? colors.onSurfaceVariant : colors.error,
        ),
      ),
      title: LayoutBuilder(
        builder: (context, constraints) => Wrap(
          alignment: WrapAlignment.spaceBetween,
          crossAxisAlignment: WrapCrossAlignment.center,
          spacing: 8,
          runSpacing: 6,
          children: [
            ConstrainedBox(
              constraints: BoxConstraints(maxWidth: constraints.maxWidth),
              child: Text(entry.title, style: theme.textTheme.titleSmall),
            ),
            Text(
              cost,
              style: theme.textTheme.labelLarge?.copyWith(
                color: entry.costUsd == null
                    ? colors.onSurfaceVariant
                    : colors.onSurface,
              ),
            ),
          ],
        ),
      ),
      subtitle: Padding(
        padding: const EdgeInsets.only(top: 6),
        child: Text(
          '${format.formatMediumDate(local)} · ${format.formatTimeOfDay(TimeOfDay.fromDateTime(local))} · $source${entry.error == null ? '' : ' · Failed'}',
          style: theme.textTheme.bodySmall?.copyWith(
            color: colors.onSurfaceVariant,
          ),
        ),
      ),
      children: [
        Align(
          alignment: Alignment.centerLeft,
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              if (entry.costUsd == null)
                Padding(
                  padding: const EdgeInsets.only(bottom: 8),
                  child: Text(
                    entry.pricing == 'plan'
                        ? 'Included in ChatGPT plan'
                        : 'Price unavailable',
                  ),
                ),
              if (entry.models.isNotEmpty) ...[
                Text('Models used', style: theme.textTheme.labelLarge),
                const SizedBox(height: 6),
                for (final model in entry.models)
                  Padding(
                    padding: const EdgeInsets.only(bottom: 6),
                    child: Text(
                      model,
                      style: theme.textTheme.bodySmall?.copyWith(
                        color: colors.onSurfaceVariant,
                      ),
                    ),
                  ),
              ],
              if (entry.actions.isNotEmpty) ...[
                const SizedBox(height: 8),
                Text(
                  'Actions and permissions',
                  style: theme.textTheme.labelLarge,
                ),
                const SizedBox(height: 6),
                for (final action in entry.actions)
                  Padding(
                    padding: const EdgeInsets.only(bottom: 6),
                    child: Text(action, style: theme.textTheme.bodySmall),
                  ),
              ],
              if (entry.error != null)
                Text(
                  entry.error!,
                  style: theme.textTheme.bodySmall?.copyWith(
                    color: colors.error,
                  ),
                ),
              if (entry.models.isEmpty &&
                  entry.actions.isEmpty &&
                  entry.error == null &&
                  entry.costUsd != null)
                Text(
                  'Recorded API cost: $cost',
                  style: theme.textTheme.bodySmall,
                ),
            ],
          ),
        ),
      ],
    );
  }
}
