import 'dart:math' as math;

import 'package:flutter/material.dart';

import '../../core/usage.dart';
import '../../design_system/design_system.dart';

String usageMoney(double value) =>
    value > 0 && value < 0.01 ? '<\$0.01' : '\$${value.toStringAsFixed(2)}';

class UsageSummary extends StatelessWidget {
  const UsageSummary({required this.report, super.key});
  final NodUsageReport report;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final colors = theme.colorScheme;
    final limit = report.limit;
    return Container(
      padding: const EdgeInsets.all(20),
      decoration: BoxDecoration(
        color: colors.surfaceContainerLow,
        borderRadius: BorderRadius.circular(NodRadii.card),
        border: Border.all(color: colors.outlineVariant),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text('This month', style: theme.textTheme.titleMedium),
          const SizedBox(height: 12),
          Wrap(
            crossAxisAlignment: WrapCrossAlignment.center,
            spacing: 10,
            runSpacing: 4,
            children: [
              Text(
                usageMoney(report.spentUsd),
                style: theme.textTheme.headlineLarge?.copyWith(
                  fontFeatures: const [FontFeature.tabularFigures()],
                ),
              ),
              Text(
                'API spending',
                style: theme.textTheme.bodyMedium?.copyWith(
                  color: colors.onSurfaceVariant,
                ),
              ),
            ],
          ),
          const SizedBox(height: 4),
          Text(
            'Projected this month: ${usageMoney(report.forecastUsd)}',
            style: theme.textTheme.bodySmall?.copyWith(
              color: colors.onSurfaceVariant,
            ),
          ),
          const SizedBox(height: 24),
          Semantics(
            label:
                'Cumulative API spending this month: ${usageMoney(report.spentUsd)}. Projected month end: ${usageMoney(report.forecastUsd)}.',
            child: SizedBox(
              height: 112,
              width: double.infinity,
              child: CustomPaint(painter: _SpendingChart(report, colors)),
            ),
          ),
          const SizedBox(height: 8),
          Row(
            mainAxisAlignment: MainAxisAlignment.spaceBetween,
            children: [
              Expanded(
                child: Text(
                  'Day 1',
                  style: theme.textTheme.labelSmall?.copyWith(
                    color: colors.onSurfaceVariant,
                  ),
                ),
              ),
              Expanded(
                child: Text(
                  'Day ${report.days}',
                  textAlign: TextAlign.end,
                  style: theme.textTheme.labelSmall?.copyWith(
                    color: colors.onSurfaceVariant,
                  ),
                ),
              ),
            ],
          ),
          const SizedBox(height: 12),
          Wrap(
            spacing: 16,
            runSpacing: 8,
            children: [
              _Legend(label: 'API spend', color: colors.secondary),
              _Legend(
                label: 'Forecast',
                color: colors.onSurfaceVariant,
                dashed: true,
              ),
            ],
          ),
          const SizedBox(height: 20),
          Divider(color: colors.outlineVariant, height: 1),
          const SizedBox(height: 16),
          Wrap(
            spacing: 8,
            runSpacing: 6,
            crossAxisAlignment: WrapCrossAlignment.center,
            children: [
              Icon(
                limit?.reached == true
                    ? Icons.pause_circle_outline
                    : Icons.shield_outlined,
                size: 18,
                color: limit?.reached == true
                    ? colors.error
                    : colors.onSurfaceVariant,
              ),
              Text(
                limit == null
                    ? 'No monthly spending limit'
                    : 'Monthly limit: ${usageMoney(limit.monthlyUsd)}',
                style: theme.textTheme.bodyMedium,
              ),
              if (limit != null && !limit.reached)
                Text(
                  '${usageMoney(math.max(0, limit.monthlyUsd - report.spentUsd))} remaining',
                  style: theme.textTheme.bodySmall?.copyWith(
                    color: colors.onSurfaceVariant,
                  ),
                ),
            ],
          ),
          if (limit?.reached == true) ...[
            const SizedBox(height: 12),
            Semantics(
              liveRegion: true,
              child: Text(
                'Monthly limit reached. New chat and background requests are paused until next month. Running turns can finish. Raise or remove the limit to resume.',
                style: theme.textTheme.bodySmall?.copyWith(color: colors.error),
              ),
            ),
          ],
        ],
      ),
    );
  }
}

class _Legend extends StatelessWidget {
  const _Legend({
    required this.label,
    required this.color,
    this.dashed = false,
  });
  final String label;
  final Color color;
  final bool dashed;
  @override
  Widget build(BuildContext context) => Row(
    mainAxisSize: MainAxisSize.min,
    children: [
      ExcludeSemantics(
        child: Row(
          children: [
            Container(width: dashed ? 6 : 16, height: 2, color: color),
            if (dashed) ...[
              const SizedBox(width: 4),
              Container(width: 6, height: 2, color: color),
            ],
          ],
        ),
      ),
      const SizedBox(width: 6),
      Flexible(
        child: Text(
          label,
          style: Theme.of(context).textTheme.labelSmall
              ?.copyWith(color: Theme.of(context).colorScheme.onSurfaceVariant),
        ),
      ),
    ],
  );
}

class _SpendingChart extends CustomPainter {
  _SpendingChart(this.report, this.colors);
  final NodUsageReport report;
  final ColorScheme colors;

  @override
  void paint(Canvas canvas, Size size) {
    final top = math.max(report.spentUsd, report.forecastUsd) * 1.15;
    final ceiling = top > 0 ? top : 1.0;
    final days = math.max(report.days, 1);
    final elapsed = report.elapsedDays.clamp(0, days).toDouble();
    Offset point(double day, double cost) => Offset(
      day / days * size.width,
      size.height - cost / ceiling * (size.height - 8),
    );
    final grid = Paint()
      ..color = colors.outlineVariant
      ..strokeWidth = 1;
    for (final fraction in [0.0, 0.5, 1.0]) {
      final y = size.height * fraction;
      canvas.drawLine(Offset(0, y), Offset(size.width, y), grid);
    }
    final line = Path()..moveTo(0, size.height);
    var total = 0.0;
    for (var index = 0; index < report.daily.length; index++) {
      total += report.daily[index];
      final position = point(math.min(index + 1.0, elapsed), total);
      line.lineTo(position.dx, position.dy);
    }
    final now = point(elapsed, report.spentUsd);
    line.lineTo(now.dx, now.dy);
    final fill = Path.from(line)
      ..lineTo(now.dx, size.height)
      ..close();
    canvas.drawPath(
      fill,
      Paint()..color = colors.primary.withValues(alpha: 0.09),
    );
    canvas.drawPath(
      line,
      Paint()
        ..color = colors.secondary
        ..strokeWidth = 2.5
        ..style = PaintingStyle.stroke
        ..strokeJoin = StrokeJoin.round,
    );
    final end = point(days.toDouble(), report.forecastUsd);
    final delta = end - now;
    final length = delta.distance;
    final forecast = Paint()
      ..color = colors.onSurfaceVariant
      ..strokeWidth = 1.5;
    if (length > 0) {
      for (var distance = 0.0; distance < length; distance += 9) {
        canvas.drawLine(
          now + delta * (distance / length),
          now + delta * (math.min(distance + 4, length) / length),
          forecast,
        );
      }
    }
    canvas.drawCircle(now, 4, Paint()..color = colors.secondary);
    canvas.drawCircle(now, 1.5, Paint()..color = colors.surfaceContainerLow);
  }

  @override
  bool shouldRepaint(_SpendingChart oldDelegate) =>
      oldDelegate.report != report || oldDelegate.colors != colors;
}
