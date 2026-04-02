<template>
  <div class="formula-field">
    <div class="formula-display">
      <span v-if="prefix" class="prefix">{{ prefix }}</span>
      <span class="value">{{
        displayValue !== null && displayValue !== undefined ? displayValue : "—"
      }}</span>
      <span v-if="suffix" class="suffix">{{ suffix }}</span>
    </div>
    <div class="formula-footer">
      <div class="formula-meta">
        <v-icon name="functions" x-small />
        <span class="formula-label">
          Computed: <code>{{ formula }}</code>
        </span>
      </div>
      <button
        v-if="!disabled"
        class="recalc-btn"
        :class="{ 'recalc-btn--loading': recalculating }"
        :disabled="recalculating"
        @click="recalculate"
        title="Recalculate all values for this field"
      >
        <v-icon :name="recalculating ? 'hourglass_empty' : 'refresh'" x-small />
        <span>{{ recalcStatus }}</span>
      </button>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, inject, ref } from "vue";
import { useApi } from "@directus/extensions-sdk";

const props = defineProps<{
  value: string | number | null;
  field: string;
  collection: string;
  primaryKey: string | number;
  formula: string;
  watchFields?: string[];
  prefix?: string;
  suffix?: string;
  disabled?: boolean;
}>();

const api = useApi();
const values = inject("values", ref<Record<string, any>>({}));

const recalculating = ref(false);
const recalcStatus = ref("Recalculate All");

async function recalculate() {
  recalculating.value = true;
  recalcStatus.value = "Working…";
  try {
    const response = await api.post("/queryable-formula/recalculate", {
      collection: props.collection,
      field: props.field,
    });
    const updated = response.data?.updated ?? 0;
    recalcStatus.value = `${updated} row${updated !== 1 ? "s" : ""} updated`;
  } catch (err: any) {
    recalcStatus.value = "Error";
  } finally {
    recalculating.value = false;
    setTimeout(() => {
      recalcStatus.value = "Recalculate All";
    }, 3000);
  }
}

const displayValue = computed(() => {
  if (props.value !== null && props.value !== undefined && props.value !== "") {
    return props.value;
  }

  // Attempt a client-side preview
  return computePreview();
});

function computePreview(): string | number | null {
  if (!props.formula) return null;

  try {
    const formulaStr = props.formula;
    const currentValues =
      values.value && typeof values.value === "object" ? values.value : {};

    const resolved = formulaStr.replace(
      /\{\{([\w.]+)\}\}/g,
      (_match: string, fieldName: string) => {
        const val = currentValues[fieldName];
        if (val === null || val === undefined) return "null";
        if (val instanceof Date)
          return JSON.stringify(val.toISOString().split("T")[0]);
        if (typeof val === "string") return JSON.stringify(val);
        return String(val);
      },
    );

    const evaluated = processFunctionsClient(resolved);
    return safeEvalClient(evaluated);
  } catch {
    return props.value;
  }
}

