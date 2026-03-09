Here's the complete reference of everything available in the formula engine we built:

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

Use `{{field_name}}` to reference any field **on the same item**:

```text
{{price}}           → numeric field
{{first_name}}      → string field
{{is_active}}       → boolean field
{{created_date}}    → date field (treated as string)
```

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

---

## What's NOT Supported

These are **not** currently implemented:

| Feature                                | Notes                                                |
| -------------------------------------- | ---------------------------------------------------- |
| Relational lookups                     | Can't do `{{category.name}}` — only same-item fields |
| Aggregations                           | No `SUM()` / `AVG()` across related items            |
| `LENGTH()`, `SUBSTRING()`, `REPLACE()` | String manipulation beyond CONCAT/UPPER/LOWER/TRIM   |
| `MIN()`, `MAX()`, `ABS()`, `POWER()`   | Extended math                                        |
| `DATE_DIFF()`, `DATE_ADD()`            | Date arithmetic                                      |
| Regex                                  | No pattern matching                                  |
