import { resumecheck } from '../testcheck/checks.js';
import type { Ctx } from './context.js';

/** The command that resumes this run at <stage>. */
/** Maps a stage name to a valid pipeline --from stage value. */
export const toFromStage = (stage: string, hasTestIssues = false): string => {
  const norm = (stage || '').toLowerCase().replace(/\s+/g, '-');
  if (norm.includes('resolve-conflicts')) return 'resolve-conflicts';
  if (norm.includes('finalise')) return 'finalise';
  if (norm.includes('review')) return 'review';
  if (norm.includes('repair')) return hasTestIssues ? 'test-repair' : 'implement';
  if (norm.includes('implement')) return 'implement';
  if (norm.includes('plan')) return 'plan';
  if (norm.includes('red')) return 'red-tests';
  return 'spec';
};

export const resumeCommand = (slug: string, stage: string): string => `ai-sdlc-helper pipeline ${slug} --from ${stage}`;

/** The stage names a FROM key stands for, as the run page and the recovery hint show them. */
const FROM_NAMES: Record<string, string> = {
  spec: 'Spec', plan: 'Plan', 'red-tests': 'Red tests', implement: 'Implement',
  'test-repair': 'Test repair', review: 'Review', finalise: 'Finalise', 'resolve-conflicts': 'Resolve conflicts',
};

export interface StageRecovery {
  stage: string;
  diagnosis: string;
  autoAction?: {
    label: string;
    command: string;
    env?: Record<string, string>;
  };
  manualAction?: {
    file?: string;
    instruction: string;
  };
  escapeHatch?: {
    label: string;
    command: string;
  };
}

export interface RecoveryContext {
  slug: string;
  stage: string;
  state?: string;
  exitCode?: number;
  docsDir?: string;
  failLog?: string;
  /** Where the run resumes (a FROM key) when its stop named one: a stop before the first stage names no stage of its own. */
  resumeFrom?: string;
  runOut?: string[];
  questions?: Array<{ n: number; title: string; answer: string; suggested?: string }>;
  permissions?: any[];
  hasTestIssues?: boolean;
}

/** Tells the developer how to resume at Test repair, only when its preconditions (resumecheck) hold now. */
export function resumeHint(ctx: Ctx): void {
  let errs: string[];
  try { errs = resumecheck(ctx.keys, ctx.origRedSha, `${ctx.docs}/test-issues.md`, ctx.slug, ctx.lockSha || undefined); } catch { return; }
  if (!errs.length) ctx.out(`Resume at Test repair once fixed: ${resumeCommand(ctx.slug, 'test-repair')}`);
}


/**
 * The lines the branch sync writes to the run output, and the recovery hints that read them back: one source, so a changed
 * wording cannot silence a hint.
 */
export const syncLines = {
  stashKept: (sha: string, ref: string, stage: string, why: string): string =>
    `BRANCH SYNC: your uncommitted changes from ${stage} are saved in the stash ${sha} (${ref}); ${why}. Get them back with: git stash apply ${sha}`,
  stashParked: (sha: string, ref: string, stage: string, resume: string): string =>
    `BRANCH SYNC: your uncommitted changes from ${stage} are saved in the stash ${sha} (${ref}); not put back, because this run restarts at ${resume}, earlier than ${stage}. Get them back with: git stash apply ${sha}`,
  testsChanged: (files: string[]): string =>
    `BRANCH SYNC: STOPPED: commits that came from GitHub changed the locked test files (${files.join(', ')}). The tests are no longer the ones Red tests locked: restart at Implement to work from them`,
  docsChanged: (kind: 'Spec' | 'Plan', files: string[]): string =>
    `BRANCH SYNC: WARNING: commits that came from GitHub changed the ${kind.toLowerCase()} (${files.join(', ')}) after ${kind} was done; resume at ${kind} to work from it`,
  foreignMoved: (from: string, to: string, commits: string[]): string =>
    `BRANCH SYNC: GitHub's ${from} has commits by someone else (${commits.join('; ')}); they are not brought into this run. The run goes on on ${to}, from its own work. To use those changes, stop the pipeline and make them yourself; to give the agents more context, use the note boxes on the run page`,
  foreignStopped: (from: string, commits: string[]): string =>
    `BRANCH SYNC: STOPPED: GitHub's ${from} has commits by someone else (${commits.join('; ')}), and SDLC_MOVE_BRANCH keeps the run on this branch. They are not brought in: bring them in yourself or let the run move to a new branch, then resume`,
  offline: (why: string): string =>
    `BRANCH SYNC: WARNING: origin could not be reached (${why}): going on offline, with no rebase and no lease push until a fetch succeeds`,
};

