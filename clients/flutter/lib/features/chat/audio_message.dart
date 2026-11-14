import 'dart:async';

import 'package:flutter/material.dart';

import '../../core/attachments.dart';
import '../../design_system/design_system.dart';
import 'audio_playback.dart';

String audioTime(Duration value) =>
    '${value.inMinutes}:${(value.inSeconds % 60).toString().padLeft(2, '0')}';

class AudioMessage extends StatefulWidget {
  const AudioMessage({
    required this.artifact,
    required this.repository,
    this.active = true,
    this.playback,
    super.key,
  });
  final NodArtifact artifact;
  final NodAttachmentsRepository repository;
  final bool active;
  final AudioPlayback? playback;
  @override
  State<AudioMessage> createState() => _AudioMessageState();
}

class _AudioMessageState extends State<AudioMessage>
    with WidgetsBindingObserver {
  late final AudioPlayback _playback;
  bool _foreground = true;
  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    _foreground =
        WidgetsBinding.instance.lifecycleState == null ||
        WidgetsBinding.instance.lifecycleState == AppLifecycleState.resumed;
    _playback =
        widget.playback ??
        AudioPlayback(artifact: widget.artifact, repository: widget.repository);
    unawaited(_playback.prepare());
  }

  @override
  void didUpdateWidget(AudioMessage oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (!widget.active) unawaited(_playback.pause());
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    _foreground = state == AppLifecycleState.resumed;
    if (!_foreground) unawaited(_playback.pause());
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    _playback.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) => ListenableBuilder(
    listenable: _playback,
    builder: (context, _) {
      final theme = Theme.of(context);
      final colors = context.nodColors;
      final duration = _playback.duration;
      final position = _playback.position;
      final max = (duration?.inMilliseconds ?? 0).toDouble();
      return SizedBox(
        width: 280,
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          mainAxisSize: MainAxisSize.min,
          children: [
            Row(
              children: [
                SizedBox.square(
                  dimension: NodSizes.touchTarget,
                  child: _playback.loading
                      ? const Padding(
                          padding: EdgeInsets.all(14),
                          child: CircularProgressIndicator(
                            strokeWidth: 2,
                            semanticsLabel: 'Loading voice message',
                          ),
                        )
                      : IconButton.filled(
                          style: IconButton.styleFrom(
                            backgroundColor: colors.accent,
                            foregroundColor: theme.colorScheme.onSecondary,
                          ),
                          tooltip: _playback.playing
                              ? 'Pause voice message'
                              : _playback.error != null
                              ? 'Retry voice message'
                              : 'Play voice message',
                          onPressed: widget.active && _foreground
                              ? _playback.toggle
                              : null,
                          icon: Icon(
                            _playback.playing
                                ? Icons.pause_rounded
                                : Icons.play_arrow_rounded,
                          ),
                        ),
                ),
                const SizedBox(width: NodSpacing.xs),
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text('Voice message', style: theme.textTheme.labelLarge),
                      SliderTheme(
                        data: SliderTheme.of(context).copyWith(
                          trackHeight: 3,
                          activeTrackColor: colors.accent,
                          thumbColor: colors.accent,
                          overlayShape: SliderComponentShape.noOverlay,
                          thumbShape: const RoundSliderThumbShape(
                            enabledThumbRadius: 5,
                          ),
                        ),
                        child: Slider(
                          padding: const EdgeInsets.symmetric(
                            vertical: 12,
                            horizontal: 4,
                          ),
                          value: max > 0
                              ? position.inMilliseconds.toDouble().clamp(0, max)
                              : 0,
                          max: max > 0 ? max : 1,
                          onChanged:
                              max > 0 &&
                                  !_playback.loading &&
                                  widget.active &&
                                  _foreground
                              ? (value) => _playback.seek(
                                  Duration(milliseconds: value.round()),
                                )
                              : null,
                          semanticFormatterCallback: (value) =>
                              '${audioTime(Duration(milliseconds: value.round()))} of ${duration == null ? 'unknown duration' : audioTime(duration)}',
                        ),
                      ),
                      Text(
                        '${audioTime(position)} / ${duration == null ? '—:——' : audioTime(duration)}',
                        style: theme.textTheme.bodySmall?.copyWith(
                          color: colors.textSecondary,
                          fontFeatures: const [FontFeature.tabularFigures()],
                        ),
                      ),
                    ],
                  ),
                ),
              ],
            ),
            if (_playback.error != null)
              Padding(
                padding: const EdgeInsets.only(top: NodSpacing.xs),
                child: Semantics(
                  liveRegion: true,
                  child: Text(
                    _playback.error!,
                    style: theme.textTheme.bodySmall?.copyWith(
                      color: theme.colorScheme.error,
                    ),
                  ),
                ),
              ),
          ],
        ),
      );
    },
  );
}
