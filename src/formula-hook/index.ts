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
    const matches = formula.match(/\{\{(\w+(?:\.\w+)+)\}\}/g) || [];
    return [...new Set(matches.map((m) => m.replace(/\{\{|\}\}/g, "")))];
  }

  /**
   * Directus may include keys in `items.update` payloads with value `undefined`
   * (meaning "omit from patch"). Spreading such a payload onto the existing row
   * clobbers DB values with undefined and makes formulas evaluate as empty → 0.
   * This shows up more often on PostgreSQL / production than in local SQLite dev.
   */
  function payloadUpdatesField(
    payload: Record<string, any>,
    field: string,
  ): boolean {
    return (
      Object.prototype.hasOwnProperty.call(payload, field) &&
      payload[field] !== undefined
    );
  }

  function mergeRecordWithPayload(
    existing: Record<string, any>,
    payload: Record<string, any>,
  ): Record<string, any> {
    const merged = { ...existing };
    for (const key of Object.keys(payload)) {
      const v = payload[key];
      if (v !== undefined) {
        merged[key] = v;
      }
    }
    return merged;
  }

  function extractRelationKey(value: any, preferredKey = "id"): any {
    if (value === null || value === undefined) return null;
    if (typeof value === "object" && !(value instanceof Date)) {
      if (Object.prototype.hasOwnProperty.call(value, preferredKey)) {
        return value[preferredKey];
      }
      if (Object.prototype.hasOwnProperty.call(value, "id")) return value.id;
      if (Object.prototype.hasOwnProperty.call(value, "value")) return value.value;
    }
    return value;
  }

  function normalizeRelationKey(value: any, preferredKey = "id"): string | null {
    const key = extractRelationKey(value, preferredKey);
    if (key === null || key === undefined) return null;
    return String(key);
  }

  function evaluateFormula(
    formula: string,
    record: Record<string, any>,
  ): string | number | null {
    try {
      let expression = formula;

      // Replace dotted refs first (e.g. {{category.name}}, {{category.parent.name}})
      expression = expression.replace(
        /\{\{(\w+(?:\.\w+)+)\}\}/g,
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
   * Delegates to the batch version for consistency.
   */
  async function resolveRelationalData(
    collection: string,
    record: Record<string, any>,
    relationalRefs: string[],
    db?: any,
  ): Promise<Record<string, any>> {
    if (relationalRefs.length === 0) return {};
    const batchResult = await batchResolveRelationalData(
      collection,
      [record],
      relationalRefs,
      db,
    );
    return batchResult.get(0) || {};
  }

  /**
   * Batch-resolve relational data for many rows at once (avoids N+1 queries).
   * Supports:
   * - Simple M2O: {{category.name}}
   * - Nested M2O chains: {{category.parent.name}}
   * - O2M (One-to-Many): {{reviews.rating}} → comma-separated values
   * - M2M (Many-to-Many): {{tags.name}} → comma-separated values
   * - Mixed chains: {{category.products.name}} (M2O → O2M)
   *
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

    // Initialize result map
    for (let i = 0; i < rows.length; i++) {
      result.set(i, {});
    }

    try {
      const schema = await getSchema();
      const allRelations = schema.relations || [];

      // Process each ref as an independent chain walk
      for (const ref of relationalRefs) {
        const segments = ref.split(".");
        if (segments.length < 2) continue;

        // All segments except the last are relation hops; the last is the field to extract
        const relationSegments = segments.slice(0, -1);
        const finalField = segments[segments.length - 1]!;

        // Walk the relation chain, tracking cursors for each source row
        let currentCollection = collection;
        // Map: source row index → array of current cursor rows at this level
        let cursors = new Map<number, Record<string, any>[]>();
        for (let i = 0; i < rows.length; i++) {
          cursors.set(i, [rows[i]!]);
        }

        let chainBroken = false;

        for (const segment of relationSegments) {
          // --- Try M2O first: currentCollection has an FK field → related collection ---
          const m2oRelation = allRelations.find(
            (r: any) =>
              r.collection === currentCollection && r.field === segment,
          );

          if (m2oRelation && m2oRelation.related_collection) {
            const relatedCollection = m2oRelation.related_collection;
            const relatedSchema = schema.collections[relatedCollection];
            const relatedPK = relatedSchema?.primary ?? "id";

            // Collect unique FK values across all cursor rows. Values may be
            // expanded relation objects in Directus payloads, so normalize for
            // lookup while keeping the scalar value for SQL.
            const fkValues = new Map<string, any>();
            for (const [, cursorRows] of cursors) {
              for (const row of cursorRows) {
                const fk = extractRelationKey(row[segment], relatedPK);
                const key = normalizeRelationKey(fk);
                if (key != null) fkValues.set(key, fk);
              }
            }

            if (fkValues.size === 0) {
              chainBroken = true;
              break;
            }

            try {
              const relatedRows = await knex
                .select("*")
                .from(relatedCollection)
                .whereIn(relatedPK, [...fkValues.values()]);

              const lookup = new Map<string, Record<string, any>>();
              for (const rr of relatedRows) {
                const key = normalizeRelationKey(rr[relatedPK], relatedPK);
                if (key != null) lookup.set(key, rr);
              }

              const newCursors = new Map<number, Record<string, any>[]>();
              for (const [rowIdx, cursorRows] of cursors) {
                const next: Record<string, any>[] = [];
                for (const row of cursorRows) {
                  const key = normalizeRelationKey(row[segment], relatedPK);
                  if (key != null) {
                    const related = lookup.get(key);
                    if (related) next.push(related);
                  }
                }
                if (next.length > 0) newCursors.set(rowIdx, next);
              }
              cursors = newCursors;
              currentCollection = relatedCollection;
            } catch (err: any) {
              logger.debug(
                `[queryable-formula] M2O batch fetch failed for "${relatedCollection}": ${err.message}`,
              );
              chainBroken = true;
              break;
            }
            continue;
          }

          // --- Try O2M / M2M: currentCollection is the "one" side ---
          const o2mRelation = allRelations.find(
            (r: any) =>
              r.related_collection === currentCollection &&
              r.meta?.one_field === segment,
          );

          if (o2mRelation) {
            const currentSchema = schema.collections[currentCollection];
            const currentPK = currentSchema?.primary ?? "id";

            // Collect PKs from all cursor rows
            const pkValues = new Map<string, any>();
            for (const [, cursorRows] of cursors) {
              for (const row of cursorRows) {
                const pk = extractRelationKey(row[currentPK], currentPK);
                const key = normalizeRelationKey(pk);
                if (key != null) pkValues.set(key, pk);
              }
            }

            if (pkValues.size === 0) {
              chainBroken = true;
              break;
            }

            if (o2mRelation.meta?.junction_field) {
              // ── M2M: traverse junction table ──
              const junctionCollection = o2mRelation.collection;
              const junctionSourceFK = o2mRelation.field; // FK → current collection
              const junctionTargetFK = o2mRelation.meta.junction_field; // FK → target collection

              // Find the relation from junction → target
              const junctionToTarget = allRelations.find(
                (r: any) =>
                  r.collection === junctionCollection &&
                  r.field === junctionTargetFK,
              );

              if (
                !junctionToTarget ||
                !junctionToTarget.related_collection
              ) {
                logger.debug(
                  `[queryable-formula] M2M: no target relation found from junction "${junctionCollection}.${junctionTargetFK}"`,
                );
                chainBroken = true;
                break;
              }

              const targetCollection = junctionToTarget.related_collection;
              const targetSchema = schema.collections[targetCollection];
              const targetPK = targetSchema?.primary ?? "id";

              try {
                // Fetch junction rows
                const junctionRows = await knex
                  .select([junctionSourceFK, junctionTargetFK])
                  .from(junctionCollection)
                  .whereIn(junctionSourceFK, [...pkValues.values()]);

                // Collect target PKs
                const targetPKs = new Map<string, any>();
                for (const jr of junctionRows) {
                  const targetPKValue = extractRelationKey(
                    jr[junctionTargetFK],
                    targetPK,
                  );
                  const key = normalizeRelationKey(targetPKValue);
                  if (key != null) targetPKs.set(key, targetPKValue);
                }

                if (targetPKs.size === 0) {
                  chainBroken = true;
                  break;
                }

                // Fetch target rows
                const targetRows = await knex
                  .select("*")
                  .from(targetCollection)
                  .whereIn(targetPK, [...targetPKs.values()]);

                const targetLookup = new Map<string, Record<string, any>>();
                for (const tr of targetRows) {
                  const key = normalizeRelationKey(tr[targetPK], targetPK);
                  if (key != null) targetLookup.set(key, tr);
                }

                // Build source PK → target rows mapping
                const sourceToTargets = new Map<
                  string,
                  Record<string, any>[]
                >();
                for (const jr of junctionRows) {
                  const sourceKey = normalizeRelationKey(
                    jr[junctionSourceFK],
                    currentPK,
                  );
                  const targetKey = normalizeRelationKey(
                    jr[junctionTargetFK],
                    targetPK,
                  );
                  const target = targetKey ? targetLookup.get(targetKey) : null;
                  if (target) {
                    const existing = sourceKey
                      ? sourceToTargets.get(sourceKey) || []
                      : [];
                    existing.push(target);
                    if (sourceKey) sourceToTargets.set(sourceKey, existing);
                  }
                }

                const newCursors = new Map<
                  number,
                  Record<string, any>[]
                >();
                for (const [rowIdx, cursorRows] of cursors) {
                  const next: Record<string, any>[] = [];
                  for (const row of cursorRows) {
                    const key = normalizeRelationKey(row[currentPK], currentPK);
                    const targets = key ? sourceToTargets.get(key) || [] : [];
                    next.push(...targets);
                  }
                  if (next.length > 0) newCursors.set(rowIdx, next);
                }
                cursors = newCursors;
                currentCollection = targetCollection;
              } catch (err: any) {
                logger.debug(
                  `[queryable-formula] M2M batch fetch failed: ${err.message}`,
                );
                chainBroken = true;
                break;
              }
            } else {
              // ── O2M: direct one-to-many ──
              const manyCollection = o2mRelation.collection;
              const manyField = o2mRelation.field;

              try {
                const manyRows = await knex
                  .select("*")
                  .from(manyCollection)
                  .whereIn(manyField, [...pkValues.values()]);

                // Group by FK value
                const fkToRows = new Map<string, Record<string, any>[]>();
                for (const mr of manyRows) {
                  const key = normalizeRelationKey(mr[manyField], currentPK);
                  if (key == null) continue;
                  const existing = fkToRows.get(key) || [];
                  existing.push(mr);
                  fkToRows.set(key, existing);
                }

                const newCursors = new Map<
                  number,
                  Record<string, any>[]
                >();
                for (const [rowIdx, cursorRows] of cursors) {
                  const next: Record<string, any>[] = [];
                  for (const row of cursorRows) {
                    const key = normalizeRelationKey(row[currentPK], currentPK);
                    const related = key ? fkToRows.get(key) || [] : [];
                    next.push(...related);
                  }
                  if (next.length > 0) newCursors.set(rowIdx, next);
                }
                cursors = newCursors;
                currentCollection = manyCollection;
              } catch (err: any) {
                logger.debug(
                  `[queryable-formula] O2M batch fetch failed for "${manyCollection}": ${err.message}`,
                );
                chainBroken = true;
                break;
              }
            }
            continue;
          }

          // No relation found for this segment
          logger.debug(
            `[queryable-formula] No relation found for "${currentCollection}.${segment}"`,
          );
          chainBroken = true;
          break;
        }

        // Extract the final field from cursor rows and populate results
        for (let i = 0; i < rows.length; i++) {
          const resolved = result.get(i)!;
          if (chainBroken) {
            resolved[ref] = null;
            continue;
          }
          const cursorRows = cursors.get(i);
          if (!cursorRows || cursorRows.length === 0) {
            resolved[ref] = null;
          } else {
            const values = cursorRows
              .map((r) => r[finalField])
              .filter((v) => v != null);
            if (values.length === 0) {
              resolved[ref] = null;
            } else if (values.length === 1) {
              resolved[ref] = values[0];
            } else {
              // Multiple values (O2M / M2M): comma-separated
              resolved[ref] = values.join(", ");
            }
          }
        }
      }
    } catch (err: any) {
      logger.warn(
        `[queryable-formula] batch relational resolution error: ${err.message}`,
      );
    }

    return result;
  }

  function processFunctions(expr: string): string {
    const functionHandlers: Record<string, (args: string) => string> = {
      CONCAT: (args: string) => {
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
      UPPER: (args: string) =>
        JSON.stringify(String(safeEval(args.trim())).toUpperCase()),
      LOWER: (args: string) =>
        JSON.stringify(String(safeEval(args.trim())).toLowerCase()),
      TRIM: (args: string) =>
        JSON.stringify(String(safeEval(args.trim())).trim()),
      ROUND: (args: string) => {
        const parts = splitArgs(args);
        const num = Number(safeEval(parts[0]!.trim()));
        const decimals = parts[1] ? Number(safeEval(parts[1].trim())) : 0;
        return String(Math.round(num * 10 ** decimals) / 10 ** decimals);
      },
      FLOOR: (args: string) =>
        String(Math.floor(Number(safeEval(args.trim())))),
      CEIL: (args: string) =>
        String(Math.ceil(Number(safeEval(args.trim())))),
      IF: (args: string) => {
        const parts = splitArgs(args);
        if (parts.length < 3) return "null";
        const cond = safeEval(parts[0]!.trim());
        const val = cond
          ? safeEval(parts[1]!.trim())
          : safeEval(parts[2]!.trim());
        return serializeFormulaValue(val);
      },
      COALESCE: (args: string) => {
        const parts = splitArgs(args);
        for (const part of parts) {
          const val = safeEval(part.trim());
          if (val !== null && val !== undefined && val !== "null") {
            return serializeFormulaValue(val);
          }
        }
        return "null";
      },
      NOW: () => JSON.stringify(new Date().toISOString()),
      TODAY: () => {
        const now = new Date();
        return JSON.stringify(now.toISOString().split("T")[0]);
      },
      DATE: (args: string) => {
        const parts = splitArgs(args);
        if (parts.length < 3) return "null";
        const y = Number(safeEval(parts[0]!.trim()));
        const mo = Number(safeEval(parts[1]!.trim()));
        const dy = Number(safeEval(parts[2]!.trim()));
        if (isNaN(y) || isNaN(mo) || isNaN(dy)) return "null";
        const dt = new Date(y, mo - 1, dy);
        return JSON.stringify(dt.toISOString().split("T")[0]);
      },
      DATEVALUE: (args: string) => {
        const d = parseDateValue(safeEval(args.trim()));
        if (!d) return "null";
        return JSON.stringify(d.toISOString().split("T")[0]);
      },
      TIME: (args: string) => {
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
      TIMEVALUE: (args: string) => {
        const d = parseDateValue(safeEval(args.trim()));
        if (!d) return "null";
        return JSON.stringify(
          d.toISOString().split("T")[1]!.split(".")[0],
        );
      },
      YEAR: (args: string) => {
        const d = parseDateValue(safeEval(args.trim()));
        return d ? String(d.getFullYear()) : "null";
      },
      MONTH: (args: string) => {
        const d = parseDateValue(safeEval(args.trim()));
        return d ? String(d.getMonth() + 1) : "null";
      },
      DAY: (args: string) => {
        const d = parseDateValue(safeEval(args.trim()));
        return d ? String(d.getDate()) : "null";
      },
      HOUR: (args: string) => {
        const d = parseDateValue(safeEval(args.trim()));
        return d ? String(d.getHours()) : "null";
      },
      MINUTE: (args: string) => {
        const d = parseDateValue(safeEval(args.trim()));
        return d ? String(d.getMinutes()) : "null";
      },
      SECOND: (args: string) => {
        const d = parseDateValue(safeEval(args.trim()));
        return d ? String(d.getSeconds()) : "null";
      },
      WEEKDAY: (args: string) => {
        const parts = splitArgs(args);
        const d = parseDateValue(safeEval(parts[0]!.trim()));
        if (!d) return "null";
        const type = parts[1] ? Number(safeEval(parts[1].trim())) : 1;
        const jsDay = d.getDay();
        if (type === 2) return String(jsDay === 0 ? 7 : jsDay);
        if (type === 3) return String(jsDay === 0 ? 6 : jsDay - 1);
        return String(jsDay + 1);
      },
      ISOWEEKNUM: (args: string) => {
        const d = parseDateValue(safeEval(args.trim()));
        if (!d) return "null";
        const target = new Date(d.getTime());
        target.setHours(0, 0, 0, 0);
        target.setDate(target.getDate() + 3 - ((target.getDay() + 6) % 7));
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
      WEEKNUM: (args: string) => {
        const parts = splitArgs(args);
        const d = parseDateValue(safeEval(parts[0]!.trim()));
        if (!d) return "null";
        const type = parts[1] ? Number(safeEval(parts[1].trim())) : 1;
        const startOfYear = new Date(d.getFullYear(), 0, 1);
        const diffMs = d.getTime() - startOfYear.getTime();
        const diffDays = Math.floor(diffMs / 86400000);
        const startDay =
          type === 2 ? (startOfYear.getDay() + 6) % 7 : startOfYear.getDay();
        return String(Math.ceil((diffDays + startDay + 1) / 7));
      },
      DATEDIF: (args: string) => {
        const parts = splitArgs(args);
        if (parts.length < 3) return "null";
        const start = parseDateValue(safeEval(parts[0]!.trim()));
        const end = parseDateValue(safeEval(parts[1]!.trim()));
        if (!start || !end) return "null";
        const unit = String(safeEval(parts[2]!.trim())).toUpperCase();
        if (unit === "D") {
          return String(
            Math.floor((end.getTime() - start.getTime()) / 86400000),
          );
        }
        if (unit === "M") {
          return String(
            (end.getFullYear() - start.getFullYear()) * 12 +
              (end.getMonth() - start.getMonth()),
          );
        }
        if (unit === "Y") {
          let years = end.getFullYear() - start.getFullYear();
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
          let months = end.getMonth() - start.getMonth();
          if (end.getDate() < start.getDate()) months--;
          if (months < 0) months += 12;
          return String(months);
        }
        if (unit === "MD") {
          let days = end.getDate() - start.getDate();
          if (days < 0) {
            const prevMonth = new Date(end.getFullYear(), end.getMonth(), 0);
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
      DAYS: (args: string) => {
        const parts = splitArgs(args);
        if (parts.length < 2) return "null";
        const endD = parseDateValue(safeEval(parts[0]!.trim()));
        const startD = parseDateValue(safeEval(parts[1]!.trim()));
        if (!endD || !startD) return "null";
        return String(
          Math.floor((endD.getTime() - startD.getTime()) / 86400000),
        );
      },
      EDATE: (args: string) => {
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
      EOMONTH: (args: string) => {
        const parts = splitArgs(args);
        if (parts.length < 2) return "null";
        const d = parseDateValue(safeEval(parts[0]!.trim()));
        if (!d) return "null";
        const months = Number(safeEval(parts[1]!.trim()));
        if (isNaN(months)) return "null";
        const eom = new Date(d.getFullYear(), d.getMonth() + months + 1, 0);
        return JSON.stringify(eom.toISOString().split("T")[0]);
      },
      NETWORKDAYS: (args: string) => {
        const parts = splitArgs(args);
        if (parts.length < 2) return "null";
        const startD = parseDateValue(safeEval(parts[0]!.trim()));
        const endD = parseDateValue(safeEval(parts[1]!.trim()));
        if (!startD || !endD) return "null";
        return String(countNetworkDays(startD, endD));
      },
    };

    let result = expr;
    let maxIterations = Math.max(100, result.length * 2);

    while (maxIterations-- > 0) {
      const call = findInnermostFunctionCall(result, functionHandlers);
      if (!call) break;
      const replacement = functionHandlers[call.name]!(call.args);
      result =
        result.slice(0, call.start) +
        replacement +
        result.slice(call.end);
    }

    return result;
  }

  function serializeFormulaValue(val: any): string {
    if (val === null || val === undefined) return "null";
    if (typeof val === "string") return JSON.stringify(val);
    return String(val);
  }

  interface ParsedFunctionCall {
    name: string;
    args: string;
    start: number;
    end: number;
  }

  function findInnermostFunctionCall(
    expression: string,
    handlers: Record<string, (args: string) => string>,
  ): ParsedFunctionCall | null {
    const stack: Array<{
      name: string | null;
      start: number;
      argsStart: number;
    }> = [];
    let inString = false;
    let stringChar = "";
    let escaped = false;

    for (let i = 0; i < expression.length; i++) {
      const char = expression[i]!;

      if (inString) {
        if (char === "\\" && !escaped) {
          escaped = true;
          continue;
        }
        if (char === stringChar && !escaped) {
          inString = false;
        }
        escaped = false;
        continue;
      }

      if (char === '"' || char === "'") {
        inString = true;
        stringChar = char;
        escaped = false;
        continue;
      }

      if (char === "(") {
        const matched = getFunctionAtParen(expression, i, handlers);
        stack.push(
          matched
            ? { name: matched.name, start: matched.start, argsStart: i + 1 }
            : { name: null, start: i, argsStart: i + 1 },
        );
        continue;
      }

      if (char === ")" && stack.length > 0) {
        const open = stack.pop()!;
        if (!open.name) continue;
        return {
          name: open.name,
          args: expression.slice(open.argsStart, i),
          start: open.start,
          end: i + 1,
        };
      }
    }

    return null;
  }

  function getFunctionAtParen(
    expression: string,
    parenIndex: number,
    handlers: Record<string, (args: string) => string>,
  ): { name: string; start: number } | null {
    let end = parenIndex - 1;
    while (end >= 0 && /\s/.test(expression[end]!)) end--;

    let start = end;
    while (start >= 0 && /[A-Za-z0-9_]/.test(expression[start]!)) start--;
    start++;

    if (start > end) return null;

    const name = expression.slice(start, end + 1).toUpperCase();
    if (!(name in handlers)) return null;

    const before = start > 0 ? expression[start - 1]! : "";
    if (before && /[A-Za-z0-9_]/.test(before)) return null;

    return { name, start };
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

    const normalized = normalizeExpressionOperators(trimmed);
    const safeCheck = normalized.replace(/\b(null|true|false)\b/g, "0");
    if (/^[\d\s+\-*/().%<>=!&|?:"]+$/.test(safeCheck)) {
      return Function(`"use strict"; return (${normalized})`)();
    }

    return trimmed;
  }

  function normalizeExpressionOperators(expression: string): string {
    let normalized = "";
    let inString = false;
    let stringChar = "";
    let escaped = false;

    for (let i = 0; i < expression.length; i++) {
      const char = expression[i]!;

      if (inString) {
        normalized += char;
        if (char === "\\" && !escaped) {
          escaped = true;
          continue;
        }
        if (char === stringChar && !escaped) {
          inString = false;
        }
        escaped = false;
        continue;
      }

      if (char === '"' || char === "'") {
        inString = true;
        stringChar = char;
        escaped = false;
        normalized += char;
        continue;
      }

      const prev = i > 0 ? expression[i - 1]! : "";
      const next = i + 1 < expression.length ? expression[i + 1]! : "";

      if (char === "<" && next === ">") {
        normalized += "!=";
        i++;
        continue;
      }

      if (
        char === "=" &&
        prev !== "!" &&
        prev !== "<" &&
        prev !== ">" &&
        prev !== "=" &&
        next !== "="
      ) {
        normalized += "==";
        continue;
      }

      normalized += char;
    }

    return normalized;
  }

  // ─── Date helpers (used by date functions) ──────────────

  function parseDateValue(val: any): Date | null {
    if (val === null || val === undefined || val === "null") return null;
    if (val instanceof Date) {
      return isNaN(val.getTime()) ? null : val;
    }
    if (typeof val === "number") {
      const d = new Date(val);
      return isNaN(d.getTime()) ? null : d;
    }
    const s = typeof val === "string" ? val.trim() : String(val);
    if (!s || s === "null") return null;
    if (/^-?\d{11,13}$/.test(s)) {
      const d = new Date(Number(s));
      return isNaN(d.getTime()) ? null : d;
    }
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
      // Collect all relational refs across formulas
      const allRelationalRefs: string[] = [];

      for (const ff of formulaFields) {
        for (const rr of ff.relationalRefs) {
          if (!allRelationalRefs.includes(rr)) allRelationalRefs.push(rr);
        }
      }

      // Use select("*") to avoid issues with O2M/M2M alias fields
      // that don't exist as real DB columns
      let query = database
        .select("*")
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

      // Strip formula field values from the incoming payload so the hook
      // is the sole authority for computed values.  Without this, an
      // external source (Directus client, flow, or internal post-create
      // update) can send stale/default formula values (e.g. 0) that
      // bypass recomputation and overwrite the correct DB values.
      const formulaFieldNames = new Set(sortedFormulas.map((f) => f.field));
      for (const ffName of formulaFieldNames) {
        if (Object.prototype.hasOwnProperty.call(payload, ffName)) {
          delete payload[ffName];
        }
      }

      // Check if any formula is directly triggered by the payload
      const hasDirectlyAffected = sortedFormulas.some(({ watchFields }) =>
        watchFields.some((wf) => payloadUpdatesField(payload, wf)),
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

          const merged = mergeRecordWithPayload(existing, payload);

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
              (wf) =>
                payloadUpdatesField(payload, wf) || recalculated.has(wf),
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
