export type ValueType = 'f' | 'i' | 'b' | 'ex' | 's' | 'f[]' | 'i[]' | 'c' | '{}'

export type UiWidget = 'number' | 'text' | 'textarea' | 'select' | 'checkbox' | 'folder' | 'numberList' | 'object' | 'hornParts'

export type UiOption = { value: string | number; label: string }

export type ConditionOp = 'eq' | 'neq' | 'in' | 'gt' | 'gte' | 'lt' | 'lte' | 'truthy' | 'falsy' | 'defined' | 'undefined'
export type Condition = { key: string; op: ConditionOp; value?: unknown }

export type ItemSpec = {
  key: string
  label: string
  description?: string
  valueType: ValueType
  units?: string
  default?: unknown
  required?: boolean
  requiredWhen?: Condition[]
  visibleWhen?: Condition[]
  cfg?: { wrap?: { prefix: string; suffix: string } }
  ui: { widget: UiWidget; options?: UiOption[]; placeholder?: string; help?: string; advanced?: boolean }
  children?: string[]
}

export type GroupSpec = { id: string; title: string; items: string[] }
export type SectionSpec = { id: string; title: string; groups: GroupSpec[] }

export type AthUiSchema = {
  schemaVersion: string
  sections: SectionSpec[]
  items: Record<string, ItemSpec>
}
