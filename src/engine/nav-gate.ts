/**
 * Visit/form open gates used to ignore the human decision and always
 * skipSpan. Approving "I could not open this visit" on a fresh Nexus study
 * then left ~208 pending steps and an empty Screening stub.
 *
 * Surface evidence is the only safe continue signal: if the visit/form is
 * now on screen (human fixed it, or a retry landed), continue. Approve
 * without that evidence still refuses — never build into the wrong place.
 */
export function navGateAllowsContinue(
  decision: { action: string } | null | undefined,
  surfaceOk: boolean,
): boolean {
  if (surfaceOk) return true;
  void decision; // decision alone never overrides a missing surface
  return false;
}

/** Whether the gate decision asks us to attempt one more open click. */
export function navGateShouldRetryOpen(
  decision: { action: string } | null | undefined,
): boolean {
  if (!decision) return false;
  return decision.action === 'retry' || decision.action === 'approve';
}
