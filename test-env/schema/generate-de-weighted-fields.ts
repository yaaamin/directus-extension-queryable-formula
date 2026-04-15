/**
 * Generates test-env/schema/de-weighted-assessments-fields.json
 * Run: bun test-env/schema/generate-de-weighted-fields.ts
 */
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const C = 'de_weighted_assessments';
const T = 'de_weighted_assessments';

type Meta = Record<string, unknown>;
type Schema = Record<string, unknown>;

function baseMeta(
  field: string,
  sort: number,
  rest: Meta,
): Meta {
  return {
    collection: C,
    conditions: null,
    display: null,
    display_options: null,
    field,
    group: null,
    note: null,
    options: null,
    readonly: false,
    required: false,
    searchable: true,
    translations: null,
    validation: null,
    validation_message: null,
    width: 'full',
    sort,
    ...rest,
  };
}

function baseSchema(
  name: string,
  rest: Schema,
): Schema {
  return {
    name,
    table: T,
    default_value: null,
    max_length: null,
    numeric_precision: null,
    numeric_scale: null,
    is_unique: false,
    is_indexed: false,
    is_primary_key: false,
    is_generated: false,
    generation_expression: null,
    has_auto_increment: false,
    foreign_key_table: null,
    foreign_key_column: null,
    ...rest,
  };
}

const fields: Record<string, unknown>[] = [];

fields.push({
  collection: C,
  field: 'id',
  type: 'uuid',
  meta: {
    ...baseMeta('id', 1, {
      hidden: true,
      interface: 'input',
      readonly: true,
      special: ['uuid'],
    }),
  },
  schema: baseSchema('id', {
    data_type: 'uuid',
    is_nullable: false,
    is_unique: true,
    is_primary_key: true,
  }),
});

fields.push({
  collection: C,
  field: 'sort',
  type: 'integer',
  meta: baseMeta('sort', 2, { hidden: true, interface: 'input', special: null }),
  schema: baseSchema('sort', {
    data_type: 'integer',
    numeric_precision: 32,
    numeric_scale: 0,
    is_nullable: true,
  }),
});

fields.push({
  collection: C,
  field: 'user_created',
  type: 'uuid',
  meta: {
    ...baseMeta('user_created', 3, {
      hidden: true,
      display: 'user',
      interface: 'select-dropdown-m2o',
      options: { template: '{{avatar}} {{first_name}} {{last_name}}' },
      readonly: true,
      special: ['user-created'],
    }),
  },
  schema: baseSchema('user_created', {
    data_type: 'uuid',
    is_nullable: true,
    foreign_key_table: 'directus_users',
    foreign_key_column: 'id',
  }),
});

fields.push({
  collection: C,
  field: 'date_created',
  type: 'timestamp',
  meta: {
    ...baseMeta('date_created', 4, {
      hidden: true,
      display: 'datetime',
      display_options: { relative: true },
      interface: 'datetime',
      readonly: true,
      special: ['date-created'],
    }),
  },
  schema: baseSchema('date_created', {
    data_type: 'timestamp with time zone',
    is_nullable: true,
  }),
});

fields.push({
  collection: C,
  field: 'user_updated',
  type: 'uuid',
  meta: {
    ...baseMeta('user_updated', 5, {
      hidden: true,
      display: 'user',
      interface: 'select-dropdown-m2o',
      options: { template: '{{avatar}} {{first_name}} {{last_name}}' },
      readonly: true,
      special: ['user-updated'],
    }),
  },
  schema: baseSchema('user_updated', {
    data_type: 'uuid',
    is_nullable: true,
    foreign_key_table: 'directus_users',
    foreign_key_column: 'id',
  }),
});

fields.push({
  collection: C,
  field: 'date_updated',
  type: 'timestamp',
  meta: {
    ...baseMeta('date_updated', 6, {
      hidden: true,
      display: 'datetime',
      display_options: { relative: true },
      interface: 'datetime',
      readonly: true,
      special: ['date-updated'],
    }),
  },
  schema: baseSchema('date_updated', {
    data_type: 'timestamp with time zone',
    is_nullable: true,
  }),
});

fields.push({
  collection: C,
  field: 'subject',
  type: 'integer',
  meta: {
    ...baseMeta('subject', 7, {
      hidden: false,
      interface: 'select-dropdown-m2o',
      options: {
        enableCreate: false,
        enableLink: true,
        template: '{{name}} ({{identification}})',
      },
      special: ['m2o'],
    }),
  },
  schema: baseSchema('subject', {
    data_type: 'integer',
    numeric_precision: 32,
    numeric_scale: 0,
    is_nullable: true,
    foreign_key_table: 'de_NDR',
    foreign_key_column: 'id',
  }),
});

