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

  // Track CRON timers for scheduled recalculation
  const cronTimers = new Map<string, ReturnType<typeof setInterval>>();

  // ─── Helpers ──────────────────────────────────────────────

  function extractFieldRefs(formula: string): string[] {
    const matches = formula.match(/\{\{([\w.]+)\}\}/g) || [];
    const refs = matches.map((m) => m.replace(/\{\{|\}\}/g, ""));
    // For dotted refs like "category.name", include the local FK column ("category")
    const localFields = refs.map((r) =>
      r.includes(".") ? r.split(".")[0]! : r,
    );
    return [...new Set(localFields)];
  }

  /**
   * Extract all unique dotted (relational) refs from a formula.
   * e.g. "{{category.name}} - {{author.email}}" → ["category.name", "author.email"]
   */
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

      // Replace dotted refs first (e.g. {{category.name}})
      expression = expression.replace(
        /\{\{([\w]+\.[\w]+)\}\}/g,
        (_match: string, dottedRef: string) => {
          const val = record[dottedRef];
          if (val === null || val === undefined) return "null";
          if (val instanceof Date) return JSON.stringify(val.toISOString().split("T")[0]);
          if (typeof val === "string") return JSON.stringify(val);
          return String(val);
        },
      );

      // Then replace simple refs (e.g. {{price}})
      expression = expression.replace(
        /\{\{(\w+)\}\}/g,
        (_match: string, fieldName: string) => {
          const val = record[fieldName];
          if (val === null || val === undefined) return "null";
          if (val instanceof Date) return JSON.stringify(val.toISOString().split("T")[0]);
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

  /**
   * Resolve relational (dotted) field references for a single record.
   * Given refs like ["category.name", "author.email"], fetches the related
   * records and returns a flat map: { "category.name": "Electronics", "author.email": "a@b.com" }
   */
  async function resolveRelationalData(
    collection: string,
    record: Record<string, any>,
    relationalRefs: string[],
    db?: any,
  ): Promise<Record<string, any>> {
    if (relationalRefs.length === 0) return {};

    const knex = db || database;
    const resolved: Record<string, any> = {};

    try {
      const schema = await getSchema();
      const collectionRelations = schema.relations || [];

      // Group refs by local field: { category: ["name"], author: ["email", "name"] }
      const refsByLocal = new Map<string, string[]>();
      for (const ref of relationalRefs) {
        const [localField, remoteField] = ref.split(".");
        if (!localField || !remoteField) continue;
        const existing = refsByLocal.get(localField) || [];
        existing.push(remoteField);
        refsByLocal.set(localField, existing);
      }

      for (const [localField, remoteFields] of refsByLocal) {
        const fkValue = record[localField];
        if (fkValue === null || fkValue === undefined) {
          // Set all dotted refs to null
          for (const rf of remoteFields) {
            resolved[`${localField}.${rf}`] = null;
          }
          continue;
        }

        // Find the M2O relation for this field
        const relation = collectionRelations.find(
          (r: any) => r.collection === collection && r.field === localField,
        );

        if (!relation || !relation.related_collection) {
          logger.debug(
            `[queryable-formula] No M2O relation found for "${collection}.${localField}"`,
          );
          for (const rf of remoteFields) {
            resolved[`${localField}.${rf}`] = null;
          }
          continue;
        }

        const relatedCollection = relation.related_collection;
        const relatedSchema = schema.collections[relatedCollection];
        const relatedPK = relatedSchema?.primary ?? "id";

        try {
          const relatedRow = await knex
            .select(remoteFields)
            .from(relatedCollection)
            .where(relatedPK, fkValue)
            .first();

          for (const rf of remoteFields) {
            resolved[`${localField}.${rf}`] = relatedRow
              ? (relatedRow[rf] ?? null)
              : null;
          }
        } catch (err: any) {
          logger.debug(
            `[queryable-formula] Failed to resolve ${localField}.* from "${relatedCollection}": ${err.message}`,
          );
          for (const rf of remoteFields) {
            resolved[`${localField}.${rf}`] = null;
          }
        }
      }
    } catch (err: any) {
      logger.warn(
        `[queryable-formula] relational resolution error: ${err.message}`,
      );
    }

    return resolved;
  }

  /**
   * Batch-resolve relational data for many rows at once (avoids N+1 queries).
   * Returns a Map keyed by row index → resolved dotted fields.
   */
  async function batchResolveRelationalData(
    collection: string,
    rows: Record<string, any>[],
    relationalRefs: string[],
    db?: any,
  ): Promise<Map<number, Record<string, any>>> {
    const result = new Map<number, Record<string, any>>();
    if (relationalRefs.length === 0 || rows.length === 0) return result;

    const knex = db || database;

    try {
      const schema = await getSchema();
      const collectionRelations = schema.relations || [];

      // Group: { category: ["name", "slug"], author: ["email"] }
      const refsByLocal = new Map<string, string[]>();
      for (const ref of relationalRefs) {
        const [localField, remoteField] = ref.split(".");
        if (!localField || !remoteField) continue;
        const existing = refsByLocal.get(localField) || [];
        existing.push(remoteField);
        refsByLocal.set(localField, existing);
      }

      // For each relation, batch-fetch all unique FK values
      const relationCache = new Map<string, Map<any, Record<string, any>>>();

      for (const [localField, remoteFields] of refsByLocal) {
        const relation = collectionRelations.find(
          (r: any) => r.collection === collection && r.field === localField,
        );

        if (!relation || !relation.related_collection) continue;

        const relatedCollection = relation.related_collection;
        const relatedSchema = schema.collections[relatedCollection];
        const relatedPK = relatedSchema?.primary ?? "id";

        // Collect unique FK values
        const fkValues = [
          ...new Set(
            rows
              .map((r) => r[localField])
              .filter((v) => v !== null && v !== undefined),
          ),
        ];

        if (fkValues.length === 0) continue;

        try {
          const relatedRows = await knex
            .select([relatedPK, ...remoteFields])
            .from(relatedCollection)
            .whereIn(relatedPK, fkValues);

          const lookup = new Map<any, Record<string, any>>();
          for (const rr of relatedRows) {
            lookup.set(rr[relatedPK], rr);
          }
          relationCache.set(localField, lookup);
        } catch (err: any) {
          logger.debug(
            `[queryable-formula] Batch fetch failed for "${relatedCollection}": ${err.message}`,
          );
        }
      }

      // Now map each row to its resolved values
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

  function processFunctions(expr: string): string {
    let result = expr;
    let maxIterations = 50;

    while (maxIterations-- > 0) {
      const previous = result;

      result = result.replace(
        /\bCONCAT\(([^()]*)\)/gi,
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
        /\bUPPER\(([^()]*)\)/gi,
        (_m: string, arg: string) => {
          const val = String(safeEval(arg.trim()));
          return JSON.stringify(val.toUpperCase());
        },
      );

      result = result.replace(
        /\bLOWER\(([^()]*)\)/gi,
        (_m: string, arg: string) => {
          const val = String(safeEval(arg.trim()));
          return JSON.stringify(val.toLowerCase());
        },
      );

      result = result.replace(
        /\bTRIM\(([^()]*)\)/gi,
        (_m: string, arg: string) => {
          const val = String(safeEval(arg.trim()));
          return JSON.stringify(val.trim());
        },
      );

      result = result.replace(
        /\bROUND\(([^()]*)\)/gi,
        (_m: string, args: string) => {
          const parts = splitArgs(args);
          const num = Number(safeEval(parts[0]!.trim()));
          const decimals = parts[1] ? Number(safeEval(parts[1].trim())) : 0;
          return String(Math.round(num * 10 ** decimals) / 10 ** decimals);
        },
      );

      result = result.replace(
        /\bFLOOR\(([^()]*)\)/gi,
        (_m: string, arg: string) => {
          return String(Math.floor(Number(safeEval(arg.trim()))));
        },
      );

      result = result.replace(
        /\bCEIL\(([^()]*)\)/gi,
        (_m: string, arg: string) => {
          return String(Math.ceil(Number(safeEval(arg.trim()))));
        },
      );

      result = result.replace(
        /\bIF\(([^()]*)\)/gi,
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
        /\bCOALESCE\(([^()]*)\)/gi,
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

      result = result.replace(/\bNOW\(\)/gi, () =>
        JSON.stringify(new Date().toISOString()),
      );

      // ── Date Creation ──────────────────────────────────

      result = result.replace(/\bTODAY\(\)/gi, () => {
        const now = new Date();
        return JSON.stringify(now.toISOString().split("T")[0]);
      });

      result = result.replace(
        /\bDATE\(([^()]*)\)/gi,
        (_m: string, args: string) => {
          const parts = splitArgs(args);
          if (parts.length < 3) return "null";
          const y = Number(safeEval(parts[0]!.trim()));
          const mo = Number(safeEval(parts[1]!.trim()));
          const dy = Number(safeEval(parts[2]!.trim()));
          if (isNaN(y) || isNaN(mo) || isNaN(dy)) return "null";
          const dt = new Date(y, mo - 1, dy);
          return JSON.stringify(dt.toISOString().split("T")[0]);
        },
      );

      result = result.replace(
        /\bDATEVALUE\(([^()]*)\)/gi,
        (_m: string, arg: string) => {
          const d = parseDateValue(safeEval(arg.trim()));
          if (!d) return "null";
          return JSON.stringify(d.toISOString().split("T")[0]);
        },
      );

      result = result.replace(
        /\bTIME\(([^()]*)\)/gi,
        (_m: string, args: string) => {
          const parts = splitArgs(args);
          if (parts.length < 3) return "null";
          const h = Number(safeEval(parts[0]!.trim()));
          const mi = Number(safeEval(parts[1]!.trim()));
          const sc = Number(safeEval(parts[2]!.trim()));
          if (isNaN(h) || isNaN(mi) || isNaN(sc)) return "null";
          return JSON.stringify(
            `${String(h).padStart(2, "0")}:${String(mi).padStart(2, "0")}:${String(sc).padStart(2, "0")}`,
          );
        },
      );

      result = result.replace(
        /\bTIMEVALUE\(([^()]*)\)/gi,
        (_m: string, arg: string) => {
          const d = parseDateValue(safeEval(arg.trim()));
          if (!d) return "null";
          return JSON.stringify(
            d.toISOString().split("T")[1]!.split(".")[0],
          );
        },
      );

      // ── Date Extraction ────────────────────────────────

      result = result.replace(
        /\bYEAR\(([^()]*)\)/gi,
        (_m: string, arg: string) => {
          const d = parseDateValue(safeEval(arg.trim()));
          return d ? String(d.getFullYear()) : "null";
        },
      );

      result = result.replace(
        /\bMONTH\(([^()]*)\)/gi,
        (_m: string, arg: string) => {
          const d = parseDateValue(safeEval(arg.trim()));
          return d ? String(d.getMonth() + 1) : "null";
        },
      );

      result = result.replace(
        /\bDAY\(([^()]*)\)/gi,
        (_m: string, arg: string) => {
          const d = parseDateValue(safeEval(arg.trim()));
          return d ? String(d.getDate()) : "null";
        },
      );

      result = result.replace(
        /\bHOUR\(([^()]*)\)/gi,
        (_m: string, arg: string) => {
          const d = parseDateValue(safeEval(arg.trim()));
          return d ? String(d.getHours()) : "null";
        },
      );

      result = result.replace(
        /\bMINUTE\(([^()]*)\)/gi,
        (_m: string, arg: string) => {
          const d = parseDateValue(safeEval(arg.trim()));
          return d ? String(d.getMinutes()) : "null";
        },
      );

      result = result.replace(
        /\bSECOND\(([^()]*)\)/gi,
        (_m: string, arg: string) => {
          const d = parseDateValue(safeEval(arg.trim()));
          return d ? String(d.getSeconds()) : "null";
        },
      );

      result = result.replace(
        /\bWEEKDAY\(([^()]*)\)/gi,
        (_m: string, args: string) => {
          const parts = splitArgs(args);
          const d = parseDateValue(safeEval(parts[0]!.trim()));
          if (!d) return "null";
          const type = parts[1]
            ? Number(safeEval(parts[1].trim()))
            : 1;
          const jsDay = d.getDay(); // 0=Sun, 6=Sat
          if (type === 2) return String(jsDay === 0 ? 7 : jsDay);
          if (type === 3)
            return String(jsDay === 0 ? 6 : jsDay - 1);
          return String(jsDay + 1); // type 1: Sun=1..Sat=7
        },
      );

      result = result.replace(
        /\bISOWEEKNUM\(([^()]*)\)/gi,
        (_m: string, arg: string) => {
          const d = parseDateValue(safeEval(arg.trim()));
          if (!d) return "null";
          const target = new Date(d.getTime());
          target.setHours(0, 0, 0, 0);
          target.setDate(
            target.getDate() + 3 - ((target.getDay() + 6) % 7),
          );
          const jan4 = new Date(target.getFullYear(), 0, 4);
          return String(
            1 +
              Math.round(
                ((target.getTime() - jan4.getTime()) / 86400000 -
                  3 +
                  ((jan4.getDay() + 6) % 7)) /
                  7,
              ),
          );
        },
      );

      result = result.replace(
        /\bWEEKNUM\(([^()]*)\)/gi,
        (_m: string, args: string) => {
          const parts = splitArgs(args);
          const d = parseDateValue(safeEval(parts[0]!.trim()));
          if (!d) return "null";
          const type = parts[1]
            ? Number(safeEval(parts[1].trim()))
            : 1;
          const startOfYear = new Date(d.getFullYear(), 0, 1);
          const diffMs = d.getTime() - startOfYear.getTime();
          const diffDays = Math.floor(diffMs / 86400000);
          const startDay =
            type === 2
              ? (startOfYear.getDay() + 6) % 7
              : startOfYear.getDay();
          return String(
            Math.ceil((diffDays + startDay + 1) / 7),
          );
        },
      );

      // ── Date Arithmetic ────────────────────────────────

      result = result.replace(
        /\bDATEDIF\(([^()]*)\)/gi,
        (_m: string, args: string) => {
          const parts = splitArgs(args);
          if (parts.length < 3) return "null";
          const start = parseDateValue(safeEval(parts[0]!.trim()));
          const end = parseDateValue(safeEval(parts[1]!.trim()));
          if (!start || !end) return "null";
          const unit = String(
            safeEval(parts[2]!.trim()),
          ).toUpperCase();
          if (unit === "D") {
            return String(
              Math.floor(
                (end.getTime() - start.getTime()) / 86400000,
              ),
            );
          }
          if (unit === "M") {
            return String(
              (end.getFullYear() - start.getFullYear()) * 12 +
                (end.getMonth() - start.getMonth()),
            );
          }
          if (unit === "Y") {
            let years =
              end.getFullYear() - start.getFullYear();
            if (
              end.getMonth() < start.getMonth() ||
              (end.getMonth() === start.getMonth() &&
                end.getDate() < start.getDate())
            ) {
              years--;
            }
            return String(years);
          }
          if (unit === "YM") {
            let months =
              end.getMonth() - start.getMonth();
            if (end.getDate() < start.getDate()) months--;
            if (months < 0) months += 12;
            return String(months);
          }
          if (unit === "MD") {
            let days = end.getDate() - start.getDate();
            if (days < 0) {
              const prevMonth = new Date(
                end.getFullYear(),
                end.getMonth(),
                0,
              );
              days += prevMonth.getDate();
            }
            return String(days);
          }
          if (unit === "YD") {
            const adjStart = new Date(
              end.getFullYear(),
              start.getMonth(),
              start.getDate(),
            );
            let diff = Math.floor(
              (end.getTime() - adjStart.getTime()) / 86400000,
            );
            if (diff < 0) diff += 365;
            return String(diff);
          }
          return "null";
        },
      );

      result = result.replace(
        /\bDAYS\(([^()]*)\)/gi,
        (_m: string, args: string) => {
          const parts = splitArgs(args);
          if (parts.length < 2) return "null";
          const endD = parseDateValue(
            safeEval(parts[0]!.trim()),
          );
          const startD = parseDateValue(
            safeEval(parts[1]!.trim()),
          );
          if (!endD || !startD) return "null";
          return String(
            Math.floor(
              (endD.getTime() - startD.getTime()) / 86400000,
            ),
          );
        },
      );

      result = result.replace(
        /\bEDATE\(([^()]*)\)/gi,
        (_m: string, args: string) => {
          const parts = splitArgs(args);
          if (parts.length < 2) return "null";
          const d = parseDateValue(safeEval(parts[0]!.trim()));
          if (!d) return "null";
          const months = Number(safeEval(parts[1]!.trim()));
          if (isNaN(months)) return "null";
          const nd = new Date(d);
          nd.setMonth(nd.getMonth() + months);
          return JSON.stringify(nd.toISOString().split("T")[0]);
        },
      );

      result = result.replace(
        /\bEOMONTH\(([^()]*)\)/gi,
        (_m: string, args: string) => {
          const parts = splitArgs(args);
          if (parts.length < 2) return "null";
          const d = parseDateValue(safeEval(parts[0]!.trim()));
          if (!d) return "null";
          const months = Number(safeEval(parts[1]!.trim()));
          if (isNaN(months)) return "null";
          const eom = new Date(
            d.getFullYear(),
            d.getMonth() + months + 1,
            0,
          );
          return JSON.stringify(
            eom.toISOString().split("T")[0],
          );
        },
      );

      result = result.replace(
        /\bNETWORKDAYS\(([^()]*)\)/gi,
        (_m: string, args: string) => {
          const parts = splitArgs(args);
          if (parts.length < 2) return "null";
          const startD = parseDateValue(
            safeEval(parts[0]!.trim()),
          );
          const endD = parseDateValue(
            safeEval(parts[1]!.trim()),
          );
          if (!startD || !endD) return "null";
          return String(countNetworkDays(startD, endD));
        },
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

  // ─── Date helpers (used by date functions) ──────────────

  function parseDateValue(val: any): Date | null {
    if (val === null || val === undefined || val === "null") return null;
    const s = typeof val === "string" ? val : String(val);
    if (!s || s === "null") return null;
    const d = new Date(s);
    return isNaN(d.getTime()) ? null : d;
  }

  function countNetworkDays(startDate: Date, endDate: Date): number {
    const s = new Date(startDate);
    s.setHours(0, 0, 0, 0);
    const e = new Date(endDate);
    e.setHours(0, 0, 0, 0);
    if (s > e) return -countNetworkDays(e, s);
    const totalDays =
      Math.round((e.getTime() - s.getTime()) / 86400000) + 1;
    const fullWeeks = Math.floor(totalDays / 7);
    const remainder = totalDays % 7;
    let workDays = fullWeeks * 5;
    const startDay = s.getDay();
    for (let i = 0; i < remainder; i++) {
      const dow = (startDay + i) % 7;
      if (dow !== 0 && dow !== 6) workDays++;
    }
    return workDays;
  }

  // ─── Dependency resolution ─────────────────────────────────

  /**
   * Topologically sort formula fields so dependencies evaluate first.
   * Uses Kahn's algorithm. Fields involved in cycles are returned
   * separately and skipped during evaluation.
   */
  function topologicalSortFormulas(
    formulaFields: FormulaFieldConfig[],
  ): { sorted: FormulaFieldConfig[]; circular: string[] } {
    if (formulaFields.length <= 1) {
      return { sorted: [...formulaFields], circular: [] };
    }

    const fieldMap = new Map(formulaFields.map((f) => [f.field, f]));
    const formulaFieldNames = new Set(formulaFields.map((f) => f.field));

    // field → set of formula fields it depends on
    const deps = new Map<string, Set<string>>();
    for (const ff of formulaFields) {
      const formulaDeps = new Set<string>();
      const refs = ff.formula.match(/\{\{(\w+)\}\}/g) || [];
      for (const ref of refs) {
        const name = ref.replace(/\{\{|\}\}/g, "");
        if (formulaFieldNames.has(name) && name !== ff.field) {
          formulaDeps.add(name);
        }
      }
      deps.set(ff.field, formulaDeps);
    }

    // field → set of formula fields that depend on it
    const dependents = new Map<string, Set<string>>();
    for (const ff of formulaFields) {
      dependents.set(ff.field, new Set());
    }
    for (const [field, fieldDeps] of deps) {
      for (const dep of fieldDeps) {
        dependents.get(dep)?.add(field);
      }
    }

    // Kahn's algorithm
    const inDegree = new Map<string, number>();
    for (const ff of formulaFields) {
      inDegree.set(ff.field, deps.get(ff.field)?.size ?? 0);
    }

    const queue: string[] = [];
    for (const [field, deg] of inDegree) {
      if (deg === 0) queue.push(field);
    }

    const sorted: FormulaFieldConfig[] = [];
    while (queue.length > 0) {
      const field = queue.shift()!;
      sorted.push(fieldMap.get(field)!);

      for (const dependent of dependents.get(field) ?? []) {
        const newDeg = (inDegree.get(dependent) ?? 1) - 1;
        inDegree.set(dependent, newDeg);
        if (newDeg === 0) queue.push(dependent);
      }
    }

    // Fields not in sorted are part of a cycle
    const circular = formulaFields
      .filter((ff) => !sorted.some((s) => s.field === ff.field))
      .map((ff) => ff.field);

    return { sorted, circular };
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
    relationalRefs: string[]; // e.g. ["category.name", "author.email"]
  }

  async function getFormulaFields(
    collection: string,
    db?: any,
  ): Promise<FormulaFieldConfig[]> {
    const formulaFields: FormulaFieldConfig[] = [];
    const knex = db || database;

    try {
      const fieldMetas = await knex
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
          relationalRefs: extractRelationalRefs(options.formula),
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
      // by any formula (including FK columns for relational refs)
      const allDependentFields = new Set<string>();
      allDependentFields.add(primaryKey);

      // Collect all relational refs across formulas
      const allRelationalRefs: string[] = [];

      for (const ff of formulaFields) {
        allDependentFields.add(ff.field);
        for (const wf of ff.watchFields) {
          allDependentFields.add(wf);
        }
        // Also include FK columns for relational refs
        for (const rr of ff.relationalRefs) {
          const localField = rr.split(".")[0]!;
          allDependentFields.add(localField);
          if (!allRelationalRefs.includes(rr)) allRelationalRefs.push(rr);
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

      // Batch-resolve relational data for this batch
      const relationalMap = await batchResolveRelationalData(
        collection,
        rows,
        allRelationalRefs,
      );

      // Sort formulas so dependencies are evaluated first
      const { sorted: sortedFormulas, circular } =
        topologicalSortFormulas(formulaFields);
      if (circular.length > 0) {
        logger.warn(
          `[queryable-formula] Circular dependency in "${collection}" — skipping fields: ${circular.join(", ")}`,
        );
      }

      // Process each row
      for (let rowIdx = 0; rowIdx < rows.length; rowIdx++) {
        const row = rows[rowIdx]!;
        const relationalData = relationalMap.get(rowIdx) || {};
        const mergedRow = { ...row, ...relationalData };
        const updates: Record<string, any> = {};
        let needsUpdate = false;

        for (const ff of sortedFormulas) {
          const computed = evaluateFormula(ff.formula, mergedRow);

          if (computed === null || computed === undefined) continue;

          // Feed result back so dependent formulas see the fresh value
          mergedRow[ff.field] = computed;

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

  // ─── CRON Scheduling ─────────────────────────────────────

  function parseCronToMs(cron: string): number | null {
    const parts = cron.trim().split(/\s+/);
    if (parts.length < 5) return null;
    const [minute, hour, dayOfMonth, month, dayOfWeek] = parts;

    // Only support simple interval patterns for setInterval
    // */N * * * * → every N minutes
    if (
      hour === "*" &&
      dayOfMonth === "*" &&
      month === "*" &&
      dayOfWeek === "*"
    ) {
      if (minute === "*") return 60_000; // every minute
      const everyN = minute!.match(/^\*\/(\d+)$/);
      if (everyN) return parseInt(everyN[1]!, 10) * 60_000;
      // Specific minute like "0" means once per hour at minute 0
    }

    // 0 * * * * → every hour
    if (
      /^\d+$/.test(minute!) &&
      hour === "*" &&
      dayOfMonth === "*" &&
      month === "*" &&
      dayOfWeek === "*"
    ) {
      return 60 * 60_000;
    }

    // 0 0 * * * → daily
    if (
      /^\d+$/.test(minute!) &&
      /^\d+$/.test(hour!) &&
      dayOfMonth === "*" &&
      month === "*" &&
      dayOfWeek === "*"
    ) {
      return 24 * 60 * 60_000;
    }

    // 0 0 * * 0 → weekly
    if (
      /^\d+$/.test(minute!) &&
      /^\d+$/.test(hour!) &&
      dayOfMonth === "*" &&
      month === "*" &&
      /^\d+$/.test(dayOfWeek!)
    ) {
      return 7 * 24 * 60 * 60_000;
    }

    // Fallback: default to hourly for unrecognized patterns
    return 60 * 60_000;
  }

  async function setupCronSchedules() {
    // Clear existing timers
    for (const [key, timer] of cronTimers) {
      clearInterval(timer);
      cronTimers.delete(key);
    }

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

        if (!options.cronSchedule) continue;

        const intervalMs = parseCronToMs(options.cronSchedule);
        if (!intervalMs) continue;

        const timerKey = `${meta.collection}::${meta.field}`;
        logger.info(
          `[queryable-formula] Scheduling recalculation for "${timerKey}" every ${Math.round(intervalMs / 60_000)} min`,
        );

        const timer = setInterval(async () => {
          try {
            const fields = await getFormulaFields(meta.collection);
            if (fields.length > 0) {
              await backfillCollection(meta.collection, fields);
            }
          } catch (err: any) {
            logger.error(
              `[queryable-formula] Scheduled recalc failed for "${timerKey}": ${err.message}`,
            );
          }
        }, intervalMs);

        cronTimers.set(timerKey, timer);
      }

      if (cronTimers.size > 0) {
        logger.info(
          `[queryable-formula] ${cronTimers.size} cron schedule(s) active`,
        );
      }
    } catch (err: any) {
      logger.error(
        `[queryable-formula] Failed to set up cron schedules: ${err.message}`,
      );
    }
  }

  // ─── 1. SERVER STARTUP: Backfill nulls + set up CRON ─────

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

      // Set up CRON schedules after backfill
      try {
        await setupCronSchedules();
      } catch (err: any) {
        logger.error(
          `[queryable-formula] Startup cron setup failed: ${err.message}`,
        );
      }
    }, 5000);
  });

  // ─── 2. FORMULA FIELD CREATED/UPDATED: Full backfill ─────

  action(
    "fields.create",
    async (meta: {
      key: string;
      payload: Record<string, any>;
      collection: string;
    }) => {
      const { payload, collection: metaCollection } = meta;

      // Determine if this is a queryable-formula field
      const iface = payload?.meta?.interface ?? payload?.interface;
      if (iface !== INTERFACE_ID) return;

      const collection = metaCollection ?? payload?.collection;
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
        // Refresh CRON schedules in case new field has one
        await setupCronSchedules();
      }, 2000);
    },
  );

  action(
    "fields.update",
    async (meta: {
      keys: string[];
      payload: Record<string, any>;
      collection: string;
    }) => {
      // When field options change (formula edited), re-backfill.
      // Directus fires this whenever a field's metadata is saved.
      // We scan the DB for the affected fields to determine which
      // collections need recalculation.

      const collections = new Set<string>();

      // Try to get collection from meta directly
      if (meta.collection) {
        // Check if any formula fields exist in this collection
        try {
          const fields = await getFormulaFields(meta.collection);
          if (fields.length > 0) {
            collections.add(meta.collection);
          }
        } catch {
          // ignore
        }
      }

      // Also look up each key — keys may be field names or numeric IDs
      for (const key of meta.keys) {
        try {
          // Try by field name + collection
          let fieldRecord = meta.collection
            ? await database
                .select("collection", "interface")
                .from("directus_fields")
                .where({
                  collection: meta.collection,
                  field: key,
                  interface: INTERFACE_ID,
                })
                .first()
            : null;

          // Fallback: try by numeric id
          if (!fieldRecord) {
            fieldRecord = await database
              .select("collection", "interface")
              .from("directus_fields")
              .where({ id: key })
              .first();
          }

          if (fieldRecord && fieldRecord.interface === INTERFACE_ID) {
            collections.add(fieldRecord.collection);
          }
        } catch {
          // ignore lookup failures
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
        // Refresh CRON schedules in case cron expression changed
        await setupCronSchedules();
      }, 2000);
    },
  );

  // ─── 3. ITEM CREATE: Compute before save ──────────────────

  filter(
    "items.create",
    async (
      payload: Record<string, any>,
      meta: { collection: string },
      eventContext: any,
    ) => {
      const { collection } = meta;
      const db = eventContext.database || database;
      const formulaFields = await getFormulaFields(collection, db);

      if (formulaFields.length === 0) return payload;

      // Sort formulas so dependencies are evaluated first
      const { sorted: sortedFormulas, circular } =
        topologicalSortFormulas(formulaFields);
      if (circular.length > 0) {
        logger.warn(
          `[queryable-formula] Circular dependency in "${collection}" — skipping fields: ${circular.join(", ")}`,
        );
      }

      // Collect relational refs across all formulas
      const allRelRefs = sortedFormulas.flatMap((ff) => ff.relationalRefs);
      const relationalData =
        allRelRefs.length > 0
          ? await resolveRelationalData(collection, payload, allRelRefs, db)
          : {};
      const enrichedPayload = { ...payload, ...relationalData };

      for (const { field, formula } of sortedFormulas) {
        const result = evaluateFormula(formula, enrichedPayload);
        if (result !== null && result !== undefined) {
          payload[field] = result;
          enrichedPayload[field] = result;
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
      const db = eventContext.database || database;
      const formulaFields = await getFormulaFields(collection, db);

      if (formulaFields.length === 0) return payload;

      // Sort all formulas in dependency order
      const { sorted: sortedFormulas, circular } =
        topologicalSortFormulas(formulaFields);
      if (circular.length > 0) {
        logger.warn(
          `[queryable-formula] Circular dependency in "${collection}" — skipping fields: ${circular.join(", ")}`,
        );
      }

      // Check if any formula is directly triggered by the payload
      const hasDirectlyAffected = sortedFormulas.some(({ watchFields }) =>
        watchFields.some((wf) => wf in payload),
      );
      if (!hasDirectlyAffected) return payload;

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

          // Resolve relational data for all formulas (cascading may need any of them)
          const allRelRefs = sortedFormulas.flatMap(
            (ff) => ff.relationalRefs,
          );
          const relationalData =
            allRelRefs.length > 0
              ? await resolveRelationalData(collection, merged, allRelRefs, db)
              : {};
          const enrichedMerged = { ...merged, ...relationalData };

          // Evaluate in dependency order, cascading through formula-to-formula deps
          const recalculated = new Set<string>();
          for (const { field, formula, watchFields } of sortedFormulas) {
            const shouldRecalc = watchFields.some(
              (wf) => wf in payload || recalculated.has(wf),
            );
            if (!shouldRecalc) continue;

            const result = evaluateFormula(formula, enrichedMerged);
            if (result !== null && result !== undefined) {
              payload[field] = result;
              enrichedMerged[field] = result;
              recalculated.add(field);
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
