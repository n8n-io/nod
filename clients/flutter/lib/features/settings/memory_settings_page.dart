import 'package:flutter/material.dart';
import 'package:share_plus/share_plus.dart';

import '../../api/settings_repository.dart';
import '../../core/settings.dart';
import 'settings_media.dart';
import 'settings_widgets.dart';

class NodMemorySettingsPage extends StatefulWidget {
  const NodMemorySettingsPage({
    super.key,
    required this.repository,
    this.onShowMessage,
  });
  final NodSettingsRepository repository;
  final ValueChanged<String>? onShowMessage;
  @override
  State<NodMemorySettingsPage> createState() => _NodMemorySettingsPageState();
}

class _NodMemorySettingsPageState extends State<NodMemorySettingsPage> {
  String filter = 'All';
  String search = '';
  NodSettingsRepository get repository => widget.repository;
  Future<void> note(
    BuildContext context,
    SettingsSectionState state,
    Map<String, Object?>? note,
  ) async {
    var area = note?['area'] as String? ?? 'about';
    if (note == null) {
      final selected = await showDialog<String>(
        context: context,
        builder: (context) => SimpleDialog(
          title: const Text('Note category'),
          children: [
            for (var i = 0; i < memoryAreas.length; i++)
              SimpleDialogOption(
                onPressed: () => Navigator.pop(context, memoryAreas[i]),
                child: Text(memoryLabels[i]),
              ),
          ],
        ),
      );
      if (selected == null || !context.mounted) return;
      area = selected;
    }
    if (await editSettings(
      context,
      SettingsEditPage(
        title: note == null ? 'Add note' : 'Edit note',
        fields: {
          'Note': note?['text'] as String? ?? '',
          'End date': note?['expires'] as String? ?? '',
        },
        multiline: const {'Note'},
        limits: const {'Note': 4000},
        help: 'One fact per note. End date is optional, in YYYY-MM-DD format. Never include passwords, codes, card details, or instructions to act.',
        save: (values) async {
          final expires = values['End date']!.trim();
          if (note == null) {
            await repository.addNote(
              area,
              values['Note']!,
              expires: expires.isEmpty ? null : expires,
            );
          } else {
            await repository.editNote(settingsText(note, 'path'), {
              'text': values['Note'],
              'expires': expires.isEmpty ? null : expires,
            });
          }
        },
      ),
    )) {
      await state.reload();
    }
  }

