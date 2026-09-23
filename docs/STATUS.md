# Metering automation: status (23 Sep 2026, end of day)

## Where things are
- **Everything tested in dry run** on live deals: EA (Steve Johnston), Red Energy (Matthew Bisazza), AGL incl. homeowner signing page (Jenny Fan), holds, skips, manual tasks, letter intake (duplicate check, no-write test mode).
- **n8n**: all MTR workflows built. `dryRun: true` in `MTR – 00 Settings`, test inbox rodrigo@impressivebatteries.com.au.
  - On (published): 00, 02, 03, 06, 10, 20 (sub-workflows, only run when called) and **30 Consent Signed** (webhook for the signing page; dry run).
  - Off: **01 Trigger**, **05 Network Letter Intake**, T Test Harness.
- **Vercel** (`main` → metering-applications.vercel.app): `/api/ea-form`, `/api/agl-form`, `/sign` + `/api/sign-*`. Only `public/` is served statically. Merges to `main` did not auto-deploy once (PR #3/#4); check the deployment is Ready after each merge.
- **Repo**: branch `claude/determined-maxwell-8o42c0` is ahead of `main` only by n8n-side changes (workflow JSON, harness, invite email); nothing Vercel needs.

## Next session (in order)
1. **Origin** (portal) and **Powershop** (web form https://www.powershop.com.au/smart-meter-request): currently manual tasks; automate.
2. **Go live** (Rodrigo decided: after Origin):
   1. `MTR – 00 Settings`: `dryRun: false` (edit `workflows/build.js`, `node workflows/deploy.js settings`).
   2. Activate `MTR – 01 Trigger` and `MTR – 05 Network Letter Intake`.
   3. First real run: Steve Johnston (EA, deal 271519930844), Rodrigo watching.
3. Then: `MTR – 40 Chaser` (day-10 chase in the same thread, day-20 escalation, signing-link reminders at 2 and 5 days), `41 Reply Watcher`, `42 Completion`.
4. Housekeeping: delete the unused DocuSeal credential (`3jRr6HHI4Wx4x1oP`) in n8n if not used elsewhere.

## Decisions log (short)
- Trigger: HubSpot email → Gmail label `Metering 2.0`, deal ID = subject. Labels `Metering 2.0 - Processed` / `- Error` applied by the workflow.
- Impressive signs EA and AGL applications (Rodrigo Candi, RC scribble); electrician Sam Husband 279684C; tasks owned by Rodrigo.
- AGL consent is signed by the homeowner on our own page (DocuSeal free edition can't create from PDF).
- Network letters: Ausgrid `Notification Letter…`, Endeavour `…_PTC_…` (attachments on the deal); Essential manual. Reference optional when the letter is attached.
- CCEW: note "CCEW <receipt> attached via n8n" (all deals since 1 Jun 2026).
- Email retailers: EA, AGL, GloBird, Amber, Red Energy. Manual: Origin, Powershop (until automated), 1st Energy, ENGIE, Alinta, Momentum, rest.
