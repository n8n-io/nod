import { readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { basename, resolve, sep } from 'node:path';
import { loadSkills } from '@earendil-works/pi-coding-agent';
import type { SkillLibrary } from '../../ports/agent.ts';

export function createSkillLibrary(
  directory: string,
  excluded: readonly string[] = [],
): SkillLibrary {
  const root = realpathSync(directory);
  const checkedPath = (base: string, file: string) => {
    const path = realpathSync(resolve(base, file));
    if (!path.startsWith(base + sep) || !path.endsWith('.md'))
      throw new Error('The skill file must be a Markdown file inside its skill directory.');
    if (!statSync(path).isFile()) throw new Error('The skill file must be a regular file.');
    return path;
  };
  const skillPaths = readdirSync(root, { withFileTypes: true })
    .filter(
      (entry) =>
        entry.isDirectory() && !entry.name.startsWith('.') && !excluded.includes(entry.name),
    )
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((entry) => checkedPath(resolve(root, entry.name), 'SKILL.md'));
  const { skills, diagnostics } = loadSkills({
    cwd: root,
    agentDir: root,
    skillPaths,
    includeDefaults: false,
  });
  if (
    diagnostics.length ||
    skills.length !== skillPaths.length ||
    skills.some((skill) => skill.name !== basename(skill.baseDir))
  )
    throw new Error('The skill metadata is invalid.');
  const enabled = skills.filter((skill) => !skill.disableModelInvocation);
  const byName = new Map(enabled.map((skill) => [skill.name, skill.baseDir]));
  return {
    core: excluded,
    catalog: enabled.map(({ name, description }) => ({ name, description: description.trim() })),
    read(name: string, file = 'SKILL.md') {
      const base = byName.get(name) ?? (excluded.includes(name) ? resolve(root, name) : undefined);
      if (!base || !base.startsWith(root + sep))
        throw new Error('Select a skill from the skill library.');
      return { name, file, content: readFileSync(checkedPath(base, file), 'utf8').trim() };
    },
  };
}
