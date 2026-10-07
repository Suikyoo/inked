/** A stored vector still describes the note: same model, computed from this version or a later one. */
export function isFresh(
  v: { model: string; sourceUpdatedAt: string } | undefined,
  note: { updatedAt: string },
  model: string,
): boolean {
  return !!v && v.model === model && Date.parse(v.sourceUpdatedAt) >= Date.parse(note.updatedAt);
}
