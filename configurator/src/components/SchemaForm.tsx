import type { ReactNode } from "react";
import { Plus, Trash2 } from "./icons";
import { ChipsInput, Field, JsonEditor, NumberInput, SegmentedControl, Toggle } from "./ui";

type Schema = Record<string, any>;

function primaryType(schema: Schema | undefined): string | undefined {
  if (!schema) return undefined;
  if (Array.isArray(schema.enum)) return "enum";
  if ("const" in schema) return "const";
  const types = Array.isArray(schema.type) ? schema.type.filter((t: string) => t !== "null") : [schema.type];
  if (types.length !== 1) return undefined;
  if (types[0] === "object" && !schema.properties) return undefined;
  return types[0];
}

/** Whether a schema can be edited as a form: an object whose properties are described. */
export function supportsForm(schema: unknown): boolean {
  const s = schema as Schema | undefined;
  return !!s && primaryType(s) === "object" && !s.oneOf && !s.anyOf && !s.allOf && !s.$ref;
}

/** Client-side hints only; the API validates the full schema on submit. */
export function fieldProblem(schema: Schema, value: unknown, required: boolean): string | undefined {
  const empty = value === undefined || value === "" || (Array.isArray(value) && value.length === 0);
  if (empty) return required ? "Required." : undefined;
  if (typeof value === "string") {
    if (typeof schema.minLength === "number" && value.length < schema.minLength) return `At least ${schema.minLength} characters.`;
    if (typeof schema.maxLength === "number" && value.length > schema.maxLength) return `At most ${schema.maxLength.toLocaleString()} characters.`;
    if (typeof schema.pattern === "string") {
      try {
        if (!new RegExp(schema.pattern, "u").test(value)) return `Must match ${schema.pattern}`;
      } catch {
        // Patterns the browser cannot compile are checked by the API.
      }
    }
  }
  if (typeof value === "number") {
    if (typeof schema.minimum === "number" && value < schema.minimum) return `Minimum ${schema.minimum}.`;
    if (typeof schema.maximum === "number" && value > schema.maximum) return `Maximum ${schema.maximum}.`;
    if (schema.type === "integer" && !Number.isInteger(value)) return "Must be a whole number.";
  }
  if (Array.isArray(value)) {
    if (typeof schema.minItems === "number" && value.length < schema.minItems) return `At least ${schema.minItems} item(s).`;
    if (typeof schema.maxItems === "number" && value.length > schema.maxItems) return `At most ${schema.maxItems} item(s).`;
  }
  return undefined;
}

function isEmptyObject(value: unknown): boolean {
  return !!value && typeof value === "object" && !Array.isArray(value) && Object.keys(value).length === 0;
}

/** Renders an input form from a JSON Schema object. Unsupported fields fall back to an inline JSON editor. */
export function SchemaForm({ schema, value, onChange }: { schema: Schema; value: unknown; onChange: (value: unknown) => void }) {
  const properties = Object.keys(schema.properties ?? {});
  if (properties.length === 0) return <p className="text-xs fg-muted">This harness takes no input fields.</p>;
  return <ObjectFields schema={schema} value={value} onChange={onChange} />;
}

function ObjectFields({ schema, value, onChange }: { schema: Schema; value: unknown; onChange: (value: Record<string, unknown>) => void }) {
  const current = value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
  const required = new Set<string>(schema.required ?? []);
  return (
    <div className="space-y-4">
      {Object.entries<Schema>(schema.properties ?? {}).map(([key, child]) => (
        <SchemaField
          key={key}
          name={key}
          schema={child ?? {}}
          required={required.has(key)}
          value={current[key]}
          onChange={(next) => {
            const updated = { ...current };
            if (next === undefined) delete updated[key];
            else updated[key] = next;
            onChange(updated);
          }}
        />
      ))}
    </div>
  );
}

function constraints(schema: Schema): string | undefined {
  const parts: string[] = [];
  if (typeof schema.maxLength === "number") parts.push(`max ${schema.maxLength.toLocaleString()} chars`);
  if (typeof schema.minimum === "number") parts.push(`min ${schema.minimum}`);
  if (typeof schema.maximum === "number") parts.push(`max ${schema.maximum}`);
  if (typeof schema.maxItems === "number") parts.push(`up to ${schema.maxItems} items`);
  if (typeof schema.format === "string") parts.push(schema.format);
  return parts.length ? parts.join(" · ") : undefined;
}

