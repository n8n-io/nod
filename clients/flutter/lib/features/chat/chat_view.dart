import 'dart:async';
import 'dart:math' as math;

import 'package:file_picker/file_picker.dart';
import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter/services.dart';
import 'package:image_picker/image_picker.dart';
import 'package:mime/mime.dart';

import '../../api/connections_management_repository.dart';
import '../../api/private_requests_repository.dart';
import '../../core/api_transport.dart';
import '../../core/app_connections.dart';
import '../../core/attachments.dart';
import '../../core/audio.dart';
import '../../core/core.dart';
import '../../core/prepared.dart';
import '../../core/private_requests.dart';
import '../../design_system/design_system.dart';
import '../../motion/motion.dart';
import '../apps/apps_page.dart';
import '../connections/connection_setup_page.dart';
import '../prepared/prepared_page.dart';
import '../private_requests/private_browser.dart';
import '../private_requests/private_requests_page.dart';
import '../results/artifact_preview.dart';
import '../results/rich_result.dart';
import 'agent_message_body.dart';
import 'attachment_draft.dart';
import 'attachment_view.dart';
import 'audio_message.dart';
import 'audio_playback.dart';
import 'chat_controller.dart';
import 'chat_models.dart';
import 'voice_draft.dart';

class NodChat extends StatefulWidget {
  const NodChat({
    required this.repository,
    this.autofocus = false,
    this.active = true,
    this.voiceDraft,
    this.pickAttachments,
    this.focusMessageId,
    this.replyToFocusedMessage = true,
    super.key,
  });

  final Future<List<NodUploadFile>> Function()? pickAttachments;

  final NodRepository repository;
  final bool autofocus;
  final bool active;
  final String? focusMessageId;
  final bool replyToFocusedMessage;
  final VoiceDraft? voiceDraft;

  @override
  State<NodChat> createState() => _NodChatState();
}

