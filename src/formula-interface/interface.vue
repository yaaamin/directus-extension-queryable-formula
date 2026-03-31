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

  if (/^[\d\s+\-*/().%<>=!&|?:]+$/.test(trimmed)) {
    return Function(`"use strict"; return (${trimmed})`)();
  }

  return trimmed;
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
  let result = expr;
  let maxIterations = 50;

  while (maxIterations-- > 0) {
    const previous = result;

    result = result.replace(
      /\bCONCAT\(([^()]*)\)/gi,
      (_m: string, args: string) => {
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
    );

    result = result.replace(
      /\bUPPER\(([^()]*)\)/gi,
      (_m: string, arg: string) => {
        const val = String(safeEvalClient(arg.trim()));
        return JSON.stringify(val.toUpperCase());
      },
    );

    result = result.replace(
      /\bLOWER\(([^()]*)\)/gi,
      (_m: string, arg: string) => {
        const val = String(safeEvalClient(arg.trim()));
        return JSON.stringify(val.toLowerCase());
      },
    );

    result = result.replace(
      /\bTRIM\(([^()]*)\)/gi,
      (_m: string, arg: string) => {
        const val = String(safeEvalClient(arg.trim()));
        return JSON.stringify(val.trim());
      },
    );

    result = result.replace(
      /\bROUND\(([^()]*)\)/gi,
      (_m: string, args: string) => {
        const parts = splitArgsClient(args);
        const num = Number(safeEvalClient(parts[0]!.trim()));
        const decimals = parts[1] ? Number(safeEvalClient(parts[1].trim())) : 0;
        return String(Math.round(num * 10 ** decimals) / 10 ** decimals);
      },
    );

    result = result.replace(
      /\bFLOOR\(([^()]*)\)/gi,
      (_m: string, arg: string) =>
        String(Math.floor(Number(safeEvalClient(arg.trim())))),
    );

    result = result.replace(/\bCEIL\(([^()]*)\)/gi, (_m: string, arg: string) =>
      String(Math.ceil(Number(safeEvalClient(arg.trim())))),
    );

    result = result.replace(
      /\bIF\(([^()]*)\)/gi,
      (_m: string, args: string) => {
        const parts = splitArgsClient(args);
        if (parts.length < 3) return "null";
        const cond = safeEvalClient(parts[0]!.trim());
        return cond
          ? String(safeEvalClient(parts[1]!.trim()))
          : String(safeEvalClient(parts[2]!.trim()));
      },
    );

    result = result.replace(
      /\bCOALESCE\(([^()]*)\)/gi,
      (_m: string, args: string) => {
        const parts = splitArgsClient(args);
        for (const part of parts) {
          const val = safeEvalClient(part.trim());
          if (val !== null && val !== undefined && val !== "null") {
            return typeof val === "string" ? JSON.stringify(val) : String(val);
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
        const parts = splitArgsClient(args);
        if (parts.length < 3) return "null";
        const y = Number(safeEvalClient(parts[0]!.trim()));
        const mo = Number(safeEvalClient(parts[1]!.trim()));
        const dy = Number(safeEvalClient(parts[2]!.trim()));
        if (isNaN(y) || isNaN(mo) || isNaN(dy)) return "null";
        const dt = new Date(y, mo - 1, dy);
        return JSON.stringify(dt.toISOString().split("T")[0]);
      },
    );

    result = result.replace(
      /\bDATEVALUE\(([^()]*)\)/gi,
      (_m: string, arg: string) => {
        const d = parseDateValueClient(safeEvalClient(arg.trim()));
        if (!d) return "null";
        return JSON.stringify(d.toISOString().split("T")[0]);
      },
    );

    result = result.replace(
      /\bTIME\(([^()]*)\)/gi,
      (_m: string, args: string) => {
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
    );

    result = result.replace(
      /\bTIMEVALUE\(([^()]*)\)/gi,
      (_m: string, arg: string) => {
        const d = parseDateValueClient(safeEvalClient(arg.trim()));
        if (!d) return "null";
        return JSON.stringify(d.toISOString().split("T")[1]!.split(".")[0]);
      },
    );

    // ── Date Extraction ────────────────────────────────

    result = result.replace(
      /\bYEAR\(([^()]*)\)/gi,
      (_m: string, arg: string) => {
        const d = parseDateValueClient(safeEvalClient(arg.trim()));
        return d ? String(d.getFullYear()) : "null";
      },
    );

    result = result.replace(
      /\bMONTH\(([^()]*)\)/gi,
      (_m: string, arg: string) => {
        const d = parseDateValueClient(safeEvalClient(arg.trim()));
        return d ? String(d.getMonth() + 1) : "null";
      },
    );

    result = result.replace(
      /\bDAY\(([^()]*)\)/gi,
      (_m: string, arg: string) => {
        const d = parseDateValueClient(safeEvalClient(arg.trim()));
        return d ? String(d.getDate()) : "null";
      },
    );

    result = result.replace(
      /\bHOUR\(([^()]*)\)/gi,
      (_m: string, arg: string) => {
        const d = parseDateValueClient(safeEvalClient(arg.trim()));
        return d ? String(d.getHours()) : "null";
      },
    );

    result = result.replace(
      /\bMINUTE\(([^()]*)\)/gi,
      (_m: string, arg: string) => {
        const d = parseDateValueClient(safeEvalClient(arg.trim()));
        return d ? String(d.getMinutes()) : "null";
      },
    );

    result = result.replace(
      /\bSECOND\(([^()]*)\)/gi,
      (_m: string, arg: string) => {
        const d = parseDateValueClient(safeEvalClient(arg.trim()));
        return d ? String(d.getSeconds()) : "null";
      },
    );

    result = result.replace(
      /\bWEEKDAY\(([^()]*)\)/gi,
      (_m: string, args: string) => {
        const parts = splitArgsClient(args);
        const d = parseDateValueClient(safeEvalClient(parts[0]!.trim()));
        if (!d) return "null";
        const type = parts[1] ? Number(safeEvalClient(parts[1].trim())) : 1;
        const jsDay = d.getDay();
        if (type === 2) return String(jsDay === 0 ? 7 : jsDay);
        if (type === 3) return String(jsDay === 0 ? 6 : jsDay - 1);
        return String(jsDay + 1);
      },
    );

    result = result.replace(
      /\bISOWEEKNUM\(([^()]*)\)/gi,
      (_m: string, arg: string) => {
        const d = parseDateValueClient(safeEvalClient(arg.trim()));
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
    );

    result = result.replace(
      /\bWEEKNUM\(([^()]*)\)/gi,
      (_m: string, args: string) => {
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
    );

    // ── Date Arithmetic ────────────────────────────────

    result = result.replace(
      /\bDATEDIF\(([^()]*)\)/gi,
      (_m: string, args: string) => {
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
        const parts = splitArgsClient(args);
        if (parts.length < 2) return "null";
        const endD = parseDateValueClient(safeEvalClient(parts[0]!.trim()));
        const startD = parseDateValueClient(safeEvalClient(parts[1]!.trim()));
        if (!endD || !startD) return "null";
        return String(
          Math.floor((endD.getTime() - startD.getTime()) / 86400000),
        );
      },
    );

    result = result.replace(
      /\bEDATE\(([^()]*)\)/gi,
      (_m: string, args: string) => {
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
    );

    result = result.replace(
      /\bEOMONTH\(([^()]*)\)/gi,
      (_m: string, args: string) => {
        const parts = splitArgsClient(args);
        if (parts.length < 2) return "null";
        const d = parseDateValueClient(safeEvalClient(parts[0]!.trim()));
        if (!d) return "null";
        const months = Number(safeEvalClient(parts[1]!.trim()));
        if (isNaN(months)) return "null";
        const eom = new Date(d.getFullYear(), d.getMonth() + months + 1, 0);
        return JSON.stringify(eom.toISOString().split("T")[0]);
      },
    );

    result = result.replace(
      /\bNETWORKDAYS\(([^()]*)\)/gi,
      (_m: string, args: string) => {
        const parts = splitArgsClient(args);
        if (parts.length < 2) return "null";
        const startD = parseDateValueClient(safeEvalClient(parts[0]!.trim()));
        const endD = parseDateValueClient(safeEvalClient(parts[1]!.trim()));
        if (!startD || !endD) return "null";
        return String(countNetworkDaysClient(startD, endD));
      },
    );

    if (result === previous) break;
  }

  return result;
}

function parseDateValueClient(val: any): Date | null {
  if (val === null || val === undefined || val === "null") return null;
  const s = typeof val === "string" ? val : String(val);
  if (!s || s === "null") return null;
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