function SchemaField({ name, schema, required, value, onChange }: {
  name: string;
  schema: Schema;
  required: boolean;
  value: unknown;
  onChange: (value: unknown) => void;
}) {
  const type = primaryType(schema);
  const label = `${schema.title ?? name}${required ? "" : " (optional)"}`;
  const description = [schema.description, constraints(schema)].filter(Boolean).join(" — ") || undefined;
  const problem = type === "object" ? undefined : fieldProblem(schema, value, required);
  const field = (control: ReactNode, error = problem) => (
    <Field label={label} hint={description} error={error}>
      {control}
    </Field>
  );
  const optional = (next: unknown) => (!required && (next === "" || next === undefined || (Array.isArray(next) && next.length === 0)) ? undefined : next);

  switch (type) {
    case "const":
      return field(<code className="text-xs">{JSON.stringify(schema.const)}</code>, undefined);
    case "enum": {
      const options: unknown[] = schema.enum;
      if (options.every((o) => typeof o === "string") && options.length <= 4) {
        return field(
          <div>
            <SegmentedControl
              label={label}
              value={typeof value === "string" ? value : ""}
              onChange={(next) => onChange(optional(next))}
              options={[...(required ? [] : [{ value: "", label: "None" }]), ...(options as string[]).map((o) => ({ value: o, label: o }))]}
            />
          </div>,
        );
      }
      return field(
        <select
          className="input"
          value={value === undefined ? "" : JSON.stringify(value)}
          onChange={(e) => onChange(e.target.value === "" ? undefined : JSON.parse(e.target.value))}
        >
          <option value="">{required ? "Choose…" : "None"}</option>
          {options.map((o) => (
            <option key={JSON.stringify(o)} value={JSON.stringify(o)}>
              {String(o)}
            </option>
          ))}
        </select>,
      );
    }
    case "string": {
      const text = typeof value === "string" ? value : "";
      const inputType = schema.format === "date" ? "date" : schema.format === "email" ? "email" : schema.format === "uri" ? "url" : undefined;
      const multiline = !inputType && (schema.maxLength === undefined || schema.maxLength > 200);
      return field(
        multiline ? (
          <textarea
            className="input"
            rows={Math.min(10, Math.max(3, text.split("\n").length + 1))}
            value={text}
            aria-label={label}
            onChange={(e) => onChange(optional(e.target.value))}
          />
        ) : (
          <input className="input" type={inputType ?? "text"} value={text} aria-label={label} onChange={(e) => onChange(optional(e.target.value))} />
        ),
      );
    }
    case "number":
    case "integer":
      return field(
        <NumberInput
          value={typeof value === "number" ? value : Number.NaN}
          min={schema.minimum}
          max={schema.maximum}
          step={type === "integer" ? 1 : "any"}
          onChange={(next) => onChange(Number.isFinite(next) ? next : undefined)}
        />,
      );
    case "boolean":
      return (
        <Toggle
          checked={value === true}
          label={label}
          description={description}
          onChange={(checked) => onChange(checked || required ? checked : undefined)}
        />
      );
    case "object":
      return (
        <fieldset className="rounded-md border border-default p-3">
          <legend className="px-1 text-sm font-semibold">{label}</legend>
          {description && <p className="-mt-1 mb-3 text-xs fg-muted">{description}</p>}
          <ObjectFields schema={schema} value={value} onChange={(next) => onChange(!required && isEmptyObject(next) ? undefined : next)} />
        </fieldset>
      );
    case "array":
      return <ArrayField label={label} description={description} schema={schema} value={value} problem={problem} onChange={(next) => onChange(optional(next))} />;
    default:
      return field(<InlineJson value={value} onChange={onChange} />, undefined);
  }
}

function ArrayField({ label, description, schema, value, problem, onChange }: {
  label: string;
  description?: string;
  schema: Schema;
  value: unknown;
  problem?: string;
  onChange: (value: unknown[]) => void;
}) {
  const items: unknown[] = Array.isArray(value) ? value : [];
  const itemSchema: Schema = schema.items ?? {};
  const itemType = primaryType(itemSchema);

  if (itemType === "string" || itemType === "number" || itemType === "integer") {
    const numeric = itemType !== "string";
    return (
      <Field label={label} hint={description ?? "Press Enter after each value."} error={problem}>
        <ChipsInput
          values={items.map(String)}
          pattern={numeric ? (itemType === "integer" ? /^-?\d+$/ : /^-?\d+(\.\d+)?$/) : undefined}
          placeholder="Type a value and press Enter"
          onChange={(values) => onChange(numeric ? values.map(Number) : values)}
        />
      </Field>
    );
  }

  if (itemType === "enum" && (itemSchema.enum as unknown[]).every((o) => typeof o === "string")) {
    const options = itemSchema.enum as string[];
    return (
      <Field label={label} hint={description} error={problem}>
        <div className="flex flex-wrap gap-2" role="group" aria-label={label}>
          {options.map((option) => (
            <label key={option} className="badge cursor-pointer !py-0.5">
              <input
                type="checkbox"
                className="h-3 w-3"
                checked={items.includes(option)}
                onChange={(e) => onChange(e.target.checked ? [...items, option] : items.filter((i) => i !== option))}
              />
              {option}
            </label>
          ))}
        </div>
      </Field>
    );
  }

  if (itemType === "object") {
    return (
      <fieldset className="rounded-md border border-default p-3">
        <legend className="px-1 text-sm font-semibold">{label}</legend>
        {description && <p className="-mt-1 mb-3 text-xs fg-muted">{description}</p>}
        <div className="space-y-3">
          {items.map((item, index) => (
            <div key={index} className="card card-pad">
              <div className="mb-2 flex items-center justify-between">
                <span className="text-xs font-semibold">Item {index + 1}</span>
                <button
                  type="button"
                  className="btn-ghost btn-sm btn-icon"
                  aria-label={`Remove item ${index + 1}`}
                  onClick={() => onChange(items.filter((_, i) => i !== index))}
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              </div>
              <ObjectFields schema={itemSchema} value={item} onChange={(next) => onChange(items.map((v, i) => (i === index ? next : v)))} />
            </div>
          ))}
        </div>
        <button
          type="button"
          className="btn-secondary btn-sm mt-3"
          disabled={typeof schema.maxItems === "number" && items.length >= schema.maxItems}
          onClick={() => onChange([...items, {}])}
        >
          <Plus /> Add item
        </button>
        {problem && <p className="mt-1 text-xs fg-danger">{problem}</p>}
      </fieldset>
    );
  }

  return (
    <Field label={label} hint={description ? `${description} (edited as JSON)` : "Edited as JSON."} error={problem}>
      <InlineJson value={value ?? []} onChange={(next) => onChange(next as unknown[])} />
    </Field>
  );
}

function InlineJson({ value, onChange }: { value: unknown; onChange: (value: unknown) => void }) {
  const rows = Math.min(12, Math.max(4, JSON.stringify(value ?? null, null, 2).split("\n").length));
  return <JsonEditor rows={rows} value={value ?? null} onChange={onChange} />;
}
