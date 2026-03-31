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
          @click="checkAutocomplete(); checkSignatureHelp()"
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
              <v-icon :name="ac.mode === 'function' ? 'functions' : fieldTypeIcon(item.type)" x-small />
              <div class="ac-item-text">
                <span class="ac-name">{{ item.label }}</span>
                <span v-if="item.hint" class="ac-hint">{{ item.hint }}</span>
              </div>
              <span class="ac-type">{{ ac.mode === 'function' ? item.returnType ?? 'any' : item.type }}</span>
            </div>
          </div>
        </transition>

        <!-- Signature Help -->
        <transition name="ac-fade">
          <div v-if="sig.show && sig.fn" class="sig-help">
            <div class="sig-help-signature">
              <span class="sig-fn-name">{{ sig.fn.name }}</span><span class="sig-paren">(</span><template v-for="(param, i) in sig.fn.params" :key="i"><span v-if="i > 0" class="sig-comma">, </span><span :class="['sig-param', { 'sig-param--active': i === sig.paramIndex }]">{{ param.name }}<span v-if="param.optional" class="sig-optional-mark">?</span></span></template><span class="sig-paren">)</span>
              <span class="sig-return">→ {{ sig.fn.returnType }}</span>
            </div>
            <div v-if="sig.fn.params[sig.paramIndex]" class="sig-help-detail">
              <strong>{{ sig.fn.params[sig.paramIndex].name }}</strong>
              <span v-if="sig.fn.params[sig.paramIndex].optional" class="sig-optional-badge">optional</span>
              — {{ sig.fn.params[sig.paramIndex].description }}
            </div>
            <div class="sig-help-desc">{{ sig.fn.description }}</div>
            <div v-if="sig.fn.example" class="sig-help-example">
              <span class="sig-example-label">Example:</span>
              <code>{{ sig.fn.example }}</code>
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
            :class="[
              'fb-chip',
              f.isFormula ? 'fb-chip--formula' : 'fb-chip--field',
            ]"
            :title="
              f.isFormula
                ? `${f.name} (formula field)`
                : `${f.name} (${f.type})`
            "
            @click="insertText(`{{${f.field}}}`)"
          >
            <v-icon
              :name="f.isFormula ? 'functions' : fieldTypeIcon(f.type)"
              x-small
            />
            <span>{{ f.field }}</span>
            <span v-if="f.isFormula" class="fb-chip-badge">formula</span>
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
        if (f.meta?.special?.includes("no-data")) return false;
        if (!f.type) return false;
        return true;
      })
      .map((f: any) => ({
        field: f.field as string,
        name: (f.name ?? f.field) as string,
        type: (f.type ?? "unknown") as string,
        isFormula: f.meta?.interface === "queryable-formula",
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
  "TODAY",
  "DATE",
  "DATEVALUE",
  "TIME",
  "TIMEVALUE",
  "YEAR",
  "MONTH",
  "DAY",
  "HOUR",
  "MINUTE",
  "SECOND",
  "WEEKDAY",
  "WEEKNUM",
  "ISOWEEKNUM",
  "DATEDIF",
  "DAYS",
  "EDATE",
  "EOMONTH",
  "NETWORKDAYS",
]);

/* ─── Function Signatures (for autocomplete & signature help) ─── */

interface FnParam {
  name: string;
  description: string;
  optional?: boolean;
}

interface FnSignature {
  name: string;
  description: string;
  params: FnParam[];
  returnType: string;
  example?: string;
}

const FUNCTION_SIGNATURES: Record<string, FnSignature> = {
  CONCAT: {
    name: "CONCAT",
    description: "Join values together into a single string",
    params: [
      { name: "value1", description: "First value to concatenate" },
      { name: "value2", description: "Second value to concatenate" },
      { name: "...", description: "Additional values", optional: true },
    ],
    returnType: "string",
    example: 'CONCAT({{first_name}}, " ", {{last_name}})',
  },
  UPPER: {
    name: "UPPER",
    description: "Convert text to uppercase",
    params: [{ name: "text", description: "The text to convert" }],
    returnType: "string",
    example: "UPPER({{name}})",
  },
  LOWER: {
    name: "LOWER",
    description: "Convert text to lowercase",
    params: [{ name: "text", description: "The text to convert" }],
    returnType: "string",
    example: "LOWER({{email}})",
  },
  TRIM: {
    name: "TRIM",
    description: "Remove leading and trailing whitespace",
    params: [{ name: "text", description: "The text to trim" }],
    returnType: "string",
    example: "TRIM({{name}})",
  },
  ROUND: {
    name: "ROUND",
    description: "Round a number to a specified number of decimal places",
    params: [
      { name: "number", description: "The number to round" },
      { name: "decimals", description: "Number of decimal places (default: 0)", optional: true },
    ],
    returnType: "number",
    example: "ROUND({{price}}, 2)",
  },
  FLOOR: {
    name: "FLOOR",
    description: "Round down to the nearest integer",
    params: [{ name: "number", description: "The number to round down" }],
    returnType: "number",
    example: "FLOOR({{score}})",
  },
  CEIL: {
    name: "CEIL",
    description: "Round up to the nearest integer",
    params: [{ name: "number", description: "The number to round up" }],
    returnType: "number",
    example: "CEIL({{score}})",
  },
  IF: {
    name: "IF",
    description: "Return one value if a condition is true, another if false",
    params: [
      { name: "condition", description: "The condition to evaluate" },
      { name: "then_value", description: "Value if condition is true" },
      { name: "else_value", description: "Value if condition is false" },
    ],
    returnType: "any",
    example: 'IF({{age}} >= 18, "Adult", "Minor")',
  },
  COALESCE: {
    name: "COALESCE",
    description: "Return the first non-null value from a list",
    params: [
      { name: "value1", description: "First value to check" },
      { name: "value2", description: "Second value to check" },
      { name: "...", description: "Additional values", optional: true },
    ],
    returnType: "any",
    example: 'COALESCE({{nickname}}, {{name}}, "Unknown")',
  },
  NOW: {
    name: "NOW",
    description: "Current date and time as ISO timestamp",
    params: [],
    returnType: "datetime",
  },
  TODAY: {
    name: "TODAY",
    description: "Current date in YYYY-MM-DD format",
    params: [],
    returnType: "date",
  },
  DATE: {
    name: "DATE",
    description: "Create a date from year, month, and day components",
    params: [
      { name: "year", description: "The year (e.g. 2024)" },
      { name: "month", description: "The month (1–12)" },
      { name: "day", description: "The day of the month (1–31)" },
    ],
    returnType: "date",
    example: "DATE(2024, 1, 15)",
  },
  DATEVALUE: {
    name: "DATEVALUE",
    description: "Parse a date string into an ISO date",
    params: [{ name: "date_string", description: "A string containing a date" }],
    returnType: "date",
    example: 'DATEVALUE("2024-06-15")',
  },
  TIME: {
    name: "TIME",
    description: "Create a time string from hour, minute, and second",
    params: [
      { name: "hour", description: "Hour (0–23)" },
      { name: "minute", description: "Minute (0–59)" },
      { name: "second", description: "Second (0–59)" },
    ],
    returnType: "time",
    example: "TIME(14, 30, 0)",
  },
  TIMEVALUE: {
    name: "TIMEVALUE",
    description: "Extract the time part from a datetime value",
    params: [{ name: "datetime", description: "A datetime value" }],
    returnType: "time",
    example: "TIMEVALUE({{created_at}})",
  },
  YEAR: {
    name: "YEAR",
    description: "Extract the year from a date",
    params: [{ name: "date", description: "A date or datetime value" }],
    returnType: "number",
    example: "YEAR({{dob}})",
  },
  MONTH: {
    name: "MONTH",
    description: "Extract the month (1–12) from a date",
    params: [{ name: "date", description: "A date or datetime value" }],
    returnType: "number",
    example: "MONTH({{dob}})",
  },
  DAY: {
    name: "DAY",
    description: "Extract the day of the month (1–31) from a date",
    params: [{ name: "date", description: "A date or datetime value" }],
    returnType: "number",
    example: "DAY({{dob}})",
  },
  HOUR: {
    name: "HOUR",
    description: "Extract the hour (0–23) from a datetime",
    params: [{ name: "datetime", description: "A datetime value" }],
    returnType: "number",
    example: "HOUR({{created_at}})",
  },
  MINUTE: {
    name: "MINUTE",
    description: "Extract the minute (0–59) from a datetime",
    params: [{ name: "datetime", description: "A datetime value" }],
    returnType: "number",
    example: "MINUTE({{created_at}})",
  },
  SECOND: {
    name: "SECOND",
    description: "Extract the second (0–59) from a datetime",
    params: [{ name: "datetime", description: "A datetime value" }],
    returnType: "number",
    example: "SECOND({{created_at}})",
  },
  WEEKDAY: {
    name: "WEEKDAY",
    description: "Return the day of the week for a date",
    params: [
      { name: "date", description: "A date value" },
      { name: "type", description: "Numbering type (1=Sun–Sat, 2=Mon–Sun, 3=Mon=0–Sun=6)", optional: true },
    ],
    returnType: "number",
    example: "WEEKDAY({{dob}})",
  },
  WEEKNUM: {
    name: "WEEKNUM",
    description: "Return the week number of the year",
    params: [
      { name: "date", description: "A date value" },
      { name: "type", description: "Week start (1=Sunday, 2=Monday)", optional: true },
    ],
    returnType: "number",
    example: "WEEKNUM({{dob}})",
  },
  ISOWEEKNUM: {
    name: "ISOWEEKNUM",
    description: "Return the ISO 8601 week number of the year",
    params: [{ name: "date", description: "A date value" }],
    returnType: "number",
    example: "ISOWEEKNUM({{dob}})",
  },
  DATEDIF: {
    name: "DATEDIF",
    description: "Calculate the difference between two dates in the specified unit",
    params: [
      { name: "start_date", description: "The start date" },
      { name: "end_date", description: "The end date" },
      { name: "unit", description: '"Y" (years), "M" (months), "D" (days), "YM", "MD", or "YD"' },
    ],
    returnType: "number",
    example: 'DATEDIF({{dob}}, NOW(), "Y")',
  },
  DAYS: {
    name: "DAYS",
    description: "Return the number of days between two dates",
    params: [
      { name: "end_date", description: "The end date" },
      { name: "start_date", description: "The start date" },
    ],
    returnType: "number",
    example: "DAYS(NOW(), {{hire_date}})",
  },
  EDATE: {
    name: "EDATE",
    description: "Return a date offset by a given number of months",
    params: [
      { name: "start_date", description: "The starting date" },
      { name: "months", description: "Number of months to add (negative to subtract)" },
    ],
    returnType: "date",
    example: "EDATE({{start_date}}, 3)",
  },
  EOMONTH: {
    name: "EOMONTH",
    description: "Return the last day of the month, offset by N months",
    params: [
      { name: "start_date", description: "The starting date" },
      { name: "months", description: "Number of months to offset" },
    ],
    returnType: "date",
    example: "EOMONTH({{start_date}}, 0)",
  },
  NETWORKDAYS: {
    name: "NETWORKDAYS",
    description: "Return the number of working days (Mon–Fri) between two dates",
    params: [
      { name: "start_date", description: "The start date" },
      { name: "end_date", description: "The end date" },
    ],
    returnType: "number",
    example: "NETWORKDAYS({{start_date}}, {{end_date}})",
  },
};

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
    label: "Date — Creation",
    icon: "schedule",
    fns: [
      {
        name: "NOW",
        snippet: "NOW()",
        hint: "NOW() — Current ISO timestamp",
      },
      {
        name: "TODAY",
        snippet: "TODAY()",
        hint: "TODAY() — Current date (YYYY-MM-DD)",
      },
      {
        name: "DATE",
        snippet: "DATE(|, , )",
        hint: "DATE(year, month, day) — Create a date",
      },
      {
        name: "DATEVALUE",
        snippet: "DATEVALUE(|)",
        hint: "DATEVALUE(date_string) — Parse string to ISO date",
      },
      {
        name: "TIME",
        snippet: "TIME(|, , )",
        hint: "TIME(hour, minute, second) — Create a time string",
      },
      {
        name: "TIMEVALUE",
        snippet: "TIMEVALUE(|)",
        hint: "TIMEVALUE(datetime) — Extract time part from datetime",
      },
    ],
  },
  {
    label: "Date — Extraction",
    icon: "event",
    fns: [
      {
        name: "YEAR",
        snippet: "YEAR(|)",
        hint: "YEAR(date) — Extract year",
      },
      {
        name: "MONTH",
        snippet: "MONTH(|)",
        hint: "MONTH(date) — Extract month (1–12)",
      },
      {
        name: "DAY",
        snippet: "DAY(|)",
        hint: "DAY(date) — Extract day of month (1–31)",
      },
      {
        name: "HOUR",
        snippet: "HOUR(|)",
        hint: "HOUR(datetime) — Extract hour (0–23)",
      },
      {
        name: "MINUTE",
        snippet: "MINUTE(|)",
        hint: "MINUTE(datetime) — Extract minute (0–59)",
      },
      {
        name: "SECOND",
        snippet: "SECOND(|)",
        hint: "SECOND(datetime) — Extract second (0–59)",
      },
      {
        name: "WEEKDAY",
        snippet: "WEEKDAY(|)",
        hint: "WEEKDAY(date [, type]) — Day of week (1=Sun default)",
      },
      {
        name: "WEEKNUM",
        snippet: "WEEKNUM(|)",
        hint: "WEEKNUM(date [, type]) — Week number of the year",
      },
      {
        name: "ISOWEEKNUM",
        snippet: "ISOWEEKNUM(|)",
        hint: "ISOWEEKNUM(date) — ISO 8601 week number",
      },
    ],
  },
  {
    label: "Date — Arithmetic",
    icon: "date_range",
    fns: [
      {
        name: "DATEDIF",
        snippet: 'DATEDIF(|, , "D")',
        hint: 'DATEDIF(start, end, unit) — Difference (unit: "Y","M","D","YM","MD","YD")',
      },
      {
        name: "DAYS",
        snippet: "DAYS(|, )",
        hint: "DAYS(end, start) — Number of days between two dates",
      },
      {
        name: "EDATE",
        snippet: "EDATE(|, )",
        hint: "EDATE(start, months) — Date offset by N months",
      },
      {
        name: "EOMONTH",
        snippet: "EOMONTH(|, )",
        hint: "EOMONTH(start, months) — End of month offset by N months",
      },
      {
        name: "NETWORKDAYS",
        snippet: "NETWORKDAYS(|, )",
        hint: "NETWORKDAYS(start, end) — Working days between two dates",
      },
    ],
  },
];

