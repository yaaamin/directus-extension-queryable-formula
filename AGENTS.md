You are a helpful debugger for a Directus extension. This is a computed field extension for Directus that stores formula results in the database, making them queryable, sortable, and filterable. Includes a visual formula builder, relational field lookups, **cross-formula references with dependency ordering**, scheduled recalculation, and a force-recalculate button.

Readme: './readme.md'

## Test Collection

For testing purposes, the following fields are available in a user collection (without the formulas):

name dob name_in_dv current_address current_atoll current_island permanent_address permanent_atoll permanent_island gender

## Architecture

The formula engine is duplicated across three locations — all three must stay in sync when making changes:

- `src/formula-hook/index.ts` — Server-side hook that evaluates formulas on item create/update and runs batch recalculation. This is the primary execution path.
- `src/formula-endpoint/index.ts` — API endpoint for on-demand recalculation (used by the "Recalculate All" button). Has its own copy of `processFunctions`, `safeEval`, `splitArgs`, etc.
- `src/formula-interface/interface.vue` — Client-side preview in the Directus UI. Has its own `processFunctionsClient`, `safeEvalClient`, `splitArgsClient` duplicates.

**When fixing or adding formula functions, update all three files.**

## Formula Parsing

Formulas use `{{fieldName}}` for field references and support functions like `CONCAT()`, `IF()`, `DATEDIF()`, `NOW()`, `UPPER()`, etc.

The `processFunctions` function iteratively applies regex replacements to resolve function calls. Key implementation details:

- Function regexes use `[^()]*` to match innermost calls first, relying on iteration to resolve nested calls.
- **All function regexes MUST use `\b` word boundary** before the function name to prevent partial matches (e.g., `IF(` matching inside `DATEDIF(`, `ROUND(` matching inside `MROUND(`).
- `safeEval` handles final expression evaluation — it supports strings, numbers, booleans, null, and simple arithmetic. It uses `Function()` for arithmetic expressions only (validated by regex).
- `splitArgs` correctly handles nested parentheses and quoted strings when splitting on commas.

## Known Bug Patterns

- **Missing `\b` word boundary on function regexes**: Causes functions like `DATEDIF()` to be partially consumed by shorter function matchers like `IF()`. Symptom: garbled output like `"DATED2026-03-31T..."` instead of the computed age. Fixed by adding `\b` before all function name patterns.

## Relational Fields

- Dotted refs like `{{category.name}}` resolve M2O relations.
- `resolveRelationalData` and `batchResolveRelationalData` handle single and batch resolution respectively.
- The schema's `relations` array is used to discover related collections and their primary keys.
