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
    const matches = formula.match(/\{\{(\w+(?:\.\w+)+)\}\}/g) || [];
    return [...new Set(matches.map((m) => m.replace(/\{\{|\}\}/g, "")))];
  }

  function evaluateFormula(
    formula: string,
    record: Record<string, any>,
  ): string | number | null {
    try {
      let expression = formula;

      // Dotted refs first (e.g. {{category.name}}, {{category.parent.name}})
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

      // Simple refs
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
      logger.warn(`[queryable-formula] Endpoint eval error: ${err.message}`);
      return null;
    }
  }

  function evaluateFormulaWithTrace(
    formula: string,
    record: Record<string, any>,
  ): {
    originalFormula: string;
    afterFieldReplacement: string;
    afterFunctions: string;
    result: string | number | null;
    error: string | null;
  } {
    const trace = {
      originalFormula: formula,
      afterFieldReplacement: formula,
      afterFunctions: formula,
      result: null as string | number | null,
      error: null as string | null,
    };

    try {
      let expression = formula;

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

      trace.afterFieldReplacement = expression;
      expression = processFunctions(expression);
      trace.afterFunctions = expression;
      trace.result = safeEval(expression);
    } catch (err: any) {
      trace.error = err.message;
    }

    return trace;
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
    )
      return trimmed.slice(1, -1);
    if (/^-?\d+(\.\d+)?$/.test(trimmed)) return Number(trimmed);
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

  interface RelationTraceStep {
    segment: string;
    type: "M2O" | "O2M" | "M2M" | "missing";
    fromCollection: string;
    toCollection?: string;
    viaCollection?: string;
    sourceField?: string;
    targetField?: string;
    inputKeys: string[];
    fetchedRows: number;
    outputRowsBySource: Record<string, number>;
    warning?: string;
  }

  interface RelationTraceRef {
    ref: string;
    relationSegments: string[];
    finalField: string;
    steps: RelationTraceStep[];
    resolvedByRow: Record<string, any>;
    warnings: string[];
  }

  interface RelationDebugTrace {
    refs: RelationTraceRef[];
  }

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

    const dependents = new Map<string, Set<string>>();
    for (const ff of formulaFields) {
      dependents.set(ff.field, new Set());
    }
    for (const [field, fieldDeps] of deps) {
      for (const dep of fieldDeps) {
        dependents.get(dep)?.add(field);
      }
    }

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

    const circular = formulaFields
      .filter((ff) => !sorted.some((s) => s.field === ff.field))
      .map((ff) => ff.field);

    return { sorted, circular };
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

  /**
   * Batch-resolve relational data for many rows at once.
   * Supports nested M2O chains, O2M, and M2M relations.
   * O2M/M2M return comma-separated values when multiple results exist.
   */
  async function batchResolveRelationalData(
    collection: string,
    rows: Record<string, any>[],
    relationalRefs: string[],
    trace?: RelationDebugTrace,
  ): Promise<Map<number, Record<string, any>>> {
    const result = new Map<number, Record<string, any>>();
    if (relationalRefs.length === 0 || rows.length === 0) return result;

    // Initialize result map
    for (let i = 0; i < rows.length; i++) {
      result.set(i, {});
    }

    try {
      const schema = await getSchema();
      const allRelations = schema.relations || [];

      for (const ref of relationalRefs) {
        const segments = ref.split(".");
        if (segments.length < 2) continue;

        const relationSegments = segments.slice(0, -1);
        const finalField = segments[segments.length - 1]!;
        const refTrace: RelationTraceRef | undefined = trace
          ? {
              ref,
              relationSegments,
              finalField,
              steps: [],
              resolvedByRow: {},
              warnings: [],
            }
          : undefined;
        if (refTrace) trace!.refs.push(refTrace);

        let currentCollection = collection;
        let cursors = new Map<number, Record<string, any>[]>();
        for (let i = 0; i < rows.length; i++) {
          cursors.set(i, [rows[i]!]);
        }

        let chainBroken = false;

        for (const segment of relationSegments) {
          // --- Try M2O first ---
          const m2oRelation = allRelations.find(
            (r: any) =>
              r.collection === currentCollection && r.field === segment,
          );

          if (m2oRelation && m2oRelation.related_collection) {
            const relatedCollection = m2oRelation.related_collection;
            const relatedSchema = schema.collections[relatedCollection];
            const relatedPK = relatedSchema?.primary ?? "id";

            const fkValues = new Map<string, any>();
            for (const [, cursorRows] of cursors) {
              for (const row of cursorRows) {
                const fk = extractRelationKey(row[segment], relatedPK);
                const key = normalizeRelationKey(fk);
                if (key != null) fkValues.set(key, fk);
              }
            }

            if (fkValues.size === 0) {
              refTrace?.warnings.push(`No FK values found for ${currentCollection}.${segment}`);
              chainBroken = true;
              break;
            }

            try {
              const relatedRows = await database
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
              refTrace?.steps.push({
                segment,
                type: "M2O",
                fromCollection: currentCollection,
                toCollection: relatedCollection,
                sourceField: segment,
                targetField: relatedPK,
                inputKeys: [...fkValues.keys()],
                fetchedRows: relatedRows.length,
                outputRowsBySource: Object.fromEntries(
                  [...newCursors.entries()].map(([idx, next]) => [
                    String(idx),
                    next.length,
                  ]),
                ),
              });
              cursors = newCursors;
              currentCollection = relatedCollection;
            } catch (err: any) {
              refTrace?.warnings.push(
                `M2O fetch failed for ${relatedCollection}: ${err.message}`,
              );
              chainBroken = true;
              break;
            }
            continue;
          }

          // --- Try O2M / M2M ---
          const o2mRelation = allRelations.find(
            (r: any) =>
              r.related_collection === currentCollection &&
              r.meta?.one_field === segment,
          );

          if (o2mRelation) {
            const currentSchema = schema.collections[currentCollection];
            const currentPK = currentSchema?.primary ?? "id";

            const pkValues = new Map<string, any>();
            for (const [, cursorRows] of cursors) {
              for (const row of cursorRows) {
                const pk = extractRelationKey(row[currentPK], currentPK);
                const key = normalizeRelationKey(pk);
                if (key != null) pkValues.set(key, pk);
              }
            }

            if (pkValues.size === 0) {
              refTrace?.warnings.push(`No PK values found for ${currentCollection}`);
              chainBroken = true;
              break;
            }

            if (o2mRelation.meta?.junction_field) {
              // M2M
              const junctionCollection = o2mRelation.collection;
              const junctionSourceFK = o2mRelation.field;
              const junctionTargetFK = o2mRelation.meta.junction_field;

              const junctionToTarget = allRelations.find(
                (r: any) =>
                  r.collection === junctionCollection &&
                  r.field === junctionTargetFK,
              );

              if (!junctionToTarget || !junctionToTarget.related_collection) {
                refTrace?.warnings.push(
                  `No M2M target relation found from ${junctionCollection}.${junctionTargetFK}`,
                );
                chainBroken = true;
                break;
              }

              const targetCollection = junctionToTarget.related_collection;
              const targetSchema = schema.collections[targetCollection];
              const targetPK = targetSchema?.primary ?? "id";

              try {
                const junctionRows = await database
                  .select([junctionSourceFK, junctionTargetFK])
                  .from(junctionCollection)
                  .whereIn(junctionSourceFK, [...pkValues.values()]);

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
                  refTrace?.warnings.push(
                    `No target keys found in junction ${junctionCollection}`,
                  );
                  chainBroken = true;
                  break;
                }

                const targetRows = await database
                  .select("*")
                  .from(targetCollection)
                  .whereIn(targetPK, [...targetPKs.values()]);

                const targetLookup = new Map<string, Record<string, any>>();
                for (const tr of targetRows) {
                  const key = normalizeRelationKey(tr[targetPK], targetPK);
                  if (key != null) targetLookup.set(key, tr);
                }

                const sourceToTargets = new Map<string, Record<string, any>[]>();
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

                const newCursors = new Map<number, Record<string, any>[]>();
                for (const [rowIdx, cursorRows] of cursors) {
                  const next: Record<string, any>[] = [];
                  for (const row of cursorRows) {
                    const key = normalizeRelationKey(row[currentPK], currentPK);
                    const targets = key ? sourceToTargets.get(key) || [] : [];
                    next.push(...targets);
                  }
                  if (next.length > 0) newCursors.set(rowIdx, next);
                }
                refTrace?.steps.push({
                  segment,
                  type: "M2M",
                  fromCollection: currentCollection,
                  toCollection: targetCollection,
                  viaCollection: junctionCollection,
                  sourceField: junctionSourceFK,
                  targetField: junctionTargetFK,
                  inputKeys: [...pkValues.keys()],
                  fetchedRows: junctionRows.length + targetRows.length,
                  outputRowsBySource: Object.fromEntries(
                    [...newCursors.entries()].map(([idx, next]) => [
                      String(idx),
                      next.length,
                    ]),
                  ),
                });
                cursors = newCursors;
                currentCollection = targetCollection;
              } catch (err: any) {
                refTrace?.warnings.push(`M2M fetch failed: ${err.message}`);
                chainBroken = true;
                break;
              }
            } else {
              // O2M
              const manyCollection = o2mRelation.collection;
              const manyField = o2mRelation.field;

              try {
                const manyRows = await database
                  .select("*")
                  .from(manyCollection)
                  .whereIn(manyField, [...pkValues.values()]);

                const fkToRows = new Map<string, Record<string, any>[]>();
                for (const mr of manyRows) {
                  const key = normalizeRelationKey(mr[manyField], currentPK);
                  if (key == null) continue;
                  const existing = fkToRows.get(key) || [];
                  existing.push(mr);
                  fkToRows.set(key, existing);
                }

                const newCursors = new Map<number, Record<string, any>[]>();
                for (const [rowIdx, cursorRows] of cursors) {
                  const next: Record<string, any>[] = [];
                  for (const row of cursorRows) {
                    const key = normalizeRelationKey(row[currentPK], currentPK);
                    const related = key ? fkToRows.get(key) || [] : [];
                    next.push(...related);
                  }
                  if (next.length > 0) newCursors.set(rowIdx, next);
                }
                refTrace?.steps.push({
                  segment,
                  type: "O2M",
                  fromCollection: currentCollection,
                  toCollection: manyCollection,
                  sourceField: currentPK,
                  targetField: manyField,
                  inputKeys: [...pkValues.keys()],
                  fetchedRows: manyRows.length,
                  outputRowsBySource: Object.fromEntries(
                    [...newCursors.entries()].map(([idx, next]) => [
                      String(idx),
                      next.length,
                    ]),
                  ),
                });
                cursors = newCursors;
                currentCollection = manyCollection;
              } catch (err: any) {
                refTrace?.warnings.push(
                  `O2M fetch failed for ${manyCollection}: ${err.message}`,
                );
                chainBroken = true;
                break;
              }
            }
            continue;
          }

          // No relation found
          refTrace?.steps.push({
            segment,
            type: "missing",
            fromCollection: currentCollection,
            inputKeys: [],
            fetchedRows: 0,
            outputRowsBySource: {},
            warning: `No relation found for ${currentCollection}.${segment}`,
          });
          refTrace?.warnings.push(
            `No relation found for ${currentCollection}.${segment}`,
          );
          chainBroken = true;
          break;
        }

        // Extract final field values
        for (let i = 0; i < rows.length; i++) {
          const resolved = result.get(i)!;
          if (chainBroken) {
            resolved[ref] = null;
            if (refTrace) refTrace.resolvedByRow[String(i)] = null;
            continue;
          }
          const cursorRows = cursors.get(i);
          if (!cursorRows || cursorRows.length === 0) {
            resolved[ref] = null;
            if (refTrace) refTrace.resolvedByRow[String(i)] = null;
          } else {
            const values = cursorRows
              .map((r) => r[finalField])
              .filter((v) => v != null);
            if (values.length === 0) {
              resolved[ref] = null;
              if (refTrace) refTrace.resolvedByRow[String(i)] = null;
            } else if (values.length === 1) {
              resolved[ref] = values[0];
              if (refTrace) refTrace.resolvedByRow[String(i)] = values[0];
            } else {
              resolved[ref] = values.join(", ");
              if (refTrace) refTrace.resolvedByRow[String(i)] = values.join(", ");
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

      // Sort formulas so dependencies are evaluated first
      const { sorted: sortedFormulas, circular } =
        topologicalSortFormulas(formulaFields);
      if (circular.length > 0) {
        logger.warn(
          `[queryable-formula] Circular dependency in "${collection}" — skipping fields: ${circular.join(", ")}`,
        );
      }

      const primaryKey = await getPrimaryKeyField(collection);
      let totalUpdated = 0;
      let offset = 0;

      while (true) {
        const allRelationalRefs: string[] = [];
        for (const ff of sortedFormulas) {
          for (const rr of ff.relationalRefs) {
            if (!allRelationalRefs.includes(rr)) allRelationalRefs.push(rr);
          }
        }

        // Use select("*") to avoid issues with O2M/M2M alias fields
        const rows = await database
          .select("*")
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

          for (const ff of sortedFormulas) {
            const computed = evaluateFormula(ff.formula, mergedRow);
            if (computed === null || computed === undefined) continue;

            // Feed result back so dependent formulas see the fresh value
            mergedRow[ff.field] = computed;

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

  // ─── POST /debug ──────────────────────────────────────────

  router.post("/debug", async (req: any, res: any) => {
    if (!req.accountability?.admin) {
      return res.status(403).json({ error: "Admin access required" });
    }

    const { collection, field, primaryKey } = req.body ?? {};

    if (!collection || typeof collection !== "string") {
      return res
        .status(400)
        .json({ error: "Missing or invalid 'collection' in body" });
    }

    if (!field || typeof field !== "string") {
      return res.status(400).json({ error: "Missing or invalid 'field' in body" });
    }

    if (primaryKey === null || primaryKey === undefined || primaryKey === "") {
      return res.status(400).json({ error: "Missing 'primaryKey' in body" });
    }

    try {
      const meta = await database
        .select("field", "options", "interface")
        .from("directus_fields")
        .where({ collection, field, interface: INTERFACE_ID })
        .first();

      if (!meta) {
        return res.status(404).json({ error: "Formula field not found" });
      }

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

      if (!options.formula) {
        return res.status(400).json({ error: "Field has no formula configured" });
      }

      const primaryKeyField = await getPrimaryKeyField(collection);
      const row = await database
        .select("*")
        .from(collection)
        .where(primaryKeyField, primaryKey)
        .first();

      if (!row) {
        return res.status(404).json({ error: "Record not found" });
      }

      const relationalRefs = extractRelationalRefs(options.formula);
      const relationTrace: RelationDebugTrace = { refs: [] };
      const relationalMap =
        relationalRefs.length > 0
          ? await batchResolveRelationalData(
              collection,
              [row],
              relationalRefs,
              relationTrace,
            )
          : new Map<number, Record<string, any>>([[0, {}]]);
      const relationalData = relationalMap.get(0) || {};
      const mergedRow = { ...row, ...relationalData };
      const formulaTrace = evaluateFormulaWithTrace(options.formula, mergedRow);
      const allRefs = [
        ...new Set(
          (options.formula.match(/\{\{([\w.]+)\}\}/g) || []).map((ref: string) =>
            ref.replace(/\{\{|\}\}/g, ""),
          ),
        ),
      ];

      return res.json({
        collection,
        field,
        primaryKey: {
          field: primaryKeyField,
          value: primaryKey,
        },
        debugMode: Boolean(options.debugMode),
        formula: options.formula,
        refs: allRefs,
        relationalRefs,
        resolvedRelationalData: relationalData,
        relationTrace,
        formulaTrace,
        currentStoredValue: row[field] ?? null,
      });
    } catch (err: any) {
      logger.error(`[queryable-formula] Debug failed: ${err.message}`);
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
          debugMode: Boolean(options.debugMode),
        };
      });

      return res.json({ fields });
    } catch (err: any) {
      return res.status(500).json({ error: err.message });
    }
  });
};