fields.push({
  collection: C,
  field: 'divider_section_3',
  type: 'alias',
  meta: {
    ...baseMeta('divider_section_3', 8, {
      hidden: false,
      interface: 'presentation-divider',
      options: { title: 'Section 3 — Background & Experience' },
      special: ['alias', 'no-data'],
    }),
  },
});

fields.push({
  collection: C,
  field: 'education_level_score',
  type: 'integer',
  meta: {
    ...baseMeta('education_level_score', 9, {
      hidden: false,
      interface: 'select-dropdown',
      note: "0=No Formal Education; 1=Certificate 1; 2=Certificate 2; 3=Certificate 3/O'Level; 4=Certificate 4/A'Level; 5=Diploma; 6=Advanced Diploma/Associate Degree/Professional Certificate; 7=Bachelor's Degree/Honours/Professional Diploma; 8=Graduate/Post-Graduate Certificate/Diploma; 9=Master's/Advanced Professional; 10=Doctoral/Higher Professional",
      options: {
        allowOther: false,
        choices: [
          { text: 'No Formal Education', value: 0 },
          { text: 'Certificate 1', value: 1 },
          { text: 'Certificate 2', value: 2 },
          { text: "Certificate 3 / O'Level", value: 3 },
          { text: "Certificate 4 / A'Level", value: 4 },
          { text: 'Diploma', value: 5 },
          { text: 'Advanced Diploma / Associate Degree / Professional Certificate', value: 6 },
          {
            text: "Bachelor's Honours Degree / Bachelor's Degree / Professional Diploma / Professional Certificate",
            value: 7,
          },
          {
            text: 'Graduate Certificate / Post Graduate Certificate / Graduate Diploma / Post Graduate Diploma',
            value: 8,
          },
          {
            text: "Master's Degree / Advanced Professional Diploma / Advanced Professional Certificate",
            value: 9,
          },
          {
            text: 'Doctoral Degree / Higher Professional Diploma / Higher Professional Certificate',
            value: 10,
          },
        ],
      },
      special: null,
    }),
  },
  schema: baseSchema('education_level_score', {
    data_type: 'integer',
    numeric_precision: 32,
    numeric_scale: 0,
    is_nullable: true,
  }),
});

fields.push({
  collection: C,
  field: 'education_level_weight',
  type: 'integer',
  meta: {
    ...baseMeta('education_level_weight', 10, {
      hidden: false,
      interface: 'input',
      readonly: true,
      options: {
        formula: '({{education_level_score}}/10)*7',
        max: 7,
        min: 7,
        step: 1,
      },
      special: null,
    }),
  },
  schema: baseSchema('education_level_weight', {
    data_type: 'integer',
    default_value: 7,
    numeric_precision: 32,
    numeric_scale: 0,
    is_nullable: true,
  }),
});

fields.push({
  collection: C,
  field: 'education_level_weighted_score',
  type: 'decimal',
  meta: {
    ...baseMeta('education_level_weighted_score', 11, {
      hidden: false,
      interface: 'queryable-formula',
      options: { formula: '{{education_level_score}}/10*7' },
      special: null,
    }),
  },
  schema: baseSchema('education_level_weighted_score', {
    data_type: 'numeric',
    numeric_precision: 10,
    numeric_scale: 5,
    is_nullable: true,
  }),
});

fields.push({
  collection: C,
  field: 'employment_experience_score',
  type: 'integer',
  meta: {
    ...baseMeta('employment_experience_score', 12, {
      hidden: false,
      interface: 'select-dropdown',
      note: '0=No exposure; 1=Volunteer/Internship; 2=Short-term/Project (<6 months); 3=Part-time/Seasonal/Temporary; 4=Sustained work (1-2 years); 5=Continuous/varied roles 2+ years',
      options: {
        allowOther: false,
        choices: [
          { text: 'No exposure', value: 0 },
          { text: 'Volunteer/Internship', value: 1 },
          { text: 'Short-term/Project-based (<6 months)', value: 2 },
          { text: 'Part-time/Seasonal/Temporary', value: 3 },
          { text: 'Sustained work (1–2 years, any type)', value: 4 },
          { text: 'Continuous or varied roles 2+ years', value: 5 },
        ],
      },
      special: null,
    }),
  },
  schema: baseSchema('employment_experience_score', {
    data_type: 'integer',
    numeric_precision: 32,
    numeric_scale: 0,
    is_nullable: true,
  }),
});

