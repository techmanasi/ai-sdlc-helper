// questions.md as the agents write it: one "### Q<n>:" block per question, each ending in an empty "**Answer:**" line.

/**
 * The text with an empty "**Answer:**" line added to every question block that has none. An agent sometimes leaves the
 * line out; without it an answer has nowhere to go and the run pauses again on the same questions.
 */
export function withAnswerLines(text: string): string {
  const lines = text.split('\n');
  const out: string[] = [];
  let block: string[] | null = null;
  const close = (): void => {
    if (!block) return;
    if (!block.some(l => /^\*\*Answer:\*\*/.test(l))) {
      while (block.length && !block[block.length - 1].trim()) block.pop();
      block.push('**Answer:**', '');
    }
    out.push(...block);
    block = null;
  };
  for (const line of lines) {
    if (/^### Q\d+:/.test(line)) { close(); block = [line]; } else if (block) block.push(line); else out.push(line);
  }
  close();
  return out.join('\n');
}
