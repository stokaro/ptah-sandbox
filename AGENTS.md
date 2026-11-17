# AGENTS.md

This repository builds the browser playground at `play.ptah.run`. It combines
pinned Ptah and provider sources with local WebAssembly and browser code.
Read [README.md](README.md) for the build, source boundaries, and scenarios.

## Pull request descriptions

### Purpose and scope

- Read and follow `.github/pull_request_template.md`, including when
  creating or updating a PR through a CLI or API. Keep its headings and
  remove drafting comments and unused optional content.
- Write in plain American English and follow the repository's title
  convention. The title and first paragraph must make the purpose clear
  to a reviewer who knows the project but not the investigation. Define
  uncommon terms before using them. Do not add tool signatures or
  generated-with footers.
- Establish intent from the request, issue, discussion, and supporting
  evidence. Do not invent user impact, urgency, performance gains, or
  security benefits. Ask for clarification when missing information
  materially changes the goal, scope, acceptable risk, or completion
  criteria.
- Explain the problem or need and the resulting behavior. For a bug fix,
  explain the established cause. Distinguish observations, conclusions
  drawn from code, and hypotheses.
- Describe meaningful limitations and non-obvious decisions. Include
  implementation details when they help assess correctness, risk, or use.
  Avoid file inventories, commit histories, and repeated summaries.
- Keep the essential explanation in the PR. Link issues that define its
  scope, required companion changes, and relevant remaining work.
  Use closing keywords only when the PR fully resolves an issue.

### Evidence and maintenance

- Report observed validation results and important coverage gaps.
  Explain what each significant check establishes. Do not present lint,
  compilation, skipped checks, or planned work as proof of behavior they
  do not verify.
- State the engines, versions, platforms, or component combinations
  actually exercised when they affect the claim. Provide manual steps
  only where they add useful verification.
- Before publishing, inspect the complete diff from the actual base
  branch to the current head. When updating an existing PR, read its
  current title and description first.
- After substantive changes, revise the description for the complete
  current PR. Update behavior, scope, risks, dependencies, and validation
  claims; replace stale text instead of appending a development diary.
- Keep the description proportional to the change. Put essential results,
  material risks, and remaining uncertainty in the main text. Link or
  collapse lengthy supporting evidence.
- Follow all repository-specific testing, documentation, safety, and
  compatibility requirements alongside this description standard.

The shared wording of this section and the PR template is maintained in
[`stokaro/ptah`](https://github.com/stokaro/ptah). Keep copies aligned across
Ptah repositories; put repository-specific additions in a separate section.

## Playground PR context

- For runtime or scenario changes, identify the affected engine and scenario,
  the pinned source versions, and the behavior a visitor can observe. Keep
  browser-specific limitations separate from native Ptah capabilities.
- For changes to source pins, overlays, or generated runtime metadata,
  explain which build inputs changed and which artifacts were rebuilt.
  Follow the [pin workflow](README.md#the-pin) rather than presenting an
  edited version label as a rebuilt runtime.
- Distinguish Node-driven runtime checks from browser interaction checks and
  deployed-site observations. Report the engine and scenario combinations
  actually exercised, including important untested combinations.
- Use the [build instructions](README.md#build) for the relevant checks.
  Include screenshots or a preview when changes to the page need visual
  review. State the starting workspace and expected database result for
  manual reproduction of a scenario.
