<template>
  <div class="formula-builder">
    <!-- ─── Formula Editor ─── -->
    <div class="fb-section">
      <div class="fb-label">Formula Template</div>
      <div class="fb-hint">
        Reference fields with
        <code v-pre>{{ field }}</code> — click a field or function below to
        insert, or type <code v-pre>{{</code> for autocomplete.
      </div>

      <div class="editor-wrap">
        <textarea
          ref="textareaEl"
          class="formula-editor"
          :value="formula"
          @input="onFormulaInput"
          @keydown="onEditorKeydown"
          @click="checkAutocomplete"
          @blur="onEditorBlur"
          placeholder="e.g. {{price}} * {{quantity}}"
          rows="4"
          spellcheck="false"
        />
        <transition name="ac-fade">
          <div v-if="ac.show && ac.items.length > 0" class="ac-popup">
            <div
              v-for="(item, idx) in ac.items"
              :key="item.value"
              :class="['ac-option', { 'ac-active': idx === ac.index }]"
              @mousedown.prevent="pickAutocomplete(item)"
            >
              <v-icon :name="fieldTypeIcon(item.type)" x-small />
              <span class="ac-name">{{ item.label }}</span>
              <span class="ac-type">{{ item.type }}</span>
            </div>
          </div>
        </transition>
      </div>

      <!-- Validation -->
      <transition name="ac-fade">
        <div
          v-if="validation"
          :class="['fb-msg', `fb-msg--${validation.level}`]"
        >
          <v-icon :name="validationIcon" x-small />
          <span>{{ validation.text }}</span>
        </div>
      </transition>

      <!-- Available Fields -->
      <div class="fb-palette" v-if="collectionFields.length > 0">
        <div class="fb-palette-title">
          <v-icon name="list" x-small />
          <span>Available Fields</span>
        </div>
        <div class="fb-chips">
          <button
            v-for="f in collectionFields"
            :key="f.field"
            class="fb-chip fb-chip--field"
            :title="`${f.name} (${f.type})`"
            @click="insertText(`{{${f.field}}}`)"
          >
            <v-icon :name="fieldTypeIcon(f.type)" x-small />
            <span>{{ f.field }}</span>
          </button>
        </div>
      </div>
      <div v-else class="fb-palette">
        <div class="fb-palette-empty">
          No other fields found. Add fields to this collection first, then
          configure the formula.
        </div>
      </div>

      <!-- Relational Fields (M2O) -->
      <div
        class="fb-palette"
        v-for="group in relationalFields"
        :key="group.localField"
      >
        <div class="fb-palette-title">
          <v-icon name="link" x-small />
          <span
            >{{ group.localField }}
            <span class="fb-relation-hint"
              >&rarr; {{ group.relatedCollection }}</span
            ></span
          >
        </div>
        <div class="fb-chips">
          <button
            v-for="f in group.fields"
            :key="`${group.localField}.${f.field}`"
            class="fb-chip fb-chip--relation"
            :title="`${group.localField}.${f.field} (${f.type}) from ${group.relatedCollection}`"
            @click="insertText(`{{${group.localField}.${f.field}}}`)"
          >
            <v-icon :name="fieldTypeIcon(f.type)" x-small />
            <span>{{ group.localField }}.{{ f.field }}</span>
          </button>
        </div>
      </div>

      <!-- Function Groups -->
      <div
        class="fb-palette"
        v-for="group in functionGroups"
        :key="group.label"
      >
        <div class="fb-palette-title">
          <v-icon :name="group.icon" x-small />
          <span>{{ group.label }}</span>
        </div>
        <div class="fb-chips">
          <button
            v-for="fn in group.fns"
            :key="fn.name"
            class="fb-chip fb-chip--fn"
            :title="fn.hint"
            @click="insertText(fn.snippet)"
          >
            {{ fn.name }}
          </button>
        </div>
      </div>
    </div>

    <!-- ─── Watch Fields ─── -->
    <div class="fb-section">
      <div class="fb-label">Watch Fields</div>
      <div class="fb-hint">
        Fields that trigger recalculation on change. Leave empty to auto-detect
        from formula.
        <template v-if="autoDetectedFields.length > 0">
          <br />Auto-detected:
          <strong>{{ autoDetectedFields.join(", ") }}</strong>
        </template>
      </div>
      <div class="fb-tags-wrap" @click="focusTagInput">
        <span v-for="tag in watchFieldTags" :key="tag" class="fb-tag">
          {{ tag }}
          <button class="fb-tag-x" @click.stop="removeWatchTag(tag)">
            &times;
          </button>
        </span>
        <input
          ref="tagInputEl"
          class="fb-tag-input"
          v-model="tagInput"
          @keydown="onTagKeydown"
          placeholder="Type field name + Enter"
        />
      </div>
    </div>

    <!-- ─── Prefix / Suffix ─── -->
    <div class="fb-section fb-row">
      <div class="fb-half">
        <div class="fb-label">Display Prefix</div>
        <input
          class="fb-input"
          :value="currentOptions.prefix ?? ''"
          @input="
            updateOption('prefix', ($event.target as HTMLInputElement).value)
          "
          placeholder="e.g. $"
        />
      </div>
      <div class="fb-half">
        <div class="fb-label">Display Suffix</div>
        <input
          class="fb-input"
          :value="currentOptions.suffix ?? ''"
          @input="
            updateOption('suffix', ($event.target as HTMLInputElement).value)
          "
          placeholder="e.g. USD"
        />
      </div>
    </div>

    <!-- ─── Scheduled Recalculation ─── -->
    <div class="fb-section">
      <div class="fb-label">
        <v-icon name="schedule" x-small />
        Scheduled Recalculation
      </div>
      <div class="fb-hint">
        Set a cron expression to periodically recalculate all values for this
        field. Leave empty to disable. The schedule applies to the entire
        collection.
      </div>
      <div class="fb-row" style="align-items: flex-end">
        <div style="flex: 1">
          <input
            class="fb-input"
            :value="currentOptions.cronSchedule ?? ''"
            @input="
              updateOption(
                'cronSchedule',
                ($event.target as HTMLInputElement).value,
              )
            "
            placeholder="e.g. */15 * * * *"
          />
        </div>
      </div>
      <div class="fb-cron-presets">
        <button
          v-for="preset in cronPresets"
          :key="preset.value"
          class="fb-chip fb-chip--fn"
          :title="preset.value"
          :class="{
            'fb-chip--active': currentOptions.cronSchedule === preset.value,
          }"
          @click="updateOption('cronSchedule', preset.value)"
        >
          {{ preset.label }}
        </button>
        <button
          class="fb-chip"
          title="Disable scheduled recalculation"
          @click="updateOption('cronSchedule', undefined)"
        >
          Disable
        </button>
      </div>
      <transition name="ac-fade">
        <div
          v-if="cronValidation"
          :class="['fb-msg', `fb-msg--${cronValidation.level}`]"
        >
          <v-icon
            :name="
              cronValidation.level === 'error'
                ? 'error_outline'
                : 'check_circle'
            "
            x-small
          />
          <span>{{ cronValidation.text }}</span>
        </div>
      </transition>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, reactive, nextTick } from "vue";
