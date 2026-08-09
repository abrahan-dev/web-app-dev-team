# Asset Configuration

The `assets` directory contains configurable content for the development team.
The `src` directory contains the application rules that load and validate this
content.

You can change an asset without changing `src` when the asset keeps its current
contract. A change to a contract also requires a change in `src`.

## Agent instructions

The `agents/roles` directory contains the instruction file for each role.
Change these files to adjust role behavior, constraints, or expected work.

The `agents/communication.md` file contains the shared communication standard.
Change this file to adjust the text rules for all roles.

Keep each current role file and file name. The application defines the role
list and the workflow in `src`. A new role requires corresponding changes in
the role types, workflow, prompts, schemas, and tests.

## Output schemas

The `agents/output-schemas` directory contains the JSON schema for each role.
Codex uses these schemas to create structured output.

The application validates the same output with Zod schemas in `src`. Keep each
JSON schema synchronized with its Zod schema. A field change requires changes
to both schemas and their tests.

## Stack catalog

The `workspace/stack.json` file contains the Bun version and package versions
for new applications. Change a version to update the stack for future
application bootstraps.

The application defines the permitted package names in `src`. A new package,
a removed package, or a new package group requires a change in `src`.

## Workspace templates

The `workspace/templates` directory contains files for new applications.
Change a template to adjust the initial content of its generated file.

Keep the current placeholders unless you also change the template renderer.
The application defines each output path and each template selection rule in
`src`. A new template file has no effect until `src` selects and renders it.

Template changes affect only future application bootstraps. They do not update
an existing application.

## Pull request template

The `git/pull-request.md` file contains the pull request body template. You can
change its text and layout.

Keep these placeholders:

- `{{featureId}}`
- `{{implementation}}`
- `{{evidence}}`

A new placeholder requires a corresponding change in the pull request
renderer.

## Changes that require source code

Change `src` when you make one of these changes:

- Add, remove, or rename a role.
- Change the workflow order or a handoff rule.
- Change an agent output field.
- Add or remove a stack package.
- Add a generated file or output path.
- Add a workspace selection condition.
- Add a pull request placeholder.
- Add automatic migration for an existing application.

## Verification

Run the complete check after each asset change:

```bash
bun run check
```

This command checks formatting, lint rules, types, complexity, and tests.
