import { readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { basename, resolve, sep } from 'node:path';
import { loadSkills, parseFrontmatter } from '@earendil-works/pi-coding-agent';
import type { SkillLibrary } from '../../ports/agent.ts';

export function createSkillLibrary(
  directory: string | readonly string[],
  excluded: readonly string[] = [],
): SkillLibrary {
  const roots = (typeof directory === 'string' ? [directory] : directory).map((path) =>
    realpathSync(path),
  );
  if (!roots.length) throw new Error('At least one skill directory is required.');
  const checkedPath = (base: string, file: string) => {
    const path = realpathSync(resolve(base, file));
    if (!path.startsWith(base + sep) || !path.endsWith('.md'))
      throw new Error('The skill file must be a Markdown file inside its skill directory.');
    if (!statSync(path).isFile()) throw new Error('The skill file must be a regular file.');
    return path;
  };
  const skillPaths = roots.flatMap((root, index) =>
    readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
      .filter((entry) => {
        if (!excluded.includes(entry.name)) return true;
        if (index === 0) return false;
        throw new Error(`The app skill ${entry.name} conflicts with a core skill.`);
      })
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((entry) => checkedPath(resolve(root, entry.name), 'SKILL.md')),
  );
  const { skills, diagnostics } = loadSkills({
    cwd: roots[0],
    agentDir: roots[0],
    skillPaths,
    includeDefaults: false,
  });
  if (
    diagnostics.length ||
    new Set(skills.map((skill) => skill.name)).size !== skills.length ||
    skills.length !== skillPaths.length ||
    skills.some((skill) => skill.name !== basename(skill.baseDir))
  )
    throw new Error(
      `The skill metadata is invalid${diagnostics
        .map(
          ({ path, message, collision }, index) =>
            `${index ? ';' : ':'} ${message} in ${collision ? `${collision.winnerPath} and ${collision.loserPath}` : path}`,
        )
        .join('')}.`,
    );
  const enabled = skills.filter((skill) => !skill.disableModelInvocation);
  const byName = new Map(enabled.map((skill) => [skill.name, skill.baseDir]));
  const toolsOf = (path: string) =>
    [parseFrontmatter(readFileSync(path, 'utf8')).frontmatter.tools]
      .flat()
      .filter((tool): tool is string => typeof tool === 'string');
  const toolsByName = new Map([
    ...excluded.flatMap((name) => {
      try {
        return [[name, toolsOf(checkedPath(resolve(roots[0], name), 'SKILL.md'))] as const];
      } catch {
        return [];
      }
    }),
    ...enabled.map((skill) => [skill.name, toolsOf(skill.filePath)] as const),
  ]);
  return {
    core: excluded,
    catalog: enabled.map(({ name, description }) => ({ name, description: description.trim() })),
    read(name: string, file = 'SKILL.md') {
      const base =
        byName.get(name) ?? (excluded.includes(name) ? resolve(roots[0], name) : undefined);
      if (!base || !roots.some((root) => base.startsWith(root + sep)))
        throw new Error('Select a skill from the skill library.');
      return { name, file, content: readFileSync(checkedPath(base, file), 'utf8').trim() };
    },
    tools: (name) => toolsByName.get(name) ?? [],
  };
}
