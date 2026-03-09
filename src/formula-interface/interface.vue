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

    // Replace {{field}} references with actual values
    const resolved = formulaStr.replace(
      /\{\{(\w+)\}\}/g,
      (_match: string, fieldName: string) => {
        const val = currentValues[fieldName];
        if (val === null || val === undefined) return "null";
        if (val instanceof Date) return JSON.stringify(val.toISOString().split("T")[0]);
        if (typeof val === "string") return `"${val}"`;
        return String(val);
      },
    );

    // Simple safe evaluation for arithmetic expressions
    if (/^[\d\s+\-*/().,"nulltrue false]+$/.test(resolved)) {
      const result = Function(`"use strict"; return (${resolved})`)();
      return result;
    }

    // For function-based formulas, show raw resolved string
    return resolved;
  } catch {
    return props.value;
  }
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
  font-family: var(--theme--fonts--monospace--font-family);
  font-size: 1rem;
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