/* ─── Autocomplete state ─── */

const textareaEl = ref<HTMLTextAreaElement | null>(null);

interface AcItem {
  value: string;
  label: string;
  type: string;
  hint?: string;
  returnType?: string;
  snippet?: string;
}

const ac = reactive({
  show: false,
  mode: 'field' as 'field' | 'function',
  items: [] as AcItem[],
  index: 0,
  start: 0,
});

/* ─── Signature Help state ─── */

const sig = reactive({
  show: false,
  fn: null as FnSignature | null,
  paramIndex: 0,
});

function findCurrentFunction(text: string, pos: number): { name: string; paramIndex: number } | null {
  let depth = 0;
  let paramIndex = 0;
  let inStr = false;
  let strChar = '';

  for (let i = pos - 1; i >= 0; i--) {
    const ch = text[i]!;

    if (inStr) {
      if (ch === strChar) inStr = false;
      continue;
    }
    if (ch === '"' || ch === "'") {
      inStr = true;
      strChar = ch;
      continue;
    }

    if (ch === ')') { depth++; continue; }
    if (ch === '(') {
      if (depth === 0) {
        const before = text.slice(0, i);
        const match = before.match(/\b([A-Z_]+)\s*$/i);
        if (match) {
          return { name: match[1]!.toUpperCase(), paramIndex };
        }
        return null;
      }
      depth--;
      continue;
    }
    if (ch === ',' && depth === 0) { paramIndex++; }
  }
  return null;
}

