export type HornPartProfile = {
  Profile: string
  k: number
  s: number
  n: number
  q: number
  a: number
  Length: number
}

export type HornPart = {
  H: HornPartProfile
  V: HornPartProfile
}

export type HornPartsValue = HornPart[]

const defaultProfile: HornPartProfile = {
  Profile: 'OS-SE',
  k: 0.5,
  s: 0.5,
  n: 4,
  q: 0,
  a: 0,
  Length: 50,
}

export const defaultHornPart: HornPart = {
  H: { ...defaultProfile },
  V: { ...defaultProfile },
}

const profileOptions = [
  { value: 'OS-SE', label: 'OS-SE' },
  { value: 'OS', label: 'OS' },
  { value: 'Conical', label: 'Conical' },
]

type ProfileEditorProps = {
  label: string
  profile: HornPartProfile
  onChange: (profile: HornPartProfile) => void
}

function ProfileEditor({ label, profile, onChange }: ProfileEditorProps) {
  const update = <K extends keyof HornPartProfile>(key: K, value: HornPartProfile[K]) => {
    onChange({ ...profile, [key]: value })
  }

  return (
    <div style={{ marginBottom: 12 }}>
      <div style={{ fontSize: 12, color: 'var(--muted)', marginBottom: 6, fontWeight: 500 }}>{label}</div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 8 }}>
        <div>
          <label style={{ fontSize: 11, color: 'var(--muted)' }}>Profile</label>
          <select
            className="select"
            value={profile.Profile}
            onChange={(e) => update('Profile', e.target.value)}
            style={{ width: '100%', padding: '6px 8px', fontSize: 12 }}
          >
            {profileOptions.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {opt.label}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label style={{ fontSize: 11, color: 'var(--muted)' }}>k</label>
          <input
            className="input"
            type="number"
            step="0.1"
            value={profile.k}
            onChange={(e) => update('k', parseFloat(e.target.value) || 0)}
            style={{ width: '100%', padding: '6px 8px', fontSize: 12 }}
          />
        </div>
        <div>
          <label style={{ fontSize: 11, color: 'var(--muted)' }}>s</label>
          <input
            className="input"
            type="number"
            step="0.1"
            value={profile.s}
            onChange={(e) => update('s', parseFloat(e.target.value) || 0)}
            style={{ width: '100%', padding: '6px 8px', fontSize: 12 }}
          />
        </div>
        <div>
          <label style={{ fontSize: 11, color: 'var(--muted)' }}>n</label>
          <input
            className="input"
            type="number"
            step="1"
            value={profile.n}
            onChange={(e) => update('n', parseFloat(e.target.value) || 0)}
            style={{ width: '100%', padding: '6px 8px', fontSize: 12 }}
          />
        </div>
        <div>
          <label style={{ fontSize: 11, color: 'var(--muted)' }}>q</label>
          <input
            className="input"
            type="number"
            step="0.1"
            value={profile.q}
            onChange={(e) => update('q', parseFloat(e.target.value) || 0)}
            style={{ width: '100%', padding: '6px 8px', fontSize: 12 }}
          />
        </div>
        <div>
          <label style={{ fontSize: 11, color: 'var(--muted)' }}>a</label>
          <input
            className="input"
            type="number"
            step="0.1"
            value={profile.a}
            onChange={(e) => update('a', parseFloat(e.target.value) || 0)}
            style={{ width: '100%', padding: '6px 8px', fontSize: 12 }}
          />
        </div>
        <div style={{ gridColumn: 'span 2' }}>
          <label style={{ fontSize: 11, color: 'var(--muted)' }}>Length (mm)</label>
          <input
            className="input"
            type="number"
            step="1"
            value={profile.Length}
            onChange={(e) => update('Length', parseFloat(e.target.value) || 0)}
            style={{ width: '100%', padding: '6px 8px', fontSize: 12 }}
          />
        </div>
      </div>
    </div>
  )
}

type HornPartsEditorProps = {
  value: HornPartsValue | undefined
  onChange: (value: HornPartsValue) => void
}

export function HornPartsEditor({ value, onChange }: HornPartsEditorProps) {
  const parts: HornPartsValue = Array.isArray(value) && value.length > 0 ? value : [{ ...defaultHornPart }]

  const updatePart = (index: number, part: HornPart) => {
    const next = [...parts]
    next[index] = part
    onChange(next)
  }

  const addPart = () => {
    onChange([...parts, { H: { ...defaultProfile }, V: { ...defaultProfile } }])
  }

  const removePart = (index: number) => {
    if (parts.length <= 1) return
    const next = parts.filter((_, i) => i !== index)
    onChange(next)
  }

  return (
    <div>
      {parts.map((part, index) => (
        <div
          key={index}
          style={{
            border: '1px solid var(--border)',
            borderRadius: 10,
            padding: 12,
            marginBottom: 10,
            background: 'rgba(0,0,0,0.12)',
          }}
        >
          <div
            style={{
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
              marginBottom: 10,
            }}
          >
            <strong style={{ fontSize: 13 }}>Part {index + 1}</strong>
            {parts.length > 1 && (
              <button
                type="button"
                className="btn"
                onClick={() => removePart(index)}
                style={{ padding: '4px 8px', fontSize: 11 }}
              >
                Remove
              </button>
            )}
          </div>
          <ProfileEditor
            label="Horizontal (H)"
            profile={part.H}
            onChange={(H) => updatePart(index, { ...part, H })}
          />
          <ProfileEditor
            label="Vertical (V)"
            profile={part.V}
            onChange={(V) => updatePart(index, { ...part, V })}
          />
        </div>
      ))}
      <button type="button" className="btn" onClick={addPart} style={{ width: '100%' }}>
        + Add Part
      </button>
    </div>
  )
}
