import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:flutter/material.dart';
import 'package:path_provider/path_provider.dart';
import 'package:share_plus/share_plus.dart';

import '../../core/attachments.dart';
import '../../core/rich_results.dart';

class NodArtifactPreview extends StatefulWidget {
  const NodArtifactPreview({
    required this.artifact,
    required this.repository,
    this.temporaryDirectory,
    super.key,
  });
  final NodArtifact artifact;
  final NodAttachmentsRepository repository;
  final Future<Directory> Function()? temporaryDirectory;
  @override
  State<NodArtifactPreview> createState() => _NodArtifactPreviewState();
}

class _NodArtifactPreviewState extends State<NodArtifactPreview> {
  final _cancelled = Completer<void>();
  Directory? _directory;
  File? _file;
  String? _error;
  String? _text;
  bool _truncated = false;
  bool _sharing = false;

  @override
  void initState() {
    super.initState();
    unawaited(_load());
  }

  Future<void> _load() async {
    try {
      final temp =
          await (widget.temporaryDirectory?.call() ?? getTemporaryDirectory());
      final directory = await Directory(temp.path).createTemp('nod-preview-');
      _directory = directory;
      final name = widget.artifact.name.replaceAll(
        RegExp(r'[^a-zA-Z0-9._ -]'),
        '_',
      );
      final file = File(
        '${directory.path}/${name.isEmpty || name == '.' || name == '..' ? 'attachment' : name.substring(0, name.length.clamp(0, 160))}',
      );
      await widget.repository.downloadAttachment(
        widget.artifact,
        file,
        cancelled: _cancelled.future,
      );
      if (artifactFormat(widget.artifact.name, widget.artifact.mimeType) ==
          NodArtifactFormat.text) {
        final length = await file.length();
        final bytes = await file
            .openRead(0, length.clamp(0, 4 * 1024 * 1024))
            .fold<List<int>>([], (all, chunk) => all..addAll(chunk));
        _text = utf8.decode(bytes, allowMalformed: true);
        _truncated = length > bytes.length;
        if (widget.artifact.mimeType == 'application/json' && !_truncated) {
          try {
            _text = const JsonEncoder.withIndent('  ')
                .convert(jsonDecode(_text!));
          } catch (_) {}
        }
      }
      if (mounted) setState(() => _file = file);
    } catch (_) {
      if (mounted) {
        setState(
          () => _error = 'Could not download this file. It may be unavailable, or Nod may be offline.',
        );
      }
    } finally {
      if (!mounted) await _cleanup();
    }
  }

  Future<void> _cleanup() async {
    try {
      if (_directory != null && await _directory!.exists()) {
        await _directory!.delete(recursive: true);
      }
    } catch (_) {}
  }

  Future<void> _share() async {
    if (_sharing || _file == null) return;
    setState(() => _sharing = true);
    try {
      final box = context.findRenderObject()! as RenderBox;
      await SharePlus.instance.share(
        ShareParams(
          files: [XFile(_file!.path, mimeType: widget.artifact.mimeType)],
          sharePositionOrigin: box.localToGlobal(Offset.zero) & box.size,
        ),
      );
    } catch (_) {
      if (mounted) {
        setState(
          () => _error = 'Could not open the share sheet. Please try again.',
        );
      }
    } finally {
      if (mounted) {
        setState(() => _sharing = false);
      } else {
        await _cleanup();
      }
    }
  }

  @override
  void dispose() {
    _cancelled.complete();
    if (!_sharing) unawaited(_cleanup());
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final image =
        artifactFormat(widget.artifact.name, widget.artifact.mimeType) ==
        NodArtifactFormat.image;
    return AlertDialog(
      title: Text(
        widget.artifact.name,
        maxLines: 2,
        overflow: TextOverflow.ellipsis,
      ),
      content: SizedBox(
        width: 480,
        child: _error != null
            ? Text(_error!)
            : _file == null
            ? const Padding(
                padding: EdgeInsets.all(24),
                child: Column(
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    CircularProgressIndicator(),
                    SizedBox(height: 16),
                    Text('Downloading file…'),
                  ],
                ),
              )
            : _text != null
            ? SizedBox(
                height: MediaQuery.sizeOf(context).height * 0.6,
                child: SingleChildScrollView(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      if (_truncated)
                        const Text(
                          'Preview limited to the first 4 MB. Open or save for the full file.',
                        ),
                      SelectableText(
                        _text!,
                        style: const TextStyle(
                          fontFamily: 'monospace',
                          fontSize: 13,
                        ),
                      ),
                    ],
                  ),
                ),
              )
            : image
            ? ConstrainedBox(
                constraints: BoxConstraints(
                  maxHeight: MediaQuery.sizeOf(context).height * 0.5,
                ),
                child: InteractiveViewer(
                  child: Image.file(
                    _file!,
                    cacheWidth: 1600,
                    cacheHeight: 1600,
                    errorBuilder: (_, error, stack) => const Text(
                      'Image preview unavailable. Use Open or save to view this file.',
                    ),
                  ),
                ),
              )
            : Text(
                '${widget.artifact.size} bytes · ${widget.artifact.mimeType}\n\nOpen or save this file using an app on your device. Active content is not executed inside Nod.',
              ),
      ),
      actions: [
        TextButton(
          onPressed: () => Navigator.pop(context),
          child: const Text('Close'),
        ),
        if (_file != null)
          FilledButton(
            onPressed: _sharing ? null : _share,
            child: const Text('Open or save'),
          ),
      ],
    );
  }
}