  @override
  Widget build(BuildContext context) => SettingsSection(
    title: 'Memory',
    load: repository.memory,
    builder: (context, data, state) {
      final notes = settingsRows(data['notes']);
      final archive = settingsRows(data['archive']);
      final skills = settingsRows(data['skills']);
      bool matches(Map<String, Object?> item) =>
          [
            item['text'],
            item['name'],
            item['description'],
            item['body'],
          ].whereType<String>().any(
            (value) => value.toLowerCase().contains(search.toLowerCase()),
          );
      return ListView(
        padding: const EdgeInsets.all(12),
        children: [
          SwitchListTile(
            title: const Text('Save new notes'),
            value: data['saving'] == true,
            onChanged: (value) => state.change(
              () => repository.saveMemorySettings({'saving': value}),
            ),
          ),
          SwitchListTile(
            title: const Text('Include sensitive details'),
            subtitle: const Text(
              'Allow background learning about health, religion, politics, and similar topics.',
            ),
            value: data['sensitive'] == true,
            onChanged: (value) async {
              if (!value ||
                  await confirmSettings(
                    context,
                    'Include sensitive details?',
                    'Allow Nod to learn sensitive details from your own messages in the background?',
                  )) {
                await state.change(
                  () => repository.saveMemorySettings({'sensitive': value}),
                );
              }
            },
          ),
          const Text(
            'Memory is context, not permission. Actions still pass the trust check.',
          ),
          Wrap(
            spacing: 8,
            children: [
              TextButton(
                onPressed: () => note(context, state, null),
                child: const Text('Add note'),
              ),
              TextButton(
                onPressed: () async {
                  await Navigator.push<void>(
                    context,
                    MaterialPageRoute(
                      builder: (_) => _MemoryImportPage(repository: repository),
                    ),
                  );
                  await state.reload();
                },
                child: const Text('Import'),
              ),
              TextButton(
                onPressed: () => state.run(() async {
                  final box = context.findRenderObject() as RenderBox?;
                  final origin = box == null
                      ? null
                      : box.localToGlobal(Offset.zero) & box.size;
                  await shareMemoryMarkdown(
                    repository,
                    isActive: () => mounted,
                    share: (file) async {
                      await SharePlus.instance.share(
                        ShareParams(
                          files: [XFile(file.path, mimeType: 'text/markdown')],
                          fileNameOverrides: const ['nod-memory.md'],
                          sharePositionOrigin: origin,
                        ),
                      );
                    },
                  );
                }),
                child: const Text('Export Markdown'),
              ),
            ],
          ),
          TextField(
            decoration: const InputDecoration(
              labelText: 'Search notes and skills',
            ),
            onChanged: (value) => setState(() => search = value),
          ),
          Wrap(
            spacing: 6,
            children: [
              for (final value in [
                'All',
                'Confirmed',
                'Learned',
                'Mentioned once',
                'Let go',
                'Skills',
              ])
                ChoiceChip(
                  label: Text(value),
                  selected: filter == value,
                  onSelected: (_) => setState(() => filter = value),
                ),
            ],
          ),
          if (filter != 'Let go' && filter != 'Skills')
            ...notes
                .where(
                  (item) =>
                      matches(item) &&
                      (filter == 'All' ||
                          item['status'] ==
                              {
                                'Confirmed': 'stated',
                                'Learned': 'observed',
                                'Mentioned once': 'tentative',
                              }[filter]),
                )
                .map(
                  (item) => Card(
                    child: ExpansionTile(
                      title: Text(settingsText(item, 'text')),
                      subtitle: Text('${item['area']} · ${item['status']}'),
                      children: [
                        ListTile(
                          title: const Text('Details'),
                          subtitle: Text(
                            'Updated: ${item['updated']}\nEdited: ${item['edited'] ?? 'Not edited'}\nEnd date: ${item['expires'] ?? 'None'}${item['learnedFrom'] == 'email' ? '\nLearned from your sent email' : ''}',
                          ),
                        ),
                        for (final source in settingsRows(item['sources']))
                          ListTile(
                            title: Text(
                              source['text'] as String? ??
                                  'Source message unavailable',
                            ),
                            subtitle: Text(
                              '${source['channel'] ?? ''} ${source['at'] ?? ''}',
                            ),
                            trailing:
                                widget.onShowMessage != null &&
                                    source['canOpenInCurrentChat'] == true &&
                                    source['id'] is String &&
                                    (source['id'] as String).isNotEmpty
                                ? TextButton(
                                    onPressed: () => widget.onShowMessage!(
                                      source['id'] as String,
                                    ),
                                    child: const Text('Show message'),
                                  )
                                : null,
                          ),
                        Wrap(
                          children: [
                            TextButton(
                              onPressed: () => note(context, state, item),
                              child: const Text('Edit'),
                            ),
                            if (item['status'] != 'stated')
                              TextButton(
                                onPressed: () => state.change(
                                  () => repository.editNote(
                                    settingsText(item, 'path'),
                                    {'confirm': true},
                                  ),
                                ),
                                child: const Text('Confirm note'),
                              ),
                            TextButton(
                              onPressed: () => state.change(
                                () => repository.archiveNote(
                                  settingsText(item, 'path'),
                                ),
                              ),
                              child: const Text('Archive'),
                            ),
                            TextButton(
                              onPressed: () async {
                                if (await confirmSettings(
                                  context,
                                  'Forget note?',
                                  'Permanently delete this note and its archived versions?',
                                )) {
                                  await state.change(
                                    () => repository.forgetNote(
                                      settingsText(item, 'path'),
                                    ),
                                  );
                                }
                              },
                              child: const Text('Forget'),
                            ),
                          ],
                        ),
                      ],
                    ),
                  ),
                ),
          if (filter == 'Let go')
            ...archive
                .where(matches)
                .map(
                  (item) => Card(
                    child: ListTile(
                      title: Text(settingsText(item, 'text')),
                      subtitle: Text('${item['reason']} · ${item['archived']}'),
                      trailing: PopupMenuButton<String>(
                        onSelected: (value) async {
                          if (value == 'restore' ||
                              await confirmSettings(
                                context,
                                'Forget archived note?',
                                'Permanently delete this archived version?',
                              )) {
                            await state.change(
                              () => repository.archivedNote(
                                item,
                                restore: value == 'restore',
                              ),
                            );
                          }
                        },
                        itemBuilder: (_) => const [
                          PopupMenuItem(
                            value: 'restore',
                            child: Text('Bring back'),
                          ),
                          PopupMenuItem(value: 'forget', child: Text('Forget')),
                        ],
                      ),
                    ),
                  ),
                ),
          if (filter == 'Skills')
            ...skills
                .where(matches)
                .map(
                  (item) => Card(
                    child: ExpansionTile(
                      title: Text(settingsText(item, 'name')),
                      subtitle: Text(settingsText(item, 'description')),
                      children: [
                        Padding(
                          padding: const EdgeInsets.all(16),
                          child: SelectableText(settingsText(item, 'body')),
                        ),
                        ListTile(
                          subtitle: Text(
                            'Learned: ${item['learned']}\nUpdated: ${item['updated']}\nTask: ${item['task'] ?? 'Unavailable'}',
                          ),
                        ),
                        Wrap(
                          children: [
                            TextButton(
                              onPressed: () async {
                                if (await editSettings(
                                  context,
                                  SettingsEditPage(
                                    title: 'Edit skill',
                                    fields: {
                                      'Description': settingsText(
                                        item,
                                        'description',
                                      ),
                                      'Steps': settingsText(item, 'body'),
                                    },
                                    limits: const {
                                      'Description': 200,
                                      'Steps': 6000,
                                    },
                                    multiline: const {'Steps'},
                                    save: (values) async {
                                      await repository.editSkill(
                                        settingsText(item, 'name'),
                                        values['Description']!,
                                        values['Steps']!,
                                      );
                                    },
                                  ),
                                )) {
                                  await state.reload();
                                }
                              },
                              child: const Text('Edit'),
                            ),
                            TextButton(
                              onPressed: () async {
                                if (await confirmSettings(
                                  context,
                                  'Forget skill?',
                                  'Permanently delete this learned procedure?',
                                )) {
                                  await state.change(
                                    () => repository.forgetSkill(
                                      settingsText(item, 'name'),
                                    ),
                                  );
                                }
                              },
                              child: const Text('Forget'),
                            ),
                          ],
                        ),
                      ],
                    ),
                  ),
                ),
          if (notes.isEmpty && skills.isEmpty && archive.isEmpty)
            const ListTile(title: Text('Nothing remembered yet')),
        ],
      );
    },
  );
}