class _NodChatState extends State<NodChat>
    with WidgetsBindingObserver, SingleTickerProviderStateMixin {
  late final ChatController _controller;
  late final TextEditingController _composerController;
  late final FocusNode _composerFocus;
  final ScrollController _scrollController = ScrollController(
    keepScrollOffset: false,
  );
  final _composerBoundsKey = GlobalKey();
  final _flightHostKey = GlobalKey();
  final _flightTargetKey = GlobalKey();
  late final AnimationController _sendFlight;
  String? _flightId;
  String _flightText = '';
  Offset _flightOrigin = Offset.zero;
  double _flightWidth = 0;
  TextStyle? _flightStyle;
  String _conversationMarker = '';
  String? _requestedFocusId;
  String? _focusedMessageId;
  bool _focusUnavailable = false;
  int _focusAttempt = 0;
  AttachmentDraft? _draft;
  VoiceDraft? _voice;
  bool _picking = false;
  bool _preparingSend = false;
  String? _attachmentError;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    _sendFlight =
        AnimationController(
          vsync: this,
          duration: const Duration(milliseconds: 380),
        )..addStatusListener((status) {
          if (status == AnimationStatus.completed && mounted) {
            setState(() => _flightId = null);
          }
        });
    if (widget.repository is NodAudioRepository) {
      _voice = (widget.voiceDraft ?? VoiceDraft())
        ..addListener(_handleComposerChanged);
    }
    _controller = ChatController(widget.repository)
      ..addListener(_handleControllerChanged);
    _composerController = TextEditingController()
      ..addListener(_handleComposerChanged);
    _composerFocus = FocusNode();
    if (widget.repository is NodAttachmentsRepository &&
        (widget.repository as NodAttachmentsRepository).attachmentsSupported) {
      _draft = AttachmentDraft(widget.repository as NodAttachmentsRepository)
        ..addListener(_handleComposerChanged);
    }
    unawaited(_controller.start());
  }

  @override
  void didUpdateWidget(NodChat oldWidget) {
    super.didUpdateWidget(oldWidget);
    assert(oldWidget.repository == widget.repository);
    if (oldWidget.focusMessageId != widget.focusMessageId ||
        oldWidget.active != widget.active ||
        oldWidget.replyToFocusedMessage != widget.replyToFocusedMessage) {
      _focusAttempt++;
      _controller.cancelMessageFocus();
      if (oldWidget.focusMessageId != null && widget.focusMessageId == null) {
        _controller.clearReply();
      }
      _requestedFocusId = null;
      _focusedMessageId = null;
      _focusUnavailable = false;
      _requestMessageFocus();
    }
    if (!widget.active) {
      _cancelSendFlight();
      unawaited(_voice?.suspend());
    }
  }

  void _requestMessageFocus() {
    final id = widget.focusMessageId;
    if (!widget.active ||
        _controller.isLoading ||
        id == null ||
        id == _requestedFocusId) {
      return;
    }
    _requestedFocusId = id;
    unawaited(_focusMessage(id));
  }

  Future<void> _focusMessage(String id) async {
    final attempt = ++_focusAttempt;
    final target = await _controller.focusMessage(
      id,
      reply: widget.replyToFocusedMessage,
    );
    if (!mounted ||
        attempt != _focusAttempt ||
        widget.focusMessageId != id ||
        _requestedFocusId != id ||
        !widget.active) {
      return;
    }
    setState(() {
      _focusedMessageId = target?.id;
      _focusUnavailable = target == null;
    });
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (mounted && _focusedMessageId == id && _scrollController.hasClients) {
        _scrollController.jumpTo(0);
      }
    });
  }

  void _handleControllerChanged() {
    if (!mounted) {
      return;
    }
    final messages = _controller.messages;
    if (_focusedMessageId != null &&
        !messages.any((message) => message.id == _focusedMessageId)) {
      _focusedMessageId = null;
      _focusUnavailable = true;
    }
    if (_flightId != null &&
        !messages.any(
          (message) => (message.clientMessageId ?? message.id) == _flightId,
        )) {
      _sendFlight.stop();
      _flightId = null;
    }
    final lastMessage = messages.isEmpty ? null : messages.last;
    final marker = <Object?>[
      messages.length,
      lastMessage?.id,
      lastMessage?.text,
      _controller.question?.id,
    ].join(':');
    final wasNearBottom =
        !_scrollController.hasClients ||
        _scrollController.position.extentBefore < 120;
    final shouldScroll = marker != _conversationMarker && wasNearBottom;
    _conversationMarker = marker;
    setState(() {});
    _requestMessageFocus();
    if (shouldScroll && widget.focusMessageId == null) {
      WidgetsBinding.instance.addPostFrameCallback((_) {
        if (!mounted || !_scrollController.hasClients) {
          return;
        }
        _scrollController.jumpTo(_scrollController.position.minScrollExtent);
      });
    }
  }

  void _handleComposerChanged() {
    if (mounted) {
      setState(() {});
    }
  }

  Future<void> _pick() async {
    if (_picking || _controller.isSending || _preparingSend) return;
    setState(() => _picking = true);
    try {
      List<NodUploadFile> files;
      if (widget.pickAttachments != null) {
        files = await widget.pickAttachments!();
      } else {
        final photos = await showModalBottomSheet<bool>(
          context: context,
          builder: (context) => SafeArea(
            child: Column(
              mainAxisSize: MainAxisSize.min,
              children: [
                ListTile(
                  leading: const Icon(Icons.folder_open),
                  title: const Text('Choose files'),
                  onTap: () => Navigator.pop(context, false),
                ),
                ListTile(
                  leading: const Icon(Icons.photo_library_outlined),
                  title: const Text('Choose photos'),
                  onTap: () => Navigator.pop(context, true),
                ),
              ],
            ),
          ),
        );
        if (photos == null || !mounted) return;
        if (photos) {
          final selected = await ImagePicker().pickMultiImage(
            requestFullMetadata: false,
          );
          files = await Future.wait(
            selected.map(
              (file) async => NodUploadFile(
                path: file.path,
                name: file.name,
                size: await file.length(),
                mimeType:
                    lookupMimeType(file.name) ?? 'application/octet-stream',
              ),
            ),
          );
        } else {
          final selected = await FilePicker.pickFiles();
          files = await Future.wait(
            selected.map(
              (file) async => NodUploadFile(
                read: file.readAsByteStream,
                name: file.name,
                size: await file.length() ?? 0,
                mimeType:
                    lookupMimeType(file.name) ?? 'application/octet-stream',
              ),
            ),
          );
        }
      }
      if (mounted) {
        _draft?.add(files);
        setState(() => _attachmentError = null);
      }
    } catch (_) {
      if (mounted) {
        setState(
          () => _attachmentError = 'Could not select files. Please try again.',
        );
      }
    } finally {
      if (mounted) setState(() => _picking = false);
    }
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    if (state == AppLifecycleState.paused ||
        state == AppLifecycleState.hidden ||
        state == AppLifecycleState.detached) {
      _cancelSendFlight();
    }
    if (state != AppLifecycleState.resumed && (_voice?.recording ?? false)) {
      unawaited(_voice!.stop());
    } else if (state == AppLifecycleState.paused ||
        state == AppLifecycleState.hidden ||
        state == AppLifecycleState.detached) {
      unawaited(_voice?.suspend());
    }
  }

  void _cancelSendFlight() {
    _sendFlight.stop();
    if (_flightId != null && mounted) {
      setState(() => _flightId = null);
    }
  }

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    if (MediaQuery.disableAnimationsOf(context) ||
        !TickerMode.valuesOf(context).enabled) {
      _cancelSendFlight();
    }
  }

  RenderEditable? _composerEditable() {
    RenderEditable? result;
    void visit(RenderObject object) {
      if (object is RenderEditable) {
        result = object;
      } else {
        object.visitChildren(visit);
      }
    }

    final object = _composerBoundsKey.currentContext?.findRenderObject();
    if (object != null) visit(object);
    return result;
  }

  Widget _buildSendFlight(BuildContext context, Widget? child) {
    if (_flightId == null) return const SizedBox.shrink();
    final host = _flightHostKey.currentContext?.findRenderObject();
    final target = _flightTargetKey.currentContext?.findRenderObject();
    if (host is! RenderBox ||
        target is! RenderBox ||
        !target.hasSize ||
        !target.attached) {
      return const SizedBox.shrink();
    }
    final t = Curves.easeOutCubic.transform(_sendFlight.value);
    final from = host.globalToLocal(_flightOrigin);
    final to = host.globalToLocal(target.localToGlobal(Offset.zero));
    final position = Offset.lerp(from, to, t)!;
    final style = DefaultTextStyle.of(_flightTargetKey.currentContext!).style;
    final colors = Theme.of(context).colorScheme;
    return Stack(
      children: [
        Positioned(
          left: position.dx - NodSpacing.md,
          top: position.dy - NodSpacing.sm,
          width:
              _flightWidth +
              (target.size.width - _flightWidth) * t +
              NodSpacing.md * 2,
          child: Material(
            key: const Key('chat-send-flight'),
            color: Color.lerp(
              colors.primaryContainer.withValues(alpha: 0),
              colors.primaryContainer,
              t,
            )!,
            borderRadius: BorderRadius.circular(NodRadii.dialog),
            child: Padding(
              padding: const EdgeInsets.symmetric(
                horizontal: NodSpacing.md,
                vertical: NodSpacing.sm,
              ),
              child: Text(
                _flightText,
                style: TextStyle.lerp(_flightStyle, style, t),
              ),
            ),
          ),
        ),
      ],
    );
  }

  Future<void> _send() async {
    final draft = _draft;
    if (_preparingSend ||
        (_voice?.recording ?? false) ||
        (_voice?.busy ?? false) ||
        _picking ||
        !_controller.canCompose ||
        (_composerController.text.trim().isEmpty &&
            (draft == null || draft.files.isEmpty) &&
            _voice?.file == null) ||
        (draft != null && draft.files.isNotEmpty && !draft.ready)) {
      return;
    }
    final text = _composerController.text;
    final selected = draft?.files.toList() ?? <DraftFile>[];
    setState(() => _preparingSend = true);
    if (selected.isNotEmpty && !await draft!.renew()) {
      if (mounted) setState(() => _preparingSend = false);
      return;
    }
    if (!mounted) return;
    final artifacts = selected.map((item) => item.artifact!).toList();
    final editable =
        widget.active &&
            !MediaQuery.disableAnimationsOf(context) &&
            TickerMode.valuesOf(context).enabled &&
            artifacts.isEmpty &&
            _voice?.file == null &&
            text.trim().isNotEmpty
        ? _composerEditable()
        : null;
    final origin = editable?.localToGlobal(
      editable.getLocalRectForCaret(const TextPosition(offset: 0)).topLeft,
    );
    final originWidth = editable?.size.width;
    final originStyle = editable?.text?.style;
    _composerController.clear();
    final sending = _controller.sendText(
      text,
      attachments: artifacts,
      recording: _voice?.file,
    );
    final pending = _controller.messages
        .where((message) => message.isPending)
        .lastOrNull;
    if (origin != null && originWidth != null && pending != null) {
      _sendFlight.stop();
      _sendFlight.value = 0;
      setState(() {
        _flightId = pending.clientMessageId ?? pending.id;
        _flightText = pending.text;
        _flightOrigin = origin;
        _flightWidth = originWidth;
        _flightStyle = originStyle;
      });
      WidgetsBinding.instance.addPostFrameCallback((_) {
        if (!mounted || _flightId == null) return;
        if (_flightTargetKey.currentContext == null) {
          _cancelSendFlight();
        } else {
          _sendFlight.forward();
        }
      });
    }
    final sent = await sending;
    if (!mounted) {
      return;
    }
    setState(() => _preparingSend = false);
    if (sent) {
      await _voice?.discard();
      if (!mounted) return;
      for (final item in selected) {
        draft?.remove(item);
      }
    } else {
      _composerController.value = TextEditingValue(
        text: text,
        selection: TextSelection.collapsed(offset: text.length),
      );
    }
    _composerFocus.requestFocus();
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    _sendFlight.dispose();
    _voice?.removeListener(_handleComposerChanged);
    _voice?.dispose();
    _controller
      ..removeListener(_handleControllerChanged)
      ..dispose();
    _composerController
      ..removeListener(_handleComposerChanged)
      ..dispose();
    _draft?.removeListener(_handleComposerChanged);
    _draft?.dispose();
    _composerFocus.dispose();
    _scrollController.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final media = MediaQuery.of(context);
    final keyboardInset = media.viewInsets.bottom;
    final duration = media.disableAnimations ? Duration.zero : Durations.short3;
    return NotificationListener<UserScrollNotification>(
      onNotification: (notification) {
        if (notification.direction != ScrollDirection.idle) _cancelSendFlight();
        return false;
      },
      child: Stack(
        key: _flightHostKey,
        fit: StackFit.expand,
        children: [
          FocusTraversalGroup(
            policy: OrderedTraversalPolicy(),
            child: AnimatedPadding(
              duration: duration,
              padding: EdgeInsets.only(bottom: keyboardInset),
              child: Column(
                children: [
                  _StatusArea(controller: _controller),
                  Expanded(
                    child: Stack(
                      fit: StackFit.expand,
                      children: [
                        NodAmbientWaves(
                          active: widget.active,
                          visible:
                              !_controller.isLoading &&
                              _controller.failure == null &&
                              _controller.question == null &&
                              _controller.connection.phase ==
                                  NodConnectionPhase.connected &&
                              (_controller.messages.isEmpty ||
                                  _controller.turn == NodTurnState.queued ||
                                  _controller.turn == NodTurnState.running),
                          working:
                              _controller.turn == NodTurnState.queued ||
                              _controller.turn == NodTurnState.running,
                        ),
                        _Conversation(
                          active: widget.active,
                          controller: _controller,
                          scrollController: _scrollController,
                          attachmentsRepository:
                              widget.repository is NodAttachmentsRepository
                              ? widget.repository as NodAttachmentsRepository
                              : null,
                          onQuestionSelected: _controller.answer,
                          focusMessageId: _focusedMessageId,
                          flightId: _flightId,
                          flightTargetKey: _flightTargetKey,
                        ),
                      ],
                    ),
                  ),
                  if (_attachmentError != null) Text(_attachmentError!),
                  if (_draft != null && _draft!.files.isNotEmpty)
                    SizedBox(
                      height: 120,
                      child: ListView(
                        scrollDirection: Axis.horizontal,
                        padding: const EdgeInsets.symmetric(horizontal: 16),
                        children: [
                          for (final item in _draft!.files)
                            SizedBox(
                              width: 240,
                              child: Card(
                                child: Padding(
                                  padding: const EdgeInsets.all(8),
                                  child: Column(
                                    crossAxisAlignment:
                                        CrossAxisAlignment.start,
                                    children: [
                                      Row(
                                        children: [
                                          Expanded(
                                            child: Text(
                                              item.file.name,
                                              maxLines: 1,
                                              overflow: TextOverflow.ellipsis,
                                            ),
                                          ),
                                          if (item.artifact != null &&
                                              item.error == null &&
                                              !item.uploading)
                                            AttachmentTile(
                                              artifact: item.artifact!,
                                              repository: _draft!.repository,
                                              compact: true,
                                            ),
                                          if (item.error != null &&
                                              item.file.size <=
                                                  nodAttachmentLimit &&
                                              item.file.size > 0)
                                            IconButton(
                                              tooltip:
                                                  'Retry upload ${item.file.name}',
                                              onPressed: () =>
                                                  _draft!.upload(item),
                                              icon: const Icon(Icons.refresh),
                                            ),
                                          IconButton(
                                            tooltip: 'Remove ${item.file.name}',
                                            onPressed:
                                                _controller.isSending ||
                                                    _preparingSend
                                                ? null
                                                : () => _draft!.remove(item),
                                            icon: const Icon(Icons.close),
                                          ),
                                        ],
                                      ),
                                      if (item.uploading)
                                        LinearProgressIndicator(
                                          value: item.progress,
                                        ),
                                      if (item.error != null)
                                        Expanded(
                                          child: SingleChildScrollView(
                                            child: Text(
                                              item.error!,
                                              style: TextStyle(
                                                color: Theme.of(context)
                                                    .colorScheme
                                                    .error,
                                              ),
                                            ),
                                          ),
                                        ),
                                      if (item.error == null)
                                        Expanded(
                                          child: SingleChildScrollView(
                                            child: Text(
                                              item.uploading
                                                  ? 'Uploading ${(item.progress * 100).round()}%'
                                                  : '${formatAttachmentSize(item.file.size)} · Ready to send',
                                            ),
                                          ),
                                        ),
                                    ],
                                  ),
                                ),
                              ),
                            ),
                        ],
                      ),
                    ),
                  if (_focusUnavailable)
                    const ListTile(
                      key: Key('chat-focus-unavailable'),
                      leading: Icon(Icons.info_outline),
                      title: Text(
                        'This message is no longer available. Choose a current task message to reply.',
                      ),
                    ),
                  if (_controller.replyTarget case final target?)
                    ListTile(
                      dense: true,
                      leading: const Icon(Icons.reply),
                      title: Text(
                        target.text,
                        maxLines: 2,
                        overflow: TextOverflow.ellipsis,
                      ),
                      trailing: IconButton(
                        tooltip: 'Cancel reply',
                        onPressed: _controller.clearReply,
                        icon: const Icon(Icons.close),
                      ),
                    ),
                  _Composer(
                    boundsKey: _composerBoundsKey,
                    voice: _voice,
                    canRecord:
                        _controller.canCompose && !_preparingSend && !_picking,
                    controller: _composerController,
                    focusNode: _composerFocus,
                    autofocus: widget.autofocus,
                    onAttach:
                        _draft == null ||
                            _controller.isSending ||
                            _preparingSend ||
                            _picking
                        ? null
                        : _pick,
                    supportsAttachments: _draft != null,
                    hasAttachments:
                        (_draft?.files.isNotEmpty ?? false) ||
                        _voice?.file != null ||
                        (_voice?.recording ?? false),
                    enabled: !_preparingSend,
                    canSend:
                        !_preparingSend &&
                        !(_voice?.recording ?? false) &&
                        !(_voice?.busy ?? false) &&
                        !_picking &&
                        _controller.canCompose &&
                        (_composerController.text.trim().isNotEmpty ||
                            (_draft?.ready ?? false) ||
                            _voice?.file != null) &&
                        ((_draft?.files.isEmpty ?? true) || _draft!.ready),
                    canStop: _controller.canStop,
                    isSending: _controller.isSending,
                    isStopping: _controller.isStopping,
                    hasQuestion: _controller.question != null,
                    onSend: _send,
                    onStop: _controller.stop,
                  ),
                ],
              ),
            ),
          ),
          Positioned.fill(
            child: IgnorePointer(
              child: ExcludeSemantics(
                child: AnimatedBuilder(
                  animation: _sendFlight,
                  builder: _buildSendFlight,
                ),
              ),
            ),
          ),
        ],
      ),
    );
  }
}

