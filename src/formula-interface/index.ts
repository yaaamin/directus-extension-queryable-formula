import { defineInterface } from "@directus/extensions-sdk";
import InterfaceComponent from "./interface.vue";

export default defineInterface({
  id: "queryable-formula",
  name: "Queryable Formula",
  icon: "functions",
  description:
    "A computed field whose value is stored in the DB and can be queried/filtered.",
  component: InterfaceComponent,
  types: ["string", "integer", "float", "bigInteger", "decimal"],
  group: "standard",
  options: [
    {
      field: "formula",
      name: "Formula Template",
      type: "text",
      meta: {
        interface: "input-multiline",
        width: "full",
        note: 'Use {{field_name}} to reference other fields. Supports: CONCAT, SUM, SUBTRACT, MULTIPLY, DIVIDE, UPPER, LOWER, TRIM, IF, ROUND, FLOOR, CEIL, NOW, COALESCE. Example: {{price}} * {{quantity}} or CONCAT({{first_name}}, " ", {{last_name}})',
        options: {
          placeholder:
            '{{price}} * {{quantity}}  or  CONCAT({{first_name}}, " ", {{last_name}})',
        },
      },
    },
    {
      field: "watchFields",
      name: "Watch Fields",
      type: "csv",
      meta: {
        interface: "tags",
        width: "full",
        note: "List of field names this formula depends on. The formula is recalculated when any of these change. Leave empty to auto-detect from template.",
        options: {
          placeholder: "e.g. price, quantity, first_name",
        },
      },
    },
    {
      field: "prefix",
      name: "Display Prefix",
      type: "string",
      meta: {
        interface: "input",
        width: "half",
        options: {
          placeholder: "e.g. $",
        },
      },
    },
    {
      field: "suffix",
      name: "Display Suffix",
      type: "string",
      meta: {
        interface: "input",
        width: "half",
        options: {
          placeholder: "e.g. USD",
        },
      },
    },
  ],
});