fields.push({
  collection: C,
  field: 'employment_experience_weight',
  type: 'integer',
  meta: {
    ...baseMeta('employment_experience_weight', 13, {
      hidden: false,
      interface: 'input',
      readonly: true,
      options: { max: 8, min: 8, step: 1 },
      special: null,
    }),
  },
  schema: baseSchema('employment_experience_weight', {
    data_type: 'integer',
    default_value: 8,
    numeric_precision: 32,
    numeric_scale: 0,
    is_nullable: true,
  }),
});

fields.push({
  collection: C,
  field: 'employment_experience_weighted_score',
  type: 'decimal',
  meta: {
    ...baseMeta('employment_experience_weighted_score', 14, {
      hidden: false,
      interface: 'queryable-formula',
      options: { formula: '{{employment_experience_score}}/5*8' },
      special: null,
    }),
  },
  schema: baseSchema('employment_experience_weighted_score', {
    data_type: 'numeric',
    numeric_precision: 10,
    numeric_scale: 5,
    is_nullable: true,
  }),
});

fields.push({
  collection: C,
  field: 'section_3_subtotal',
  type: 'decimal',
  meta: {
    ...baseMeta('section_3_subtotal', 15, {
      hidden: false,
      interface: 'queryable-formula',
      note: '/15',
      options: {
        formula:
          '(COALESCE({{education_level_score}}, 0) / 10 * 7)\n+ (COALESCE({{employment_experience_score}}, 0) / 5 * 8)',
      },
      special: null,
    }),
  },
  schema: baseSchema('section_3_subtotal', {
    data_type: 'numeric',
    numeric_precision: 10,
    numeric_scale: 5,
    is_nullable: true,
  }),
});

fields.push({
  collection: C,
  field: 'section_3_remarks',
  type: 'text',
  meta: baseMeta('section_3_remarks', 16, {
    hidden: false,
    interface: 'input-multiline',
    special: null,
  }),
  schema: baseSchema('section_3_remarks', {
    data_type: 'text',
    is_nullable: true,
  }),
});

fields.push({
  collection: C,
  field: 'divider_section_4',
  type: 'alias',
  meta: {
    ...baseMeta('divider_section_4', 17, {
      hidden: false,
      interface: 'presentation-divider',
      options: { title: 'Section 4 — Disability Severity' },
      special: ['alias', 'no-data'],
    }),
  },
});

fields.push({
  collection: C,
  field: 'disability_severity_score',
  type: 'integer',
  meta: {
    ...baseMeta('disability_severity_score', 18, {
      hidden: false,
      interface: 'select-dropdown',
      note: 'Mild=5; Moderate=3; Severe=1; Profound=0',
      options: {
        allowOther: false,
        choices: [
          { text: 'Mild (Functional with minimal limitations)', value: 5 },
          { text: 'Moderate (Needs support in specific areas)', value: 3 },
          { text: 'Severe (Requires significant assistance)', value: 1 },
          { text: 'Profound (Fully dependent in most areas)', value: 0 },
        ],
      },
      special: null,
    }),
  },
  schema: baseSchema('disability_severity_score', {
    data_type: 'integer',
    numeric_precision: 32,
    numeric_scale: 0,
    is_nullable: true,
  }),
});

fields.push({
  collection: C,
  field: 'disability_severity_weight',
  type: 'integer',
  meta: {
    ...baseMeta('disability_severity_weight', 19, {
      hidden: false,
      interface: 'input',
      readonly: true,
      options: { max: 2, min: 2, step: 1 },
      special: null,
    }),
  },
  schema: baseSchema('disability_severity_weight', {
    data_type: 'integer',
    default_value: 2,
    numeric_precision: 32,
    numeric_scale: 0,
    is_nullable: true,
  }),
});

fields.push({
  collection: C,
  field: 'disability_severity_weighted_score',
  type: 'decimal',
  meta: {
    ...baseMeta('disability_severity_weighted_score', 20, {
      hidden: false,
      interface: 'queryable-formula',
      options: { formula: '{{disability_severity_score}}*2' },
      special: null,
    }),
  },
  schema: baseSchema('disability_severity_weighted_score', {
    data_type: 'numeric',
    numeric_precision: 10,
    numeric_scale: 5,
    is_nullable: true,
  }),
});