class _Conversation extends StatelessWidget {
  const _Conversation({
    required this.active,
    required this.controller,
    required this.scrollController,
    required this.onQuestionSelected,
    required this.flightId,
    required this.flightTargetKey,
    this.attachmentsRepository,
    this.focusMessageId,
  });

  final String? focusMessageId;
  final bool active;
  final ChatController controller;
  final ScrollController scrollController;
  final NodAttachmentsRepository? attachmentsRepository;
  final Future<bool> Function(ChatChoice choice) onQuestionSelected;
  final String? flightId;
  final GlobalKey flightTargetKey;

  @override
  Widget build(BuildContext context) {
    final messages = controller.messages
        .where(
          (message) =>
              message.role != NodMessageRole.assistant ||
              message.text.trim().isNotEmpty ||
              message.attachments.isNotEmpty ||
              message.presentation != null,
        )
        .toList();
    final working =
        active &&
        !controller.isLoading &&
        controller.failure == null &&
        controller.question == null &&
        controller.connection.phase == NodConnectionPhase.connected &&
        (controller.turn == NodTurnState.queued ||
            controller.turn == NodTurnState.running);
    if (controller.isLoading && messages.isEmpty) {
      return const Center(child: CircularProgressIndicator());
    }
    if (messages.isEmpty && controller.question == null) {
      return _EmptyConversation(
        failure: controller.failure?.kind == ChatFailureKind.audio
            ? null
            : controller.failure,
      );
    }
    Widget messageItem(ChatMessageItem message) {
      return Center(
        child: ConstrainedBox(
          constraints: const BoxConstraints(maxWidth: 760),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              _MessageBubble(
                key: ValueKey(message.id),
                active: active,
                message: message,
                flightTargetKey:
                    (message.clientMessageId ?? message.id) == flightId
                    ? flightTargetKey
                    : null,
                streaming:
                    message.isStreaming &&
                    controller.failure == null &&
                    controller.question == null &&
                    (controller.turn == NodTurnState.queued ||
                        controller.turn == NodTurnState.running),
                attachmentsRepository: attachmentsRepository,
                transport: controller.transport,
              ),
              if (message.replyToMessageId != null)
                Padding(
                  padding: const EdgeInsets.symmetric(horizontal: 24),
                  child: Text(
                    'Reply to ${controller.messages.where((item) => item.id == message.replyToMessageId).firstOrNull?.text ?? 'earlier message'}',
                    maxLines: 2,
                    overflow: TextOverflow.ellipsis,
                    style: Theme.of(context).textTheme.bodySmall,
                  ),
                ),
              if (message.id == focusMessageId &&
                  message.role == NodMessageRole.assistant &&
                  message.turnId != null &&
                  controller.transport != null)
                Align(
                  alignment: Alignment.centerLeft,
                  child: TextButton.icon(
                    icon: const Icon(Icons.open_in_browser),
                    label: const Text('Open task browser'),
                    onPressed: () => Navigator.of(context).push(
                      MaterialPageRoute<void>(
                        builder: (_) => NodPrivateBrowser(
                          repository: NodPrivateRequestsRepository(
                            controller.transport!,
                          ),
                          turnId: message.turnId!,
                        ),
                      ),
                    ),
                  ),
                ),
              if (controller.hasChoices(message))
                _AnswerChoices(
                  key: ValueKey('choices-${message.id}'),
                  message: message,
                  controller: controller,
                ),
              if (!message.isPending && !message.isStreaming)
                Wrap(
                  children: [
                    TextButton.icon(
                      onPressed: controller.canCompose
                          ? () => controller.replyTo(message)
                          : null,
                      icon: const Icon(Icons.reply, size: 16),
                      label: const Text('Reply'),
                    ),
                    IconButton(
                      tooltip: 'Copy message',
                      icon: const Icon(Icons.copy, size: 16),
                      onPressed: () =>
                          Clipboard.setData(ClipboardData(text: message.text)),
                    ),
                    for (final reaction in message.reactions)
                      ActionChip(
                        label: Text(reaction.reaction),
                        onPressed:
                            reaction.actor == 'user' && controller.canReact
                            ? () => controller.react(message, null)
                            : null,
                      ),
                    if (message.role == NodMessageRole.assistant &&
                        controller.canReact)
                      PopupMenuButton<String>(
                        tooltip: 'React',
                        icon: const Icon(Icons.add_reaction_outlined, size: 18),
                        onSelected: (value) => controller.react(
                          message,
                          value == message.reaction ? null : value,
                        ),
                        itemBuilder: (_) => [
                          for (final emoji in ['👍', '❤️', '🎉', '👀', '👎'])
                            PopupMenuItem(value: emoji, child: Text(emoji)),
                        ],
                      ),
                  ],
                ),
            ],
          ),
        ),
      );
    }

    final focusIndex = messages.indexWhere(
      (message) => message.id == focusMessageId,
    );
    if (focusIndex >= 0) {
      final anchor = ValueKey('focus-anchor-$focusMessageId');
      return SelectionArea(
        child: CustomScrollView(
          key: ValueKey('chat-focus-$focusMessageId'),
          controller: scrollController,
          reverse: true,
          center: anchor,
          slivers: [
            SliverList.builder(
              itemCount: messages.length - focusIndex - 1,
              itemBuilder: (context, index) =>
                  messageItem(messages[focusIndex + index + 1]),
            ),
            SliverList.builder(
              key: anchor,
              itemCount: focusIndex + 1,
              itemBuilder: (context, index) =>
                  messageItem(messages[focusIndex - index]),
            ),
          ],
        ),
      );
    }
    return SelectionArea(
      child: ListView.builder(
        key: const Key('chat-message-list'),
        controller: scrollController,
        reverse: true,
        padding: EdgeInsets.fromLTRB(16, 20, 16, working ? 56 : 24),
        itemCount: messages.length + (controller.question == null ? 0 : 1),
        itemBuilder: (context, index) {
          if (index == 0 && controller.question != null) {
            return _QuestionCard(
              question: controller.question!,
              enabled: controller.canCompose,
              onSelected: onQuestionSelected,
            );
          }
          final messageIndex =
              messages.length -
              1 -
              index +
              (controller.question == null ? 0 : 1);
          final message = messages[messageIndex];
          return messageItem(message);
        },
      ),
    );
  }
}

