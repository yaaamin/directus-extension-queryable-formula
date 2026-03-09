import { defineInterface } from "@directus/extensions-sdk";
import InterfaceComponent from "./interface.vue";
import OptionsComponent from "./options.vue";

export default defineInterface({
  id: "queryable-formula",
  name: "Queryable Formula",
  icon: "functions",
  description:
    "A computed field whose value is stored in the DB and can be queried/filtered.",
  component: InterfaceComponent,
  types: ["string", "integer", "float", "bigInteger", "decimal"],
  group: "standard",
  options: OptionsComponent,
});