fields.push({
  collection: C,
  field: 'section_4_score',
  type: 'decimal',
  meta: {
    ...baseMeta('section_4_score', 21, {
      hidden: false,
      interface: 'queryable-formula',
      note: '/10',
      options: { formula: '{{disability_severity_score}}*2' },
      special: null,
    }),
  },
  schema: baseSchema('section_4_score', {
    data_type: 'numeric',
    numeric_precision: 10,
    numeric_scale: 5,
    is_nullable: true,
  }),
});

fields.push({
  collection: C,
  field: 'section_4_remarks',
  type: 'text',
  meta: baseMeta('section_4_remarks', 22, {
    hidden: false,
    interface: 'input-multiline',
    special: null,
  }),
  schema: baseSchema('section_4_remarks', {
    data_type: 'text',
    is_nullable: true,
  }),
});

fields.push({
  collection: C,
  field: 'divider_section_5',
  type: 'alias',
  meta: {
    ...baseMeta('divider_section_5', 23, {
      hidden: false,
      interface: 'presentation-divider',
      options: { title: 'Section 5 — Functional Capabilities' },
      special: ['alias', 'no-data'],
    }),
  },
});

function sliderScore(field: string, sort: number, note: string | null = null) {
  fields.push({
    collection: C,
    field,
    type: 'integer',
    meta: {
      ...baseMeta(field, sort, {
        hidden: false,
        interface: 'slider',
        note,
        options: { max: 5, min: 1, step: 1 },
        special: null,
      }),
    },
    schema: baseSchema(field, {
      data_type: 'integer',
      numeric_precision: 32,
      numeric_scale: 0,
      is_nullable: true,
    }),
  });
}

function readonlyWeight(field: string, sort: number, def: number) {
  fields.push({
    collection: C,
    field,
    type: 'integer',
    meta: {
      ...baseMeta(field, sort, {
        hidden: false,
        interface: 'input',
        readonly: true,
        options: { max: def, min: def, step: 1 },
        special: null,
      }),
    },
    schema: baseSchema(field, {
      data_type: 'integer',
      default_value: def,
      numeric_precision: 32,
      numeric_scale: 0,
      is_nullable: true,
    }),
  });
}

function weightedFormula(
  field: string,
  sort: number,
  formula: string,
) {
  fields.push({
    collection: C,
    field,
    type: 'decimal',
    meta: {
      ...baseMeta(field, sort, {
        hidden: false,
        interface: 'queryable-formula',
        options: { formula },
        special: null,
      }),
    },
    schema: baseSchema(field, {
      data_type: 'numeric',
      numeric_precision: 10,
      numeric_scale: 5,
      is_nullable: true,
    }),
  });
}

sliderScore('communication_skills_score', 24);
readonlyWeight('communication_skills_weight', 25, 6);
weightedFormula(
  'communication_skills_weighted_score',
  26,
  '{{communication_skills_score}}/5*6',
);

sliderScore('technical_skills_score', 27);
readonlyWeight('technical_skills_weight', 28, 6);
weightedFormula(
  'technical_skills_weighted_score',
  29,
  '{{technical_skills_score}}/5*6',
);

sliderScore('cognitive_functioning_score', 30);
readonlyWeight('cognitive_functioning_weight', 31, 7);
weightedFormula(
  'cognitive_functioning_weighted_score',
  32,
  '{{cognitive_functioning_score}}/5*7',
);

sliderScore('mobility_score', 33);
readonlyWeight('mobility_weight', 34, 6);
weightedFormula('mobility_weighted_score', 35, '{{mobility_score}}/5*6');

sliderScore('dexterity_score', 36);
readonlyWeight('dexterity_weight', 37, 6);
weightedFormula('dexterity_weighted_score', 38, '{{dexterity_score}}/5*6');

sliderScore('strength_score', 39);
readonlyWeight('strength_weight', 40, 7);
weightedFormula('strength_weighted_score', 41, '{{strength_score}}/5*7');

sliderScore('independence_score', 42);
readonlyWeight('independence_weight', 43, 7);
weightedFormula(
  'independence_weighted_score',
  44,
  '{{independence_score}}/5*7',
);