class _EmptyConversation extends StatelessWidget {
  const _EmptyConversation({required this.failure});

  final ChatFailure? failure;

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).colorScheme;
    return LayoutBuilder(
      builder: (context, constraints) {
        final minHeight = constraints.hasBoundedHeight
            ? math.max(0.0, constraints.maxHeight - NodSpacing.lg * 2)
            : 0.0;
        return SingleChildScrollView(
          padding: const EdgeInsets.all(NodSpacing.lg),
          child: ConstrainedBox(
            constraints: BoxConstraints(minHeight: minHeight),
            child: Center(
              child: ConstrainedBox(
                constraints: const BoxConstraints(maxWidth: 440),
                child: Column(
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    if (failure == null)
                      const NodBrandMark(size: 64)
                    else
                      Icon(Icons.cloud_off, size: 36, color: colors.primary),
                    const SizedBox(height: NodSpacing.md),
                    Text(
                      failure == null
                          ? 'What can I help with?'
                          : 'Chat unavailable',
                      key: const Key('chat-empty-title'),
                      textAlign: TextAlign.center,
                      style: Theme.of(context).textTheme.headlineSmall,
                    ),
                    const SizedBox(height: NodSpacing.xs),
                    Text(
                      failure == null
                          ? 'Send a message to start the conversation.'
                          : _failureText(failure!),
                      textAlign: TextAlign.center,
                      style: Theme.of(context).textTheme.bodyLarge
                          ?.copyWith(color: colors.onSurfaceVariant),
                    ),
                  ],
                ),
              ),
            ),
          ),
        );
      },
    );
  }
}

