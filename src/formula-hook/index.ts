import type { HookExtensionContext } from "@directus/extensions";

export default (
  { filter, action, init }: { filter: any; action: any; init: any },
  context: HookExtensionContext,
) => {
  const { database, logger, getSchema } = context;

  const BATCH_SIZE = 200;
  const INTERFACE_ID = "queryable-formula";

  // Track backfill state to avoid duplicate runs
  let backfillRunning = false;

  // ─── Helpers ──────────────────────────────────────────────

  function extractFieldRefs(formula: string): string[] {
    const matches = formula.match(/\{\{(\w+)\}\}/g) || [];
    return [...new Set(matches.map((m) => m.replace(/\{\{|\}\}/g, "")))];
  }

  function evaluateFormula(
    formula: string,
    record: Record<string, any>,
  ): string | number | null {
    try {
      let expression = formula;

      expression = expression.replace(
        /\{\{(\w+)\}\}/g,
        (_match: string, fieldName: string) => {
          const val = record[fieldName];
          if (val === null || val === undefined) return "null";
          if (typeof val === "string") return JSON.stringify(val);
          return String(val);
        },
      );

      expression = processFunctions(expression);
      return safeEval(expression);
    } catch (err: any) {
      logger.warn(
        `[queryable-formula] Failed to evaluate formula "${formula}": ${err.message}`,
      );
      return null;
    }
  }

  function processFunctions(expr: string): string {
    let result = expr;
    let maxIterations = 50;

    while (maxIterations-- > 0) {
      const previous = result;

      result = result.replace(
        /CONCAT\(([^()]*)\)/gi,
        (_m: string, args: string) => {
          const parts = splitArgs(args);
          const joined = parts
            .map((p) => {
              const trimmed = p.trim();
              try {
                return String(safeEval(trimmed));
              } catch {
                return trimmed.replace(/^"|"$/g, "");
              }
            })
            .join("");
          return JSON.stringify(joined);
        },
      );

      result = result.replace(
        /UPPER\(([^()]*)\)/gi,
        (_m: string, arg: string) => {
          const val = String(safeEval(arg.trim()));
          return JSON.stringify(val.toUpperCase());
        },
      );

      result = result.replace(
        /LOWER\(([^()]*)\)/gi,
        (_m: string, arg: string) => {
          const val = String(safeEval(arg.trim()));
          return JSON.stringify(val.toLowerCase());
        },
      );

      result = result.replace(
        /TRIM\(([^()]*)\)/gi,
        (_m: string, arg: string) => {
          const val = String(safeEval(arg.trim()));
          return JSON.stringify(val.trim());
        },
      );

      result = result.replace(
        /ROUND\(([^()]*)\)/gi,
        (_m: string, args: string) => {
          const parts = splitArgs(args);
          const num = Number(safeEval(parts[0]!.trim()));
          const decimals = parts[1] ? Number(safeEval(parts[1].trim())) : 0;
          return String(Math.round(num * 10 ** decimals) / 10 ** decimals);
        },
      );

      result = result.replace(
        /FLOOR\(([^()]*)\)/gi,
        (_m: string, arg: string) => {
          return String(Math.floor(Number(safeEval(arg.trim()))));
        },
      );

      result = result.replace(
        /CEIL\(([^()]*)\)/gi,
        (_m: string, arg: string) => {
          return String(Math.ceil(Number(safeEval(arg.trim()))));
        },
      );

      result = result.replace(
        /IF\(([^()]*)\)/gi,
        (_m: string, args: string) => {
          const parts = splitArgs(args);
          if (parts.length < 3) return "null";
          const cond = safeEval(parts[0]!.trim());
          return cond
            ? String(safeEval(parts[1]!.trim()))
            : String(safeEval(parts[2]!.trim()));
        },
      );

      result = result.replace(
        /COALESCE\(([^()]*)\)/gi,
        (_m: string, args: string) => {
          const parts = splitArgs(args);
          for (const part of parts) {
            const val = safeEval(part.trim());
            if (val !== null && val !== undefined && val !== "null") {
              return typeof val === "string"
                ? JSON.stringify(val)
                : String(val);
            }
          }
          return "null";
        },
      );

      result = result.replace(/NOW\(\)/gi, () =>
        JSON.stringify(new Date().toISOString()),
      );

      if (result === previous) break;
    }

    return result;
  }

  function splitArgs(argsStr: string): string[] {
    const args: string[] = [];
    let depth = 0;
    let current = "";
    let inString = false;
    let stringChar = "";

    for (const char of argsStr) {
      if (inString) {
        current += char;
        if (char === stringChar) inString = false;
        continue;
      }

      if (char === '"' || char === "'") {
        inString = true;
        stringChar = char;
        current += char;
      } else if (char === "(") {
        depth++;
        current += char;
      } else if (char === ")") {
        depth--;
        current += char;
      } else if (char === "," && depth === 0) {
        args.push(current);
        current = "";
      } else {
        current += char;
      }
    }

    if (current.trim()) args.push(current);
    return args;
  }

  function safeEval(expression: string): any {
    const trimmed = expression.trim();

    if (trimmed === "null") return null;
    if (trimmed === "true") return true;
    if (trimmed === "false") return false;

    if (
      (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
      (trimmed.startsWith("'") && trimmed.endsWith("'"))
    ) {
      return trimmed.slice(1, -1);
    }

    if (/^-?\d+(\.\d+)?$/.test(trimmed)) {
      return Number(trimmed);
    }

    if (/^[\d\s+\-*/().%<>=!&|?:]+$/.test(trimmed)) {
      return Function(`"use strict"; return (${trimmed})`)();
    }

    return trimmed;
  }

  // ─── Schema helpers ───────────────────────────────────────

  async function getPrimaryKeyField(collection: string): Promise<string> {
    const schema = await getSchema();
    const collectionSchema = schema.collections[collection];
    if (collectionSchema?.primary) {
      return collectionSchema.primary;
    }
    return "id";
  }

  interface FormulaFieldConfig {
    field: string;
    formula: string;
    watchFields: string[];
  }

  async function getFormulaFields(
    collection: string,
  ): Promise<FormulaFieldConfig[]> {
    const formulaFields: FormulaFieldConfig[] = [];

    try {
      const fieldMetas = await database
        .select("field", "options", "interface")
        .from("directus_fields")
        .where({ collection, interface: INTERFACE_ID });

      for (const meta of fieldMetas) {
        let options: any = {};
        if (typeof meta.options === "string") {
          try {
            options = JSON.parse(meta.options);
          } catch {
            options = {};
          }
        } else if (meta.options) {
          options = meta.options;
        }

        if (options.formula) {
          const watchFields =
            options.watchFields && options.watchFields.length > 0
              ? options.watchFields
              : extractFieldRefs(options.formula);

          formulaFields.push({
            field: meta.field,
            formula: options.formula,
            watchFields,
          });
        }
      }
    } catch (err: any) {
      logger.warn(
        `[queryable-formula] Error reading formula fields for ${collection}: ${err.message}`,
      );
    }

    return formulaFields;
  }

  async function getAllFormulaCollections(): Promise<
    Map<string, FormulaFieldConfig[]>
  > {
    const result = new Map<string, FormulaFieldConfig[]>();

    try {
      const allFormulaMetas = await database
        .select("collection", "field", "options")
        .from("directus_fields")
        .where({ interface: INTERFACE_ID });

      for (const meta of allFormulaMetas) {
        let options: any = {};
        if (typeof meta.options === "string") {
          try {
            options = JSON.parse(meta.options);
          } catch {
            options = {};
          }
        } else if (meta.options) {
          options = meta.options;
        }

        if (!options.formula) continue;

        const watchFields =
          options.watchFields && options.watchFields.length > 0
            ? options.watchFields
            : extractFieldRefs(options.formula);

        const config: FormulaFieldConfig = {
          field: meta.field,
          formula: options.formula,
          watchFields,
        };

        const existing = result.get(meta.collection) || [];
        existing.push(config);
        result.set(meta.collection, existing);
      }
    } catch (err: any) {
      logger.warn(
        `[queryable-formula] Error scanning formula fields: ${err.message}`,
      );
    }

    return result;
  }

  // ─── Backfill engine ──────────────────────────────────────

  async function backfillCollection(
    collection: string,
    formulaFields: FormulaFieldConfig[],
    options: { onlyNulls?: boolean } = {},
  ): Promise<number> {
    const primaryKey = await getPrimaryKeyField(collection);
    let totalUpdated = 0;
    let offset = 0;

    logger.info(
      `[queryable-formula] Backfilling ${formulaFields.length} formula field(s) in "${collection}"${options.onlyNulls ? " (null values only)" : " (all rows)"}...`,
    );

    while (true) {
      // Build query — select primary key + all fields needed
      // by any formula
      const allDependentFields = new Set<string>();
      allDependentFields.add(primaryKey);

      for (const ff of formulaFields) {
        allDependentFields.add(ff.field);
        for (const wf of ff.watchFields) {
          allDependentFields.add(wf);
        }
      }

      let query = database
        .select([...allDependentFields])
        .from(collection)
        .orderBy(primaryKey, "asc")
        .limit(BATCH_SIZE)
        .offset(offset);

      // If onlyNulls, only fetch rows where at least one formula
      // field is null
      if (options.onlyNulls) {
        query = query.where((builder: any) => {
          for (const ff of formulaFields) {
            builder.orWhereNull(ff.field);
            builder.orWhere(ff.field, "=", "");
          }
        });
      }

      const rows = await query;

      if (!rows || rows.length === 0) break;

      // Process each row
      for (const row of rows) {
        const updates: Record<string, any> = {};
        let needsUpdate = false;

        for (const ff of formulaFields) {
          const computed = evaluateFormula(ff.formula, row);

          if (computed === null || computed === undefined) continue;

          // Check if value actually changed
          const current = row[ff.field];
          const computedStr = String(computed);
          const currentStr =
            current !== null && current !== undefined ? String(current) : null;

          if (currentStr !== computedStr) {
            updates[ff.field] = computed;
            needsUpdate = true;
          }
        }

        if (needsUpdate) {
          try {
            await database(collection)
              .where(primaryKey, row[primaryKey])
              .update(updates);
            totalUpdated++;
          } catch (err: any) {
            logger.warn(
              `[queryable-formula] Failed to update ${collection}[${row[primaryKey]}]: ${err.message}`,
            );
          }
        }
      }

      // If we're doing onlyNulls and got fewer than BATCH_SIZE,
      // we're done. If not onlyNulls, advance offset.
      if (options.onlyNulls) {
        // Re-query since we've updated some; if no more nulls,
        // the next iteration will return 0 rows
        // Don't advance offset since rows shift
        if (rows.length < BATCH_SIZE) break;
      } else {
        offset += BATCH_SIZE;
        if (rows.length < BATCH_SIZE) break;
      }
    }

    if (totalUpdated > 0) {
      logger.info(
        `[queryable-formula] Backfilled ${totalUpdated} row(s) in "${collection}"`,
      );
    } else {
      logger.debug(
        `[queryable-formula] No rows needed backfill in "${collection}"`,
      );
    }

    return totalUpdated;
  }

  async function backfillAll(options: { onlyNulls?: boolean } = {}) {
    if (backfillRunning) {
      logger.debug("[queryable-formula] Backfill already running, skipping");
      return;
    }

    backfillRunning = true;

    try {
      const collections = await getAllFormulaCollections();

      if (collections.size === 0) {
        logger.debug(
          "[queryable-formula] No formula fields found, nothing to backfill",
        );
        return;
      }

      logger.info(
        `[queryable-formula] Starting backfill for ${collections.size} collection(s)...`,
      );

      let totalUpdated = 0;

      for (const [collection, fields] of collections) {
        try {
          const updated = await backfillCollection(collection, fields, options);
          totalUpdated += updated;
        } catch (err: any) {
          logger.error(
            `[queryable-formula] Backfill failed for "${collection}": ${err.message}`,
          );
        }
      }

      logger.info(
        `[queryable-formula] Backfill complete. ${totalUpdated} total row(s) updated.`,
      );
    } finally {
      backfillRunning = false;
    }
  }

  // ─── 1. SERVER STARTUP: Backfill nulls ────────────────────

  init("app.after", async () => {
    // Small delay to ensure DB is ready
    setTimeout(async () => {
      try {
        await backfillAll({ onlyNulls: true });
      } catch (err: any) {
        logger.error(
          `[queryable-formula] Startup backfill failed: ${err.message}`,
        );
      }
    }, 5000);
  });

  // ─── 2. FORMULA FIELD CREATED/UPDATED: Full backfill ─────

  action(
    "fields.create",
    async (meta: { key: string; payload: Record<string, any> }) => {
      const { payload } = meta;

      if (payload?.meta?.interface !== INTERFACE_ID) return;

      const collection = payload.collection;
      if (!collection) return;

      logger.info(
        `[queryable-formula] New formula field detected in "${collection}", triggering backfill...`,
      );

      // Short delay to let Directus finish its own processing
      setTimeout(async () => {
        try {
          const fields = await getFormulaFields(collection);
          if (fields.length > 0) {
            await backfillCollection(collection, fields);
          }
        } catch (err: any) {
          logger.error(
            `[queryable-formula] Post-create backfill failed: ${err.message}`,
          );
        }
      }, 2000);
    },
  );

  action(
    "fields.update",
    async (meta: { keys: string[]; payload: Record<string, any> }) => {
      // When field options change (formula edited), re-backfill
      const { payload } = meta;

      if (
        !payload?.meta?.options?.formula &&
        payload?.meta?.interface !== INTERFACE_ID
      ) {
        return;
      }

      // We need to figure out which collection was affected
      // keys are in format "collection.field"
      const collections = new Set<string>();

      for (const key of meta.keys) {
        try {
          const fieldRecord = await database
            .select("collection", "interface")
            .from("directus_fields")
            .where({ id: key })
            .first();

          if (fieldRecord && fieldRecord.interface === INTERFACE_ID) {
            collections.add(fieldRecord.collection);
          }
        } catch {
          // key might be the field name directly
        }
      }

      if (collections.size === 0) return;

      logger.info(
        `[queryable-formula] Formula field updated, re-backfilling ${collections.size} collection(s)...`,
      );

      setTimeout(async () => {
        for (const collection of collections) {
          try {
            const fields = await getFormulaFields(collection);
            if (fields.length > 0) {
              // Full recompute since formula changed
              await backfillCollection(collection, fields);
            }
          } catch (err: any) {
            logger.error(
              `[queryable-formula] Post-update backfill failed for "${collection}": ${err.message}`,
            );
          }
        }
      }, 2000);
    },
  );

  // ─── 3. ITEM CREATE: Compute before save ──────────────────

  filter(
    "items.create",
    async (payload: Record<string, any>, meta: { collection: string }) => {
      const { collection } = meta;
      const formulaFields = await getFormulaFields(collection);

      if (formulaFields.length === 0) return payload;

      for (const { field, formula } of formulaFields) {
        const result = evaluateFormula(formula, payload);
        if (result !== null && result !== undefined) {
          payload[field] = result;
        }
      }

      return payload;
    },
  );

  // ─── 4. ITEM UPDATE: Recompute if deps changed ───────────

  filter(
    "items.update",
    async (
      payload: Record<string, any>,
      meta: { collection: string; keys: string[] },
      eventContext: any,
    ) => {
      const { collection, keys } = meta;
      const formulaFields = await getFormulaFields(collection);

      if (formulaFields.length === 0) return payload;

      const relevantFormulas = formulaFields.filter(({ watchFields }) =>
        watchFields.some((wf) => wf in payload),
      );

      if (relevantFormulas.length === 0) return payload;

      const db = eventContext.database || database;
      const primaryKeyField = await getPrimaryKeyField(collection);

      for (const key of keys) {
        try {
          const existing = await db
            .select("*")
            .from(collection)
            .where(primaryKeyField, key)
            .first();

          if (!existing) continue;

          const merged = { ...existing, ...payload };

          for (const { field, formula } of relevantFormulas) {
            const result = evaluateFormula(formula, merged);
            if (result !== null && result !== undefined) {
              payload[field] = result;
            }
          }
        } catch (err: any) {
          logger.warn(
            `[queryable-formula] Error fetching record ${key} from ${collection}: ${err.message}`,
          );
        }
      }

      return payload;
    },
  );
};