import { useStores } from "@directus/extensions-sdk";

/* ─── Props / Emit ─── */

const props = withDefaults(
  defineProps<{
    value: Record<string, any> | null;
    collection: string;
  }>(),
  { value: null },
);

const emit = defineEmits<{
  (e: "input", value: Record<string, any>): void;
}>();

/* ─── Options reactivity ─── */

const currentOptions = computed(() => props.value ?? {});
const formula = computed(() => currentOptions.value.formula ?? "");

function updateOption(key: string, val: any) {
  emit("input", {
    ...currentOptions.value,
    [key]: val === "" ? undefined : val,
  });
}

/* ─── Collection fields via Directus store ─── */

let fieldsStore: any = null;
let relationsStore: any = null;
try {
  const stores = useStores();
  fieldsStore = stores.useFieldsStore();
  relationsStore = stores.useRelationsStore();
} catch {
  // Store not available
}

const collectionFields = computed(() => {
  if (!fieldsStore || !props.collection) return [];
  try {
    const all = fieldsStore.getFieldsForCollection(props.collection);
    return all
      .filter((f: any) => {
        if (f.meta?.interface === "queryable-formula") return false;
        if (f.meta?.special?.includes("no-data")) return false;
        if (!f.type) return false;
        return true;
      })
      .map((f: any) => ({
        field: f.field as string,
        name: (f.name ?? f.field) as string,
        type: (f.type ?? "unknown") as string,
      }));
  } catch {
    return [];
  }
});

