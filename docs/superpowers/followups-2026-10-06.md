# Follow-ups after the round-1 review fixes

These are findings from the 2026-10-06 review-fix plan that were parked or deferred as non-blocking. The final review judged none of them required before merge.

## Parked after the final review
- device-cookie HMAC not bound to a credential version (survives password change/recovery, 180 d) — matches the I-3 ruling; follow-up to add auth_salt to HMAC input — cost if wrong: a past device/stolen cookie skips only the account cap, per-IP limit still applies.
- logout wait unbounded on hung fetch; recover()/register don't wait for a pending logout; broadcast-lock vs in-flight unlock race — all fail closed (spurious "session ended", no data/key loss) — cost if wrong: occasional extra sign-in.
- signOut doesn't broadcast (peers keep keys until next request/idle; peer lock may re-remember username after "forget") — follow-up 'signout' message — cost if wrong: plaintext stays in another open tab of the same browser until its next request or 15 min idle.
- nits: detached JSDoc in util.ts, unused RecoveryKeyPanel error prop; title input not read-only during lock; register/setup don't set device cookie.

## Deferred minors from the task reviews
- (Task 1) add account-limiter test (30 attempts from many IPs → 429 even for correct key; success resets both)
- (Task 1) burst test doesn't assert retryAfter; attempt() doc could mention 5th attempt still verifies
- (Task 2) no unit test for toFastifyTrustProxy n=2 / multi-hop chain; startup hop-count warning logged even for CIDR config
- (Task 3) setup token logged at warn — invisible if LOG_LEVEL=error/silent (consider unconditional stderr line)
- (Task 3) no test for default setup-token path (generated, logged once, cleared after setup, fresh on restart)
- (Task 3) redactUrl case-sensitive/anchored (//join, /JOIN not redacted); style nits (long lines)
- (Task 4) no limiter test for /recovery-key or /password; no missing-X-Inked test on this route
- (Task 5) render tests lack /\evil and javascript: cases; hook doesn't strip data-internal in non-internal branches (relies on html:false); no App insecure-gate test; internal-link click hijacks Ctrl/middle-click; spellcheck read per render
- (Task 6) putHead merges stale fields under newer stamp; loadNote/saveNoteBody write bodies unconditionally
- (Task 6) I5 test lacks recovery round-trip; no adoptHead foreign-stamp test; setup token < 8 chars gets generic 400 copy
- (Task 7) queue items sent with no session/other tab's cookie after lock (owner guard skipped when signed out); another account's queued items counted for next user; copy notice lost during lock flush; held items depend on racing save settling (no fetch timeout); createNote treats any 409 as copied; test gaps (renameNote epoch, hook wiring, online/interval/beforeunload); stale search/head after queued save
- (Task 7) dropped notice says "deleted elsewhere" even for 400/413; root-copy notice misstates cause; settle().finally(unregister) could surface unhandled rejection
- (Task 9) "same-origin links routed in-app" imprecise (only root-relative /... + wiki-links); 429 omitted from password/recovery-key rows; TRUST_PROXY yes/no/on aliases undocumented
