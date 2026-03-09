<template>
  <div class="formula-field">
    <div class="formula-display">
      <span v-if="prefix" class="prefix">{{ prefix }}</span>
      <span class="value">{{
        displayValue !== null && displayValue !== undefined ? displayValue : "—"
      }}</span>
      <span v-if="suffix" class="suffix">{{ suffix }}</span>
    </div>
    <div class="formula-meta">
      <v-icon name="functions" x-small />
      <span class="formula-label">
        Computed: <code>{{ formula }}</code>
      </span>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, watch, inject, ref } from "vue";

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

const emit = defineEmits(["input"]);

const values = inject("values", ref<Record<string, any>>({}));

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

// Watch dependent fields and trigger re-evaluation hint
watch(
  () => {
    if (!values.value || typeof values.value !== "object") return null;
    const fields = getWatchFields();
    return fields.map((f) => values.value[f]);
  },
  () => {
    // Client-side preview updates automatically via computed.
    // Actual DB value is handled by the server-side hook.
    const preview = computePreview();
    if (preview !== null && preview !== undefined) {
      emit("input", preview);
    }
  },
  { deep: true },
);

function getWatchFields(): string[] {
  if (props.watchFields && props.watchFields.length > 0) {
    return props.watchFields;
  }
  // Auto-detect from formula template
  const matches = props.formula?.match(/\{\{(\w+)\}\}/g) || [];
  return matches.map((m) => m.replace(/\{\{|\}\}/g, ""));
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

.formula-meta {
  display: flex;
  align-items: center;
  gap: 4px;
  margin-top: 4px;
  font-size: 0.75rem;
  color: var(--theme--foreground-subdued);
}

.formula-meta code {
  background: var(--theme--background-subdued);
  padding: 1px 4px;
  border-radius: 3px;
  font-size: 0.7rem;
}
</style>