/** Recovery for what the branch sync reported, or null when the latest output has none of it. */
function syncRecovery(ctx: RecoveryContext, latest: string, stopping: boolean): StageRecovery | null {
  const stage = ctx.stage || 'Pipeline';
  const stash = /BRANCH SYNC: your uncommitted changes from ([^\n]+?) are saved in the stash (\w+) \(([^)]+)\)/.exec(latest);
  const tests = /BRANCH SYNC: STOPPED: commits that came from GitHub changed the locked test files \(([^)]*)\)/.exec(latest);
  const foreign = /BRANCH SYNC: STOPPED: GitHub's (\S+) has commits by someone else/.exec(latest);
  if (foreign) {
    return {
      stage,
      diagnosis: `GitHub's ${foreign[1]} has commits by someone else, and SDLC_MOVE_BRANCH keeps the run on that branch, so the run stopped instead of taking them in.`,
      autoAction: { label: `Resume at ${stage}`, command: resumeCommand(ctx.slug, toFromStage(ctx.stage)) },
      manualAction: { instruction: 'Bring the commits in yourself (git pull --rebase), or clear SDLC_MOVE_BRANCH so the run moves to a new branch, then resume.' },
    };
  }
  if (tests) {
    return {
      stage,
      diagnosis: `Commits from GitHub changed the locked test files (${tests[1]}), so the red gate no longer describes the tests.`,
      autoAction: { label: 'Restart at Implement', command: resumeCommand(ctx.slug, 'implement') },
      manualAction: { instruction: 'Read the incoming change to the tests; Implement works from the tests as they are now.' },
    };
  }
  if (stash) {
    return {
      stage,
      diagnosis: `Your uncommitted changes from ${stash[1]} are saved in the stash ${stash[2].slice(0, 7)} (${stash[3]}) and were not put back.`,
      autoAction: { label: 'Apply my saved changes', command: `git stash apply ${stash[2]}` },
      manualAction: { instruction: `Resume at ${stage} when the branch is as you want it; the stash is kept until then.` },
      escapeHatch: { label: `Resume at ${stage}`, command: resumeCommand(ctx.slug, toFromStage(stage, ctx.hasTestIssues)) },
    };
  }
  if (stopping) return null;
  const docs = /BRANCH SYNC: WARNING: commits that came from GitHub changed the (spec|plan)/.exec(latest);
  if (docs) {
    const which = docs[1] === 'spec' ? 'spec' : 'plan';
    return {
      stage: which === 'spec' ? 'Spec' : 'Plan',
      diagnosis: `Commits from GitHub changed the ${which} after it was done.`,
      autoAction: { label: `Resume at ${which === 'spec' ? 'Spec' : 'Plan'}`, command: resumeCommand(ctx.slug, which) },
      manualAction: { instruction: 'The run went on with the changed document; resume at that stage to work from it.' },
    };
  }
  if (/BRANCH SYNC: WARNING: origin could not be reached/.test(latest)) {
    return {
      stage,
      diagnosis: 'origin could not be reached, so the branch was not synced with GitHub.',
      autoAction: { label: `Resume at ${stage}`, command: resumeCommand(ctx.slug, toFromStage(stage, ctx.hasTestIssues)) },
      manualAction: { instruction: 'Check the network and your git credentials, then resume.' },
    };
  }
  return null;
}

