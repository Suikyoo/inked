# Follow-ups after the deploy + follow-ups branch (2026-10-07)

> **Status: resolved (2026-10-07).** Every item below was triaged FIX or ACCEPT in `docs/superpowers/specs/2026-10-07-cleanup-round-design.md`; see that spec for the per-item outcome.

Non-blocking items left after the final review of branch deploy-and-followups. Rulings and deferred minors from the task reviews:

## Parked rulings
- nginx error_log can record a failing request line with /join token or ?username (502 during inked rebuild); documented as sensitive — cost if wrong: occasional token in host-only logs; invites short-lived.
- smoke check 5 aborts silently on a curl transport error (still fails closed); `!override` needs Compose ≥ v2.24.4 (undocumented; older Compose might rejoin cloudflared-net); realip smoke checks need default Docker pool — follow-ups.

## Deferred minors
- (Task 1) body limit really 4 MiB end-to-end (nginx 5m, Fastify 4 MiB); nginx static upstream can go stale if inked recreated alone (doc: restart nginx / or use resolver); wrong CLOUDFLARED_NET_CIDR failure mode undocumented; INKED_DATA_DIR missing from deploy.md; host inside trusted CIDR (accepted-risk wording); smoke test needs fresh data per run; spec should mention empty.conf mask
- (Task 2) redaction on raw URL (percent-encoded /%6Aoin not redacted); setup/register cookie test lacks Max-Age/Secure asserts; duplicated authSaltOf/saltOf test helpers; /api/auth/password doesn't re-issue device cookie for the changing device (revoked until next login) — final review to triage
- (Task 3) peer login >4 s after signout leaves live server session (cookie) — could self-logout in afterSignIn; endFromPeer during booting overwritten by boot; missing tests (KDF-phase signout, already-signed-out peer, mid-lock signout, short token, title readOnly); client.test microtask fragility; PEER_LOCK_MAX_MS timer outlives two tests; dead remember:true branch
- (Task 4) duplicate identical copy after a timed-out-but-applied update; register/recover moved-wait behaviour diff (+ no recover test); outer signal abort listener not removed; hung-send test relies on PENDING_RETRY_MS === QUEUE_REQUEST_TIMEOUT_MS; leaveNote doesn't test hook wiring itself
- (Task 4) no per-owner deferred-notice retention test; deferredNotices not cleared on forgetAccount; notices append unbounded-but-bounded cosmetic; lock now leaves late items for next unlock (doc line)
- (Task 5) stale tab's lock/sign-out still logs out + broadcasts after mismatch (ends other account's session; nothing lost); late-reply guard compares user id not session generation; queue-only mismatch never ends the tab's session (per ruling); loadNote returns stale head/body to editor → false conflict; link hook defence-in-depth (/\host other branch, "/\t/" accepted, data-wikilink not stripped); no endFromPeer requestUser test