function safeEvalClient(expression: string): any {
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

  if (/^-?\d+(\.\d+)?$/.test(trimmed)) return Number(trimmed);

  const normalized = normalizeExpressionOperatorsClient(trimmed);
  const safeCheck = normalized.replace(/\b(null|true|false)\b/g, "0");
  if (/^[\d\s+\-*/().%<>=!&|?:"]+$/.test(safeCheck)) {
    return Function(`"use strict"; return (${normalized})`)();
  }

  return trimmed;
}

function normalizeExpressionOperatorsClient(expression: string): string {
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

function splitArgsClient(argsStr: string): string[] {
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

function processFunctionsClient(expr: string): string {
  const functionHandlers: Record<string, (args: string) => string> = {
    CONCAT: (args: string) => {
      const parts = splitArgsClient(args);
      const joined = parts
        .map((p) => {
          const trimmed = p.trim();
          try {
            return String(safeEvalClient(trimmed));
          } catch {
            return trimmed.replace(/^"|"$/g, "");
          }
        })
        .join("");
      return JSON.stringify(joined);
    },
    UPPER: (args: string) =>
      JSON.stringify(String(safeEvalClient(args.trim())).toUpperCase()),
    LOWER: (args: string) =>
      JSON.stringify(String(safeEvalClient(args.trim())).toLowerCase()),
    TRIM: (args: string) =>
      JSON.stringify(String(safeEvalClient(args.trim())).trim()),
    ROUND: (args: string) => {
      const parts = splitArgsClient(args);
      const num = Number(safeEvalClient(parts[0]!.trim()));
      const decimals = parts[1] ? Number(safeEvalClient(parts[1].trim())) : 0;
      return String(Math.round(num * 10 ** decimals) / 10 ** decimals);
    },
    FLOOR: (args: string) =>
      String(Math.floor(Number(safeEvalClient(args.trim())))),
    CEIL: (args: string) =>
      String(Math.ceil(Number(safeEvalClient(args.trim())))),
    IF: (args: string) => {
      const parts = splitArgsClient(args);
      if (parts.length < 3) return "null";
      const cond = safeEvalClient(parts[0]!.trim());
      const val = cond
        ? safeEvalClient(parts[1]!.trim())
        : safeEvalClient(parts[2]!.trim());
      return serializeFormulaValueClient(val);
    },
    COALESCE: (args: string) => {
      const parts = splitArgsClient(args);
      for (const part of parts) {
        const val = safeEvalClient(part.trim());
        if (val !== null && val !== undefined && val !== "null") {
          return serializeFormulaValueClient(val);
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
      const parts = splitArgsClient(args);
      if (parts.length < 3) return "null";
      const y = Number(safeEvalClient(parts[0]!.trim()));
      const mo = Number(safeEvalClient(parts[1]!.trim()));
      const dy = Number(safeEvalClient(parts[2]!.trim()));
      if (isNaN(y) || isNaN(mo) || isNaN(dy)) return "null";
      const dt = new Date(y, mo - 1, dy);
      return JSON.stringify(dt.toISOString().split("T")[0]);
    },
    DATEVALUE: (args: string) => {
      const d = parseDateValueClient(safeEvalClient(args.trim()));
      if (!d) return "null";
      return JSON.stringify(d.toISOString().split("T")[0]);
    },
    TIME: (args: string) => {
      const parts = splitArgsClient(args);
      if (parts.length < 3) return "null";
      const h = Number(safeEvalClient(parts[0]!.trim()));
      const mi = Number(safeEvalClient(parts[1]!.trim()));
      const sc = Number(safeEvalClient(parts[2]!.trim()));
      if (isNaN(h) || isNaN(mi) || isNaN(sc)) return "null";
      return JSON.stringify(
        `${String(h).padStart(2, "0")}:${String(mi).padStart(2, "0")}:${String(sc).padStart(2, "0")}`,
      );
    },
    TIMEVALUE: (args: string) => {
      const d = parseDateValueClient(safeEvalClient(args.trim()));
      if (!d) return "null";
      return JSON.stringify(d.toISOString().split("T")[1]!.split(".")[0]);
    },
    YEAR: (args: string) => {
      const d = parseDateValueClient(safeEvalClient(args.trim()));
      return d ? String(d.getFullYear()) : "null";
    },
    MONTH: (args: string) => {
      const d = parseDateValueClient(safeEvalClient(args.trim()));
      return d ? String(d.getMonth() + 1) : "null";
    },
    DAY: (args: string) => {
      const d = parseDateValueClient(safeEvalClient(args.trim()));
      return d ? String(d.getDate()) : "null";
    },
    HOUR: (args: string) => {
      const d = parseDateValueClient(safeEvalClient(args.trim()));
      return d ? String(d.getHours()) : "null";
    },
    MINUTE: (args: string) => {
      const d = parseDateValueClient(safeEvalClient(args.trim()));
      return d ? String(d.getMinutes()) : "null";
    },
    SECOND: (args: string) => {
      const d = parseDateValueClient(safeEvalClient(args.trim()));
      return d ? String(d.getSeconds()) : "null";
    },
    WEEKDAY: (args: string) => {
      const parts = splitArgsClient(args);
      const d = parseDateValueClient(safeEvalClient(parts[0]!.trim()));
      if (!d) return "null";
      const type = parts[1] ? Number(safeEvalClient(parts[1].trim())) : 1;
      const jsDay = d.getDay();
      if (type === 2) return String(jsDay === 0 ? 7 : jsDay);
      if (type === 3) return String(jsDay === 0 ? 6 : jsDay - 1);
      return String(jsDay + 1);
    },
    ISOWEEKNUM: (args: string) => {
      const d = parseDateValueClient(safeEvalClient(args.trim()));
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
      const parts = splitArgsClient(args);
      const d = parseDateValueClient(safeEvalClient(parts[0]!.trim()));
      if (!d) return "null";
      const type = parts[1] ? Number(safeEvalClient(parts[1].trim())) : 1;
      const startOfYear = new Date(d.getFullYear(), 0, 1);
      const diffMs = d.getTime() - startOfYear.getTime();
      const diffDays = Math.floor(diffMs / 86400000);
      const startDay =
        type === 2 ? (startOfYear.getDay() + 6) % 7 : startOfYear.getDay();
      return String(Math.ceil((diffDays + startDay + 1) / 7));
    },
    DATEDIF: (args: string) => {
      const parts = splitArgsClient(args);
      if (parts.length < 3) return "null";
      const start = parseDateValueClient(safeEvalClient(parts[0]!.trim()));
      const end = parseDateValueClient(safeEvalClient(parts[1]!.trim()));
      if (!start || !end) return "null";
      const unit = String(safeEvalClient(parts[2]!.trim())).toUpperCase();
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
        let diff = Math.floor((end.getTime() - adjStart.getTime()) / 86400000);
        if (diff < 0) diff += 365;
        return String(diff);
      }
      return "null";
    },
    DAYS: (args: string) => {
      const parts = splitArgsClient(args);
      if (parts.length < 2) return "null";
      const endD = parseDateValueClient(safeEvalClient(parts[0]!.trim()));
      const startD = parseDateValueClient(safeEvalClient(parts[1]!.trim()));
      if (!endD || !startD) return "null";
      return String(
        Math.floor((endD.getTime() - startD.getTime()) / 86400000),
      );
    },
    EDATE: (args: string) => {
      const parts = splitArgsClient(args);
      if (parts.length < 2) return "null";
      const d = parseDateValueClient(safeEvalClient(parts[0]!.trim()));
      if (!d) return "null";
      const months = Number(safeEvalClient(parts[1]!.trim()));
      if (isNaN(months)) return "null";
      const nd = new Date(d);
      nd.setMonth(nd.getMonth() + months);
      return JSON.stringify(nd.toISOString().split("T")[0]);
    },
    EOMONTH: (args: string) => {
      const parts = splitArgsClient(args);
      if (parts.length < 2) return "null";
      const d = parseDateValueClient(safeEvalClient(parts[0]!.trim()));
      if (!d) return "null";
      const months = Number(safeEvalClient(parts[1]!.trim()));
      if (isNaN(months)) return "null";
      const eom = new Date(d.getFullYear(), d.getMonth() + months + 1, 0);
      return JSON.stringify(eom.toISOString().split("T")[0]);
    },
    NETWORKDAYS: (args: string) => {
      const parts = splitArgsClient(args);
      if (parts.length < 2) return "null";
      const startD = parseDateValueClient(safeEvalClient(parts[0]!.trim()));
      const endD = parseDateValueClient(safeEvalClient(parts[1]!.trim()));
      if (!startD || !endD) return "null";
      return String(countNetworkDaysClient(startD, endD));
    },
  };

  let result = expr;
  let maxIterations = Math.max(100, result.length * 2);

  while (maxIterations-- > 0) {
    const call = findInnermostFunctionCallClient(result, functionHandlers);
    if (!call) break;
    const replacement = functionHandlers[call.name]!(call.args);
    result = result.slice(0, call.start) + replacement + result.slice(call.end);
  }

  return result;
}

function serializeFormulaValueClient(val: any): string {
  if (val === null || val === undefined) return "null";
  if (typeof val === "string") return JSON.stringify(val);
  return String(val);
}

interface ParsedFunctionCallClient {
  name: string;
  args: string;
  start: number;
  end: number;
}

function findInnermostFunctionCallClient(
  expression: string,
  handlers: Record<string, (args: string) => string>,
): ParsedFunctionCallClient | null {
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
      const matched = getFunctionAtParenClient(expression, i, handlers);
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

function getFunctionAtParenClient(
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

function parseDateValueClient(val: any): Date | null {
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

function countNetworkDaysClient(startDate: Date, endDate: Date): number {
  const s = new Date(startDate);
  s.setHours(0, 0, 0, 0);
  const e = new Date(endDate);
  e.setHours(0, 0, 0, 0);
  if (s > e) return -countNetworkDaysClient(e, s);
  const totalDays = Math.round((e.getTime() - s.getTime()) / 86400000) + 1;
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
</script>

<style scoped>
.formula-field {
  width: 100%;
}

.formula-display {
  padding: 8px 12px;
  background-color: var(--theme--background-subdued);
  border: 1px solid var(--theme--border-color);
  border-radius: var(--theme--border-radius);
  font-family: "Inter", var(--theme--fonts--sans--font-family), sans-serif;
  font-size: 0.875rem;
  min-height: 40px;
  display: flex;
  align-items: center;
  gap: 4px;
}

.prefix,
.suffix {
  color: var(--theme--foreground-subdued);
  font-size: 0.9em;
}

.value {
  color: var(--theme--foreground);
  font-weight: 600;
}

.formula-footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-top: 4px;
  gap: 8px;
}

.formula-meta {
  display: flex;
  align-items: center;
  gap: 4px;
  font-size: 0.75rem;
  color: var(--theme--foreground-subdued);
}

.formula-meta code {
  background: var(--theme--background-subdued);
  padding: 1px 4px;
  border-radius: 3px;
  font-size: 0.7rem;
  font-family: "Inter", var(--theme--fonts--sans--font-family), sans-serif;
}

.recalc-btn {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 2px 8px;
  font-size: 11px;
  color: var(--theme--primary);
  background: transparent;
  border: 1px solid var(--theme--primary);
  border-radius: var(--theme--border-radius);
  cursor: pointer;
  transition: all 0.15s;
  white-space: nowrap;
}

.recalc-btn:hover:not(:disabled) {
  background: color-mix(in srgb, var(--theme--primary) 10%, transparent);
}

.recalc-btn:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}

.recalc-btn--loading {
  color: var(--theme--foreground-subdued);
  border-color: var(--theme--border-color);
}
</style>
