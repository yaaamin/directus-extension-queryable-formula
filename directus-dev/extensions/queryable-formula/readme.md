# Queryable Formula — Directus Extension

A computed field extension for Directus that stores formula results in the database, making them queryable, sortable, and filterable. Includes a visual formula builder, relational field lookups, scheduled recalculation, and a force-recalculate button.

---

Here's the complete reference of everything available in the formula engine:

---

## Arithmetic Operators

| Operator | Description        | Example                                |
| -------- | ------------------ | -------------------------------------- |
| `+`      | Addition           | `{{price}} + {{tax}}`                  |
| `-`      | Subtraction        | `{{total}} - {{discount}}`             |
| `*`      | Multiplication     | `{{price}} * {{quantity}}`             |
| `/`      | Division           | `{{total}} / {{count}}`                |
| `%`      | Modulo (remainder) | `{{number}} % 2`                       |
| `()`     | Grouping           | `({{price}} + {{tax}}) * {{quantity}}` |

You can chain them freely:

```text
({{base_price}} * {{quantity}}) - {{discount}} + {{shipping}}
```

---

## Comparison Operators

Used inside `IF()`:

| Operator | Description      | Example inside IF                 |
| -------- | ---------------- | --------------------------------- |
| `==`     | Equal            | `IF({{status}} == "active", ...)` |
| `!=`     | Not equal        | `IF({{type}} != "free", ...)`     |
| `>`      | Greater than     | `IF({{age}} > 18, ...)`           |
| `<`      | Less than        | `IF({{stock}} < 10, ...)`         |
| `>=`     | Greater or equal | `IF({{score}} >= 50, ...)`        |
| `<=`     | Less or equal    | `IF({{price}} <= 100, ...)`       |

---

## Logical Operators

| Operator | Description | Example                                                  |
| -------- | ----------- | -------------------------------------------------------- |
| `&&`     | AND         | `IF({{age}} > 18 && {{verified}} == true, ...)`          |
| `\|\|`   | OR          | `IF({{role}} == "admin" \|\| {{role}} == "editor", ...)` |

---

## String Functions

| Function            | Description                      | Example                                      | Result               |
| ------------------- | -------------------------------- | -------------------------------------------- | -------------------- |
| `CONCAT(a, b, ...)` | Join values together             | `CONCAT({{first_name}}, " ", {{last_name}})` | `"John Doe"`         |
| `UPPER(a)`          | Uppercase                        | `UPPER({{name}})`                            | `"JOHN"`             |
| `LOWER(a)`          | Lowercase                        | `LOWER({{email}})`                           | `"john@example.com"` |
| `TRIM(a)`           | Remove whitespace from both ends | `TRIM({{input}})`                            | `"hello"`            |

Nesting works:

```text
UPPER(CONCAT({{first_name}}, " ", {{last_name}}))
→ "JOHN DOE"

CONCAT(UPPER({{first_name}}), " ", LOWER({{last_name}}))
→ "JOHN doe"
```

---

## Math Functions

| Function                 | Description               | Example                     | Result         |
| ------------------------ | ------------------------- | --------------------------- | -------------- |
| `ROUND(value)`           | Round to nearest integer  | `ROUND({{price}} * 1.1)`    | `11`           |
| `ROUND(value, decimals)` | Round to N decimal places | `ROUND({{price}} * 1.1, 2)` | `11.05`        |
| `FLOOR(value)`           | Round down                | `FLOOR({{rating}})`         | `4` (from 4.7) |
| `CEIL(value)`            | Round up                  | `CEIL({{rating}})`          | `5` (from 4.2) |

---

## Logic Functions

### IF(condition, then, else)

```text
IF({{stock}} > 0, "In Stock", "Out of Stock")

IF({{price}} > 100, {{price}} * 0.9, {{price}})

IF({{type}} == "premium", {{price}} * 1.5, {{price}})
```

Nested IFs:

```text
IF({{score}} >= 90, "A", IF({{score}} >= 80, "B", IF({{score}} >= 70, "C", "F")))
```

### COALESCE(a, b, ...)

Returns the **first non-null** value:

```text
COALESCE({{nickname}}, {{first_name}}, "Unknown")
```

If `nickname` is null but `first_name` is "John" → returns `"John"`.

---

## Date Functions

| Function | Description           | Example | Result                       |
| -------- | --------------------- | ------- | ---------------------------- |
| `NOW()`  | Current ISO timestamp | `NOW()` | `"2026-09-03T10:00:00.000Z"` |

---

## Literal Values

| Type    | Syntax               | Example                                 |
| ------- | -------------------- | --------------------------------------- |
| String  | `"text"` or `'text'` | `CONCAT({{name}}, " - ", "active")`     |
| Number  | `123`, `45.67`       | `{{price}} * 1.15`                      |
| Boolean | `true` / `false`     | `IF({{active}} == true, ...)`           |
| Null    | `null`               | `COALESCE({{field}}, null, "fallback")` |

---

## Field References

### Local Fields

Use `{{field_name}}` to reference any field **on the same item**:

```text
{{price}}           → numeric field
{{first_name}}      → string field
{{is_active}}       → boolean field
{{created_date}}    → date field (treated as string)
```

### Relational Fields (M2O Lookups)