class _MessageBubble extends StatelessWidget {
  const _MessageBubble({
    required this.active,
    required this.message,
    required this.streaming,
    this.flightTargetKey,
    this.attachmentsRepository,
    this.transport,
    super.key,
  });

  final bool active;
  final NodApiTransport? transport;
  final NodAttachmentsRepository? attachmentsRepository;

  final ChatMessageItem message;
  final bool streaming;
  final GlobalKey? flightTargetKey;

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).colorScheme;
    final reducedMotion = MediaQuery.disableAnimationsOf(context);
    final isOwner = message.role == NodMessageRole.owner;
    final isSystem = message.role == NodMessageRole.system;
    final maxWidth = math.min(MediaQuery.sizeOf(context).width * 0.78, 560.0);
    final attachments = attachmentsRepository == null
        ? const SizedBox.shrink()
        : Wrap(
            spacing: 8,
            runSpacing: 8,
            children: [
              for (final artifact in message.attachments)
                if (artifact.mimeType.toLowerCase().startsWith('audio/'))
                  AudioMessage(
                    key: ValueKey(artifact.id),
                    artifact: artifact,
                    repository: attachmentsRepository!,
                    active: active,
                  )
                else
                  AttachmentTile(
                    artifact: artifact,
                    repository: attachmentsRepository!,
                  ),
            ],
          );
    final text = Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      mainAxisSize: MainAxisSize.min,
      children: [
        if (message.text.isNotEmpty)
          Text(
            message.text,
            key: ValueKey('message-text-${message.id}'),
            style: Theme.of(context).textTheme.bodyLarge,
          ),
        attachments,
      ],
    );
    Widget content;
    if (isSystem) {
      content = Align(
        child: Container(
          constraints: BoxConstraints(maxWidth: maxWidth),
          margin: const EdgeInsets.only(bottom: NodSpacing.lg),
          padding: const EdgeInsets.symmetric(
            horizontal: NodSpacing.md,
            vertical: NodSpacing.sm,
          ),
          decoration: BoxDecoration(
            color: colors.surfaceContainerLow,
            borderRadius: BorderRadius.circular(NodRadii.control),
          ),
          child: DefaultTextStyle.merge(
            style: TextStyle(color: colors.onSurfaceVariant),
            child: text,
          ),
        ),
      );
    } else if (isOwner) {
      content = Opacity(
        opacity: flightTargetKey == null ? 1 : 0,
        child: Align(
          alignment: Alignment.centerRight,
          child: AnimatedContainer(
            duration: reducedMotion ? Duration.zero : Durations.short3,
            constraints: BoxConstraints(maxWidth: maxWidth),
            margin: const EdgeInsets.only(bottom: NodSpacing.lg),
            padding: const EdgeInsets.symmetric(
              horizontal: NodSpacing.md,
              vertical: NodSpacing.sm,
            ),
            decoration: BoxDecoration(
              color: colors.primaryContainer,
              borderRadius: BorderRadius.circular(NodRadii.dialog),
              border: message.isPending
                  ? Border.all(color: colors.outlineVariant)
                  : null,
            ),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              mainAxisSize: MainAxisSize.min,
              children: [
                DefaultTextStyle.merge(
                  style: TextStyle(color: colors.onPrimaryContainer),
                  child: KeyedSubtree(key: flightTargetKey, child: text),
                ),
                if (message.isPending) ...[
                  const SizedBox(height: NodSpacing.xxs),
                  Text(
                    'Sending…',
                    key: const Key('pending-message-label'),
                    style: Theme.of(context).textTheme.labelSmall
                        ?.copyWith(color: colors.onPrimaryContainer),
                  ),
                ],
              ],
            ),
          ),
        ),
      );
    } else {
      content = Padding(
        padding: const EdgeInsets.only(bottom: NodSpacing.xl),
        child: Row(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            const Padding(
              padding: EdgeInsets.only(top: NodSpacing.xxs),
              child: NodBrandMark(size: 24, semanticLabel: ''),
            ),
            const SizedBox(width: NodSpacing.sm),
            Expanded(
              child: DefaultTextStyle.merge(
                style: TextStyle(color: colors.onSurface),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    if (message.text.isNotEmpty)
                      AgentMessageBody(
                        text: message.text,
                        streaming: streaming,
                        active: active,
                        onArtifactLink: (href, label) {
                          final proposal = RegExp(
                            r'^/apps\?connect=([a-fA-F0-9]{8}(?:-[a-fA-F0-9]{4}){3}-[a-fA-F0-9]{12})$',
                          ).firstMatch(href);
                          if (proposal != null && transport != null) {
                            Navigator.of(context).push(
                              MaterialPageRoute<void>(
                                builder: (_) => NodConnectionSetupPage(
                                  repository:
                                      NodConnectionsManagementRepository(
                                        transport!,
                                      ),
                                  name: label,
                                  discoveryId: proposal[1],
                                ),
                              ),
                            );
                            return true;
                          }
                          final preparedId = preparedIdFromLink(href);
                          if (preparedId != null && transport != null) {
                            Navigator.of(context).push(
                              MaterialPageRoute<void>(
                                builder: (_) => Scaffold(
                                  appBar: AppBar(
                                    title: const Text('Prepared work'),
                                  ),
                                  body: NodPreparedPage(
                                    transport: transport!,
                                    issueId: preparedId,
                                  ),
                                ),
                              ),
                            );
                            return true;
                          }
                          final ref = NodPrivateRequestRef.fromLink(href);
                          if (ref != null && transport != null) {
                            Navigator.of(context).push(
                              MaterialPageRoute<void>(
                                builder: (_) => NodPrivateRequestsPage(
                                  transport: transport!,
                                  initialRequest: ref,
                                ),
                              ),
                            );
                            return true;
                          }
                          final uri = Uri.tryParse(href);
                          if (uri == null ||
                              uri.hasScheme ||
                              uri.hasAuthority) {
                            return false;
                          }
                          final artifact = message.attachments
                              .where(
                                (item) =>
                                    uri.path == '/api/artifacts/${item.id}',
                              )
                              .firstOrNull;
                          if (artifact == null ||
                              attachmentsRepository == null) {
                            return false;
                          }
                          showDialog<void>(
                            context: context,
                            builder: (_) => NodArtifactPreview(
                              artifact: artifact,
                              repository: attachmentsRepository!,
                            ),
                          );
                          return true;
                        },
                        key: ValueKey('message-text-${message.id}'),
                      ),
                    if (message.presentation != null)
                      NodRichResult(
                        result: message.presentation!,
                        artifacts: message.attachments,
                        repository: attachmentsRepository,
                        onOpenApps: transport is NodAppsRepository
                            ? () => Navigator.of(context).push(
                                MaterialPageRoute<void>(
                                  builder: (_) => Scaffold(
                                    appBar: AppBar(title: const Text('Apps')),
                                    body: NodAppsPage(
                                      repository:
                                          transport! as NodAppsRepository,
                                    ),
                                  ),
                                ),
                              )
                            : null,
                      ),
                    attachments,
                  ],
                ),
              ),
            ),
          ],
        ),
      );
    }
    return Semantics(
      label: message.attachments.isEmpty
          ? _messageLabel(message)
          : (isOwner ? 'You' : 'Nod'),
      liveRegion: message.isStreaming,
      excludeSemantics:
          message.attachments.isEmpty && message.presentation == null,
      child: content,
    );
  }
}