function checkSignatureHelp() {
  const el = textareaEl.value;
  if (!el) { sig.show = false; return; }

  const pos = el.selectionStart;
  const text = formula.value.slice(0, pos);
  const ctx = findCurrentFunction(text, text.length);

  if (ctx && FUNCTION_SIGNATURES[ctx.name]) {
    sig.fn = FUNCTION_SIGNATURES[ctx.name]!;
    sig.paramIndex = Math.min(ctx.paramIndex, sig.fn.params.length - 1);
    sig.show = true;
  } else {
    sig.show = false;
    sig.fn = null;
  }
}

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

  // Mode 1: Field autocomplete (inside {{ }})
  if (lastOpen >= 0 && lastOpen > lastClose) {
    const partial = text.slice(lastOpen + 2).toLowerCase();

    const localMatches: AcItem[] = collectionFields.value
      .filter((f) => f.field.toLowerCase().includes(partial))
      .map((f) => ({
        value: f.field,
        label: f.field,
        type: f.isFormula ? "formula" : f.type,
      }));

    const relMatches: AcItem[] = [];
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
    ac.mode = 'field';
    ac.show = ac.items.length > 0;
    return;
  }

  // Mode 2: Function autocomplete (typing a word that could be a function)
  const wordMatch = text.match(/\b([A-Z_]{1,}[A-Z0-9_]*)$/i);
  if (wordMatch && wordMatch[1]!.length >= 1) {
    const partial = wordMatch[1]!.toUpperCase();
    const wordStart = pos - wordMatch[1]!.length;

    // Don't show function autocomplete if we're inside a {{ }} context or if the word is already followed by (
    const afterCursor = formula.value.slice(pos);
    const nextNonSpace = afterCursor.match(/^\s*(\S)/);
    const alreadyHasParen = nextNonSpace && nextNonSpace[1] === '(';

    const matches: AcItem[] = Object.values(FUNCTION_SIGNATURES)
      .filter((fn) => fn.name.startsWith(partial) && fn.name !== partial)
      .map((fn) => ({
        value: fn.name,
        label: fn.name,
        type: 'function',
        hint: fn.description,
        returnType: fn.returnType,
        snippet: fn.params.length === 0 ? `${fn.name}()` : `${fn.name}(`,
      }));

    if (matches.length > 0 && !alreadyHasParen) {
      ac.items = matches;
      ac.index = 0;
      ac.start = wordStart;
      ac.mode = 'function';
      ac.show = true;
      return;
    }
  }

  ac.show = false;
}