fields.push({
  collection: C,
  field: 'section_5_subtotal',
  type: 'decimal',
  meta: {
    ...baseMeta('section_5_subtotal', 45, {
      hidden: false,
      interface: 'queryable-formula',
      note: null,
      options: {
        formula:
          'COALESCE({{communication_skills_score}}, 0) / 5 * 6 +\nCOALESCE({{technical_skills_score}}, 0) / 5 * 6 +\nCOALESCE({{cognitive_functioning_score}}, 0) / 5 * 7 +\nCOALESCE({{mobility_score}}, 0) / 5 * 6 +\nCOALESCE({{dexterity_score}}, 0) / 5 * 6 +\nCOALESCE({{strength_score}}, 0) / 5 * 7 +\nCOALESCE({{independence_score}}, 0) / 5 * 7',
      },
      special: null,
    }),
  },
  schema: baseSchema('section_5_subtotal', {
    data_type: 'numeric',
    numeric_precision: 10,
    numeric_scale: 5,
    is_nullable: true,
  }),
});

fields.push({
  collection: C,
  field: 'section_5_remarks',
  type: 'text',
  meta: baseMeta('section_5_remarks', 46, {
    hidden: false,
    interface: 'input-multiline',
    special: null,
  }),
  schema: baseSchema('section_5_remarks', {
    data_type: 'text',
    is_nullable: true,
  }),
});

fields.push({
  collection: C,
  field: 'divider_section_6',
  type: 'alias',
  meta: {
    ...baseMeta('divider_section_6', 47, {
      hidden: false,
      interface: 'presentation-divider',
      options: { title: 'Section 6 — Psychosocial & Motivation' },
      special: ['alias', 'no-data'],
    }),
  },
});

sliderScore('social_interaction_score', 48);
readonlyWeight('social_interaction_weight', 49, 7);
weightedFormula(
  'social_interaction_weighted_score',
  50,
  '{{social_interaction_score}}/5*7',
);

sliderScore('motivation_work_interest_score', 51);
readonlyWeight('motivation_work_interest_weight', 52, 8);
weightedFormula(
  'motivation_work_interest_weighted_score',
  53,
  '{{motivation_work_interest_score}}/5*8',
);

fields.push({
  collection: C,
  field: 'section_6_subtotal',
  type: 'decimal',
  meta: {
    ...baseMeta('section_6_subtotal', 54, {
      hidden: false,
      interface: 'queryable-formula',
      options: {
        formula:
          'COALESCE({{social_interaction_score}},0)/5*7 +\nCOALESCE({{motivation_work_interest_score}},0)/5*8',
      },
      special: null,
    }),
  },
  schema: baseSchema('section_6_subtotal', {
    data_type: 'numeric',
    numeric_precision: 10,
    numeric_scale: 5,
    is_nullable: true,
  }),
});

fields.push({
  collection: C,
  field: 'section_6_remarks',
  type: 'text',
  meta: baseMeta('section_6_remarks', 55, {
    hidden: false,
    interface: 'input-multiline',
    special: null,
  }),
  schema: baseSchema('section_6_remarks', {
    data_type: 'text',
    is_nullable: true,
  }),
});

fields.push({
  collection: C,
  field: 'divider_section_7',
  type: 'alias',
  meta: {
    ...baseMeta('divider_section_7', 56, {
      hidden: false,
      interface: 'presentation-divider',
      options: { title: 'Section 7 — Workplace Support Needs' },
      special: ['alias', 'no-data'],
    }),
  },
});

function needsSelect(field: string, sort: number, note: string) {
  fields.push({
    collection: C,
    field,
    type: 'integer',
    meta: {
      ...baseMeta(field, sort, {
        hidden: false,
        interface: 'select-dropdown',
        note,
        options: {
          allowOther: false,
          choices: [
            { text: 'No', value: 5 },
            { text: 'Minor', value: 4 },
            { text: 'Moderate', value: 3 },
            { text: 'Significant', value: 2 },
            { text: 'Extensive', value: 1 },
          ],
        },
        special: null,
      }),
    },
    schema: baseSchema(field, {
      data_type: 'integer',
      numeric_precision: 32,
      numeric_scale: 0,
      is_nullable: true,
    }),
  });
}

needsSelect(
  'needs_accommodations_score',
  57,
  '5=No; 4=Minor; 3=Moderate; 2=Significant; 1=Extensive',
);
readonlyWeight('needs_accommodations_weight', 58, 7);
weightedFormula(
  'needs_accommodations_weighted_score',
  59,
  '{{needs_accommodations_score}}/5*7',
);

