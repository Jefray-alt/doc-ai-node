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
