import { resumecheck } from '../testcheck/checks.js';
import type { Ctx } from './context.js';

/** The command that resumes this run at <stage>. */
export const resumeCommand = (slug: string, stage: string): string => `ai-sdlc-helper pipeline ${slug} --from ${stage}`;

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

/** Diagnoses a paused, failed, or stopped stage and provides 3-tuple recovery paths. */
export function stageRecoveryHint(ctx: RecoveryContext): StageRecovery {
  const normStage = (ctx.stage || '').toLowerCase().replace(/\s+/g, '-');
  const tailText = (ctx.runOut || []).join('\n');
  const isPaused = ctx.state === 'paused' || ctx.exitCode === 2;
  const unansweredCount = (ctx.questions || []).filter(q => !q.answer?.trim()).length;
  const pendingPermsCount = (ctx.permissions || []).length;

  // Resuming at Plan or Red tests once the red-tests commit exists is refused before any stage starts (no stage is recorded).
  const refused = /FROM=(\S+) but the red-tests commit \w+ already exists/.exec(tailText);
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

  if (normStage === 'spec' || normStage.includes('spec')) {
    if (unansweredCount > 0) {
      return {
        stage: 'Spec',
        diagnosis: `Spec agent generated ${unansweredCount} clarifying question(s) requiring answers before planning.`,
        autoAction: {
          label: 'Auto-answer with suggested defaults & resume Spec',
          command: resumeCommand(ctx.slug, 'spec'),
          env: { SDLC_AUTO_ANSWER: '1' },
        },
        manualAction: {
          file: 'questions.md',
          instruction: "Answer the questions under '## Answer:' in questions.md, then resume.",
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
        file: 'plan.md',
        instruction: 'Inspect generated plan.md and add or refine implementation steps.',
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
          file: 'log/red.json',
          instruction: 'Inspect failing test results in log/red.json and adjust test assertions to verify unbuilt behavior.',
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
        file: 'log/red.err',
        instruction: 'Check runner errors in log/red.err, fix imports/syntax, and run npm test locally.',
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
        file: 'log/now.json',
        instruction: 'Inspect failing assertions in log/now.json and fix source code or add test-issues.md.',
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
        file: 'log/review.md',
        instruction: 'Inspect review findings in log/review.md and address requested changes in code.',
      },
      escapeHatch: {
        label: 'Approve review findings and advance to Finalise',
        command: resumeCommand(ctx.slug, 'finalise'),
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

  // Fallback recovery
  return {
    stage: ctx.stage || 'Pipeline',
    diagnosis: `Pipeline ${isPaused ? 'paused' : 'stopped'} at stage ${ctx.stage || 'unknown'}.`,
    autoAction: {
      label: 'Resume pipeline where it stopped',
      command: resumeCommand(ctx.slug, normStage || 'spec'),
    },
    manualAction: {
      file: 'log/run.out',
      instruction: 'Inspect log/run.out for root cause details.',
    },
    escapeHatch: {
      label: 'Restart pipeline from Spec',
      command: resumeCommand(ctx.slug, 'spec'),
    },
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