interface RelationGroup {
  localField: string;
  relatedCollection: string;
  fields: { field: string; name: string; type: string }[];
}

const relationalFields = computed<RelationGroup[]>(() => {
  if (!fieldsStore || !relationsStore || !props.collection) return [];
  try {
    const relations = relationsStore.getRelationsForCollection(
      props.collection,
    );
    const m2oRelations = relations.filter(
      (r: any) =>
        r.collection === props.collection &&
        r.related_collection &&
        r.meta?.one_collection,
    );

    const groups: RelationGroup[] = [];

    for (const rel of m2oRelations) {
      const relatedCollection =
        rel.related_collection ?? rel.meta?.one_collection;
      if (!relatedCollection) continue;

      const relatedFields =
        fieldsStore.getFieldsForCollection(relatedCollection);
      const usableFields = relatedFields
        .filter((f: any) => {
          if (f.meta?.special?.includes("no-data")) return false;
          if (!f.type) return false;
          if (f.meta?.hidden) return false;
          return true;
        })
        .map((f: any) => ({
          field: f.field as string,
          name: (f.name ?? f.field) as string,
          type: (f.type ?? "unknown") as string,
        }));

      if (usableFields.length > 0) {
        groups.push({
          localField: rel.field,
          relatedCollection,
          fields: usableFields,
        });
      }
    }

    return groups;
  } catch {
    return [];
  }
});

/* ─── Function definitions ─── */

const KNOWN_FUNCTIONS = new Set([
  "CONCAT",
  "UPPER",
  "LOWER",
  "TRIM",
  "ROUND",
  "FLOOR",
  "CEIL",
  "IF",
  "COALESCE",
  "NOW",
]);

interface FnDef {
  name: string;
  snippet: string; // | marks cursor position
  hint: string;
}

interface FnGroup {
  label: string;
  icon: string;
  fns: FnDef[];
}

const functionGroups: FnGroup[] = [
  {
    label: "String",
    icon: "text_fields",
    fns: [
      {
        name: "CONCAT",
        snippet: "CONCAT(|)",
        hint: "CONCAT(a, b, …) — Join values together",
      },
      {
        name: "UPPER",
        snippet: "UPPER(|)",
        hint: "UPPER(text) — Convert to uppercase",
      },
      {
        name: "LOWER",
        snippet: "LOWER(|)",
        hint: "LOWER(text) — Convert to lowercase",
      },
      {
        name: "TRIM",
        snippet: "TRIM(|)",
        hint: "TRIM(text) — Remove surrounding whitespace",
      },
    ],
  },
  {
    label: "Math",
    icon: "calculate",
    fns: [
      {
        name: "ROUND",
        snippet: "ROUND(|, 0)",
        hint: "ROUND(number, decimals) — Round a number",
      },
      {
        name: "FLOOR",
        snippet: "FLOOR(|)",
        hint: "FLOOR(number) — Round down to integer",
      },
      {
        name: "CEIL",
        snippet: "CEIL(|)",
        hint: "CEIL(number) — Round up to integer",
      },
    ],
  },
  {
    label: "Logic",
    icon: "alt_route",
    fns: [
      {
        name: "IF",
        snippet: "IF(|, , )",
        hint: "IF(condition, then, else) — Conditional value",
      },
      {
        name: "COALESCE",
        snippet: "COALESCE(|, )",
        hint: "COALESCE(a, b, …) — First non-null value",
      },
    ],
  },
  {
    label: "Date",
    icon: "schedule",
    fns: [
      {
        name: "NOW",
        snippet: "NOW()",
        hint: "NOW() — Current ISO timestamp",
      },
    ],
  },
];

