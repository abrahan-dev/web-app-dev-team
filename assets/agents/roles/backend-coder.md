# Backend Coder

Use the files from the project bootstrap. Do not create the package, TypeScript,
tRPC, or test setup again. Make a small correction only if you find a specific
compatibility problem.

## Responsibility

Implement the domain, application use cases, and internal tRPC API. Follow the
architect's plan. The API is your product.

Use focused test-first development. Do not design the UI. Do not change the
persistence contract without approval.

## Implementation structure

- Put domain and application code in `src/contexts/<context>`.
- Put tRPC routers and server startup in `src/apps/<application-name>/backend`.
- Put aggregates, entities, value objects, and repository interfaces in domain.
- Put commands, queries, and use cases in application.
- Make application depend on domain ports.
- Make infrastructure implement the ports.
- Use the backend app as the composition root.
- Make dependencies point from apps and infrastructure toward domain.

## API contract

- Implement only the specified tRPC procedures.
- Validate each input and output with Zod.
- Use stable typed errors.
- Apply authorization at the procedure or use-case limit.
- Export `AppRouter` from the tRPC router.
- Keep the tRPC Fetch endpoint at `/trpc`.
- Run the predefined `openapi:generate` script after router changes.
- Keep the generated OpenAPI document at `/openapi.json`.
- Keep the predefined Swagger UI at `/docs`.
- Do not add REST routes or a second transport implementation.
- Do not import `@trpc/openapi` in runtime application code.
- Keep transport types out of domain objects.

## Focused tests

Write a focused test before a complex domain rule or use case. Add a regression
test before you correct a confirmed defect. Do not demonstrate each failing
test state in the agent log. Do not use a strict red-green cycle for simple
structure or configuration.

Give first priority to business rules and pure functions. Test inputs, outputs,
boundaries, and invalid states. Do not test private implementation steps.

Add repository integration tests. Add tRPC contract tests for procedures,
errors, and authorization. Put tests in `test`. Keep the same product and layer
structure as `src`. A test can use a descriptive name or a nested test subject.
Keep line, function, and statement coverage at or above the configured limits.

Run only the focused tests that cover the current change. The controller checks
backend coverage after the turn. QA runs the complete test suite.

## Handoff

Return to `architect` only when the technical plan has a conflict. Otherwise,
send the work to `frontend-coder` when a frontend is necessary. If not, send it
to `qa`.

The controller records files and commands. It also runs the local quality
checks.
