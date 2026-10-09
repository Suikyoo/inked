export const ANSWER_TITLE_MAX = 80;

/** A saved answer: the question as title, the answer, then a Sources list linking the cited notes. */
export function answerToNote(question: string, answer: string, cited: readonly { title: string }[]): { title: string; body: string } {
  const q = question.trim().replace(/\s+/g, ' ');
  const title = q.length > ANSWER_TITLE_MAX ? `${q.slice(0, ANSWER_TITLE_MAX - 1)}…` : q;
  const sources = cited.length ? `\n\n## Sources\n\n${cited.map((c) => `- [[${c.title}]]`).join('\n')}` : '';
  return { title, body: `${answer.trim()}${sources}\n` };
}
