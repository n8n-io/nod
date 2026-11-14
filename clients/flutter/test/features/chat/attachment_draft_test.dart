import 'dart:async';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:nod_client/core/attachments.dart';
import 'package:nod_client/features/chat/attachment_draft.dart';
import 'package:nod_client/features/chat/fakes/fake_nod_repository.dart';

class _Repository implements NodAttachmentsRepository {
  final backend = FakeNodRepository();
  @override
  bool get attachmentsSupported => true;
  List<NodArtifact> get uploaded => backend.uploaded;
  int get uploadCalls => backend.uploadCalls;
  int get cancelledUploads => backend.cancelledUploads;
  Completer<void>? get uploadGate => backend.uploadGate;
  set uploadGate(Completer<void>? value) => backend.uploadGate = value;
  Future<void> dispose() => backend.dispose();
  @override
  Future<void> sendAttachments(
    String text,
    List<NodArtifact> attachments, {
    required String clientMessageId,
  }) => backend.sendAttachments(
    text,
    attachments,
    clientMessageId: clientMessageId,
  );
  @override
  Future<void> downloadAttachment(
    NodArtifact artifact,
    File destination, {
    required Future<void> cancelled,
  }) => backend.downloadAttachment(artifact, destination, cancelled: cancelled);
  bool failUpload = false;
  Completer<void>? renewGate;
  int renewCalls = 0;

  @override
  Future<NodArtifact> uploadAttachment(
    NodUploadFile file, {
    required Future<void> cancelled,
    required void Function(double) onProgress,
  }) {
    if (failUpload) return Future.error(StateError('synthetic failure'));
    return backend.uploadAttachment(
      file,
      cancelled: cancelled,
      onProgress: onProgress,
    );
  }

  @override
  Future<List<NodArtifact>> renewAttachments(List<String> ids) async {
    renewCalls++;
    if (renewGate != null) await renewGate!.future;
    return backend.renewAttachments(ids);
  }
}

void main() {
  const file = NodUploadFile(
    name: 'synthetic.txt',
    mimeType: 'text/plain',
    size: 16,
  );
  late _Repository repository;
  late AttachmentDraft draft;
  setUp(() {
    repository = _Repository();
    draft = AttachmentDraft(repository);
  });
  tearDown(() async {
    draft.dispose();
    await repository.dispose();
  });

  test('uploads serialize and removing the active file releases the next queued file', () async {
    repository.uploadGate = Completer<void>();
    draft.add([file, file]);
    await Future<void>.delayed(Duration.zero);
    expect(repository.uploadCalls, 1);
    expect(draft.ready, isFalse);
    draft.remove(draft.files.first);
    repository.uploadGate!.complete();
    await Future<void>.delayed(Duration.zero);
    expect(repository.uploadCalls, 2);
    expect(repository.cancelledUploads, 1);
    expect(draft.files, hasLength(1));
    expect(draft.ready, isTrue);
  });

  test(
    'a failed upload retains its selection and supports explicit retry',
    () async {
      repository.failUpload = true;
      draft.add([file]);
      await Future<void>.delayed(Duration.zero);
      expect(draft.ready, isFalse);
      expect(draft.files.single.error, isNotNull);
      expect(draft.files.single.error, isNot(contains('synthetic failure')));
      repository.failUpload = false;
      await draft.upload(draft.files.single);
      expect(draft.ready, isTrue);
      expect(draft.files.single.error, isNull);
    },
  );

  test(
    'an expired upload must be uploaded again before send is enabled',
    () async {
      draft.add([file]);
      await Future<void>.delayed(Duration.zero);
      final oldId = draft.files.single.artifact!.id;
      repository.uploaded.clear();
      expect(await draft.renew(), isFalse);
      expect(draft.files.single.artifact, isNull);
      expect(draft.files.single.error, contains('no longer available'));
      await draft.upload(draft.files.single);
      expect(draft.files.single.artifact!.id, isNot(oldId));
      expect(await draft.renew(), isTrue);
    },
  );

  test('periodic and send-time renewals share one operation and cannot restore removed files', () async {
    draft.add([file]);
    await Future<void>.delayed(Duration.zero);
    repository.renewGate = Completer<void>();
    final first = draft.renew();
    final second = draft.renew();
    expect(identical(first, second), isTrue);
    expect(repository.renewCalls, 1);
    draft.remove(draft.files.single);
    repository.renewGate!.complete();
    await first;
    expect(draft.files, isEmpty);
    expect(draft.ready, isFalse);
  });
}
