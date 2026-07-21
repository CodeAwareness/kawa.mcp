/**
 * Recovery for tool-call args mangled by a mis-closed parameter tag.
 *
 * When an LLM emits a parameter block that is opened correctly but closed with
 * `</fieldName>` instead of the required closing tag — and the NEXT parameter is
 * opened without the required prefix — the harness's tool-call parser never sees
 * a parameter boundary. Everything up to the next well-formed close is folded
 * into the preceding field's string value. What reaches this process is
 * perfectly valid JSON in which one field carries a self-describing tail:
 *
 *   { consequences: 'real text</consequences>\n<parameter name="symptom">real symptom' }
 *
 * There is no second wire format to parse — the tail is simply data. But it is
 * losslessly recoverable, because it names the field it was meant for and
 * carries that field's value verbatim.
 *
 * This is deliberately a compensating path (the project otherwise forbids
 * fallbacks): left alone, the corruption reaches the store, syncs, and becomes
 * immutable, which has already cost several supersede cycles. Recovery is
 * strictly guarded and always logged, never silent.
 */

/** `</host>` + optional whitespace + a parameter opening + everything after it. */
const MANGLED_TAIL = /<\/([A-Za-z_][\w-]*)>\s*<parameter name="([A-Za-z_]\w*)">([\s\S]*)$/

export interface SalvageEntry {
  /** The field whose value was recovered. */
  field: string
  /** The field that had absorbed it. */
  fromField: string
}

export interface SalvageResult {
  args: Record<string, unknown>
  salvaged: SalvageEntry[]
}

/**
 * Arrays and objects arrive as JSON text; anything else is a plain string.
 * Only attempt a parse when the value actually looks structured, so a string
 * like "123" or "true" is never silently coerced to another type.
 */
function parseSalvagedValue(raw: string): unknown {
  const trimmed = raw.trim()
  if (trimmed.startsWith('[') || trimmed.startsWith('{')) {
    try {
      return JSON.parse(trimmed)
    } catch {
      // Not valid JSON after all — keep the text rather than dropping it.
    }
  }
  return trimmed
}

/**
 * Peel absorbed fields out of `args`. Returns a new object; `args` is untouched.
 *
 * `knownFields` are the schema field names of the tool being called — recovery
 * is refused for anything not in that set.
 */
export function salvageMangledArgs(
  args: Record<string, unknown>,
  knownFields: readonly string[],
): SalvageResult {
  const known = new Set(knownFields)
  const out: Record<string, unknown> = { ...args }
  const salvaged: SalvageEntry[] = []

  // A single malformed emission can chain: field A absorbs B, whose value in
  // turn absorbs C. Keep peeling until a pass finds nothing new.
  let progressed = true
  while (progressed) {
    progressed = false

    for (const [hostField, hostValue] of Object.entries(out)) {
      if (typeof hostValue !== 'string') continue

      const match = hostValue.match(MANGLED_TAIL)
      if (!match || match.index === undefined) continue

      const [, closingTag, targetField, rawValue] = match

      // Three guards, all required. Any miss means this is probably genuine
      // prose (a decision *documenting* this very bug legitimately contains
      // these markers), so leave it alone and let normal validation decide.
      //
      //  1. the bogus closing tag names the host field — evidence of a
      //     mis-closed host parameter rather than incidental mention
      if (closingTag !== hostField) continue
      //  2. the absorbed field is real for this tool
      if (!known.has(targetField)) continue
      //  3. it was not otherwise supplied — never overwrite genuine input
      const existing = out[targetField]
      if (existing !== undefined && existing !== null && existing !== '') continue

      out[hostField] = hostValue.slice(0, match.index).trimEnd()
      out[targetField] = parseSalvagedValue(rawValue)
      salvaged.push({ field: targetField, fromField: hostField })
      progressed = true
      break
    }
  }

  return { args: out, salvaged }
}