/** Diagnoses a paused, failed, or stopped stage and provides 3-tuple recovery paths. */
export function stageRecoveryHint(ctx: RecoveryContext): StageRecovery {
  const normStage = (ctx.stage || '').toLowerCase().replace(/\s+/g, '-');
  const tailText = (ctx.runOut || []).join('\n');
  const isPaused = ctx.state === 'paused' || ctx.exitCode === 2;
  const unansweredCount = (ctx.questions || []).filter(q => !q.answer?.trim()).length;
  const pendingPermsCount = (ctx.permissions || []).length;

  // Resuming at Plan or Red tests once the red-tests commit exists is refused before any stage starts. Only the output of the
  // latest run counts (it starts at its "SDLC: <slug> on branch" line): an older refusal in the tail is not this failure.
  const lines = ctx.runOut || [];
  const latest = lines.slice(Math.max(0, lines.map(l => l.startsWith('SDLC: ')).lastIndexOf(true))).join('\n');
  const refused = /FROM=(\S+) but the red-tests commit \w+ already exists/.exec(latest);
  if (refused) {
    const was = refused[1] === 'plan' ? 'Plan' : 'Red tests';
    return {
      stage: was,
      diagnosis: `${was} cannot be resumed: the red-tests commit already exists. Resume at Implement, Test repair or Review, or restart the run to redo it.`,
      autoAction: { label: 'Resume at Implement', command: resumeCommand(ctx.slug, 'implement') },
      manualAction: { instruction: 'Restart the run (discards its branch and worktree) to redo this stage.' },
      escapeHatch: { label: 'Resume at Review', command: resumeCommand(ctx.slug, 'review') },
    };
  }

  // What the branch sync stopped for is the failure; its warnings only explain the fallback below.
  const synced = syncRecovery(ctx, latest, true);
  if (synced) return synced;

  // A stop before the first stage names no stage of its own, and guessing one would be a lie. The status keeps the stage
  // the run started from (resumeFrom): say that it stopped in setup, and resume there.
  const resumeAt = ctx.resumeFrom && FROM_NAMES[ctx.resumeFrom] ? ctx.resumeFrom : '';
  if (!ctx.stage && resumeAt) {
    const name = FROM_NAMES[resumeAt];
    const command = resumeCommand(ctx.slug, resumeAt);
    const error = latest.split('\n').filter(l => /^ERROR: /.test(l)).pop();
    const restart = resumeCommand(ctx.slug, 'spec');
    return {
      stage: `Setup (before ${name})`,
      diagnosis: error ? error.replace(/^ERROR: /, '') : `The run stopped before ${name} started.`,
      autoAction: { label: `Resume at ${name}`, command },
      manualAction: { file: 'logs/run.out', instruction: 'Fix what the error above names, then resume.' },
      // Restarting from Spec is a different command, so it stays on offer as the bailout; when it is the same, it is not.
      ...(command !== restart ? { escapeHatch: { label: 'Resume pipeline from Spec', command: restart } } : {}),
    };
  }

  // A run killed from outside by a signal: the agent did not crash.
  const signalled = /run stopped by (SIG[A-Z0-9]+) \(exit \d+\) during ([^,\n]+)(?:, agent (\S+))?/.exec(latest);
  if (signalled) {
    const [, sig, during, agentName] = signalled;
    const stageName = ctx.stage || during;
    return {
      stage: stageName,
      diagnosis: agentName ? `Agent '${agentName}' was stopped by ${sig} (the run was killed from outside)` : `The run was stopped by ${sig} during ${during} (it was killed from outside)`,
      autoAction: { label: `Resume at ${stageName}`, command: resumeCommand(ctx.slug, toFromStage(stageName, ctx.hasTestIssues)) },
      manualAction: agentName ? { file: `logs/${agentName}.err`, instruction: 'Nothing is wrong with the agent: start the run again from this stage.' } : { instruction: 'Start the run again from this stage.' },
    };
  }

  // The run's supervisor was killed from outside: the run stopped itself rather than go on orphaned.
  const orphaned = /supervisor (\d+) is gone: stopping the run \(it was killed from outside\) during ([^,\n]+)/.exec(latest);
  if (orphaned) {
    const stageName = ctx.stage || orphaned[2];
    return {
      stage: stageName,
      diagnosis: `The run's supervisor (process ${orphaned[1]}) was killed from outside, so the run stopped itself during ${orphaned[2]}`,
      autoAction: { label: `Resume at ${stageName}`, command: resumeCommand(ctx.slug, toFromStage(stageName, ctx.hasTestIssues)) },
      manualAction: { instruction: 'Nothing is wrong with the agent: start the run again from this stage.' },
    };
  }

  // A new test file the project's own static checks reject: only the Red tests agent may fix a test file, so run Red tests again.
  const staticChecks = /RED GATE FAILED: (\d+) static check failure\(s\) in the new test files/.exec(latest);
  if (staticChecks) {
    return {
      stage: 'Red tests',
      diagnosis: `${staticChecks[1]} new test file error(s) fail the project's static checks (lint or typecheck): a test file CI cannot compile or lint cannot be fixed by Implement, which may not edit it.`,
      autoAction: { label: 'Resume at Red tests', command: resumeCommand(ctx.slug, 'red-tests') },
      manualAction: { file: 'logs/red-checks.log', instruction: 'Fix the import or lint error in the test files (never in the source), then run again from Red tests.' },
    };
  }

  // Test names that repeat: the Red tests agent already had its one retry, so run Red tests again (the handoff lists the names).
  const repeats = /RED GATE FAILED: (\d+) test name\(s\) repeat in the new tests/.exec(latest);
  if (repeats) {
    return {
      stage: 'Red tests',
      diagnosis: `${repeats[1]} test name(s) repeat in the new tests: a result cannot tell same-named tests apart.`,
      autoAction: { label: 'Resume at Red tests', command: resumeCommand(ctx.slug, 'red-tests') },
      manualAction: { file: 'logs/tests.log', instruction: 'Give every test, and every row of a parameterised test, a unique name in its file, then run again from Red tests.' },
    };
  }

  // New tests that already pass test behaviour that exists: the spec or plan should have said so, so the fix is there, not in Red tests.
  const already = /RED GATE FAILED: (\d+) new test\(s\) already pass before implementation/.exec(latest);
  if (already) {
    return {
      stage: 'Plan',
      diagnosis: `${already[1]} new test(s) already pass before implementation: they test behaviour that already exists, which the spec or plan did not identify as existing.`,
      autoAction: { label: 'Resume at Plan', command: resumeCommand(ctx.slug, 'plan') },
      manualAction: { file: 'logs/red-passing.md', instruction: 'Mark the behaviour of the passing tests as existing in the spec or plan (logs/handoff.json carries the list to the Plan agent), then run again from Spec or Plan.' },
      escapeHatch: { label: 'Resume at Spec', command: resumeCommand(ctx.slug, 'spec') },
    };
  }

  const agentFailMatch = /agent '([^']+)' failed:\s*([^\n]+)/i.exec(latest)
    || /agent '([^']+)' failed[^\n]*(?:\n\s*failure\s*\([^)]*\):\s*([^\n]+))/i.exec(latest)
    || /agent '([^']+)' failed(?:\s*\([^)]*\))?:\s*([^\n]+)/i.exec(latest)
    || /agent '([^']+)' (?:hit the usage limit|hit quota[^\n]*):\s*([^\n]+)/i.exec(latest)
    || /agent '([^']+)' (?:quota \/ usage limit reached):\s*([^\n]+)/i.exec(latest);
  if (agentFailMatch) {
    const agentName = agentFailMatch[1];
    const reason = (agentFailMatch[2] || 'process exited with error').trim();
    const isQuota = /quota|rate limit|usage limit|RESOURCE_EXHAUSTED/i.test(reason);
    const isModelUnsupported = /model.*(?:not supported|unknown|invalid|not found)/i.test(reason);
    // The stop may name a resume stage that is not the stage shown (an inline Resolve conflicts stop after Plan resumes at
    // Red tests): resume where the run says it will, and name that stage.
    const stageName = ctx.stage || (resumeAt ? FROM_NAMES[resumeAt] : 'Pipeline');
    const resumeKey = resumeAt || toFromStage(stageName, ctx.hasTestIssues);

    if (isModelUnsupported) {
      return {
        stage: stageName,
        diagnosis: `Agent '${agentName}' failed: model not supported with current account (${reason})`,
        autoAction: {
          label: `Switch to supported model & retry ${stageName}`,
          command: `${resumeCommand(ctx.slug, resumeKey)} --model gpt-4o`,
        },
        manualAction: {
          file: `logs/${agentName}.err`,
          instruction: `The configured model is not supported by your signed-in account or credentials. Switch to a supported model in settings or supply an OpenAI API key.`,
        },
        escapeHatch: {
          label: `Resume at Review`,
          command: resumeCommand(ctx.slug, 'review'),
        },
      };
    }

    return {
      stage: stageName,
      diagnosis: isQuota
        ? `Agent '${agentName}' reached quota or rate limit: ${reason}`
        : `Agent '${agentName}' crashed or failed: ${reason}`,
      autoAction: {
        label: isQuota ? `Retry ${stageName} after quota reset` : `Retry ${stageName} stage`,
        command: resumeCommand(ctx.slug, resumeKey),
      },
      manualAction: {
        file: `logs/${agentName}.err`,
        instruction: isQuota
          ? `Check billing/quota limits, or switch model in settings, then resume.`
          : `Inspect error details in logs/${agentName}.err and logs/${agentName}.log, fix CLI/flags, then resume.`,
      },
      escapeHatch: {
        label: `Resume at Review`,
        command: resumeCommand(ctx.slug, 'review'),
      },
    };
  }

  if (normStage === 'spec' || normStage.includes('spec')) {
    if (unansweredCount > 0) {
      return {
        stage: 'Spec',
        diagnosis: `Spec agent generated ${unansweredCount} clarifying question(s) requiring answers before planning.`,
        autoAction: {
          label: 'Auto-answer with suggested defaults & resume Spec',
          command: resumeCommand(ctx.slug, 'spec'),
          env: { SDLC_AUTO_ACCEPT: '1' },
        },
        manualAction: {
          file: 'questions.md',
          instruction: "Answer the questions under '**Answer:**' in questions.md, then resume.",
        },
        escapeHatch: {
          label: 'Bypass Spec stage and proceed directly to Plan',
          command: resumeCommand(ctx.slug, 'plan'),
        },
      };
    }
    if (pendingPermsCount > 0) {
      return {
        stage: 'Spec',
        diagnosis: `Spec agent requested ${pendingPermsCount} tool authorization(s) requiring user permission.`,
        autoAction: {
          label: 'Allow requested permissions & resume',
          command: `ai-sdlc-helper permit ${ctx.slug} allow all`,
        },
        manualAction: {
          file: 'permissions.json',
          instruction: 'Inspect and grant tool permissions in the permissions panel.',
        },
        escapeHatch: {
          label: 'Resume Spec stage with current permissions',
          command: resumeCommand(ctx.slug, 'spec'),
        },
      };
    }
    return {
      stage: 'Spec',
      diagnosis: 'Spec stage halted or agent exited unexpectedly.',
      autoAction: {
        label: 'Retry Spec stage',
        command: resumeCommand(ctx.slug, 'spec'),
      },
      manualAction: {
        file: 'brief.md',
        instruction: 'Review or clarify requirements in brief.md, then resume.',
      },
      escapeHatch: {
        label: 'Provide manual spec.md and resume from Plan',
        command: resumeCommand(ctx.slug, 'plan'),
      },
    };
  }

  if (normStage === 'plan' || normStage.includes('plan')) {
    return {
      stage: 'Plan',
      diagnosis: 'Plan generation stopped or planner agent encountered an error.',
      autoAction: {
        label: 'Retry Plan stage',
        command: resumeCommand(ctx.slug, 'plan'),
      },
      manualAction: {
        file: 'plan-1.md',
        instruction: 'Inspect the generated plan-1.md and add or refine implementation steps.',
      },
      escapeHatch: {
        label: 'Accept current plan draft and proceed to Red Tests',
        command: resumeCommand(ctx.slug, 'red-tests'),
      },
    };
  }

  if (normStage === 'red-tests' || normStage.includes('red')) {
    if (tailText.includes('tests passed at red') || tailText.includes('should fail') || tailText.includes('unexpectedly passed')) {
      return {
        stage: 'Red tests',
        diagnosis: 'Tests passed prematurely on unimplemented code (green on red). Tests must fail before implementation begins.',
        autoAction: {
          label: 'Re-run Red Tests agent with stricter assertion prompt',
          command: resumeCommand(ctx.slug, 'red-tests'),
        },
        manualAction: {
          file: 'logs/red.json',
          instruction: 'Inspect failing test results in logs/red.json and adjust test assertions to verify unbuilt behavior.',
        },
        escapeHatch: {
          label: 'Proceed to Implement with current tests anyway',
          command: resumeCommand(ctx.slug, 'implement'),
        },
      };
    }
    return {
      stage: 'Red tests',
      diagnosis: 'Test suite failed to run, timed out, or encountered a syntax/runner error.',
      autoAction: {
        label: 'Retry Red Tests stage',
        command: resumeCommand(ctx.slug, 'red-tests'),
      },
      manualAction: {
        file: 'logs/tests.log',
        instruction: 'Check runner errors in logs/tests.log, fix imports/syntax, and run npm test locally.',
      },
      escapeHatch: {
        label: 'Verify tests manually with npm test, then resume at Implement',
        command: resumeCommand(ctx.slug, 'implement'),
      },
    };
  }

  if (normStage === 'implement' || normStage.includes('implement')) {
    if (ctx.hasTestIssues) {
      return {
        stage: 'Implement',
        diagnosis: 'Implement agent completed attempts but claimed test defects in test-issues.md.',
        autoAction: {
          label: 'Advance to Test Repair stage to address claimed defects',
          command: resumeCommand(ctx.slug, 'test-repair'),
        },
        manualAction: {
          file: 'test-issues.md',
          instruction: 'Inspect claimed test issues in test-issues.md and verify whether tests or code need adjustment.',
        },
        escapeHatch: {
          label: 'Retry Implement without repairing tests',
          command: resumeCommand(ctx.slug, 'implement'),
        },
      };
    }
    return {
      stage: 'Implement',
      diagnosis: 'Implementation attempts exhausted or test checks still failing.',
      autoAction: {
        label: 'Retry Implementation with a fresh attempt',
        command: resumeCommand(ctx.slug, 'implement'),
      },
      manualAction: {
        file: 'logs/tests.json',
        instruction: 'Inspect failing assertions in logs/tests.json and fix source code or add test-issues.md.',
      },
      escapeHatch: {
        label: 'Proceed to Review with current implementation checkpoint',
        command: resumeCommand(ctx.slug, 'review'),
      },
    };
  }

  if (normStage === 'test-repair' || normStage.includes('repair')) {
    if (tailText.includes('no longer fails on the unimplemented source') || tailText.includes('REJECT: test failed at red')) {
      return {
        stage: 'Test repair',
        diagnosis: 'Test Repair rejected: a repaired test now passes on the original red commit (no longer detects the bug).',
        autoAction: {
          label: 'Retry Test Repair agent with strict redcheck auditing',
          command: resumeCommand(ctx.slug, 'test-repair'),
        },
        manualAction: {
          file: 'test-issues.md',
          instruction: 'Edit the repaired test so it tests the valid contract while still failing on the unimplemented base.',
        },
        escapeHatch: {
          label: 'Discard test repair and resume Implement with original red tests',
          command: resumeCommand(ctx.slug, 'implement'),
        },
      };
    }
    return {
      stage: 'Test repair',
      diagnosis: 'Test Repair stage stopped or failed verification.',
      autoAction: {
        label: 'Retry Test Repair stage',
        command: resumeCommand(ctx.slug, 'test-repair'),
      },
      manualAction: {
        file: 'test-issues.md',
        instruction: 'Review test-issues.md and adjust the test repair specifications.',
      },
      escapeHatch: {
        label: 'Resume Implement directly',
        command: resumeCommand(ctx.slug, 'implement'),
      },
    };
  }

  if (normStage === 'review' || normStage.includes('review')) {
    if (tailText.includes('GUARD FAILED: review modified tests')) {
      return {
        stage: 'Review',
        diagnosis: 'Review guard failed: review agent illegally modified test files.',
        autoAction: {
          label: 'Revert test changes and re-run Review',
          command: resumeCommand(ctx.slug, 'review'),
        },
        manualAction: {
          instruction: 'Discard test file modifications from the working tree (git checkout -- <test_files>).',
        },
        escapeHatch: {
          label: 'Bypass Review and advance to Finalise',
          command: resumeCommand(ctx.slug, 'finalise'),
        },
      };
    }
    return {
      stage: 'Review',
      diagnosis: 'Code review identified blocking issues or checks broke after review.',
      autoAction: {
        label: 'Send review remarks back to Implement for fixes',
        command: resumeCommand(ctx.slug, 'implement'),
      },
      manualAction: {
        file: 'logs/review.log',
        instruction: 'Inspect review findings in logs/review.log and address requested changes in code.',
      },
      escapeHatch: {
        label: 'Approve review findings and advance to Finalise',
        command: resumeCommand(ctx.slug, 'finalise'),
      },
    };
  }

  if (normStage === 'resolve-conflicts') {
    const offered = isPaused && /did not push/.test(tailText);
    // The stage's own plain summary ("What happened: …"), when the tail has one.
    const lastWhat = [...tailText.matchAll(/^\s*What happened: (.+)$/gm)].pop()?.[1];
    return {
      stage: 'Resolve conflicts',
      diagnosis: offered
        ? 'Resolve conflicts did not push: the resolution could break this task or the work merged meanwhile. A follow-up backlog item is offered.'
        : (lastWhat ? `${lastWhat} The branch is back where it was.` : 'Resolve conflicts stopped before pushing; the branch is back where it was.'),
      autoAction: {
        label: offered ? 'Resume Resolve conflicts once the follow-up question is answered' : 'Retry Resolve conflicts',
        command: resumeCommand(ctx.slug, 'resolve-conflicts'),
      },
      manualAction: {
        file: offered ? 'questions.md' : 'logs/resolve-conflicts.md',
        instruction: offered
          ? 'Read logs/resolve-conflicts.md, then answer yes in questions.md to add the follow-up item (anything else adds nothing).'
          : 'Read logs/resolve-conflicts.md, fix what it names, then resume.',
      },
      escapeHatch: {
        label: 'Rebase by hand',
        command: 'git fetch origin && git rebase origin/main',
      },
    };
  }

  if (normStage === 'finalise' || normStage.includes('finalise')) {
    return {
      stage: 'Finalise',
      diagnosis: 'Finalise stage paused: merge conflict with base branch or PR creation encountered an error.',
      autoAction: {
        label: 'Retry Finalise stage',
        command: resumeCommand(ctx.slug, 'finalise'),
      },
      manualAction: {
        instruction: 'Check git status, resolve any merge conflicts against base branch, and git commit.',
      },
      escapeHatch: {
        label: 'Keep feature branch and push/merge manually',
        command: `git push origin sdlc/${ctx.slug}`,
      },
    };
  }

  const warned = syncRecovery(ctx, latest, false);
  if (warned) return warned;
  // Fallback recovery: a stage no rule above knows. The command resumes at the stage the run was in, and the bailout that
  // restarts from Spec is left out when it would repeat the auto command.
  const auto = resumeCommand(ctx.slug, toFromStage(ctx.stage));
  return {
    stage: ctx.stage || 'Pipeline',
    diagnosis: ctx.stage
      ? `The run ${isPaused ? 'paused' : 'stopped'} at ${ctx.stage}; see logs/run.out for the cause.`
      : `The run ${isPaused ? 'paused' : 'stopped'} before any stage started.`,
    autoAction: {
      label: ctx.stage ? `Resume at ${ctx.stage}` : 'Resume pipeline from Spec',
      command: auto,
    },
    manualAction: {
      file: 'logs/run.out',
      instruction: 'Inspect logs/run.out for root cause details.',
    },
    ...(auto !== resumeCommand(ctx.slug, 'spec') ? { escapeHatch: { label: 'Resume pipeline from Spec', command: resumeCommand(ctx.slug, 'spec') } } : {}),
  };
}

/** Formats a StageRecovery diagnosis into human-readable terminal output. */
export function formatRecoveryCli(recovery: StageRecovery): string {
  const lines = [
    '================================================================================',
    `SDLC PIPELINE PAUSED / STOPPED AT: ${recovery.stage}`,
    `DIAGNOSIS: ${recovery.diagnosis}`,
    '--------------------------------------------------------------------------------',
    'RECOVERY OPTIONS:',
  ];
  if (recovery.autoAction) {
    lines.push(`  1. Auto:    ${recovery.autoAction.label}`);
    lines.push(`              $ ${recovery.autoAction.command}`);
  }
  if (recovery.manualAction) {
    lines.push(`  2. Manual:  ${recovery.manualAction.instruction}${recovery.manualAction.file ? ` (File: ${recovery.manualAction.file})` : ''}`);
  }
  if (recovery.escapeHatch) {
    lines.push(`  3. Bailout: ${recovery.escapeHatch.label}`);
    lines.push(`              $ ${recovery.escapeHatch.command}`);
  }
  lines.push('================================================================================');
  return lines.join('\n');
}
