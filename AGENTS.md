# Project Planning Rules

## Planning Documents
- docs/product-brief.md: Product goals and MVP scope
- docs/feature-backlog.md: Candidate features and priorities
- docs/roadmap.md: Implementation sequence and status

## Workflow
1. Start with product discovery for new projects.
2. Generate features based on the approved product brief.
3. Prioritize features before creating the roadmap.
4. Only detail the current feature for implementation.
5. Keep requirements, design, and tasks lightweight and focused on the current feature.
6. After a feature is completed, update the roadmap.

For code-change requests, the main session routes implementation to the
configured `implementer` agent by default and passes along user requirements
and decisions. Planning and exploration remain in the main session. Follow
[docs/agent-workflow.md](docs/agent-workflow.md), including its clean-worktree
and branch startup checks, serial independent review, review limit, and
task-scoped commit rules. If a configured role is unavailable, report that and
stop; do not silently fall back to another role or model.

## Guardrails
- Never start coding during product planning.
- Ask for approval before changing MVP scope.
- Do not duplicate detailed implementation requirements in planning docs.
- Do not automatically implement the next feature.
- Keep documentation lightweight for solo projects.

## UI Development
- When you need information about Mantine UI components, start with https://mantine.dev/llms.txt and follow the relevant documentation links.
- Group each component with its styles, types, and related hooks in its own folder under `frontend/src/components/`.
- Declare component types and interfaces in colocated `<ComponentName>.types.ts` files, not in component `.tsx` files. Keep shared domain types in the folder that owns them and import them where needed.
- Keep `App.tsx` focused on composition. Extract state and interaction logic into focused hooks in the relevant component folder.
- Keep Mantine theme configuration in `frontend/src/config/theme.ts`.

## Git Commits
- Use Conventional Commits: `<type>(<optional scope>): <imperative description>`.
- Use a lowercase description without a trailing period. Prefer standard types such as `feat`, `fix`, `docs`, `refactor`, `test`, `build`, `ci`, and `chore`.
- Mark breaking changes with `!` and explain them in a `BREAKING CHANGE:` footer.
