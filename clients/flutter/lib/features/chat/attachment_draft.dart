import 'dart:async';

import 'package:flutter/foundation.dart';

import '../../core/attachments.dart';

class DraftFile {
  DraftFile(this.file);
  final NodUploadFile file;
  final cancelled = Completer<void>();
  NodArtifact? artifact;
  double progress = 0;
  String? error;
  bool uploading = false;
}

class AttachmentDraft extends ChangeNotifier {
  AttachmentDraft(this.repository);
  final NodAttachmentsRepository repository;
  final files = <DraftFile>[];
  Timer? _renewal;
  var _disposed = false;
  Future<void> _uploads = Future.value();
  Future<bool>? _renewing;

  bool get ready =>
      files.isNotEmpty &&
      files.every(
        (item) =>
            item.artifact != null && item.error == null && !item.uploading,
      );

  void add(List<NodUploadFile> selected) {
    for (final file in selected) {
      final item = DraftFile(file);
      files.add(item);
      if (file.size > nodAttachmentLimit) {
        item.error =
            'File exceeds the 90 MB limit. Remove it to send the other files.';
      } else if (file.size == 0) {
        item.error = 'This file is empty.';
      } else {
        unawaited(upload(item));
      }
    }
    _renewal ??= Timer.periodic(
      const Duration(minutes: 5),
      (_) => unawaited(renew()),
    );
    notifyListeners();
  }

  Future<void> upload(DraftFile item) {
    if (item.uploading || item.cancelled.isCompleted || _disposed) {
      return Future.value();
    }
    item.uploading = true;
    item.error = null;
    notifyListeners();
    final next = _uploads.then((_) => _upload(item));
    _uploads = next;
    return next;
  }

  Future<void> _upload(DraftFile item) async {
    if (item.cancelled.isCompleted || _disposed) return;
    item.uploading = true;
    item.error = null;
    item.progress = 0;
    notifyListeners();
    try {
      final artifact = await repository.uploadAttachment(
        item.file,
        cancelled: item.cancelled.future,
        onProgress: (progress) {
          if (!_disposed && files.contains(item)) {
            item.progress = progress;
            notifyListeners();
          }
        },
      );
      if (!_disposed && files.contains(item)) item.artifact = artifact;
    } catch (_) {
      if (!_disposed && files.contains(item)) item.error = 'Upload failed. Retry or remove this file. Your server may need an update if uploads are unavailable.';
    } finally {
      item.uploading = false;
      if (!_disposed) notifyListeners();
    }
  }

  Future<bool> renew() =>
      _renewing ??= _renew().whenComplete(() => _renewing = null);

  Future<bool> _renew() async {
    final snapshot = files
        .where((item) => item.artifact != null && !item.uploading)
        .toList();
    if (snapshot.isEmpty) return true;
    final originals = {for (final item in snapshot) item: item.artifact!.id};
    bool current(DraftFile item) =>
        files.contains(item) &&
        !item.uploading &&
        item.artifact?.id == originals[item];
    try {
      final renewed = <NodArtifact>[];
      final ids = snapshot.map((item) => item.artifact!.id).toList();
      for (var start = 0; start < ids.length; start += 100) {
        renewed.addAll(
          await repository.renewAttachments(
            ids.sublist(start, (start + 100).clamp(0, ids.length)),
          ),
        );
      }
      if (_disposed) return false;
      for (final item in snapshot.where(current)) {
        final matching = renewed
            .where((artifact) => artifact.id == item.artifact!.id)
            .firstOrNull;
        if (matching == null) {
          item.error =
              'This upload is no longer available. Retry to upload it again.';
          item.artifact = null;
        } else {
          item.artifact = matching;
          item.error = null;
        }
      }
      notifyListeners();
      return ready;
    } catch (_) {
      if (!_disposed) {
        for (final item in snapshot.where(current)) {
          item.error = 'Could not check this upload. Try again when connected.';
        }
        notifyListeners();
      }
      return false;
    }
  }

  void remove(DraftFile item) {
    if (!item.cancelled.isCompleted) item.cancelled.complete();
    files.remove(item);
    if (files.isEmpty) {
      _renewal?.cancel();
      _renewal = null;
    }
    notifyListeners();
  }

  @override
  void dispose() {
    _disposed = true;
    _renewal?.cancel();
    for (final item in files) {
      if (!item.cancelled.isCompleted) item.cancelled.complete();
    }
    super.dispose();
  }
}