class _MemoryImportPage extends StatefulWidget {
  const _MemoryImportPage({required this.repository});
  final NodSettingsRepository repository;
  @override
  State<_MemoryImportPage> createState() => _MemoryImportPageState();
}

class _MemoryImportPageState extends State<_MemoryImportPage> {
  final input = TextEditingController();
  List<NodMemoryImportNote>? notes;
  final excluded = <int>{};
  bool busy = false;
  String? error;
  Map<String, Object?>? result;
  @override
  void dispose() {
    input.clear();
    input.dispose();
    super.dispose();
  }

  Future<void> save() async {
    setState(() {
      busy = true;
      error = null;
    });
    try {
      final saved = await widget.repository.importNotes([
        for (var i = 0; i < notes!.length; i++)
          if (!excluded.contains(i)) notes![i],
      ]);
      if (mounted) setState(() => result = saved);
    } catch (cause) {
      if (mounted) setState(() => error = settingsError(cause));
    } finally {
      if (mounted) setState(() => busy = false);
    }
  }

  @override
  Widget build(BuildContext context) => Scaffold(
    appBar: AppBar(title: const Text('Import memory')),
    body: ListView(
      padding: const EdgeInsets.all(16),
      children: [
        const Text(
          'Paste notes from another assistant. Use one fact per bullet under About you, Preferences, People, Routines, or Lessons headings. Review before importing. Secrets and duplicates are skipped by the server.',
        ),
        if (notes == null) ...[
          TextField(
            controller: input,
            maxLines: 12,
            maxLength: 100000,
            decoration: const InputDecoration(labelText: 'Notes to import'),
          ),
          FilledButton(
            onPressed: () => setState(() {
              notes = parseNodMemoryImport(input.text);
              excluded.clear();
            }),
            child: const Text('Review notes'),
          ),
        ] else if (result != null) ...[
          Text('Import result: ${result!['imported']}'),
          FilledButton(
            onPressed: () => Navigator.pop(context),
            child: const Text('Done'),
          ),
        ] else ...[
          for (var i = 0; i < notes!.length; i++)
            CheckboxListTile(
              value: !excluded.contains(i),
              title: Text(notes![i].text),
              subtitle: Text(notes![i].area),
              onChanged: busy
                  ? null
                  : (value) => setState(() {
                      if (value == true) {
                        excluded.remove(i);
                      } else {
                        excluded.add(i);
                      }
                    }),
            ),
          if (error != null) Text(error!),
          FilledButton(
            onPressed: busy || notes!.length == excluded.length ? null : save,
            child: Text(busy ? 'Importing' : 'Import selected notes'),
          ),
          TextButton(
            onPressed: busy ? null : () => setState(() => notes = null),
            child: const Text('Back'),
          ),
        ],
      ],
    ),
  );
}