class _StatusArea extends StatelessWidget {
  const _StatusArea({required this.controller});

  final ChatController controller;

  @override
  Widget build(BuildContext context) {
    final failure = controller.failure;
    return Column(
      mainAxisSize: MainAxisSize.min,
      children: [
        if (failure == null)
          _ConnectionStatus(connection: controller.connection),
        if (failure != null)
          _FailureBanner(
            failure: failure,
            onRetry: failure.canRetry ? controller.retry : null,
          ),
      ],
    );
  }
}

class _ConnectionStatus extends StatelessWidget {
  const _ConnectionStatus({required this.connection});
  final NodConnectionState connection;

  @override
  Widget build(BuildContext context) {
    if (connection.phase == NodConnectionPhase.connected) {
      return const SizedBox.shrink();
    }
    final state =
        connection.phase == NodConnectionPhase.connecting ||
            connection.phase == NodConnectionPhase.reconnecting
        ? NodMotionState.connecting
        : connection.phase == NodConnectionPhase.offline
        ? NodMotionState.offline
        : NodMotionState.idle;
    final colors = Theme.of(context).colorScheme;
    final label = switch (connection.phase) {
      NodConnectionPhase.connecting => 'Connecting',
      NodConnectionPhase.reconnecting => 'Reconnecting',
      NodConnectionPhase.offline => 'Offline',
      NodConnectionPhase.disconnected => 'Disconnected',
      NodConnectionPhase.connected => '',
    };
    return Semantics(
      liveRegion: true,
      label: label,
      excludeSemantics: true,
      child: Container(
        key: const Key('chat-turn-status'),
        width: double.infinity,
        padding: const EdgeInsets.symmetric(horizontal: 20, vertical: 8),
        decoration: BoxDecoration(
          color: colors.surfaceContainerLow,
          border: Border(bottom: BorderSide(color: colors.outlineVariant)),
        ),
        child: Center(
          child: ConstrainedBox(
            constraints: const BoxConstraints(maxWidth: 760),
            child: Row(
              children: [
                ExcludeSemantics(child: NodPresence(state: state, size: 24)),
                const SizedBox(width: 8),
                Expanded(
                  child: Text(
                    label,
                    style: Theme.of(context).textTheme.labelLarge
                        ?.copyWith(color: colors.onSurfaceVariant),
                  ),
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }
}

class _FailureBanner extends StatelessWidget {
  const _FailureBanner({required this.failure, required this.onRetry});

  final ChatFailure failure;
  final VoidCallback? onRetry;

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).colorScheme;
    final title = _failureTitle(failure.kind);
    final detail = _failureText(failure);
    final bodySize = Theme.of(context).textTheme.bodyMedium?.fontSize ?? 14;
    final scaledBodySize = MediaQuery.textScalerOf(context).scale(bodySize);
    final summary = Semantics(
      container: true,
      liveRegion: true,
      label: '$title. $detail',
      excludeSemantics: true,
      child: Row(
        children: [
          ExcludeSemantics(
            child: NodPresence(
              state: failure.kind == ChatFailureKind.offline
                  ? NodMotionState.offline
                  : NodMotionState.error,
              size: 24,
            ),
          ),
          const SizedBox(width: NodSpacing.sm),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  title,
                  style: Theme.of(context).textTheme.labelLarge
                      ?.copyWith(color: colors.onErrorContainer),
                ),
                const SizedBox(height: NodSpacing.xxs),
                Text(
                  detail,
                  style: Theme.of(context).textTheme.bodyMedium
                      ?.copyWith(color: colors.onErrorContainer),
                ),
              ],
            ),
          ),
        ],
      ),
    );
    return Material(
      color: colors.errorContainer,
      child: Padding(
        key: Key('chat-failure-${failure.kind.name}'),
        padding: const EdgeInsets.fromLTRB(20, 10, 12, 10),
        child: Center(
          child: ConstrainedBox(
            constraints: const BoxConstraints(maxWidth: 760),
            child: LayoutBuilder(
              builder: (context, constraints) {
                final stackRetry =
                    onRetry != null &&
                    constraints.maxWidth < 480 &&
                    scaledBodySize >= bodySize * 1.5;
                final retry = TextButton(
                  key: const Key('chat-retry'),
                  onPressed: onRetry,
                  child: const Text('Retry'),
                );
                if (stackRetry) {
                  return Column(
                    crossAxisAlignment: CrossAxisAlignment.stretch,
                    children: [
                      summary,
                      Align(alignment: Alignment.centerRight, child: retry),
                    ],
                  );
                }
                return Row(
                  children: [
                    Expanded(child: summary),
                    if (onRetry != null) retry,
                  ],
                );
              },
            ),
          ),
        ),
      ),
    );
  }
}

class _AnswerChoices extends StatefulWidget {
  const _AnswerChoices({
    required this.message,
    required this.controller,
    super.key,
  });