/* ─── Autocomplete state ─── */

const textareaEl = ref<HTMLTextAreaElement | null>(null);

const ac = reactive({
  show: false,
  items: [] as Array<{ value: string; label: string; type: string }>,
  index: 0,
  start: 0,
});

function checkAutocomplete() {
  const el = textareaEl.value;
  if (!el) {
    ac.show = false;
    return;
  }

  const pos = el.selectionStart;
  const text = formula.value.slice(0, pos);
  const lastOpen = text.lastIndexOf("{{");
  const lastClose = text.lastIndexOf("}}");

  if (lastOpen >= 0 && lastOpen > lastClose) {
    const partial = text.slice(lastOpen + 2).toLowerCase();

    // Local fields
    const localMatches = collectionFields.value
      .filter((f) => f.field.toLowerCase().includes(partial))
      .map((f) => ({ value: f.field, label: f.field, type: f.type }));

    // Relational fields (dotted: e.g. "category.name")
    const relMatches: typeof localMatches = [];
    for (const group of relationalFields.value) {
      for (const f of group.fields) {
        const dotted = `${group.localField}.${f.field}`;
        if (dotted.toLowerCase().includes(partial)) {
          relMatches.push({
            value: dotted,
            label: dotted,
            type: f.type,
          });
        }
      }
    }

    ac.items = [...localMatches, ...relMatches];
    ac.index = 0;
    ac.start = lastOpen;
    ac.show = true;
  } else {
    ac.show = false;
  }
}

function pickAutocomplete(item: { value: string }) {
  const el = textareaEl.value;
  if (!el) return;

  const pos = el.selectionStart;
  const text = formula.value;
  const replacement = `{{${item.value}}}`;
  const newText = text.slice(0, ac.start) + replacement + text.slice(pos);

  updateOption("formula", newText);
  ac.show = false;

  const newPos = ac.start + replacement.length;
  nextTick(() => {
    el.focus();
    el.setSelectionRange(newPos, newPos);
  });
}

function onEditorBlur() {
  setTimeout(() => {
    ac.show = false;
  }, 150);
}

/* ─── Keyboard handling ─── */

function onEditorKeydown(e: KeyboardEvent) {
  if (!ac.show || ac.items.length === 0) return;

  switch (e.key) {
    case "ArrowDown":
      e.preventDefault();
      ac.index = Math.min(ac.index + 1, ac.items.length - 1);
      break;
    case "ArrowUp":
      e.preventDefault();
      ac.index = Math.max(ac.index - 1, 0);
      break;
    case "Enter":
    case "Tab":
      e.preventDefault();
      pickAutocomplete(ac.items[ac.index]!);
      break;
    case "Escape":
      e.preventDefault();
      ac.show = false;
      break;
  }
}

/* ─── Formula input ─── */

function onFormulaInput(e: Event) {
  const val = (e.target as HTMLTextAreaElement).value;
  updateOption("formula", val);
  nextTick(checkAutocomplete);
}

/* ─── Insert at cursor ─── */

function insertText(rawText: string) {
  const el = textareaEl.value;
  const cursorMarkerPos = rawText.indexOf("|");
  const text = rawText.replace("|", "");

  const currentFormula = formula.value;
  const insertPos = el
    ? (el.selectionStart ?? currentFormula.length)
    : currentFormula.length;
  const endPos = el ? (el.selectionEnd ?? insertPos) : insertPos;

  const before = currentFormula.slice(0, insertPos);
  const after = currentFormula.slice(endPos);
  const newFormula = before + text + after;

  updateOption("formula", newFormula);

  nextTick(() => {
    if (!el) return;
    const newCursorPos =
      cursorMarkerPos >= 0
        ? insertPos + cursorMarkerPos
        : insertPos + text.length;
    el.focus();
    el.setSelectionRange(newCursorPos, newCursorPos);
  });
}

