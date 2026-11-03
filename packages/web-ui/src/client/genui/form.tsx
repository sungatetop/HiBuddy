/**
 * `form` surface: structured user input collected in-chat (FR-04).
 *
 * props: { fields: [{ id, label, type: "text"|"number"|"select"|"checkbox",
 *          required?, options?, placeholder? }], submitLabel?, description? }
 * data:  {} (unused)
 *
 * S4-3 scope: render + validation + local confirmation of collected values.
 * S4-5 wires the submission into the conversation as a structured upstream
 * message (A4 交互回传). All values are plain controlled React state — model
 * text never becomes markup (SR-02).
 */
import { useState, type CSSProperties, type ReactNode } from 'react'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import { asArray, asRecord, asString, optionalString } from './guards.ts'
import type { UiSurfaceProps } from './registry.ts'

interface FieldSpec {
  id: string
  label: string
  type: 'text' | 'number' | 'select' | 'checkbox'
  required?: boolean
  options?: ReadonlyArray<string>
  placeholder?: string
}

/** Validate the instruction against the form contract; throw on mismatch. */
function parseForm({ instruction }: UiSurfaceProps): { fields: ReadonlyArray<FieldSpec>, submitLabel: string, description?: string } {
  const p = asRecord(instruction.props)
  const fields = asArray(p.fields).map((entry) => {
    const record = asRecord(entry)
    const type = asString(record.type)
    const kind = type === 'number' || type === 'select' || type === 'checkbox' ? type : 'text'
    const spec: FieldSpec = {
      id: asString(record.id),
      label: asString(record.label ?? record.id),
      type: kind,
      required: record.required === true,
      options: record.options === undefined ? undefined : asArray(record.options).map(asString),
      placeholder: optionalString(record.placeholder),
    }
    if (spec.type === 'select' && (spec.options === undefined || spec.options.length === 0)) {
      throw new TypeError(`select field "${spec.id}" needs non-empty options`)
    }
    return spec
  })
  if (fields.length === 0) throw new TypeError('fields must be non-empty')
  return {
    fields,
    submitLabel: optionalString(p.submitLabel) ?? '提交',
    description: optionalString(p.description),
  }
}

const styles = {
  root: { display: 'grid', gap: 10 } satisfies CSSProperties,
  description: { margin: 0, fontSize: 12, lineHeight: 1.6, color: 'var(--dsw-alias-label-tertiary)' } satisfies CSSProperties,
  field: { display: 'grid', gap: 4 } satisfies CSSProperties,
  label: { fontSize: 12, color: 'var(--dsw-alias-label-secondary)', lineHeight: 1.4 } satisfies CSSProperties,
  control: {
    width: '100%',
    boxSizing: 'border-box' as const,
    padding: '6px 10px',
    border: '1px solid var(--dsw-specific-input-major)',
    borderRadius: 8,
    background: 'transparent',
    color: 'inherit',
    font: 'inherit',
    fontSize: 13,
    lineHeight: 1.5,
  } satisfies CSSProperties,
  check: { display: 'flex', alignItems: 'center', gap: 8, fontSize: 13 } satisfies CSSProperties,
  actions: { display: 'flex', justifyContent: 'flex-end' } satisfies CSSProperties,
  note: { margin: 0, fontSize: 12, lineHeight: 1.6, color: 'var(--dsw-alias-state-warn-primary)' } satisfies CSSProperties,
  filled: { margin: '2px 0 0', fontSize: 12, color: 'var(--dsw-alias-label-tertiary)' } satisfies CSSProperties,
  raw: {
    margin: 0,
    padding: '8px 10px',
    border: '1px solid var(--dsw-specific-input-major)',
    borderRadius: 8,
    maxHeight: 180,
    overflow: 'auto',
    fontFamily: 'var(--ds-font-family-code)',
    fontSize: 12,
    lineHeight: 1.5,
    whiteSpace: 'pre-wrap' as const,
    wordBreak: 'break-all',
  } satisfies CSSProperties,
}

/** Current values bag: text/number/select as string, checkbox as boolean. */
type FormValues = Record<string, string | boolean>

/** Whether every required field carries a non-empty value. */
function validValues(fields: ReadonlyArray<FieldSpec>, values: FormValues): boolean {
  return fields.every((field) => {
    if (!field.required) return true
    const value = values[field.id]
    return field.type === 'checkbox' ? value === true : typeof value === 'string' && value.trim().length > 0
  })
}

/** The registered `form` surface (submission wiring lands in S4-5). */
export function FormSurface(props: UiSurfaceProps): ReactNode {
  const { instruction, t } = props
  const { fields, submitLabel, description } = parseForm(props)
  const [values, setValues] = useState<FormValues>({})
  const [requiredNote, setRequiredNote] = useState(false)
  const [submitted, setSubmitted] = useState<FormValues | undefined>(undefined)
  const set = (id: string, value: string | boolean): void => {
    setRequiredNote(false)
    setValues((previous) => ({ ...previous, [id]: value }))
  }
  const onSubmit = (): void => {
    if (!validValues(fields, values)) {
      setRequiredNote(true)
      return
    }
    setSubmitted({ ...values })
  }
  return (
    <form
      data-hibuddy-genui-surface="form"
      style={styles.root}
      onSubmit={(event) => {
        event.preventDefault()
        onSubmit()
      }}
    >
      {description !== undefined && <p style={styles.description}>{description}</p>}
      {fields.map((field) => {
        const value = values[field.id]
        const commonId = `hibuddy-genui-field-${field.id}`
        return (
          <div key={field.id} style={styles.field}>
            {field.type === 'checkbox'
              ? (
                  <label style={styles.check} htmlFor={commonId}>
                    <input
                      id={commonId}
                      type="checkbox"
                      checked={value === true}
                      onChange={(event) => set(field.id, event.target.checked)}
                    />
                    <span>{field.label}{field.required && ' *'}</span>
                  </label>
                )
              : (
                  <>
                    <label style={styles.label} htmlFor={commonId}>
                      {field.label}
                      {field.required && ' *'}
                    </label>
                    {field.type === 'select'
                      ? (
                          <select
                            id={commonId}
                            style={styles.control}
                            value={typeof value === 'string' ? value : ''}
                            onChange={(event) => set(field.id, event.target.value)}
                          >
                            <option value="">—</option>
                            {(field.options ?? []).map((option) => (
                              <option key={option} value={option}>{option}</option>
                            ))}
                          </select>
                        )
                      : (
                          <input
                            id={commonId}
                            style={styles.control}
                            type={field.type === 'number' ? 'number' : 'text'}
                            placeholder={field.placeholder}
                            value={typeof value === 'string' ? value : ''}
                            onChange={(event) => set(field.id, event.target.value)}
                          />
                        )}
                  </>
                )}
          </div>
        )
      })}
      {requiredNote && <p style={styles.note}>{t('formRequired')}</p>}
      <div style={styles.actions}>
        <Button variant="primary" onClick={onSubmit}>{submitLabel}</Button>
      </div>
      {submitted !== undefined && (
        <div style={{ display: 'grid', gap: 4 }}>
          <div style={styles.filled}>{t('formFilled')}</div>
          <pre style={styles.raw}>{JSON.stringify(submitted, null, 2)}</pre>
        </div>
      )}
    </form>
  )
}