  final ChatMessageItem message;
  final ChatController controller;

  @override
  State<_AnswerChoices> createState() => _AnswerChoicesState();
}

class _AnswerChoicesState extends State<_AnswerChoices> {
  final Set<String> _selected = {};

  @override
  Widget build(BuildContext context) {
    final choices = widget.message.answerChoices!;
    final enabled =
        widget.controller.canCompose &&
        widget.controller.connection.phase == NodConnectionPhase.connected;
    return Padding(
      padding: const EdgeInsets.symmetric(horizontal: 24),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          for (final option in choices.options)
            if (choices.multiple)
              CheckboxListTile(
                value: _selected.contains(option.id),
                title: Text(option.label),
                subtitle: option.description == null
                    ? null
                    : Text(option.description!),
                onChanged: enabled
                    ? (value) => setState(() {
                        value == true
                            ? _selected.add(option.id)
                            : _selected.remove(option.id);
                      })
                    : null,
              )
            else
              OutlinedButton(
                key: ValueKey('answer-${option.id}'),
                onPressed: enabled
                    ? () => unawaited(
                        widget.controller.answerChoices(widget.message, [
                          option.id,
                        ]),
                      )
                    : null,
                child: Text(option.answerText),
              ),
          if (choices.multiple)
            FilledButton(
              onPressed: enabled && _selected.isNotEmpty
                  ? () => unawaited(
                      widget.controller.answerChoices(
                        widget.message,
                        _selected.toList(),
                      ),
                    )
                  : null,
              child: const Text('Send selected answers'),
            ),
          TextButton(
            onPressed: enabled
                ? () => widget.controller.replyTo(widget.message)
                : null,
            child: const Text('Write an answer'),
          ),
        ],
      ),
    );
  }
}

class _QuestionCard extends StatelessWidget {
  const _QuestionCard({
    required this.question,
    required this.enabled,
    required this.onSelected,
  });

