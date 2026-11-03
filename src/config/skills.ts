import fs from 'node:fs';
import path from 'node:path';
import { ASSETS_DIR, exists, readSettings, shellWord } from '../util.js';
import { PARTS_DIR, codeSearchErrors, codeSearchFor, codeSearchGuide } from './codeSearch.js';
import { AGENT_STAGES, type AgentStage } from '../pipeline/context.js';
import { NOTES_DIR, toolNoteSections, withHeading } from './toolNotes.js';
import { layout, resolve, testFiles, testFramework } from './settings.js';

export const SKILLS_DIR = path.join(ASSETS_DIR, 'skills');

/** A skill or prompt template with {{CODE_SEARCH}} filled in. */
export const renderTemplate = (text: string, guide: string): string => text.split('{{CODE_SEARCH}}').join(guide);

/** The names of the skills the package ships. */
export const skillNames = (skillsDir = SKILLS_DIR): string[] =>
  fs.readdirSync(skillsDir).filter(f => f.endsWith('.md')).map(f => f.replace(/\.md$/, '')).sort();

/**
 * The skill <name> for the project at <root>: {{CODE_SEARCH}} filled for the code indexer in use (or Grep/Glob), and
 * {{TEST_DIR}}, {{TEST_FILES}}, {{TEST_CMD}}, {{TEST_FRAMEWORK}}, {{BACKLOG_DIR}}, {{BRANCH_PREFIX}} and {{TEST_PATHSPECS}}
 * from the settings; when they cannot be resolved, wording that tells the agent to find out. Null for an unknown skill.
 */
export function renderSkill(name: string, root: string, { env = process.env, skillsDir = SKILLS_DIR, partsDir = PARTS_DIR, notesDirs = [NOTES_DIR] }: {
  env?: NodeJS.ProcessEnv; skillsDir?: string; partsDir?: string; notesDirs?: string[];
} = {}): string | null {
  if (!/^[a-z0-9-]+$/.test(name) || !exists(path.join(skillsDir, `${name}.md`))) return null;
  const file = readSettings(root);
  const search = codeSearchFor(root, codeSearchErrors(file).length ? {} : file, env);
  const { config } = resolve(root, { env });
  const values: Record<string, string> = config ? {
    TEST_DIR: layout(config).testDirs.join(', '), TEST_FILES: testFiles(config), TEST_CMD: layout(config).testCmd,
    TEST_FRAMEWORK: testFramework(config), BACKLOG_DIR: config.backlogDir, BRANCH_PREFIX: config.git.branchPrefix,
    TEST_PATHSPECS: layout(config).testPathspecs.map(shellWord).join(' '),
  } : {
    TEST_DIR: "the project's test folder", TEST_FILES: "the project's test files", TEST_CMD: "the project's test command",
    TEST_FRAMEWORK: 'tests in the style the project already uses',
    BACKLOG_DIR: (typeof file.backlogDir === 'string' && file.backlogDir) || 'Docs/backlog',
    BRANCH_PREFIX: 'sdlc/', TEST_PATHSPECS: '<the test files>',
  };
  let text = renderTemplate(fs.readFileSync(path.join(skillsDir, `${name}.md`), 'utf8'), codeSearchGuide(search, root, partsDir));
  for (const [k, v] of Object.entries(values)) text = text.split(`{{${k}}}`).join(v);
  if (config) {
    const stages: AgentStage[] = name === 'tdd-loop' ? ['red-tests', 'implement']
      : (AGENT_STAGES as readonly string[]).includes(name) ? [name as AgentStage] : [];
    const notes = withHeading(stages.flatMap(st => toolNoteSections(st, config, 'skill', { dirs: notesDirs })));
    if (notes) text = `${text.replace(/\n+$/, '')}\n\n${notes}\n`;
  }
  return text;
}
