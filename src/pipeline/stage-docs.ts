// Spec and Plan commit and push their documents, so GitHub holds them as soon as they exist: `[spec] docs(<slug>): ...` and
// `[plan] docs(<slug>): ...`. The draft pull request opens at the first push with changes beyond the base. Nothing here stops a
// run: a failed commit, push or gh call is kept in errors.log and said in one line (Red tests commits the documents again).
import { type Ctx } from './context.js';
import { keepError } from './errors.js';
import { draftPrText } from './ci.js';
import { findOrCreatePr, firstLine } from './finalise.js';
import { commitPrLink } from './pr-link.js';
import { netGit } from './push-check.js';

export async function commitStageDocs(ctx: Ctx, tag: 'spec' | 'plan', what: string): Promise<void> {
  const git = ctx.git;
  try {
    git.run('add', '-A', '--', ctx.docs);
    if (!git.lines('diff', '--cached', '--name-only', '--', ctx.docs).length) return;
    git.run('commit', '-q', '-m', `[${tag}] docs(${ctx.slug}): ${what}`, '--', ctx.docs);
  } catch (e) {
    keepError(ctx, `${tag}: commit documents`, (e as Error).message);
    ctx.out(`   WARNING: the ${tag} documents could not be committed (see ${ctx.log}/errors.log); Red tests commits them`);
    return;
  }
  if (ctx.offline || git.tryRun('remote', 'get-url', 'origin') === null) return;
  try { netGit(ctx).runTimeout(120_000, 'push', '-q', '-u', 'origin', ctx.branch); } catch (e) {
    keepError(ctx, `${tag}: push documents`, (e as Error).message);
    ctx.out(`   WARNING: the ${tag} documents could not be pushed (see ${ctx.log}/errors.log); the next push takes them`);
    return;
  }
  ctx.out(`   ${tag} documents committed and pushed to ${ctx.branch}`);
  try {
    const { title, body } = draftPrText(ctx);
    const opened = findOrCreatePr(ctx.root, ctx.branch, title, body, ctx.config.git.base || undefined, { draft: true });
    if (opened.url === null) {
      keepError(ctx, 'gh pr create', opened.error);
      ctx.out(`   could not open a pull request for ${ctx.branch}: ${firstLine(opened.error)} (see ${ctx.log}/errors.log)`);
      return;
    }
    commitPrLink(ctx, opened.url);
    ctx.out(`   pull request: ${opened.url}`);
  } catch (e) { keepError(ctx, 'gh pr create', (e as Error).message); }
}
