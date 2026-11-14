import 'package:flutter/material.dart';

import '../../core/attachments.dart';
import '../results/artifact_preview.dart';

class AttachmentTile extends StatelessWidget {
  const AttachmentTile({
    required this.artifact,
    required this.repository,
    super.key,
    this.compact = false,
  });
  final bool compact;
  final NodArtifact artifact;
  final NodAttachmentsRepository repository;

  @override
  Widget build(BuildContext context) {
    void open() => showDialog<void>(
      context: context,
      builder: (_) =>
          NodArtifactPreview(artifact: artifact, repository: repository),
    );
    if (compact) {
      return IconButton(
        tooltip: 'Preview ${artifact.name}',
        icon: const Icon(Icons.visibility_outlined),
        onPressed: open,
      );
    }
    return OutlinedButton.icon(
      style: OutlinedButton.styleFrom(
        foregroundColor: Theme.of(context).colorScheme.onSurface,
      ),
      onPressed: open,
      icon: const Icon(Icons.insert_drive_file_outlined),
      label: Text(
        '${artifact.name} · ${formatAttachmentSize(artifact.size)}',
        maxLines: 2,
        overflow: TextOverflow.ellipsis,
      ),
    );
  }
}

String formatAttachmentSize(int bytes) => bytes < 1024 * 1024
    ? '${(bytes / 1024).ceil()} KB'
    : '${(bytes / (1024 * 1024)).toStringAsFixed(1)} MB';