needsSelect(
  'needs_modifications_score',
  60,
  '5=No; 4=Minor; 3=Moderate; 2=Significant; 1=Extensive',
);
readonlyWeight('needs_modifications_weight', 61, 8);
weightedFormula(
  'needs_modifications_weighted_score',
  62,
  '{{needs_modifications_score}}/5*8',
);

fields.push({
  collection: C,
  field: 'section_7_subtotal',
  type: 'decimal',
  meta: {
    ...baseMeta('section_7_subtotal', 63, {
      hidden: false,
      interface: 'queryable-formula',
      options: {
        formula:
          'COALESCE({{needs_accommodations_score}},0)/5*7 +\nCOALESCE({{needs_modifications_score}},0)/5*8',
      },
      special: null,
    }),
  },
  schema: baseSchema('section_7_subtotal', {
    data_type: 'numeric',
    numeric_precision: 10,
    numeric_scale: 5,
    is_nullable: true,
  }),
});

fields.push({
  collection: C,
  field: 'section_7_remarks',
  type: 'text',
  meta: baseMeta('section_7_remarks', 64, {
    hidden: false,
    interface: 'input-multiline',
    special: null,
  }),
  schema: baseSchema('section_7_remarks', {
    data_type: 'text',
    is_nullable: true,
  }),
});

fields.push({
  collection: C,
  field: 'divider_summary',
  type: 'alias',
  meta: {
    ...baseMeta('divider_summary', 65, {
      hidden: false,
      interface: 'presentation-divider',
      options: { title: 'Summary & Readiness' },
      special: ['alias', 'no-data'],
    }),
  },
});

fields.push({
  collection: C,
  field: 'total_score',
  type: 'decimal',
  meta: {
    ...baseMeta('total_score', 66, {
      hidden: false,
      interface: 'queryable-formula',
      options: {
        formula:
          '(COALESCE({{needs_accommodations_score}},0)*7 +\nCOALESCE({{needs_modifications_score}},0)*8 +\nCOALESCE({{social_interaction_score}},0)*7 +\nCOALESCE({{motivation_work_interest_score}},0)*8 +\nCOALESCE({{communication_skills_score}},0)*6 +\nCOALESCE({{technical_skills_score}},0)*6 +\nCOALESCE({{cognitive_functioning_score}},0)*7 +\nCOALESCE({{mobility_score}},0)*6 +\nCOALESCE({{dexterity_score}},0)*6 +\nCOALESCE({{strength_score}},0)*7 +\nCOALESCE({{independence_score}},0)*7\n)/5\n+\nCOALESCE({{education_level_score}},0)/10*7\n+\nCOALESCE({{employment_experience_score}},0)/5*8',
      },
      special: null,
    }),
  },
  schema: baseSchema('total_score', {
    data_type: 'numeric',
    numeric_precision: 10,
    numeric_scale: 5,
    is_nullable: true,
  }),
});

fields.push({
  collection: C,
  field: 'readiness_category',
  type: 'string',
  meta: {
    ...baseMeta('readiness_category', 67, {
      hidden: false,
      display: null,
      interface: 'queryable-formula',
      readonly: true,
      note: '70-100=Highly Work-Ready; 50-69=Work-Ready (Supported); 35-49=Partially Ready; <35=Needs Development',
      options: {
        formula:
          'IF({{total_score}} > 70, \"Highly Work Ready\", IF({{total_score}} >= 50, \"Work-Ready / Supported\", IF({{total_score}} >= 35, \"Partially Ready\", \"Needs Development\")))',
      },
      special: null,
    }),
  },
  schema: baseSchema('readiness_category', {
    data_type: 'character varying',
    max_length: 255,
    is_nullable: true,
  }),
});

fields.push({
  collection: C,
  field: 'comments_recommendations',
  type: 'text',
  meta: baseMeta('comments_recommendations', 68, {
    hidden: false,
    interface: 'input-multiline',
    special: null,
  }),
  schema: baseSchema('comments_recommendations', {
    data_type: 'text',
    is_nullable: true,
  }),
});

const bySort = [...fields].sort(
  (a, b) => (a.meta as Meta).sort - (b.meta as Meta).sort,
);
const out = join(dirname(fileURLToPath(import.meta.url)), 'de-weighted-assessments-fields.json');
writeFileSync(out, JSON.stringify(bySort, null, 2) + '\n', 'utf8');
console.log(`Wrote ${bySort.length} fields → ${out}`);