Use `{{relation.field}}` to pull a value from a **related item** via a Many-to-One relationship. The engine automatically resolves the foreign key, finds the related table and primary key via the Directus schema, and fetches the value.

```text
{{category.name}}       → string field from the related "categories" table
{{author.email}}        → string field from the related "users" table
{{supplier.country}}    → string field from the related "suppliers" table
```

How it works:

1. `category` is the **local FK field** on the current item (stores a foreign key like `3`)
2. `.name` is the **field on the related table** to read
3. The engine looks up the relation in the Directus schema, queries the related table for the record matching the FK, and returns the `name` column

You can use relational refs anywhere you'd use a normal field:

```text
CONCAT({{name}}, " — ", {{category.name}})
→ "Widget Pro — Electronics"

IF({{category.type}} == "premium", {{price}} * 1.2, {{price}})
→ applies a 20% markup for premium categories

CONCAT({{author.first_name}}, " ", {{author.last_name}})
→ "Jane Smith"

UPPER({{supplier.country}})
→ "GERMANY"
```

> **Note:** Only M2O (Many-to-One) relations are supported. You can traverse one level deep — `{{relation.field}}` — but not nested relations like `{{relation.other_relation.field}}`.

---

## Real-World Examples

**E-commerce — line total:**

```text
ROUND({{unit_price}} * {{quantity}} * (1 - {{discount_pct}} / 100), 2)
```

**Full name:**

```text
CONCAT({{first_name}}, " ", {{last_name}})
```

**Display label with status:**

```text
CONCAT({{name}}, " (", UPPER({{status}}), ")")
→ "Widget Pro (ACTIVE)"
```

**Price tier:**

```text
IF({{price}} >= 1000, "Premium", IF({{price}} >= 100, "Standard", "Budget"))
```

**Stock status with quantity:**

```text
IF({{stock}} > 50, CONCAT("In Stock (", {{stock}}, ")"), IF({{stock}} > 0, "Low Stock", "Out of Stock"))
```

**Percentage:**

```text
CONCAT(ROUND({{completed}} / {{total}} * 100, 1), "%")
→ "73.5%"
```

**Fallback chain:**

```text
COALESCE({{display_name}}, CONCAT({{first_name}}, " ", {{last_name}}), {{email}}, "Anonymous")
```

**Product with category label (relational):**

```text
CONCAT({{name}}, " [", UPPER({{category.name}}), "]")
→ "Widget Pro [ELECTRONICS]"
```

**Order total with tax rate from related region:**

```text
ROUND({{subtotal}} * (1 + {{region.tax_rate}} / 100), 2)
→ 107.50 (if subtotal=100, region.tax_rate=7.5)
```

**Author display name with fallback:**

```text
COALESCE({{author.display_name}}, CONCAT({{author.first_name}}, " ", {{author.last_name}}), "Unknown Author")
```

---

## Force Recalculate

Each formula field includes a **"Recalculate All"** button on the item detail page. Clicking it triggers a full recalculation of every row in the collection for that field via a REST API call.

- **Endpoint:** `POST /queryable-formula/recalculate`
- **Body:** `{ "collection": "products", "field": "total_price" }` (field is optional — omit to recalculate all formula fields in the collection)
- **Auth:** Admin access required
- **Response:** `{ "updated": 42, "collection": "products", "field": "total_price" }`

You can also check which formula fields exist:

- **Endpoint:** `GET /queryable-formula/status`
- **Response:** `{ "fields": [{ "collection": "products", "field": "total_price", "formula": "...", "cronSchedule": "*/15 * * * *" }] }`

---

## Scheduled Recalculation (CRON)

You can configure a **cron schedule** per formula field to automatically recalculate all values at a regular interval. This is useful for formulas that reference `NOW()` or relational data that may change without triggering a direct update.

Set the cron expression in the field configuration panel under **"Scheduled Recalculation"**. Preset buttons are provided for common intervals:

| Preset         | Cron Expression | Interval   |
| -------------- | --------------- | ---------- |
| Every 5 min    | `*/5 * * * *`   | 5 minutes  |
| Every 15 min   | `*/15 * * * *`  | 15 minutes |
| Hourly         | `0 * * * *`     | 1 hour     |
| Daily midnight | `0 0 * * *`     | 24 hours   |
| Weekly (Sun)   | `0 0 * * 0`     | 7 days     |

Leave the field empty to disable scheduling. Schedules are picked up on server startup and refresh automatically when you create or update a formula field.

---

## What's NOT Supported

These are **not** currently implemented:

| Feature                                | Notes                                                     |
| -------------------------------------- | --------------------------------------------------------- |
| Nested relational lookups              | Can't do `{{category.parent.name}}` — only one level deep |
| O2M / M2M relational lookups           | Only M2O (Many-to-One) relations are supported            |
| Aggregations                           | No `SUM()` / `AVG()` across related items                 |
| `LENGTH()`, `SUBSTRING()`, `REPLACE()` | String manipulation beyond CONCAT/UPPER/LOWER/TRIM        |
| `MIN()`, `MAX()`, `ABS()`, `POWER()`   | Extended math                                             |
| `DATE_DIFF()`, `DATE_ADD()`            | Date arithmetic                                           |
| Regex                                  | No pattern matching                                       |