/* ─── Validation ─── */

const validation = computed(() => {
  const f = formula.value;
  if (!f.trim()) return null;

  // Balanced {{ }}
  const opens = (f.match(/\{\{/g) || []).length;
  const closes = (f.match(/\}\}/g) || []).length;
  if (opens !== closes) {
    return {
      level: "error",
      text: `Unmatched braces: ${opens} opening vs ${closes} closing`,
    };
  }

  // Balanced parentheses
  let depth = 0;
  for (const ch of f) {
    if (ch === "(") depth++;
    if (ch === ")") depth--;
    if (depth < 0)
      return { level: "error", text: "Unexpected closing parenthesis" };
  }
  if (depth > 0) {
    return {
      level: "error",
      text: `${depth} unclosed parenthesis${depth > 1 ? "es" : ""}`,
    };
  }

  // Unknown functions
  const fnMatches = f.match(/\b([A-Z_]+)\s*\(/gi) || [];
  for (const m of fnMatches) {
    const name = m.replace(/\s*\($/, "").toUpperCase();
    if (!KNOWN_FUNCTIONS.has(name)) {
      return { level: "warning", text: `Unknown function: ${name}` };
    }
  }

  // Unknown field references (simple and dotted)
  const simpleRefs = [...f.matchAll(/\{\{(\w+)\}\}/g)].map((m) => m[1]!);
  const dottedRefs = [...f.matchAll(/\{\{(\w+\.\w+)\}\}/g)].map((m) => m[1]!);

  const fieldSet = new Set(collectionFields.value.map((cf) => cf.field));
  const unknownSimple = simpleRefs
    .filter((r) => !r.includes("."))
    .filter((r) => !fieldSet.has(r));

  // For dotted refs, check that the local field exists in relationalFields
  const relLocalFields = new Set(
    relationalFields.value.map((rg) => rg.localField),
  );
  const relFieldSet = new Set(
    relationalFields.value.flatMap((rg) =>
      rg.fields.map((f2) => `${rg.localField}.${f2.field}`),
    ),
  );
  const unknownDotted = dottedRefs.filter((r) => !relFieldSet.has(r));

  const allUnknowns = [...unknownSimple, ...unknownDotted];
  if (
    allUnknowns.length > 0 &&
    (collectionFields.value.length > 0 || relationalFields.value.length > 0)
  ) {
    return {
      level: "warning",
      text: `Unknown field${allUnknowns.length > 1 ? "s" : ""}: ${allUnknowns.join(", ")}`,
    };
  }

  return { level: "success", text: "Formula looks valid" };
});

const validationIcon = computed(() => {
  if (!validation.value) return "";
  const icons: Record<string, string> = {
    error: "error_outline",
    warning: "warning_amber",
    success: "check_circle",
  };
  return icons[validation.value.level] ?? "info";
});

/* ─── CRON presets & validation ─── */

const cronPresets = [
  { label: "Every 5 min", value: "*/5 * * * *" },
  { label: "Every 15 min", value: "*/15 * * * *" },
  { label: "Hourly", value: "0 * * * *" },
  { label: "Daily midnight", value: "0 0 * * *" },
  { label: "Weekly (Sun)", value: "0 0 * * 0" },
];

const cronValidation = computed(() => {
  const cron = currentOptions.value.cronSchedule;
  if (!cron) return null;
  const parts = cron.trim().split(/\s+/);
  if (parts.length < 5 || parts.length > 6) {
    return {
      level: "error" as const,
      text: `Expected 5 fields, got ${parts.length}`,
    };
  }
  return { level: "success" as const, text: "Cron expression looks valid" };
});

/* ─── Auto-detected watch fields ─── */

const autoDetectedFields = computed(() => {
  const refs = formula.value.match(/\{\{([\w.]+)\}\}/g) || [];
  return [...new Set(refs.map((r) => r.replace(/\{\{|\}\}/g, "")))];
});

/* ─── Watch field tags ─── */

const watchFieldTags = computed<string[]>(() => {
  const wf = currentOptions.value.watchFields;
  if (!wf) return [];
  if (Array.isArray(wf)) return wf;
  if (typeof wf === "string")
    return wf
      .split(",")
      .map((s: string) => s.trim())
      .filter(Boolean);
  return [];
});

const tagInput = ref("");
const tagInputEl = ref<HTMLInputElement | null>(null);

function focusTagInput() {
  tagInputEl.value?.focus();
}

function addWatchTag() {
  const val = tagInput.value.trim().replace(/,$/, "").trim();
  if (!val) return;
  if (watchFieldTags.value.includes(val)) {
    tagInput.value = "";
    return;
  }
  updateOption("watchFields", [...watchFieldTags.value, val]);
  tagInput.value = "";
}

function removeWatchTag(tag: string) {
  const updated = watchFieldTags.value.filter((t) => t !== tag);
  updateOption("watchFields", updated.length > 0 ? updated : undefined);
}

function popWatchTag() {
  if (watchFieldTags.value.length === 0) return;
  const updated = watchFieldTags.value.slice(0, -1);
  updateOption("watchFields", updated.length > 0 ? updated : undefined);
}

function onTagKeydown(e: KeyboardEvent) {
  if (e.key === "Enter" || e.key === ",") {
    e.preventDefault();
    addWatchTag();
  } else if (e.key === "Backspace" && !tagInput.value) {
    popWatchTag();
  }
}

/* ─── Helpers ─── */

function fieldTypeIcon(type: string): string {
  const map: Record<string, string> = {
    string: "text_fields",
    text: "notes",
    integer: "pin",
    bigInteger: "pin",
    float: "decimal_increase",
    decimal: "decimal_increase",
    boolean: "toggle_on",
    datetime: "schedule",
    date: "calendar_today",
    time: "schedule",
    timestamp: "schedule",
    uuid: "fingerprint",
    json: "data_object",
    csv: "list",
  };
  return map[type] ?? "circle";
}
</script>

<style scoped>
.formula-builder {
  display: flex;
  flex-direction: column;
  gap: 28px;
}

.fb-section {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.fb-label {
  font-weight: 600;
  font-size: 14px;
  color: var(--theme--foreground);
}

.fb-hint {
  font-size: 12px;
  color: var(--theme--foreground-subdued);
  line-height: 1.5;
}

.fb-hint code {
  background: var(--theme--background-normal);
  padding: 1px 5px;
  border-radius: 4px;
  font-size: 11px;
}

/* ─── Editor ─── */

.editor-wrap {
  position: relative;
}

.formula-editor {
  width: 100%;
  min-height: 80px;
  padding: 10px 12px;
  font-family: var(--theme--fonts--monospace--font-family, monospace);
  font-size: 14px;
  line-height: 1.6;
  color: var(--theme--foreground);
  background: var(--theme--background-normal);
  border: var(--theme--border-width) solid var(--theme--border-color);
  border-radius: var(--theme--border-radius);
  resize: vertical;
  outline: none;
  transition: border-color 0.15s;
  box-sizing: border-box;
}

.formula-editor:focus {
  border-color: var(--theme--primary);
}

/* ─── Autocomplete ─── */

.ac-popup {
  position: absolute;
  top: 100%;
  left: 0;
  right: 0;
  z-index: 100;
  background: var(--theme--background);
  border: var(--theme--border-width) solid var(--theme--border-color);
  border-radius: var(--theme--border-radius);
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15);
  max-height: 200px;
  overflow-y: auto;
  margin-top: 2px;
}

.ac-option {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  cursor: pointer;
  font-size: 13px;
  transition: background 0.1s;
}

.ac-option:hover,
.ac-active {
  background: var(--theme--background-accent);
}

.ac-name {
  font-weight: 500;
  color: var(--theme--foreground);
  font-family: var(--theme--fonts--monospace--font-family, monospace);
}

.ac-type {
  margin-left: auto;
  font-size: 11px;
  color: var(--theme--foreground-subdued);
  text-transform: lowercase;
}

.ac-fade-enter-active,
.ac-fade-leave-active {
  transition: opacity 0.15s;
}
.ac-fade-enter-from,
.ac-fade-leave-to {
  opacity: 0;
}

/* ─── Validation ─── */

.fb-msg {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  padding: 6px 10px;
  border-radius: var(--theme--border-radius);
}

.fb-msg--error {
  color: var(--theme--danger);
  background: color-mix(in srgb, var(--theme--danger) 8%, transparent);
}

.fb-msg--warning {
  color: var(--theme--warning);
  background: color-mix(in srgb, var(--theme--warning) 8%, transparent);
}

.fb-msg--success {
  color: var(--theme--success);
  background: color-mix(in srgb, var(--theme--success) 8%, transparent);
}

/* ─── Palette ─── */

.fb-palette {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.fb-palette-title {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 11px;
  font-weight: 600;
  color: var(--theme--foreground-subdued);
  text-transform: uppercase;
  letter-spacing: 0.05em;
}

.fb-palette-empty {
  font-size: 12px;
  color: var(--theme--foreground-subdued);
  font-style: italic;
}

.fb-chips {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.fb-chip {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 4px 10px;
  font-size: 12px;
  font-family: var(--theme--fonts--monospace--font-family, monospace);
  border: var(--theme--border-width) solid var(--theme--border-color);
  border-radius: 14px;
  background: var(--theme--background);
  color: var(--theme--foreground);
  cursor: pointer;
  transition: all 0.15s;
  white-space: nowrap;
}

.fb-chip:hover {
  border-color: var(--theme--primary);
  color: var(--theme--primary);
  background: color-mix(in srgb, var(--theme--primary) 8%, transparent);
}

.fb-chip--fn {
  font-weight: 600;
}

.fb-chip--active {
  border-color: var(--theme--primary);
  background: color-mix(in srgb, var(--theme--primary) 15%, transparent);
  color: var(--theme--primary);
}

.fb-chip--relation {
  border-color: var(--theme--secondary);
  color: var(--theme--secondary);
}

.fb-chip--relation:hover {
  background: color-mix(in srgb, var(--theme--secondary) 8%, transparent);
}

.fb-relation-hint {
  font-weight: 400;
  font-size: 11px;
  opacity: 0.7;
}

.fb-cron-presets {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-top: 8px;
}

/* ─── Tags Input ─── */

.fb-tags-wrap {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  padding: 8px 10px;
  background: var(--theme--background-normal);
  border: var(--theme--border-width) solid var(--theme--border-color);
  border-radius: var(--theme--border-radius);
  min-height: 36px;
  align-items: center;
  cursor: text;
}

.fb-tag {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 2px 8px;
  font-size: 12px;
  font-family: var(--theme--fonts--monospace--font-family, monospace);
  background: color-mix(in srgb, var(--theme--primary) 10%, transparent);
  color: var(--theme--primary);
  border-radius: 10px;
}

.fb-tag-x {
  background: none;
  border: none;
  color: inherit;
  cursor: pointer;
  font-size: 14px;
  line-height: 1;
  padding: 0 2px;
  opacity: 0.6;
}

.fb-tag-x:hover {
  opacity: 1;
}

.fb-tag-input {
  flex: 1;
  min-width: 100px;
  border: none;
  background: transparent;
  outline: none;
  font-size: 13px;
  color: var(--theme--foreground);
  font-family: var(--theme--fonts--monospace--font-family, monospace);
}

/* ─── Prefix / Suffix ─── */

.fb-row {
  flex-direction: row;
  gap: 16px;
}

.fb-half {
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.fb-input {
  width: 100%;
  padding: 8px 12px;
  font-size: 14px;
  color: var(--theme--foreground);
  background: var(--theme--background-normal);
  border: var(--theme--border-width) solid var(--theme--border-color);
  border-radius: var(--theme--border-radius);
  outline: none;
  transition: border-color 0.15s;
  box-sizing: border-box;
}

.fb-input:focus {
  border-color: var(--theme--primary);
}
</style>
