import 'package:flutter/material.dart';

import '../../core/schedules.dart';
import '../../design_system/design_system.dart';

String scheduleCadence(NodSchedule schedule) {
  if (schedule.kind == 'once') return 'One time';
  final fields = schedule.cron!.trim().split(RegExp(r'\s+'));
  if (fields.length != 5) return 'Custom schedule';
  final [minute, hour, day, month, weekday] = fields;
  if (int.tryParse(minute) == null ||
      int.tryParse(hour) == null ||
      day != '*' ||
      month != '*') {
    return 'Custom schedule';
  }
  return switch (weekday) {
    '*' => 'Every day',
    '1-5' => 'Every weekday',
    '0,6' || '6,0' => 'Every weekend',
    '0' || '7' => 'Every Sunday',
    '1' => 'Every Monday',
    '2' => 'Every Tuesday',
    '3' => 'Every Wednesday',
    '4' => 'Every Thursday',
    '5' => 'Every Friday',
    '6' => 'Every Saturday',
    _ => 'Custom schedule',
  };
}

class ScheduleTile extends StatelessWidget {
  const ScheduleTile({
    super.key,
    required this.schedule,
    required this.details,
  });
  final NodSchedule schedule;
  final Widget details;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final colors = context.nodColors;
    final next = schedule.enabled ? schedule.nextRun?.toLocal() : null;
    final material = MaterialLocalizations.of(context);
    final active = next != null;
    final today = DateUtils.isSameDay(next, DateTime.now());
    final status = !schedule.enabled
        ? 'Paused'
        : active
        ? 'Active'
        : 'No upcoming run';
    final statusColor = !schedule.enabled
        ? colors.textSecondary
        : active
        ? colors.success
        : colors.textSecondary;
    final statusBackground = active ? colors.successSoft : colors.surfaceInset;
    return Material(
      clipBehavior: Clip.antiAlias,
      color: colors.surfaceOverlay,
      shape: RoundedRectangleBorder(
        borderRadius: BorderRadius.circular(NodRadii.card),
        side: BorderSide(color: colors.border),
      ),
      child: Theme(
        data: theme.copyWith(dividerColor: Colors.transparent),
        child: ExpansionTile(
          tilePadding: const EdgeInsets.all(NodSpacing.md),
          childrenPadding: const EdgeInsets.fromLTRB(
            NodSpacing.md,
            0,
            NodSpacing.md,
            NodSpacing.md,
          ),
          iconColor: colors.textSecondary,
          collapsedIconColor: colors.textSecondary,
          title: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Wrap(
                spacing: NodSpacing.xs,
                runSpacing: NodSpacing.xs,
                crossAxisAlignment: WrapCrossAlignment.center,
                children: [
                  Container(
                    padding: const EdgeInsets.symmetric(
                      horizontal: 8,
                      vertical: 4,
                    ),
                    decoration: BoxDecoration(
                      color: statusBackground,
                      borderRadius: BorderRadius.circular(NodRadii.control),
                    ),
                    child: Text(
                      status,
                      style: theme.textTheme.labelSmall?.copyWith(
                        color: statusColor,
                        fontWeight: FontWeight.w600,
                      ),
                    ),
                  ),
                  Text(
                    scheduleCadence(schedule),
                    style: theme.textTheme.bodySmall?.copyWith(
                      color: colors.textSecondary,
                    ),
                  ),
                ],
              ),
              const SizedBox(height: NodSpacing.sm),
              Text(
                schedule.title,
                style: theme.textTheme.titleMedium?.copyWith(
                  fontWeight: FontWeight.w600,
                ),
              ),
              const SizedBox(height: NodSpacing.xs),
              Text(
                schedule.prompt,
                maxLines: 2,
                overflow: TextOverflow.ellipsis,
                style: theme.textTheme.bodyMedium?.copyWith(
                  color: colors.textSecondary,
                ),
              ),
              const SizedBox(height: NodSpacing.md),
              Row(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Icon(
                    active
                        ? Icons.schedule_outlined
                        : !schedule.enabled
                        ? Icons.pause_circle_outline
                        : Icons.check_circle_outline,
                    size: 18,
                    color: colors.textSecondary,
                  ),
                  const SizedBox(width: NodSpacing.xs),
                  Expanded(
                    child: Text(
                      next != null
                          ? '${today ? 'Today' : material.formatMediumDate(next)} at ${material.formatTimeOfDay(TimeOfDay.fromDateTime(next), alwaysUse24HourFormat: MediaQuery.alwaysUse24HourFormatOf(context))}'
                          : !schedule.enabled
                          ? 'On hold until you resume'
                          : 'No upcoming run',
                      style: theme.textTheme.bodySmall?.copyWith(
                        fontWeight: FontWeight.w500,
                      ),
                    ),
                  ),
                ],
              ),
            ],
          ),
          children: [details],
        ),
      ),
    );
  }
}
