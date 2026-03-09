import type { EndpointExtensionContext } from "@directus/extensions";

export default (router: any, context: EndpointExtensionContext) => {
  const { database, logger, getSchema } = context;

  const INTERFACE_ID = "queryable-formula";
  const BATCH_SIZE = 200;

  // ─── Helpers (duplicated from hook — endpoints run in a separate context) ───

  function extractFieldRefs(formula: string): string[] {
    const matches = formula.match(/\{\{([\w.]+)\}\}/g) || [];
    const refs = matches.map((m) => m.replace(/\{\{|\}\}/g, ""));
    const localFields = refs.map((r) =>
      r.includes(".") ? r.split(".")[0]! : r,
    );
    return [...new Set(localFields)];
  }

  function extractRelationalRefs(formula: string): string[] {
    const matches = formula.match(/\{\{([\w]+\.[\w]+)\}\}/g) || [];
    return [...new Set(matches.map((m) => m.replace(/\{\{|\}\}/g, "")))];
  }

  function evaluateFormula(
    formula: string,
    record: Record<string, any>,
  ): string | number | null {
    try {
      let expression = formula;

      // Dotted refs first
      expression = expression.replace(
        /\{\{([\w]+\.[\w]+)\}\}/g,
        (_match: string, dottedRef: string) => {
          const val = record[dottedRef];
          if (val === null || val === undefined) return "null";
          if (typeof val === "string") return JSON.stringify(val);
          return String(val);
        },
      );

      // Simple refs
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
      logger.warn(`[queryable-formula] Endpoint eval error: ${err.message}`);
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
        (_m: string, arg: string) =>
          String(Math.floor(Number(safeEval(arg.trim())))),
      );

      result = result.replace(/CEIL\(([^()]*)\)/gi, (_m: string, arg: string) =>
        String(Math.ceil(Number(safeEval(arg.trim())))),
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
    )
      return trimmed.slice(1, -1);
    if (/^-?\d+(\.\d+)?$/.test(trimmed)) return Number(trimmed);
    if (/^[\d\s+\-*/().%<>=!&|?:]+$/.test(trimmed)) {
      return Function(`"use strict"; return (${trimmed})`)();
    }
    return trimmed;
  }

  async function getPrimaryKeyField(collection: string): Promise<string> {
    const schema = await getSchema();
    const collectionSchema = schema.collections[collection];
    return collectionSchema?.primary ?? "id";
  }

  interface FormulaFieldConfig {
    field: string;
    formula: string;
    watchFields: string[];
    relationalRefs: string[];
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
            relationalRefs: extractRelationalRefs(options.formula),
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

  // ─── Batch relational resolution ───────────────────────────

  async function batchResolveRelationalData(
    collection: string,
    rows: Record<string, any>[],
    relationalRefs: string[],
  ): Promise<Map<number, Record<string, any>>> {
    const result = new Map<number, Record<string, any>>();
    if (relationalRefs.length === 0 || rows.length === 0) return result;

    try {
      const schema = await getSchema();
      const collectionRelations = schema.relations || [];

      const refsByLocal = new Map<string, string[]>();
      for (const ref of relationalRefs) {
        const [localField, remoteField] = ref.split(".");
        if (!localField || !remoteField) continue;
        const existing = refsByLocal.get(localField) || [];
        existing.push(remoteField);
        refsByLocal.set(localField, existing);
      }

      const relationCache = new Map<string, Map<any, Record<string, any>>>();

      for (const [localField, remoteFields] of refsByLocal) {
        const relation = collectionRelations.find(
          (r: any) => r.collection === collection && r.field === localField,
        );
        if (!relation || !relation.related_collection) continue;

        const relatedCollection = relation.related_collection;
        const relatedSchema = schema.collections[relatedCollection];
        const relatedPK = relatedSchema?.primary ?? "id";

        const fkValues = [
          ...new Set(rows.map((r) => r[localField]).filter((v) => v != null)),
        ];
        if (fkValues.length === 0) continue;

        try {
          const relatedRows = await database
            .select([relatedPK, ...remoteFields])
            .from(relatedCollection)
            .whereIn(relatedPK, fkValues);

          const lookup = new Map<any, Record<string, any>>();
          for (const rr of relatedRows) lookup.set(rr[relatedPK], rr);
          relationCache.set(localField, lookup);
        } catch {
          // skip
        }
      }

      for (let i = 0; i < rows.length; i++) {
        const row = rows[i]!;
        const resolved: Record<string, any> = {};
        for (const [localField, remoteFields] of refsByLocal) {
          const fkValue = row[localField];
          const lookup = relationCache.get(localField);
          const relatedRow = fkValue != null ? lookup?.get(fkValue) : undefined;
          for (const rf of remoteFields) {
            resolved[`${localField}.${rf}`] = relatedRow
              ? (relatedRow[rf] ?? null)
              : null;
          }
        }
        result.set(i, resolved);
      }
    } catch (err: any) {
      logger.warn(
        `[queryable-formula] batch relational resolution error: ${err.message}`,
      );
    }

    return result;
  }

  // ─── POST /recalculate ────────────────────────────────────

  router.post("/recalculate", async (req: any, res: any) => {
    // Only admins can trigger recalculation
    if (!req.accountability?.admin) {
      return res.status(403).json({ error: "Admin access required" });
    }

    const { collection, field } = req.body ?? {};

    if (!collection || typeof collection !== "string") {
      return res
        .status(400)
        .json({ error: "Missing or invalid 'collection' in body" });
    }

    try {
      let formulaFields = await getFormulaFields(collection);

      // Optionally filter to a specific field
      if (field && typeof field === "string") {
        formulaFields = formulaFields.filter((f) => f.field === field);
      }

      if (formulaFields.length === 0) {
        return res.json({ updated: 0, message: "No formula fields found" });
      }

      const primaryKey = await getPrimaryKeyField(collection);
      let totalUpdated = 0;
      let offset = 0;

      while (true) {
        const allDependentFields = new Set<string>();
        allDependentFields.add(primaryKey);
        const allRelationalRefs: string[] = [];
        for (const ff of formulaFields) {
          allDependentFields.add(ff.field);
          for (const wf of ff.watchFields) allDependentFields.add(wf);
          for (const rr of ff.relationalRefs) {
            const localField = rr.split(".")[0]!;
            allDependentFields.add(localField);
            if (!allRelationalRefs.includes(rr)) allRelationalRefs.push(rr);
          }
        }

        const rows = await database
          .select([...allDependentFields])
          .from(collection)
          .orderBy(primaryKey, "asc")
          .limit(BATCH_SIZE)
          .offset(offset);

        if (!rows || rows.length === 0) break;

        const relationalMap = await batchResolveRelationalData(
          collection,
          rows,
          allRelationalRefs,
        );

        for (let rowIdx = 0; rowIdx < rows.length; rowIdx++) {
          const row = rows[rowIdx]!;
          const relationalData = relationalMap.get(rowIdx) || {};
          const mergedRow = { ...row, ...relationalData };
          const updates: Record<string, any> = {};
          let needsUpdate = false;

          for (const ff of formulaFields) {
            const computed = evaluateFormula(ff.formula, mergedRow);
            if (computed === null || computed === undefined) continue;
            const current = row[ff.field];
            if (
              String(computed) !== (current != null ? String(current) : null)
            ) {
              updates[ff.field] = computed;
              needsUpdate = true;
            }
          }

          if (needsUpdate) {
            await database(collection)
              .where(primaryKey, row[primaryKey])
              .update(updates);
            totalUpdated++;
          }
        }

        offset += BATCH_SIZE;
        if (rows.length < BATCH_SIZE) break;
      }

      logger.info(
        `[queryable-formula] Manual recalculate: ${totalUpdated} row(s) updated in "${collection}"`,
      );

      return res.json({
        updated: totalUpdated,
        collection,
        field: field ?? "all",
      });
    } catch (err: any) {
      logger.error(`[queryable-formula] Recalculate failed: ${err.message}`);
      return res.status(500).json({ error: err.message });
    }
  });

  // ─── GET /status ──────────────────────────────────────────

  router.get("/status", async (req: any, res: any) => {
    if (!req.accountability?.admin) {
      return res.status(403).json({ error: "Admin access required" });
    }

    try {
      const allFormulaMetas = await database
        .select("collection", "field", "options")
        .from("directus_fields")
        .where({ interface: INTERFACE_ID });

      const fields = allFormulaMetas.map((meta: any) => {
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
        return {
          collection: meta.collection,
          field: meta.field,
          formula: options.formula ?? null,
          cronSchedule: options.cronSchedule ?? null,
        };
      });

      return res.json({ fields });
    } catch (err: any) {
      return res.status(500).json({ error: err.message });
    }
  });
};