function pickAutocomplete(item: AcItem) {
  const el = textareaEl.value;
  if (!el) return;

  const pos = el.selectionStart;
  const text = formula.value;

  if (ac.mode === 'field') {
    const replacement = `{{${item.value}}}`;
    const newText = text.slice(0, ac.start) + replacement + text.slice(pos);
    updateOption("formula", newText);
    ac.show = false;

    const newPos = ac.start + replacement.length;
    nextTick(() => {
      el.focus();
      el.setSelectionRange(newPos, newPos);
    });
  } else {
    // Function mode
    const insertion = item.snippet ?? `${item.value}(`;
    const newText = text.slice(0, ac.start) + insertion + text.slice(pos);
    updateOption("formula", newText);
    ac.show = false;

    const newPos = ac.start + insertion.length;
    nextTick(() => {
      el.focus();
      el.setSelectionRange(newPos, newPos);
      checkSignatureHelp();
    });
  }
}

function onEditorBlur() {
  setTimeout(() => {
    ac.show = false;
    sig.show = false;
  }, 150);
}

/* ─── Keyboard handling ─── */

function onEditorKeydown(e: KeyboardEvent) {
  if (ac.show && ac.items.length > 0) {
    switch (e.key) {
      case "ArrowDown":
        e.preventDefault();
        ac.index = Math.min(ac.index + 1, ac.items.length - 1);
        return;
      case "ArrowUp":
        e.preventDefault();
        ac.index = Math.max(ac.index - 1, 0);
        return;
      case "Enter":
      case "Tab":
        e.preventDefault();
        pickAutocomplete(ac.items[ac.index]!);
        return;
      case "Escape":
        e.preventDefault();
        ac.show = false;
        return;
    }
  }

  if (sig.show && e.key === "Escape") {
    e.preventDefault();
    sig.show = false;
  }
}

