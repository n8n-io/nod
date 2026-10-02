# Atlas documentation pilot — handover note

Recorded: 2026-10-02 16:00, Europe/Lisbon  
Project: Atlas documentation navigation  
Document owner: Mira Vale

## Rollout decision

Proceed with the internal desktop pilot on 2026-10-06. Keep the public release and the mobile rollout on hold. The internal pilot is limited to eight volunteer staff reviewers, who will use desktop browsers and the current documentation site alongside the new navigation.

The pilot can start with the known mobile issue because mobile access is outside its scope. The public release needs both the mobile fix and accessibility sign-off. The accessibility review is booked for 2026-10-05, but its outcome is not known. A booked review is not approval to release.

## Findings from the trial

Desktop navigation is ready for the limited pilot. Reviewers completed 19 of 20 document-finding tasks without help, compared with 14 of 20 using the old navigation. The unresolved task involved an outdated document title; its redirect has since been corrected and checked. No broken desktop navigation links remain in the trial set.

The mobile menu still traps keyboard focus after opening a nested section. This was reproduced on three narrow-screen browser configurations. Closing the menu with a pointer works, but that workaround is not sufficient for a public release. The defect is tracked as ATLAS-17.

## Work and ownership

| Work | Owner | Due | Completion evidence |
| --- | --- | --- | --- |
| Fix the mobile keyboard-focus defect | Leo Chen | 2026-10-05 | Re-test the three failing configurations and attach results to ATLAS-17 |
| Complete the accessibility review | Rina Holt | 2026-10-05 | Written sign-off or a list of remaining blockers |
| Send internal pilot invitations | Mira Vale | 2026-10-05 | Eight reviewers receive desktop-only instructions |
| Collect and group pilot feedback | Sam Ortiz | 2026-10-08 | One issue list separating blockers from optional improvements |
| Decide public-release readiness | Mira Vale | 2026-10-09 | Mobile evidence, accessibility outcome and pilot feedback reviewed together |

## Pilot operation

Reviewers will try finding a setup guide, locating an example and moving between related topics. Feedback goes into the existing Atlas review form. Sam will check that form each afternoon during the pilot. The form link is already included in the invitation draft.

The content set contains 18 guides and nine glossary entries. Six screenshots have been refreshed. Two alternative navigation labels and a dark-mode polish request are parked for later; neither blocks this pilot. The old navigation remains available to every reviewer.

## Contingency

If the mobile fix or accessibility sign-off is still incomplete on 2026-10-09, keep the public release on hold and continue the internal desktop pilot only if no desktop blocker has appeared. There is no fallback public-launch date. Mira will choose a new decision date after the missing evidence is available. If a desktop blocker appears, pause the pilot and direct reviewers to the old navigation.
