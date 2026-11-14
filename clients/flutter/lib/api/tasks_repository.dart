import '../core/api_transport.dart';
import '../core/nod_errors.dart';
import '../core/tasks.dart';

class NodTasksRepository {
  const NodTasksRepository(this.transport);
  final NodApiTransport transport;

  Future<List<NodTask>> loadTasks() async {
    final json = await transport.requestJson('GET', '/api/tasks');
    if (json is! List) throw const NodProtocolException();
    return json.map((item) => NodTask.fromJson(taskMap(item))).toList();
  }

  Future<NodTaskDetail> loadTask(String id) async => NodTaskDetail.fromJson(
    taskMap(
      await transport.requestJson(
        'GET',
        '/api/tasks/${Uri.encodeComponent(id)}',
      ),
    ),
  );

  Future<void> rename(String id, String title) async {
    final value = title.trim();
    if (value.isEmpty || value.length > 160) throw const NodRequestException();
    await transport.requestJson(
      'PATCH',
      '/api/tasks/${Uri.encodeComponent(id)}',
      body: {'title': value},
    );
  }

  Future<void> stop(String id) async {
    await transport.requestJson(
      'POST',
      '/api/tasks/${Uri.encodeComponent(id)}/stop',
    );
  }

  Future<NodTaskReplyContext> prepareReply(String id) async {
    final detail = await loadTask(id);
    final state = taskMap(await transport.requestJson('GET', '/api/state'));
    final target = detail.task.replyTarget;
    if (target == null) throw const NodRequestException();
    return NodTaskReplyContext(
      task: detail.task,
      threadId: taskText(state, 'threadId'),
      replyToMessageId: target,
    );
  }

  Future<void> reply(
    NodTaskReplyContext context,
    String text, {
    required String clientMessageId,
  }) async {
    if (text.trim().isEmpty) throw const NodRequestException();
    await transport.requestJson(
      'POST',
      '/api/messages',
      body: {
        'text': text.trim(),
        'clientMessageId': clientMessageId,
        'threadId': context.threadId,
        'replyToMessageId': context.replyToMessageId,
      },
    );
  }
}