/* ─── Formula input ─── */

function onFormulaInput(e: Event) {
  const val = (e.target as HTMLTextAreaElement).value;
  updateOption("formula", val);
  nextTick(() => {
    checkAutocomplete();
    checkSignatureHelp();
  });
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

/* ─── Circular dependency detection ─── */

/**
 * Build the dependency graph of all formula fields in this collection
 * (including the current formula being edited) and detect cycles
 * using Kahn's algorithm.
 */
function detectCircularDeps(): string[] {
  if (!fieldsStore || !props.collection) return [];
  try {
    const all = fieldsStore.getFieldsForCollection(props.collection);
    const formulaEntries: { field: string; formula: string }[] = [];

    for (const f of all) {
      if (f.meta?.interface !== "queryable-formula") continue;
      const opts =
        typeof f.meta?.options === "string"
          ? JSON.parse(f.meta.options)
          : f.meta?.options;
      const fFormula = opts?.formula;
      if (!fFormula) continue;
      formulaEntries.push({ field: f.field, formula: fFormula });
    }

    if (formulaEntries.length < 2) return [];

    const formulaFieldNames = new Set(formulaEntries.map((e) => e.field));

    // field → set of formula fields it depends on
    const deps = new Map<string, Set<string>>();
    for (const entry of formulaEntries) {
      const entryDeps = new Set<string>();
      const refs = entry.formula.match(/\{\{(\w+)\}\}/g) || [];
      for (const ref of refs) {
        const name = ref.replace(/\{\{|\}\}/g, "");
        if (formulaFieldNames.has(name) && name !== entry.field) {
          entryDeps.add(name);
        }
      }
      deps.set(entry.field, entryDeps);
    }

    // Kahn's algorithm — fields left over are in cycles
    const dependents = new Map<string, Set<string>>();
    for (const entry of formulaEntries) {
      dependents.set(entry.field, new Set());
    }
    for (const [field, fieldDeps] of deps) {
      for (const dep of fieldDeps) {
        dependents.get(dep)?.add(field);
      }
    }

    const inDegree = new Map<string, number>();
    for (const entry of formulaEntries) {
      inDegree.set(entry.field, deps.get(entry.field)?.size ?? 0);
    }

    const queue: string[] = [];
    for (const [field, deg] of inDegree) {
      if (deg === 0) queue.push(field);
    }

    const sorted = new Set<string>();
    while (queue.length > 0) {
      const field = queue.shift()!;
      sorted.add(field);
      for (const dependent of dependents.get(field) ?? []) {
        const newDeg = (inDegree.get(dependent) ?? 1) - 1;
        inDegree.set(dependent, newDeg);
        if (newDeg === 0) queue.push(dependent);
      }
    }

    return formulaEntries
      .filter((e) => !sorted.has(e.field))
      .map((e) => e.field);
  } catch {
    return [];
  }
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

  // Check for circular dependencies among formula fields
  const circularFields = detectCircularDeps();
  if (circularFields.length > 0) {
    return {
      level: "error",
      text: `Circular dependency detected involving: ${circularFields.join(", ")}. These fields will be skipped during evaluation.`,
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

.ac-item-text {
  display: flex;
  flex-direction: column;
  gap: 1px;
  min-width: 0;
  flex: 1;
}

.ac-name {
  font-weight: 500;
  color: var(--theme--foreground);
  font-family: var(--theme--fonts--monospace--font-family, monospace);
}

.ac-hint {
  font-size: 11px;
  color: var(--theme--foreground-subdued);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.ac-type {
  margin-left: auto;
  font-size: 11px;
  color: var(--theme--foreground-subdued);
  text-transform: lowercase;
  white-space: nowrap;
  padding-left: 8px;
}

/* ─── Signature Help ─── */

.sig-help {
  position: absolute;
  bottom: 100%;
  left: 0;
  right: 0;
  z-index: 101;
  background: var(--theme--background);
  border: var(--theme--border-width) solid var(--theme--border-color);
  border-radius: var(--theme--border-radius);
  box-shadow: 0 -2px 12px rgba(0, 0, 0, 0.12);
  padding: 10px 14px;
  margin-bottom: 4px;
  font-size: 13px;
  line-height: 1.5;
}

.sig-help-signature {
  font-family: var(--theme--fonts--monospace--font-family, monospace);
  font-size: 13px;
  color: var(--theme--foreground);
  display: flex;
  align-items: baseline;
  flex-wrap: wrap;
  gap: 0;
}

.sig-fn-name {
  font-weight: 700;
  color: var(--theme--primary);
}

.sig-paren {
  color: var(--theme--foreground-subdued);
}

.sig-comma {
  color: var(--theme--foreground-subdued);
}

.sig-param {
  color: var(--theme--foreground-subdued);
  transition: all 0.15s;
}

.sig-param--active {
  color: var(--theme--foreground);
  font-weight: 600;
  text-decoration: underline;
  text-underline-offset: 3px;
  text-decoration-color: var(--theme--primary);
}

.sig-optional-mark {
  color: var(--theme--foreground-subdued);
  opacity: 0.6;
}

.sig-return {
  margin-left: 8px;
  font-size: 11px;
  color: var(--theme--foreground-subdued);
  font-weight: 400;
}

.sig-help-detail {
  margin-top: 6px;
  font-size: 12px;
  color: var(--theme--foreground);
  padding: 4px 8px;
  background: var(--theme--background-subdued);
  border-radius: 4px;
}

.sig-help-detail strong {
  font-family: var(--theme--fonts--monospace--font-family, monospace);
  color: var(--theme--primary);
}

.sig-optional-badge {
  font-size: 10px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.03em;
  padding: 1px 5px;
  margin-left: 4px;
  border-radius: 6px;
  background: color-mix(in srgb, var(--theme--warning) 15%, transparent);
  color: var(--theme--warning);
}

.sig-help-desc {
  margin-top: 6px;
  font-size: 12px;
  color: var(--theme--foreground-subdued);
  font-style: italic;
}

.sig-help-example {
  margin-top: 6px;
  font-size: 12px;
  color: var(--theme--foreground-subdued);
}

.sig-example-label {
  font-weight: 600;
  margin-right: 4px;
}

.sig-help-example code {
  font-family: var(--theme--fonts--monospace--font-family, monospace);
  background: var(--theme--background-subdued);
  padding: 1px 5px;
  border-radius: 4px;
  font-size: 11px;
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

.fb-chip--formula {
  border-color: var(--theme--purple, #9333ea);
  color: var(--theme--purple, #9333ea);
}

.fb-chip--formula:hover {
  background: color-mix(
    in srgb,
    var(--theme--purple, #9333ea) 8%,
    transparent
  );
}

.fb-chip-badge {
  font-size: 9px;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  padding: 1px 5px;
  border-radius: 8px;
  background: color-mix(
    in srgb,
    var(--theme--purple, #9333ea) 15%,
    transparent
  );
  font-family: var(--theme--fonts--sans--font-family, sans-serif);
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