  final ChatQuestion question;
  final bool enabled;
  final Future<bool> Function(ChatChoice choice) onSelected;

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).colorScheme;
    final isApproval = question.style == ChatQuestionStyle.approval;
    final choices = isApproval
        ? question.choices.reversed.toList()
        : question.choices;
    final title = isApproval ? 'Nod needs your approval' : 'Nod has a question';
    return Center(
      child: ConstrainedBox(
        constraints: const BoxConstraints(maxWidth: 760),
        child: Semantics(
          container: true,
          liveRegion: true,
          label: '$title. ${question.prompt}',
          child: Container(
            key: Key('chat-question-${question.id}'),
            margin: const EdgeInsets.fromLTRB(
              NodSpacing.xl,
              0,
              NodSpacing.xl,
              NodSpacing.lg,
            ),
            padding: const EdgeInsets.all(NodSpacing.lg),
            decoration: BoxDecoration(
              color: colors.surfaceContainerLow,
              border: Border.all(color: colors.outlineVariant),
              borderRadius: BorderRadius.circular(NodRadii.card),
            ),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                Text(title, style: Theme.of(context).textTheme.titleMedium),
                const SizedBox(height: NodSpacing.xs),
                Text(
                  question.prompt,
                  style: Theme.of(context).textTheme.bodyLarge,
                ),
                const SizedBox(height: NodSpacing.md),
                Wrap(
                  spacing: NodSpacing.xs,
                  runSpacing: NodSpacing.xs,
                  alignment: WrapAlignment.end,
                  children: [
                    for (final (index, choice) in choices.indexed)
                      FocusTraversalOrder(
                        order: NumericFocusOrder(10 + index.toDouble()),
                        child: isApproval && choice == question.choices.first
                            ? FilledButton(
                                key: ValueKey(
                                  'question-choice-${choice.value}',
                                ),
                                onPressed: enabled
                                    ? () => unawaited(onSelected(choice))
                                    : null,
                                child: Text(choice.label),
                              )
                            : OutlinedButton(
                                key: ValueKey(
                                  'question-choice-${choice.value}',
                                ),
                                onPressed: enabled
                                    ? () => unawaited(onSelected(choice))
                                    : null,
                                child: Text(choice.label),
                              ),
                      ),
                  ],
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }
}

class _Composer extends StatelessWidget {
  const _Composer({
    required this.controller,
    required this.focusNode,
    required this.autofocus,
    required this.canSend,
    required this.canStop,
    required this.isSending,
    required this.isStopping,
    required this.hasQuestion,
    required this.onSend,
    required this.onStop,
    required this.onAttach,
    required this.supportsAttachments,
    required this.hasAttachments,
    required this.enabled,
    required this.voice,
    required this.canRecord,
    required this.boundsKey,
  });

  final TextEditingController controller;
  final FocusNode focusNode;
  final bool autofocus;
  final bool canSend;
  final bool canStop;
  final bool isSending;
  final bool isStopping;
  final bool hasQuestion;
  final VoidCallback onSend;
  final VoidCallback onStop;
  final VoidCallback? onAttach;
  final bool supportsAttachments;
  final bool hasAttachments;
  final bool enabled;
  final VoiceDraft? voice;
  final bool canRecord;
  final GlobalKey boundsKey;

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).colorScheme;
    final recording = voice?.recording ?? false;
    final voiceBusy = voice?.busy ?? false;
    final hasAudio = voice?.file != null;
    final showStop =
        canStop && controller.text.trim().isEmpty && !hasAttachments;
    final busy = showStop ? isStopping : isSending;
    final canDiscard = enabled && !isSending && !voiceBusy;
    final microphone = voice == null || hasAudio
        ? null
        : IconButton(
            key: const Key('chat-record'),
            tooltip: 'Record voice message',
            onPressed: canRecord && !voiceBusy
                ? () async {
                    focusNode.unfocus();
                    await AudioPlayback.pauseActive();
                    await voice!.start();
                  }
                : null,
            icon: voiceBusy
                ? const SizedBox.square(
                    dimension: 18,
                    child: CircularProgressIndicator(strokeWidth: 2),
                  )
                : const Icon(Icons.mic_none),
          );
    return Material(
      color: colors.surface,
      child: DecoratedBox(
        decoration: BoxDecoration(
          border: Border(top: BorderSide(color: colors.outlineVariant)),
        ),
        child: SafeArea(
          top: false,
          child: Center(
            child: ConstrainedBox(
              constraints: const BoxConstraints(maxWidth: 800),
              child: Padding(
                padding: const EdgeInsets.fromLTRB(16, 8, 16, 12),
                child: Column(
                  mainAxisSize: MainAxisSize.min,
                  crossAxisAlignment: CrossAxisAlignment.stretch,
                  children: [
                    if (hasAudio)
                      Padding(
                        padding: const EdgeInsets.only(bottom: 8),
                        child: Row(
                          children: [
                            const Icon(Icons.graphic_eq, size: 20),
                            const SizedBox(width: 8),
                            Expanded(
                              child: Text(
                                'Voice message · ${voice!.duration}',
                                style: Theme.of(context).textTheme.bodyMedium,
                              ),
                            ),
                            IconButton(
                              tooltip: 'Discard recording',
                              onPressed: canDiscard ? voice!.discard : null,
                              icon: const Icon(Icons.close),
                            ),
                          ],
                        ),
                      ),
                    Row(
                      crossAxisAlignment: CrossAxisAlignment.end,
                      children: [
                        Expanded(
                          child: recording
                              ? InputDecorator(
                                  decoration: const InputDecoration(
                                    border: OutlineInputBorder(),
                                    contentPadding: EdgeInsets.symmetric(
                                      horizontal: 4,
                                      vertical: 4,
                                    ),
                                  ),
                                  child: Row(
                                    children: [
                                      IconButton(
                                        tooltip: 'Discard recording',
                                        onPressed: canDiscard
                                            ? voice!.discard
                                            : null,
                                        icon: const Icon(Icons.close),
                                      ),
                                      const SizedBox(width: 4),
                                      Icon(
                                        Icons.mic,
                                        size: 18,
                                        color: colors.error,
                                      ),
                                      const SizedBox(width: 8),
                                      Expanded(
                                        child: Text(
                                          'Recording ${voice!.duration}',
                                          style: Theme.of(context)
                                              .textTheme
                                              .bodyMedium,
                                        ),
                                      ),
                                      IconButton(
                                        key: const Key('chat-record-stop'),
                                        tooltip: 'Stop recording',
                                        onPressed: voiceBusy
                                            ? null
                                            : voice!.stop,
                                        icon: const Icon(Icons.stop_rounded),
                                      ),
                                    ],
                                  ),
                                )
                              : FocusTraversalOrder(
                                  key: boundsKey,
                                  order: const NumericFocusOrder(20),
                                  child: CallbackShortcuts(
                                    bindings: <ShortcutActivator, VoidCallback>{
                                      const SingleActivator(
                                        LogicalKeyboardKey.enter,
                                      ): onSend,
                                    },
                                    child: TextField(
                                      key: const Key('chat-composer'),
                                      controller: controller,
                                      focusNode: focusNode,
                                      autofocus: autofocus,
                                      enabled: enabled && !isSending,
                                      minLines: 1,
                                      maxLines: 6,
                                      textCapitalization:
                                          TextCapitalization.sentences,
                                      keyboardType: TextInputType.multiline,
                                      textInputAction: TextInputAction.newline,
                                      decoration: InputDecoration(
                                        hintText: hasAudio
                                            ? 'Add a message…'
                                            : hasQuestion
                                            ? 'Reply or choose an option above'
                                            : 'Message Nod',
                                        border: const OutlineInputBorder(),
                                        prefixIcon: supportsAttachments
                                            ? IconButton(
                                                key: const Key('chat-attach'),
                                                tooltip: 'Attach files',
                                                onPressed: voiceBusy
                                                    ? null
                                                    : onAttach,
                                                icon: const Icon(
                                                  Icons.attach_file,
                                                ),
                                              )
                                            : null,
                                        suffixIcon: microphone,
                                      ),
                                    ),
                                  ),
                                ),
                        ),
                        const SizedBox(width: 8),
                        FocusTraversalOrder(
                          order: const NumericFocusOrder(21),
                          child: IconButton.filled(
                            key: Key(showStop ? 'chat-stop' : 'chat-send'),
                            tooltip: showStop ? 'Stop Nod' : 'Send',
                            onPressed: showStop
                                ? (isStopping ? null : onStop)
                                : (canSend ? onSend : null),
                            icon: busy
                                ? const SizedBox.square(
                                    dimension: 18,
                                    child: CircularProgressIndicator(
                                      strokeWidth: 2,
                                    ),
                                  )
                                : Icon(
                                    showStop
                                        ? Icons.stop_rounded
                                        : Icons.arrow_upward_rounded,
                                  ),
                          ),
                        ),
                      ],
                    ),
                    if (voice?.error != null)
                      Padding(
                        padding: const EdgeInsets.only(top: 8),
                        child: Semantics(
                          liveRegion: true,
                          child: Text(
                            voice!.error!,
                            style: Theme.of(context).textTheme.bodySmall
                                ?.copyWith(color: colors.error),
                          ),
                        ),
                      ),
                  ],
                ),
              ),
            ),
          ),
        ),
      ),
    );
  }
}

String _failureTitle(ChatFailureKind kind) => switch (kind) {
  ChatFailureKind.offline => 'Offline',
  ChatFailureKind.unauthorized => 'Connection needs attention',
  ChatFailureKind.conversationReset => 'Conversation reset',
  ChatFailureKind.audio => 'Couldn’t send voice message',
  ChatFailureKind.unknown => 'Couldn’t load chat',
};

String _failureText(ChatFailure failure) {
  return switch (failure.kind) {
    ChatFailureKind.offline =>
      failure.detail ?? 'You are offline. Reconnect and try again.',
    ChatFailureKind.unauthorized =>
      failure.detail ?? 'This connection is no longer authorized.',
    ChatFailureKind.conversationReset =>
      failure.detail ?? 'This conversation was reset on the server.',
    ChatFailureKind.audio =>
      failure.detail ??
          'Could not send the voice message. Your recording is kept.',
    ChatFailureKind.unknown =>
      failure.detail ?? 'Something went wrong while loading the conversation.',
  };
}

String _messageLabel(ChatMessageItem message) {
  final sender = switch (message.role) {
    NodMessageRole.owner => 'You',
    NodMessageRole.assistant => 'Nod',
    NodMessageRole.system => 'System',
  };
  final state = message.isPending
      ? ', sending'
      : message.isStreaming
      ? ', updating'
      : '';
  return '$sender$state: ${message.text}';
}
